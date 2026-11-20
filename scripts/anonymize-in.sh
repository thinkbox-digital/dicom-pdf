#!/usr/bin/env bash
# Standalone test-data preparation. Nothing here is packaged into the Java app.
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_dir=$(cd -- "$script_dir/.." && pwd -P)
python_bin=${PYTHON:-"$project_dir/target/anonymizer-venv/bin/python"}
if [[ ! -x "$python_bin" ]] && [[ -z ${PYTHON:-} ]]; then
    python_bin=python3
fi

exec "$python_bin" -I - "$project_dir" "$@" <<'PYTHON'
"""Prepare metadata-anonymized DICOM images for local testing only."""
import argparse
import bz2
from collections import Counter
import gzip
import hashlib
import hmac
import lzma
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import tarfile
import tempfile
import warnings
import zipfile

PROJECT = Path(sys.argv[1])
parser = argparse.ArgumentParser(
    prog="anonymize-in.sh",
    description="Read in/ recursively and write anonymized test images to "
                "target/anonymized-in/, preserving filenames, paths and archive formats. "
                "Supplied inputs are never modified.",
    epilog="Requires pydicom 3.0.2; 7z inputs also require py7zr 1.1.4. "
           "Pixels are unchanged: visually review burned-in text and recognizable anatomy. "
           "This is not a certified DICOM confidentiality profile implementation.",
)
parser.add_argument("--input", type=Path, default=PROJECT / "in",
                    help="source directory (default: repository in/)")
parser.add_argument("--output", type=Path, default=PROJECT / "target/anonymized-in",
                    help="new directory under target/; must not already exist")
parser.add_argument("--strict", action="store_true",
                    help="abort instead of omitting unreadable or incomplete DICOM inputs")
parser.add_argument("--max-file-mib", type=int, default=512,
                    help="maximum size of one input/expanded file (default: 512)")
parser.add_argument("--max-total-mib", type=int, default=8192,
                    help="cumulative input/expanded byte limit (default: 8192)")
parser.add_argument("--max-files", type=int, default=100000,
                    help="cumulative input/archive entry limit (default: 100000)")
parser.add_argument("--max-depth", type=int, default=8,
                    help="maximum nested archive layers (default: 8)")
args = parser.parse_args(sys.argv[2:])

try:
    import pydicom
    from pydicom.dataset import FileMetaDataset
    from pydicom.errors import InvalidDicomError
    from pydicom.uid import (ExplicitVRBigEndian, ExplicitVRLittleEndian,
                             ImplicitVRLittleEndian, MediaStorageDirectoryStorage)
except ImportError:
    parser.exit(1, "Missing pydicom. See README.md: Anonymize test inputs.\n")

# Invalid metadata can contain identifying strings in library warnings. Do not
# echo it to a terminal or write an original-to-anonymous name/UID mapping.
warnings.filterwarnings("ignore")
PIXELS = (0x7FE00010, 0x7FE00008, 0x7FE00009)
TEXT_VRS = {"AE", "AS", "LO", "LT", "SH", "ST", "UC", "UR", "UT"}
# Retain the units used to interpret rescaled pixels, not descriptive free text.
SAFE_TEXT = {"RescaleType"}
STRUCTURAL_UIDS = {
    "SOPClassUID", "ReferencedSOPClassUID", "RelatedGeneralSOPClassUID",
    "OriginalSpecializedSOPClassUID", "SOPClassesInStudy", "SOPClassesSupported",
    "TransferSyntaxUID", "CodingSchemeUID", "ContextGroupExtensionCreatorUID",
}
REMOVE_SEQUENCES = {
    "OriginalAttributesSequence", "ModifiedAttributesSequence", "EncryptedAttributesSequence",
    "DigitalSignaturesSequence", "MACParametersSequence", "IconImageSequence",
    "GraphicAnnotationSequence", "ContentSequence", "AcquisitionContextSequence",
}
IDENTITY_WORDS = ("Patient", "Person", "Physician", "Operator", "Institution",
                  "ClinicalTrial", "Request", "Order", "Insurance", "Visit")
salt = secrets.token_bytes(32)
counts = Counter()
consumed = 0
entry_count = 0


def token(value):
    return hmac.new(salt, value.encode("utf-8"), hashlib.sha256).digest()


def uid(value):
    # The same original UID maps to the same valid 2.25 UID throughout this run,
    # including references in sequences, loose files and separate archives.
    return "2.25." + str(int.from_bytes(token("uid:" + str(value))[:16], "big"))


