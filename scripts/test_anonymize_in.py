"""Standalone Bash anonymizer regressions using synthetic inputs only.

Run: target/anonymizer-venv/bin/python -I scripts/test_anonymize_in.py
"""
import bz2
import gzip
import hashlib
import io
import lzma
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import (ExplicitVRBigEndian, ExplicitVRLittleEndian,
                         ImplicitVRLittleEndian, JPEGBaseline8Bit,
                         MediaStorageDirectoryStorage, SecondaryCaptureImageStorage)
import py7zr

PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / "scripts/anonymize-in.sh"
STUDY, SERIES, SOP = "2.25.1000", "2.25.2000", "2.25.3000"


def image(sop=SOP, syntax=ExplicitVRLittleEndian, raw=False):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = syntax
    meta.SourceApplicationEntityTitle = "PRIVATE_HOSPITAL"
    meta.PrivateInformationCreatorUID = "2.25.7777"
    meta.PrivateInformation = b"SYNTHETIC_SECRET"
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"SYNTHETIC_SECRET".ljust(128, b"\0"))
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID = STUDY, SERIES
    ds.PatientName = "SYNTHETIC_SECRET^PERSON"
    ds.PatientID = "SYNTHETIC_SECRET"
    ds.PatientBirthDate, ds.PatientSex = "19800101", "F"
    ds.PatientWeight = 75
    ds.IssuerOfPatientID = "SYNTHETIC_SECRET"
    ds.Modality = "CT"
    ds.InstitutionName = "SYNTHETIC_SECRET"
    ds.StationName = "SYNTHETIC_SECRET"
    ds.StudyDescription = "SYNTHETIC_SECRET"
    ds.AccessionNumber = "SYNTHETIC_SECRET"
    ds.StudyDate, ds.StudyTime = "20251231", "235959"
    ds.AcquisitionDateTime = "20251231235959"
    ds.ReferringPhysicianName = "SYNTHETIC_SECRET^DOCTOR"
    ds.BurnedInAnnotation = "NO"
    ds.Rows, ds.Columns, ds.SamplesPerPixel = 2, 2, 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    ds.PixelData = b"\x01\x02\x03\x04"
    ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1024, 1, "HU"
    ds.add_new((0x0011, 0x0010), "LO", "PRIVATE_CREATOR")
    ds.add_new((0x0011, 0x1010), "LO", "SYNTHETIC_SECRET")
    ds.add_new((0x6000, 0x3000), "OW", b"SYNTHETIC_SECRET\0")
    ref = Dataset()
    ref.ReferencedSOPClassUID, ref.ReferencedSOPInstanceUID = SecondaryCaptureImageStorage, SOP
    ref.add_new((0x0013, 0x0010), "LO", "SYNTHETIC_SECRET")
    ds.ReferencedImageSequence = [ref]
    original = Dataset()
    original.PatientName = "SYNTHETIC_SECRET^OLD"
    ds.OriginalAttributesSequence = [original]
    if syntax == JPEGBaseline8Bit:
        # An opaque encapsulated payload verifies preservation without a decoder.
        ds.PixelData = encapsulate([b"\xff\xd8synthetic-pixel-stream\xff\xd9"])
        ds[0x7FE00010].is_undefined_length = True
    stream = io.BytesIO()
    if raw:
        ds.preamble = None
        ds.file_meta = FileMetaDataset()
        pydicom.dcmwrite(stream, ds, implicit_vr=True, little_endian=True)
    else:
        pydicom.dcmwrite(stream, ds, enforce_file_format=True)
    return stream.getvalue()


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return stream.getvalue()


class AnonymizeInTest(unittest.TestCase):
    def setUp(self):
        parent = PROJECT / "target/anonymizer-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)
        self.source, self.output = self.root / "input", self.root / "clean"
        self.source.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *extra, success=True, output=None, in_place=False):
        publication = ["--in-place"] if in_place else ["--output", str(output or self.output)]
        result = subprocess.run(
            ["bash", str(SCRIPT), "--input", str(self.source), *publication, *extra],
            env={**os.environ, "PYTHON": sys.executable}, capture_output=True, text=True, timeout=60,
        )
        if success:
            self.assertEqual(0, result.returncode, result.stderr)
        else:
            self.assertNotEqual(0, result.returncode)
            self.assertFalse((output or self.output).exists())
        self.assertNotIn("SYNTHETIC_SECRET", result.stdout + result.stderr)
        self.assertFalse(list(self.root.glob(".anonymize-in-*")))
        return result

    def test_metadata_scrub_pixels_references_and_originals(self):
        original = image()
        (self.source / "SYNTHETIC_SECRET.dcm").write_bytes(original)
        (self.source / "second.dcm").write_bytes(image("2.25.3001"))
        self.run_script()
        cleaned = sorted(self.output.glob("*.dcm"))
        self.assertEqual({"SYNTHETIC_SECRET.dcm", "second.dcm"}, {p.name for p in cleaned})
        first, second = (pydicom.dcmread(path) for path in cleaned)
        self.assertNotEqual(SOP, first.SOPInstanceUID)
        self.assertEqual(first.SOPInstanceUID, second.ReferencedImageSequence[0].ReferencedSOPInstanceUID)
        self.assertEqual(first.StudyInstanceUID, second.StudyInstanceUID)
        self.assertEqual(first.PatientID, second.PatientID)
        self.assertEqual("YES", first.PatientIdentityRemoved)
        self.assertEqual("20000101", first.StudyDate)
        self.assertEqual("000000", first.StudyTime)
        self.assertEqual("20000101000000", first.AcquisitionDateTime)
        self.assertEqual(SecondaryCaptureImageStorage, first.SOPClassUID)
        self.assertEqual(SecondaryCaptureImageStorage, first.ReferencedImageSequence[0].ReferencedSOPClassUID)
        self.assertEqual(first.SOPInstanceUID, first.file_meta.MediaStorageSOPInstanceUID)
        self.assertEqual(b"\x01\x02\x03\x04", first.PixelData)
        self.assertEqual("HU", first.RescaleType)
        self.assertFalse(any(e.tag.is_private for e in first.iterall()))
        self.assertNotIn("PatientWeight", first)
        self.assertNotIn("OriginalAttributesSequence", first)
        self.assertNotIn(0x60003000, first)
        self.assertEqual(b"\0" * 128, first.preamble)
        for path in cleaned:
            self.assertNotIn(b"SYNTHETIC_SECRET", path.read_bytes())
        self.assertEqual(original, (self.source / "SYNTHETIC_SECRET.dcm").read_bytes())
        self.run_script(output=self.root / "second-run")
        again = pydicom.dcmread(self.root / "second-run/SYNTHETIC_SECRET.dcm")
        self.assertNotEqual(first.SOPInstanceUID, again.SOPInstanceUID)
        self.assertNotEqual(first.PatientID, again.PatientID)

    def test_nested_archives_extensionless_data_and_non_images(self):
        loose = image()
        (self.source / "loose.dcm").write_bytes(loose)
        inner = zip_bytes([("patient/IMAGE001", image("2.25.3001", raw=True)), ("notes.txt", b"SYNTHETIC_SECRET")])
        outer = zip_bytes([("SYNTHETIC_SECRET.zip", inner)])
        (self.source / "renamed.payload").write_bytes(outer)
        (self.source / "report.txt").write_bytes(b"SYNTHETIC_SECRET")
        directory = pydicom.dcmread(io.BytesIO(loose))
        del directory.PixelData
        del directory.SOPClassUID
        del directory.SOPInstanceUID
        directory.file_meta.MediaStorageSOPClassUID = MediaStorageDirectoryStorage
        directory.save_as(self.source / "DICOMDIR", enforce_file_format=True)
        self.run_script()
        self.assertEqual({"loose.dcm", "renamed.payload"}, {p.name for p in self.output.iterdir()})
        self.assertEqual(outer, (self.source / "renamed.payload").read_bytes())
        a = pydicom.dcmread(self.output / "loose.dcm")
        with zipfile.ZipFile(self.output / "renamed.payload") as archive:
            self.assertEqual(["SYNTHETIC_SECRET.zip"], archive.namelist())
            with zipfile.ZipFile(io.BytesIO(archive.read("SYNTHETIC_SECRET.zip"))) as nested:
                self.assertEqual(["patient/IMAGE001"], nested.namelist())
                nested_data = nested.read("patient/IMAGE001")
                b = pydicom.dcmread(io.BytesIO(nested_data))
        self.assertEqual(a.StudyInstanceUID, b.StudyInstanceUID)
        self.assertEqual(a.PatientID, b.PatientID)
        self.assertEqual(a.SOPInstanceUID, b.ReferencedImageSequence[0].ReferencedSOPInstanceUID)
        self.assertNotIn(b"SYNTHETIC_SECRET", nested_data)

    def test_7z_and_tar_compression(self):
        seed = self.root / "seed.dcm"
        seed.write_bytes(image())
        with py7zr.SevenZipFile(self.source / "test.7z", "w") as archive:
            archive.write(seed, "SYNTHETIC_SECRET/image.dcm")
        for number, mode in enumerate(("w", "w:gz", "w:bz2", "w:xz")):
            with tarfile.open(self.source / f"archive-{number}.payload", mode) as archive:
                archive.add(seed, arcname="SYNTHETIC_SECRET/image.dcm")
        for suffix, compress in (("gz", gzip.compress), ("bz2", bz2.compress), ("xz", lzma.compress)):
            (self.source / f"image.dcm.{suffix}").write_bytes(compress(seed.read_bytes()))
        self.run_script()
        self.assertEqual({p.name for p in self.source.iterdir()}, {p.name for p in self.output.iterdir()})
        with py7zr.SevenZipFile(self.output / "test.7z") as archive:
            self.assertEqual(["SYNTHETIC_SECRET/image.dcm"], archive.getnames())
            archive.extractall(self.root / "seven-recovered")
        paths = [self.root / "seven-recovered/SYNTHETIC_SECRET/image.dcm"]
        for number, mode in enumerate(("w", "w:gz", "w:bz2", "w:xz")):
            with tarfile.open(self.output / f"archive-{number}.payload") as archive:
                self.assertEqual(["SYNTHETIC_SECRET/image.dcm"], archive.getnames())
                data = archive.extractfile("SYNTHETIC_SECRET/image.dcm").read()
                self.assertNotIn(b"SYNTHETIC_SECRET", data)
                self.assertEqual(b"\x01\x02\x03\x04", pydicom.dcmread(io.BytesIO(data)).PixelData)
            expected_magic = {"w": b"", "w:gz": b"\x1f\x8b", "w:bz2": b"BZh", "w:xz": b"\xfd7zXZ\0"}[mode]
            self.assertTrue((self.output / f"archive-{number}.payload").read_bytes().startswith(expected_magic))
        for suffix, decompress in (("gz", gzip.decompress), ("bz2", bz2.decompress), ("xz", lzma.decompress)):
            data = decompress((self.output / f"image.dcm.{suffix}").read_bytes())
            self.assertNotIn(b"SYNTHETIC_SECRET", data)
            self.assertEqual(b"\x01\x02\x03\x04", pydicom.dcmread(io.BytesIO(data)).PixelData)
        for path in paths:
            self.assertNotIn(b"SYNTHETIC_SECRET", path.read_bytes())

    def test_transfer_syntax_and_encapsulated_pixel_preservation(self):
        syntaxes = (ExplicitVRLittleEndian, ExplicitVRBigEndian, ImplicitVRLittleEndian, JPEGBaseline8Bit)
        originals = {}
        for i, syntax in enumerate(syntaxes):
            data = image(f"2.25.400{i}", syntax)
            (self.source / f"image-{i}.dcm").write_bytes(data)
            originals[syntax] = pydicom.dcmread(io.BytesIO(data)).PixelData
        self.run_script()
        for path in self.output.glob("*.dcm"):
            ds = pydicom.dcmread(path)
            self.assertEqual(originals[ds.file_meta.TransferSyntaxUID], ds.PixelData)

    def test_corrupt_input_never_publishes_partial_set(self):
        (self.source / "first.dcm").write_bytes(image())
        (self.source / "last.dcm").write_bytes(b"SYNTHETIC_SECRET")
        self.run_script("--strict", success=False)
        self.assertEqual(b"SYNTHETIC_SECRET", (self.source / "last.dcm").read_bytes())

    def test_unusable_loose_and_archived_inputs_omitted_by_default(self):
        (self.source / "first.dcm").write_bytes(image())
        incomplete = pydicom.dcmread(io.BytesIO(image()))
        del incomplete.SOPClassUID
        del incomplete.SOPInstanceUID
        incomplete.file_meta = FileMetaDataset()
        stream = io.BytesIO()
        pydicom.dcmwrite(stream, incomplete, implicit_vr=False, little_endian=True)
        (self.source / "mixed.zip").write_bytes(zip_bytes([
            ("valid.dcm", image("2.25.3001")),
            ("incomplete.dcm", stream.getvalue()),
        ]))
        (self.source / "last.dcm").write_bytes(b"SYNTHETIC_SECRET")
        result = self.run_script()
        self.assertEqual({"first.dcm", "mixed.zip"}, {p.name for p in self.output.iterdir()})
        self.assertIn("Omitted 2 unreadable/incomplete DICOM inputs", result.stdout)
        self.assertNotIn(b"SYNTHETIC_SECRET", (self.output / "first.dcm").read_bytes())
        with zipfile.ZipFile(self.output / "mixed.zip") as archive:
            self.assertEqual(["valid.dcm"], archive.namelist())
            self.assertNotIn(b"SYNTHETIC_SECRET", archive.read("valid.dcm"))
        self.assertEqual(b"SYNTHETIC_SECRET", (self.source / "last.dcm").read_bytes())

    def test_dataset_sop_identity_recovered_from_file_meta(self):
        for i, keyword in enumerate(("SOPClassUID", "SOPInstanceUID", "both")):
            incomplete = pydicom.dcmread(io.BytesIO(image()))
            if keyword in ("SOPClassUID", "both"):
                del incomplete.SOPClassUID
            if keyword in ("SOPInstanceUID", "both"):
                del incomplete.SOPInstanceUID
            incomplete.save_as(self.source / f"image-{i}.dcm", enforce_file_format=True)
        result = self.run_script("--strict")
        self.assertIn("recovered SOP identity from file meta for 3 inputs", result.stdout)
        self.assertEqual(3, len(list(self.output.iterdir())))
        for path in self.output.iterdir():
            ds = pydicom.dcmread(path)
            self.assertEqual(SecondaryCaptureImageStorage, ds.SOPClassUID)
            self.assertEqual(ds.SOPInstanceUID, ds.file_meta.MediaStorageSOPInstanceUID)
            self.assertNotEqual(SOP, ds.SOPInstanceUID)

    def test_part10_image_containing_zip_payload_is_not_extracted(self):
        ds = pydicom.dcmread(io.BytesIO(image()))
        ds.PixelData = zip_bytes([("not-an-image.dcm", b"SYNTHETIC_SECRET")])
        path = self.source / "image-with-zip.dcm"
        ds.save_as(path, enforce_file_format=True)
        self.assertTrue(zipfile.is_zipfile(path))
        self.run_script("--strict")
        self.assertEqual(1, len(list(self.output.iterdir())))
        cleaned = pydicom.dcmread(self.output / "image-with-zip.dcm")
        self.assertEqual(pydicom.dcmread(path).PixelData, cleaned.PixelData)

    def test_all_unusable_inputs_do_not_publish_empty_output(self):
        (self.source / "bad.dcm").write_bytes(b"SYNTHETIC_SECRET")
        self.run_script(success=False)

    def test_relative_paths_empty_directories_and_equal_basenames_survive(self):
        for name in ("first/same.dcm", "second/same.dcm"):
            path = self.source / name
            path.parent.mkdir()
            path.write_bytes(image())
        (self.source / "empty").mkdir()
        (self.source / "nested").mkdir()
        archive = self.source / "nested/series.zip"
        archive.write_bytes(zip_bytes([
            ("empty/", b""),
            ("one/IMAGE001", image()),
            ("two/IMAGE001", image("2.25.3001")),
        ]))
        self.run_script()
        self.assertEqual({"first/same.dcm", "second/same.dcm", "nested/series.zip"},
                         {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()})
        self.assertTrue((self.output / "empty").is_dir())
        with zipfile.ZipFile(self.output / "nested/series.zip") as cleaned:
            self.assertEqual(["empty/", "one/IMAGE001", "two/IMAGE001"], cleaned.namelist())
            self.assertNotEqual(pydicom.dcmread(io.BytesIO(cleaned.read("one/IMAGE001"))).SOPInstanceUID,
                                pydicom.dcmread(io.BytesIO(cleaned.read("two/IMAGE001"))).SOPInstanceUID)

    def test_zip_comments_removed_while_member_names_remain(self):
        source = self.source / "test.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.comment = b"SYNTHETIC_SECRET"
            info = zipfile.ZipInfo("SYNTHETIC_SECRET/image.dcm")
            info.comment = b"SYNTHETIC_SECRET"
            archive.writestr(info, image())
        self.run_script()
        with zipfile.ZipFile(self.output / "test.zip") as archive:
            self.assertEqual(["SYNTHETIC_SECRET/image.dcm"], archive.namelist())
            self.assertEqual(b"", archive.comment)
            self.assertEqual(b"", archive.infolist()[0].comment)
            self.assertNotIn(b"SYNTHETIC_SECRET", archive.read("SYNTHETIC_SECRET/image.dcm"))

    def test_name_fields_are_scrubbed_inside_retained_sequences(self):
        ds = pydicom.dcmread(io.BytesIO(image()))
        ref = ds.ReferencedImageSequence[0]
        ref.OperatorsName = ["SYNTHETIC_SECRET^ONE", "SYNTHETIC_SECRET^TWO"]
        ref.InstitutionName = "SYNTHETIC_SECRET"
        ref.add_new((0x0008, 0x1048), "CS", "SYNTHETIC_SECRET")  # PhysiciansOfRecord
        ref.add_new((0x0008, 0x1010), "OB", b"SYNTHETIC_SECRET")  # StationName
        code = Dataset()
        code.CodeValue = "SYNTHETIC_SECRET"
        code.CodingSchemeDesignator = "99TEST"
        code.CodeMeaning = "Synthetic station"
        ref.PerformedStationNameCodeSequence = [code]
        path = self.source / "names.dcm"
        ds.save_as(path, enforce_file_format=True)
        self.run_script()
        output = self.output / path.name
        cleaned = pydicom.dcmread(output)
        ref = cleaned.ReferencedImageSequence[0]
        self.assertEqual("ANONYMOUS", ref.OperatorsName)
        self.assertEqual("", ref.InstitutionName)
        self.assertEqual("", ref.PhysiciansOfRecord)
        self.assertNotIn("StationName", ref)
        self.assertNotIn("PerformedStationNameCodeSequence", ref)
        self.assertEqual(cleaned.SOPInstanceUID, ref.ReferencedSOPInstanceUID)
        self.assertNotIn(b"SYNTHETIC_SECRET", output.read_bytes())

    def test_gzip_stored_filename_preserved(self):
        source = self.source / "original.dcm.gz"
        with source.open("wb") as output:
            with gzip.GzipFile(filename="stored-image.dcm", fileobj=output, mode="wb") as archive:
                archive.write(image())
        self.run_script()
        cleaned = self.output / "original.dcm.gz"
        self.assertIn(b"stored-image.dcm\0", cleaned.read_bytes()[:100])
        self.assertNotIn(b"SYNTHETIC_SECRET", gzip.decompress(cleaned.read_bytes()))

    def test_unsafe_archive_and_symlink_rejected(self):
        archive = self.source / "bad.zip"
        for name in ("../escape.dcm", "/absolute.dcm", "C:/drive.dcm", "folder\\image.dcm"):
            with self.subTest(name=name):
                archive.write_bytes(zip_bytes([(name, image())]))
                self.run_script(success=False)
        archive.unlink()
        (self.source / "linked").symlink_to(self.root)
        self.run_script(success=False)

    def test_size_count_and_depth_limits(self):
        nested = zip_bytes([("image.dcm", image())])
        (self.source / "archive.zip").write_bytes(zip_bytes([("inner.zip", nested)]))
        self.run_script("--max-depth", "1", success=False)
        self.run_script("--max-files", "1", success=False)
        (self.source / "archive.zip").unlink()
        (self.source / "large.bin").write_bytes(b"x" * (1024**2 + 1))
        self.run_script("--max-file-mib", "1", success=False)

    def test_in_place_replaces_loose_images_and_archives(self):
        loose = self.source / "nested" / "image.dcm"
        loose.parent.mkdir()
        loose.write_bytes(image())
        loose.chmod(0o640)
        alias = self.source / "alias.dcm"
        os.link(loose, alias)
        archive = self.source / "images.zip"
        archive.write_bytes(zip_bytes([("image.dcm", image()), ("notes.txt", b"omitted")]))
        skipped = self.source / "notes.txt"
        skipped.write_bytes(b"keep original")

        result = self.run_script(in_place=True)

        self.assertIn("Replaced 3 files in place", result.stdout)
        self.assertFalse(self.output.exists())
        self.assertEqual(b"keep original", skipped.read_bytes())
        self.assertEqual(0o640, loose.stat().st_mode & 0o777)
        self.assertNotIn(b"SYNTHETIC_SECRET", loose.read_bytes())
        self.assertEqual(loose.read_bytes(), alias.read_bytes())
        with zipfile.ZipFile(archive) as cleaned:
            self.assertEqual(["image.dcm"], cleaned.namelist())
            self.assertNotIn(b"SYNTHETIC_SECRET", cleaned.read("image.dcm"))
        self.assertFalse(list(self.source.rglob(".anonymize-in-*")))

    def test_in_place_scrubbing_failure_preserves_inputs(self):
        original = image()
        path = self.source / "a-valid.dcm"
        path.write_bytes(original)
        bad = self.source / "z-unreadable.dcm"
        bad.write_bytes(b"unreadable")

        result = self.run_script("--strict", in_place=True, success=False)

        self.assertIn("No output was published", result.stderr)
        self.assertEqual(original, path.read_bytes())
        self.assertEqual(b"unreadable", bad.read_bytes())

    def test_existing_output_and_input_overlap_refused(self):
        (self.source / "image.dcm").write_bytes(image())
        self.run_script()
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.output.iterdir()}
        result = subprocess.run(["bash", str(SCRIPT), "--input", str(self.source), "--output", str(self.output)],
                                env={**os.environ, "PYTHON": sys.executable}, capture_output=True, timeout=30)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.output.iterdir()})
        self.run_script(output=self.source / "overlap", success=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