def clean_metadata(dataset):
    for element in list(dataset):
        tag, keyword = element.tag, element.keyword
        if (tag.is_private or tag.element == 0 or tag.group == 0x0010
                or 0x5000 <= tag.group <= 0x50FF or 0x6000 <= tag.group <= 0x60FF
                or tag.group in (0x0004, 0x0400, 0xFFFA, 0xFFFC)
                or keyword in REMOVE_SEQUENCES):
            del dataset[tag]
        elif element.VR == "SQ":
            if any(word in keyword for word in IDENTITY_WORDS):
                del dataset[tag]
            else:
                for item in element.value:
                    clean_metadata(item)
        elif element.VR == "PN":
            element.value = "ANONYMOUS"
        elif element.VR in TEXT_VRS and keyword not in SAFE_TEXT:
            element.value = ""
        elif element.VR in {"DA", "TM", "DT"}:
            element.value = {"DA": "20000101", "TM": "000000", "DT": "20000101000000"}[element.VR]
        elif element.VR == "UI" and keyword not in STRUCTURAL_UIDS and element.value:
            element.value = [uid(v) for v in element.value] if element.VM > 1 else uid(element.value)
        elif element.VR == "UN":
            # Unknown binary attributes have no reliable confidentiality semantics.
            del dataset[tag]


def unusable_dicom(reason):
    if args.strict:
        raise ValueError(reason)
    counts["omitted_unusable_dicom"] += 1
    # Report the reason without exposing original filenames or patient metadata.
    print(f"Skipping unusable DICOM input: {reason}.", file=sys.stderr)


def anonymize(path, destination, hint):
    with path.open("rb") as source:
        part10 = source.read(132)[128:] == b"DICM"
    try:
        dataset = pydicom.dcmread(path, force=not part10)
    except (InvalidDicomError, ValueError, EOFError, OSError):
        if part10 or Path(hint).suffix.lower() in {".dcm", ".dicom"}:
            unusable_dicom("unreadable DICOM dataset")
            return
        counts["omitted_non_dicom"] += 1
        return
    if dataset.file_meta.get("MediaStorageSOPClassUID") == MediaStorageDirectoryStorage:
        counts["omitted_non_image_dicom"] += 1
        return
    if not dataset.get("SOPClassUID") or not dataset.get("SOPInstanceUID"):
        # Some image datasets omit SOP identity tags that are still available
        # in their Part 10 file meta. Reuse those identities before remapping.
        repaired = False
        for keyword, meta_keyword in (("SOPClassUID", "MediaStorageSOPClassUID"),
                                      ("SOPInstanceUID", "MediaStorageSOPInstanceUID")):
            if not dataset.get(keyword) and dataset.file_meta.get(meta_keyword):
                setattr(dataset, keyword, dataset.file_meta[meta_keyword].value)
                repaired = True
        if repaired:
            counts["repaired_sop_identity"] += 1
    if not dataset.get("SOPClassUID") or not dataset.get("SOPInstanceUID"):
        if part10 or Path(hint).suffix.lower() in {".dcm", ".dicom"}:
            unusable_dicom("missing SOP class or instance UID")
            return
        counts["omitted_non_dicom"] += 1
        return
    if not any(tag in dataset for tag in PIXELS):
        counts["omitted_non_image_dicom"] += 1
        return
    if not dataset.get("Rows") or not dataset.get("Columns"):
        unusable_dicom("image has no pixel dimensions")
        return
    # Use the issuer with the ID to avoid combining different patients who have
    # the same local ID. Fall back to supplied name/date, then study identity.
    if dataset.get("PatientID"):
        patient = (str(dataset.PatientID), str(dataset.get("IssuerOfPatientID", "")))
    elif dataset.get("PatientName"):
        patient = (str(dataset.PatientName), str(dataset.get("PatientBirthDate", "")))
    else:
        patient = (str(dataset.get("StudyInstanceUID", dataset.SOPInstanceUID)),)
    patient_id = "TEST-" + token(repr(patient)).hex()[:16].upper()
    pixel_bytes = {tag: dataset[tag].value for tag in PIXELS if tag in dataset}
    if str(dataset.get("BurnedInAnnotation", "")).upper() != "NO":
        counts["images_needing_pixel_review"] += 1
    transfer_syntax = dataset.file_meta.get("TransferSyntaxUID")
    if not transfer_syntax:
        implicit, little = dataset.original_encoding[:2]
        if implicit is None or little is None:
            raise ValueError("Cannot determine DICOM transfer syntax")
        transfer_syntax = (ImplicitVRLittleEndian if implicit else
                           ExplicitVRLittleEndian if little else ExplicitVRBigEndian)
    clean_metadata(dataset)
    dataset.PatientName = "TEST^" + patient_id
    dataset.PatientID = patient_id
    dataset.PatientBirthDate = ""
    dataset.PatientSex = ""
    dataset.PatientIdentityRemoved = "YES"
    dataset.DeidentificationMethod = "Local testing metadata scrub; pixels unchanged; review required"
    dataset.LongitudinalTemporalInformationModified = "REMOVED"
    # Discard all original file-meta extras and preamble, which may contain PHI.
    dataset.preamble = b"\0" * 128
    dataset.file_meta = FileMetaDataset()
    dataset.file_meta.TransferSyntaxUID = transfer_syntax
    dataset.file_meta.MediaStorageSOPClassUID = dataset.SOPClassUID
    dataset.file_meta.MediaStorageSOPInstanceUID = dataset.SOPInstanceUID
    pydicom.dcmwrite(destination, dataset, enforce_file_format=True)
    checked = pydicom.dcmread(destination)
    if (checked.file_meta.TransferSyntaxUID != transfer_syntax
            or any(checked[tag].value != value for tag, value in pixel_bytes.items())):
        raise ValueError("Pixel bytes or transfer syntax changed")
    counts["images"] += 1


def reserve(size):
    global entry_count, consumed
    entry_count += 1
    consumed += size
    if (size < 0 or size > args.max_file_mib * 1024**2
            or consumed > args.max_total_mib * 1024**2 or entry_count > args.max_files):
        raise ValueError("Input/archive size or entry limit exceeded")


def validate_members(members):
    """Validate names even though only scratch storage ever uses these paths."""
    used, files = set(), set()
    for name, directory, size in members:
        parts = name.rstrip("/").split("/")
        if (not name or "\\" in name or ":" in name or any(ord(c) < 32 for c in name)
                or any(part in ("", ".", "..") for part in parts)):
            raise ValueError("Unsafe archive member path")
        key = "/".join(parts).casefold()
        if key in used:
            raise ValueError("Duplicate archive member path")
        used.add(key)
        if not directory:
            files.add(key)
        reserve(size)
    for name in used:
        if any("/".join(name.split("/")[:i]) in files for i in range(1, len(name.split("/")))):
            raise ValueError("Archive file/directory collision")


def copy_stream(source, destination, expected=None):
    size = 0
    with destination.open("xb") as output:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            size += len(block)
            if size > args.max_file_mib * 1024**2 or (expected is not None and size > expected):
                raise ValueError("Expanded file size limit exceeded")
            output.write(block)
    if expected is not None and size != expected:
        raise ValueError("Expanded archive size differs from declared size")
    if expected is None:
        reserve(size)


def gzip_filename(path):
    """Keep a GZIP stream's original filename, without retaining its comment."""
    with path.open("rb") as source:
        header = source.read(10)
        if len(header) != 10:
            raise ValueError("Truncated GZIP header")
        flags = header[3]
        if flags & 4:
            length = source.read(2)
            if len(length) != 2:
                raise ValueError("Truncated GZIP header")
            source.seek(int.from_bytes(length, "little"), 1)
        if flags & 8:
            name = bytearray()
            while len(name) <= 65535:
                value = source.read(1)
                if value == b"\0":
                    return name.decode("latin-1")
                if not value:
                    break
                name.extend(value)
            raise ValueError("Invalid GZIP filename")
    return ""


def tar_mode(magic):
    if magic.startswith(b"\x1f\x8b"):
        return "w:gz"
    if magic.startswith(b"BZh"):
        return "w:bz2"
    if magic.startswith(b"\xfd7zXZ\0"):
        return "w:xz"
    return "w"


def process(path, destination, scratch, hint, depth=0):
    if depth > args.max_depth:
        raise ValueError("Nested archive depth limit exceeded")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with path.open("rb") as source:
        header = source.read(132)
    magic = header[:8]
    # An image may contain ZIP bytes in its pixels or other payload. A DICOM
    # file header takes precedence over ZIP's end-of-file signature detection.
    if header[128:] == b"DICM":
        anonymize(path, destination, hint)
    elif zipfile.is_zipfile(path):
        counts["archives"] += 1
        with zipfile.ZipFile(path) as archive, tempfile.TemporaryDirectory(dir=scratch) as temporary:
            members = archive.infolist()
            for info in members:
                kind = stat.S_IFMT(info.external_attr >> 16)
                if (kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1
                        or kind == stat.S_IFDIR and not info.is_dir()
                        or info.is_dir() and (kind == stat.S_IFREG or info.file_size != 0)
                        or "\0" in info.orig_filename):
                    raise ValueError("Linked, special or encrypted ZIP member")
            validate_members([(i.filename, i.is_dir(), i.file_size) for i in members])
            # Write fresh archive metadata; retain every surviving member's
            # original name, path and compression method, including nested ZIPs.
            with zipfile.ZipFile(destination, "x") as cleaned_archive:
                for number, info in enumerate(members):
                    if info.is_dir():
                        cleaned_archive.writestr(zipfile.ZipInfo(info.filename), b"")
                        continue
                    staged = Path(temporary) / f"input-{number}"
                    cleaned = Path(temporary) / f"output-{number}"
                    with archive.open(info) as source:
                        copy_stream(source, staged, info.file_size)
                    process(staged, cleaned, scratch, info.filename, depth + 1)
                    if cleaned.is_file():
                        cleaned_archive.write(cleaned, arcname=info.filename, compress_type=info.compress_type)
                        cleaned.unlink()
                    staged.unlink()
    elif magic.startswith(b"7z\xbc\xaf\x27\x1c"):
        try:
            import py7zr
        except ImportError:
            raise ValueError("7z input requires py7zr 1.1.4; see README.md") from None
        counts["archives"] += 1
        with py7zr.SevenZipFile(path, max_extract_size=args.max_total_mib * 1024**2) as archive:
            if archive.needs_password():
                raise ValueError("Encrypted 7z archive is unsupported")
            members = archive.list()
            if any(not (i.is_file or i.is_directory) or i.is_symlink for i in members):
                raise ValueError("Linked or special 7z member")
            validate_members([(i.filename, i.is_directory, i.uncompressed) for i in members])
            with tempfile.TemporaryDirectory(dir=scratch) as temporary:
                expanded = Path(temporary) / "expanded"
                expanded.mkdir()
                archive.extractall(path=expanded)
                with py7zr.SevenZipFile(destination, "x") as cleaned_archive:
                    for number, info in enumerate(members):
                        staged = expanded / info.filename
                        cleaned = Path(temporary) / f"output-{number}"
                        if info.is_directory:
                            cleaned.mkdir()
                            cleaned_archive.write(cleaned, arcname=info.filename)
                            continue
                        if staged.is_symlink() or not staged.is_file() or staged.stat().st_size != info.uncompressed:
                            raise ValueError("Expanded 7z member differs from its inventory")
                        process(staged, cleaned, scratch, info.filename, depth + 1)
                        if cleaned.is_file():
                            cleaned_archive.write(cleaned, arcname=info.filename)
                            cleaned.unlink()
                        staged.unlink()
    elif magic.startswith(b"Rar!"):
        raise ValueError("RAR archives are unsupported; unpack them into a separate folder first")
    elif tarfile.is_tarfile(path):
        counts["archives"] += 1
        with tarfile.open(path, "r:*") as archive, tempfile.TemporaryDirectory(dir=scratch) as temporary:
            members = archive.getmembers()
            if any(not (i.isfile() or i.isdir()) for i in members):
                raise ValueError("Linked or special TAR member")
            validate_members([(i.name, i.isdir(), i.size) for i in members])
            with tarfile.open(destination, tar_mode(magic)) as cleaned_archive:
                for number, info in enumerate(members):
                    entry = tarfile.TarInfo(info.name)
                    if info.isdir():
                        entry.type, entry.mode = tarfile.DIRTYPE, 0o700
                        cleaned_archive.addfile(entry)
                        continue
                    staged = Path(temporary) / f"input-{number}"
                    cleaned = Path(temporary) / f"output-{number}"
                    with archive.extractfile(info) as source:
                        copy_stream(source, staged, info.size)
                    process(staged, cleaned, scratch, info.name, depth + 1)
                    if cleaned.is_file():
                        entry.size, entry.mode = cleaned.stat().st_size, 0o600
                        with cleaned.open("rb") as source:
                            cleaned_archive.addfile(entry, source)
                        cleaned.unlink()
                    staged.unlink()
    elif magic.startswith((b"\x1f\x8b", b"BZh", b"\xfd7zXZ\0")):
        counts["archives"] += 1
        opener = gzip.open if magic.startswith(b"\x1f\x8b") else bz2.open if magic.startswith(b"BZh") else lzma.open
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            staged = Path(temporary) / "expanded"
            cleaned = Path(temporary) / "cleaned"
            with opener(path, "rb") as source:
                copy_stream(source, staged)
            process(staged, cleaned, scratch, str(Path(hint).with_suffix("")), depth + 1)
            if cleaned.is_file():
                with cleaned.open("rb") as source, destination.open("xb") as output:
                    if opener is gzip.open:
                        with gzip.GzipFile(filename=gzip_filename(path), mode="wb", fileobj=output, mtime=0) as compressed:
                            shutil.copyfileobj(source, compressed)
                    else:
                        with opener(output, "wb") as compressed:
                            shutil.copyfileobj(source, compressed)
    elif Path(hint).suffix.lower() in {".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".tgz"}:
        raise ValueError("Unreadable or unsupported archive")
    else:
        anonymize(path, destination, hint)


def walk_error(error):
    raise ValueError("Cannot read a source directory") from error


def main():
    source, destination = args.input.absolute(), args.output.absolute()
    if any(value <= 0 for value in (args.max_file_mib, args.max_total_mib, args.max_files, args.max_depth)):
        parser.error("size, entry and depth limits must be positive")
    if source.is_symlink() or not source.is_dir():
        parser.error("--input must be an ordinary directory")
    source = source.resolve()
    if destination.exists() or destination.is_symlink():
        parser.error("--output already exists; choose a new directory")
    destination = destination.resolve()
    if not destination.is_relative_to(PROJECT / "target"):
        parser.error("--output must be a new directory under the repository's target/")
    if source.is_relative_to(destination) or destination.is_relative_to(source):
        parser.error("input and output directories must not overlap")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".anonymize-in-", dir=destination.parent) as temporary:
        work = Path(temporary)
        result, scratch = work / "cleaned", work / "scratch"
        result.mkdir()
        scratch.mkdir()
        # os.walk does not follow directory symlinks; reject them explicitly.
        for directory, dirs, files in os.walk(source, followlinks=False, onerror=walk_error):
            (result / Path(directory).relative_to(source)).mkdir(parents=True, exist_ok=True)
            for name in sorted(dirs + files):
                path = Path(directory) / name
                if path.is_symlink() or not (path.is_file() or path.is_dir()):
                    raise ValueError("Source tree contains a link or special file")
            dirs.sort()
            for name in sorted(files):
                path = Path(directory) / name
                reserve(path.stat().st_size)
                process(path, result / path.relative_to(source), scratch, name)
        if not counts["images"]:
            raise ValueError("No DICOM images found; no output was published")
        result.rename(destination)
    print(f"Anonymized {counts['images']} images from {counts['archives']} archives and loose inputs.")
    print(f"Omitted {counts['omitted_non_dicom']} non-DICOM files and "
          f"{counts['omitted_non_image_dicom']} non-image DICOM objects (including DICOMDIR).")
    print(f"Omitted {counts['omitted_unusable_dicom']} unreadable/incomplete DICOM inputs; "
          f"recovered SOP identity from file meta for {counts['repaired_sop_identity']} inputs.")
    print(f"Pixel review needed: {counts['images_needing_pixel_review']} images have no BurnedInAnnotation=NO assertion.")
    print("All pixels remain unchanged; review images before sharing. Test use only.")
    print("Original filenames, folder paths and archive formats are preserved; review names before sharing.")
    print(f"Cleaned input: {destination}")


try:
    main()
except KeyboardInterrupt:
    sys.exit("Cancelled; no output was published.")
except Exception as error:
    # Library exception messages may include original paths or metadata values.
    if isinstance(error, ValueError) and error.__traceback__.tb_next is not None:
        origin = error.__traceback__
        while origin.tb_next:
            origin = origin.tb_next
        message = str(error) if origin.tb_frame.f_code.co_filename == "<stdin>" else type(error).__name__
    else:
        message = type(error).__name__
    sys.exit(f"Anonymization failed: {message}. No output was published.\n")
PYTHON
