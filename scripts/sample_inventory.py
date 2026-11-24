#!/usr/bin/env python3
"""Inventory supplied samples read-only and safely stage new archives/loose inputs.

Reports and staging are private local artifacts below target/additional-samples.
Console output is aggregate only: no filenames, patient tags, paths or parser
messages. ZIP safety delegates to convert_archives.py; nested expansion adds
session-wide file/byte/depth budgets. Unknown archive types are reported.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from functools import partial
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
import zlib

import convert_archives as archive_tools

MAX_ARCHIVE_DEPTH = 4
MAX_ARCHIVES = 32
MAX_SESSION_FILES = 4096
MAX_SESSION_BYTES = 512 * 1024 * 1024
MAX_LOOSE_BYTES = 128 * 1024 * 1024


def file_kind(path: Path) -> str:
    """Detect by bytes/ZIP structure, never by a possibly misleading extension."""
    if zipfile.is_zipfile(path):
        return "zip"
    with path.open("rb") as source:
        header = source.read(132)
    if header.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "7z"
    if header.startswith((b"Rar!\x1a\x07\x00", b"Rar!\x1a\x07\x01\x00")):
        return "rar"
    if len(header) >= 132 and header[128:132] == b"DICM":
        return "dicom-part10"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"%PDF-"):
        return "pdf"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if header.startswith(b"\x1f\x8b"):
        return "gzip"
    return "other"


def work_path(work: Path, *parts: str) -> Path:
    path = work.joinpath(*parts)
    if not path.resolve().is_relative_to(work.resolve()):
        raise ValueError("Staging/report path escapes private work directory")
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink():
            raise ValueError("Staging/report paths must not contain symlinks")
        if ancestor == work:
            break
    return path


def prior_inputs(input_root: Path, reports: list[Path]) -> tuple[set[str], set[str]]:
    hashes: set[str] = set()
    paths: set[str] = set()
    basenames = {p.name: p.relative_to(input_root).as_posix() for p in input_root.rglob("*") if p.is_file()}

    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if "sha256" in key.lower() and isinstance(item, str) and re.fullmatch(r"[0-9a-fA-F]{64}", item):
                    hashes.add(item.lower())
                if key in ("input", "archive", "sourcePath", "sourceFile") and isinstance(item, str):
                    candidate = Path(item)
                    try:
                        paths.add(candidate.resolve().relative_to(input_root.resolve()).as_posix())
                    except ValueError:
                        if item in basenames:
                            paths.add(basenames[item])
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    for report in reports:
        if report.is_file():
            visit(json.loads(report.read_text(encoding="utf-8")))
    return hashes, paths


def input_inventory(root: Path) -> list[dict]:
    result = []
    for path in sorted(root.rglob("*")):
        if path.is_dir() and not path.is_symlink():
            continue
        row = {"sourceID": f"input-{len(result)+1:03}", "sourcePath": path.relative_to(root).as_posix()}
        if path.is_symlink() or not path.is_file():
            row.update(kind="unsupported-filesystem-entry", status="not-read", sha256=None, size=None)
        else:
            row.update(kind=file_kind(path), size=path.stat().st_size, sha256=archive_tools.fingerprint(path), status="inventoried")
        result.append(row)
    return result


class SessionBudget:
    def __init__(self, *, files=MAX_SESSION_FILES, bytes=MAX_SESSION_BYTES, archives=MAX_ARCHIVES):
        self.max_files, self.max_bytes, self.max_archives = files, bytes, archives
        self.files = self.bytes = self.archives = 0

    def reserve_archive(self, archive: Path) -> None:
        with zipfile.ZipFile(archive) as source:
            members = [item for item in source.infolist() if not item.is_dir()]
            # safe_extract repeats authoritative member/path/type/actual-byte
            # validation. Reserve cumulative limits before writing anything.
            count, size = len(members), sum(item.file_size for item in members)
        self.reserve(count, size)

    def reserve(self, count: int, size: int) -> None:
        if self.archives + 1 > self.max_archives or self.files + count > self.max_files or self.bytes + size > self.max_bytes:
            raise ValueError("Nested archive session budget exceeded")
        self.archives += 1
        self.files += count
        self.bytes += size


def stage_zip(archive: Path, work: Path, source_id: str, budget: SessionBudget,
              *, depth=0, parent_id=None, results=None, probe_files=None) -> list[dict]:
    results = [] if results is None else results
    probe_files = [] if probe_files is None else probe_files
    row = {"sourceID": source_id, "parentArchiveID": parent_id, "depth": depth,
           "archive": str(archive), "archiveSha256": archive_tools.fingerprint(archive)}
    results.append(row)
    if depth > MAX_ARCHIVE_DEPTH:
        row.update(status="rejected", reason="Nested archive depth limit exceeded")
        return results
    try:
        budget.reserve_archive(archive)
        destination = work_path(work, "staged", f"{source_id}-{row['archiveSha256'][:10]}")
        report_path = work_path(work, "extractions", f"{source_id}-{row['archiveSha256'][:10]}.json")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            if not report_path.is_file():
                raise FileExistsError("Existing staging has no extraction inventory")
            inventory = json.loads(report_path.read_text(encoding="utf-8"))
            archive_tools.verify_stage(inventory, archive, destination)
        else:
            inventory = archive_tools.safe_extract(archive, destination)
            report_path.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
        if inventory["archiveSha256"] != row["archiveSha256"]:
            raise ValueError("Archive changed between inventory and extraction")
        row.update(status="staged", staging=str(destination), fileCount=inventory["fileCount"],
                   expandedBytes=inventory["expandedBytes"], files=inventory["files"])
        for index, member in enumerate(inventory["files"]):
            path = destination / member["path"]
            kind = file_kind(path)
            child_id = f"{source_id}-member-{index+1:04}"
            probe_files.append({"sourceID": child_id, "archiveID": source_id, "path": str(path),
                                "relativePath": member["path"], "sourceBytes": member["size"],
                                "sha256": member["sha256"], "kind": kind})
            if kind == "zip":
                stage_zip(path, work, child_id, budget, depth=depth+1, parent_id=source_id,
                          results=results, probe_files=probe_files)
            elif kind == "7z":
                stage_7z(path, work, child_id, budget, depth=depth+1, parent_id=source_id,
                         results=results, probe_files=probe_files)
            elif kind in ("rar", "gzip"):
                results.append({"sourceID": child_id, "parentArchiveID": source_id, "depth": depth+1,
                                "status": "unsupported-archive", "kind": kind, "archive": str(path),
                                "archiveSha256": member["sha256"], "reason": "ZIP stager does not expand this archive type"})
        archive_tools.verify_stage(inventory, archive, destination)
    except Exception as error:
        row.update(status="rejected", errorType=type(error).__name__, reason=str(error))
    return results


def _process_limits(cpu_seconds: int) -> None:
    # Existing local 7z is optional and is never redistributed. Limit its
    # address space and CPU as well as wall time/output below.
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))


def seven_output(arguments: list[str], maximum: int, *, timeout=35, check=lambda: None):
    executable = shutil.which("7z") or shutil.which("7zz")
    if executable is None:
        raise FileNotFoundError("No existing local 7z/7zz reader is installed")
    command = [executable, *arguments]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL,
                               preexec_fn=partial(_process_limits, timeout - 5) if os.name == "posix" else None)
    total, deadline = 0, time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            check()
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Local archive reader exceeded its time limit")
            for key, _ in selector.select(min(remaining, 0.25)):
                block = os.read(key.fd, 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                total += len(block)
                if total > maximum:
                    raise ValueError("Local archive reader exceeded its output bound")
                yield block
        code = process.wait(timeout=max(0.01, deadline-time.monotonic()))
        if code != 0:
            raise ValueError(f"Local 7z reader exited with status {code}")
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def run_7z(arguments: list[str], maximum: int) -> bytes:
    return b"".join(seven_output(arguments, maximum))


def seven_members(archive: Path) -> list[dict]:
    listing = run_7z(["l", "-t7z", "-slt", "-ba", "-sccUTF-8", "-spd", "-p-", "--", str(archive)], 8*1024*1024).decode("utf-8")
    members, block = [], {}
    for line in [*listing.splitlines(), ""]:
        if not line:
            if block:
                members.append(block)
                block = {}
            continue
        if " = " not in line:
            raise ValueError("Archive member listing is ambiguous or contains control characters")
        key, value = line.split(" = ", 1)
        if key in block:
            raise ValueError("Archive member listing contains duplicate properties")
        block[key] = value
    result, used, files = [], set(), set()
    total, count = 0, 0
    for item in members:
        if "Path" not in item or "Size" not in item:
            raise ValueError("Archive member listing lacks required metadata")
        attributes = item.get("Attributes", "")
        if (item.get("Encrypted") == "+" or item.get("Anti") == "+" or any(item.get(name) not in (None, "", "-") for name in
                ["Symbolic Link", "Hard Link", "Alternate Stream", "Reparse Point"]) or re.search(r"(?:^| )[bclps][rwx-]", attributes)):
            raise ValueError("Archive contains encrypted, linked, or nonordinary entries")
        directory = item.get("Folder") == "+" or attributes.startswith("D") or bool(re.search(r"(?:^| )d[rwx-]", attributes))
        name = item["Path"]
        info = zipfile.ZipInfo(name.rstrip("/")+"/" if directory else name)
        info.external_attr = ((stat.S_IFDIR if directory else stat.S_IFREG) | 0o700) << 16
        info.file_size = int(item["Size"])
        relative = archive_tools.member_path(info)
        if info.file_size < 0:
            raise ValueError("Archive contains an invalid member size")
        key = relative.as_posix().casefold()
        if key in used:
            raise ValueError("Archive member paths collide")
        used.add(key)
        if not directory:
            count += 1
            total += info.file_size
            files.add(key)
        if count > archive_tools.MAX_FILES or info.file_size > archive_tools.MAX_FILE_BYTES or total > archive_tools.MAX_TOTAL_BYTES:
            raise ValueError("Archive exceeds creator file/count/expanded-byte limits")
        crc = item.get("CRC", "")
        if crc and not re.fullmatch(r"[0-9a-fA-F]{8}", crc):
            raise ValueError("Archive contains an invalid member CRC")
        result.append({"relative": relative, "directory": directory, "size": info.file_size,
                       "crc": int(crc, 16) if crc else None})
    if not count:
        raise ValueError("Archive contains no files")
    for member in result:
        if any(parent.as_posix().casefold() in files for parent in member["relative"].parents if parent != Path(".")):
            raise ValueError("Archive has a file/directory collision")
    return result


def extract_seven_members(archive: Path, destination: Path, members: list[dict], *, check=lambda: None) -> None:
    """Stream 7z members in archive order into paths already validated by seven_members."""
    maximum = sum(member["size"] for member in members if not member["directory"])
    arguments = ["x", "-t7z", "-so", "-spd", "-mmt=1", "-y", "-p-", "--", str(archive)]
    # A single decode avoids repeatedly expanding the prefix of a solid block.
    with closing(seven_output(arguments, maximum, timeout=1805, check=check)) as blocks:
        block = b""
        for member in members:
            check()
            target = destination / member["relative"]
            if member["directory"]:
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            remaining = member["size"]
            crc = 0
            with target.open("xb") as output:
                while remaining:
                    if not block:
                        block = next(blocks, b"")
                        if not block:
                            raise ValueError("7z output ended before the declared member size")
                    data, block = block[:remaining], block[remaining:]
                    output.write(data)
                    crc = zlib.crc32(data, crc)
                    remaining -= len(data)
            if member["crc"] is not None and crc != member["crc"]:
                raise ValueError("Expanded 7z member CRC differs from the archive listing")
        if block or next(blocks, None) is not None:
            raise ValueError("7z output exceeds the declared member sizes")


def stage_7z(archive: Path, work: Path, source_id: str, budget: SessionBudget,
             *, depth=0, parent_id=None, results=None, probe_files=None) -> list[dict]:
    results = [] if results is None else results
    probe_files = [] if probe_files is None else probe_files
    before = archive_tools.fingerprint(archive)
    row = {"sourceID": source_id, "parentArchiveID": parent_id, "depth": depth, "kind": "7z",
           "archive": str(archive), "archiveSha256": before}
    results.append(row)
    temporary = None
    try:
        if depth > MAX_ARCHIVE_DEPTH:
            raise ValueError("Nested archive depth limit exceeded")
        members = seven_members(archive)
        budget.reserve(sum(not member["directory"] for member in members), sum(member["size"] for member in members))
        destination = work_path(work, "staged", f"{source_id}-{before[:10]}")
        report_path = work_path(work, "extractions", f"{source_id}-{before[:10]}.json")
        destination.parent.mkdir(parents=True, exist_ok=True)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if not report_path.is_file():
                raise FileExistsError("Existing staging has no extraction inventory")
            inventory = json.loads(report_path.read_text(encoding="utf-8"))
            archive_tools.verify_stage(inventory, archive, destination)
        else:
            temporary = Path(tempfile.mkdtemp(prefix=".sample-7z-", dir=destination.parent))
            extract_seven_members(archive, temporary, members)
            files = []
            for member in members:
                if member["directory"]:
                    continue
                target = temporary / member["relative"]
                files.append({"path": member["relative"].as_posix(), "size": member["size"], "sha256": archive_tools.fingerprint(target)})
            if archive_tools.fingerprint(archive) != before:
                raise ValueError("Original archive changed during staging")
            temporary.rename(destination)
            temporary = None
            inventory = {"archive": str(archive), "archiveSha256": before, "files": files, "fileCount": len(files),
                         "expandedBytes": sum(item["size"] for item in files), "staging": str(destination)}
            report_path.write_text(json.dumps(inventory, indent=2)+"\n", encoding="utf-8")
        row.update(status="staged", staging=str(destination), fileCount=inventory["fileCount"],
                   expandedBytes=inventory["expandedBytes"], files=inventory["files"])
        for index, member in enumerate(inventory["files"]):
            path = destination / member["path"]
            kind = file_kind(path)
            child_id = f"{source_id}-member-{index+1:04}"
            probe_files.append({"sourceID": child_id, "archiveID": source_id, "path": str(path),
                                "relativePath": member["path"], "sourceBytes": member["size"], "sha256": member["sha256"], "kind": kind})
            if kind == "zip":
                stage_zip(path, work, child_id, budget, depth=depth+1, parent_id=source_id, results=results, probe_files=probe_files)
            elif kind == "7z":
                stage_7z(path, work, child_id, budget, depth=depth+1, parent_id=source_id, results=results, probe_files=probe_files)
            elif kind in ("rar", "gzip"):
                results.append({"sourceID": child_id, "parentArchiveID": source_id, "status": "unsupported-archive", "kind": kind,
                                "archive": str(path), "archiveSha256": member["sha256"], "reason": "No guarded stager is implemented for this archive type"})
        archive_tools.verify_stage(inventory, archive, destination)
    except Exception as error:
        row.update(status="rejected", errorType=type(error).__name__, reason=str(error))
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)
    return results


def stage_loose(source: Path, work: Path, row: dict) -> dict:
    if row["size"] > MAX_LOOSE_BYTES:
        return {"sourceID": row["sourceID"], "status": "not-staged", "reason": "Loose sample exceeds 128 MiB staging limit"}
    destination = work_path(work, "staged", f"{row['sourceID']}-{row['sha256'][:10]}")
    target = destination / source.name
    if destination.is_symlink() or target.is_symlink():
        raise ValueError("Staging paths must not be symlinks")
    destination.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if not target.is_file() or archive_tools.fingerprint(target) != row["sha256"]:
            raise ValueError("Existing loose staging differs; no overwrite allowed")
    else:
        temporary = None
        try:
            with source.open("rb") as input_file, tempfile.NamedTemporaryFile(prefix=".copy-", dir=destination, delete=False) as output_file:
                temporary = Path(output_file.name)
                shutil.copyfileobj(input_file, output_file, 1024*1024)
            if temporary.stat().st_size != row["size"] or archive_tools.fingerprint(temporary) != row["sha256"]:
                raise ValueError("Loose source changed during copy")
            os.link(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"sourceID": row["sourceID"], "status": "staged", "staging": str(destination), "file": str(target),
            "creatorSingleFileLimitExceeded": row["size"] > archive_tools.MAX_FILE_BYTES}


JAVA_PROBE = r'''import com.google.gson.*;
import java.nio.file.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
public class SampleMetadataProbe {
 public static void main(String[] args)throws Exception {
  JsonArray result=new JsonArray();
  for(JsonElement value:JsonParser.parseString(Files.readString(Path.of(args[0]))).getAsJsonArray()) {
   JsonObject row=value.getAsJsonObject().deepCopy();Path path=Path.of(row.get("path").getAsString());
   try(var input=DicomInputStream.createWithLimitFromFileLength(path.toFile())) {
    input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);input.setAllocateLimit(1024*1024);
    var meta=input.readFileMetaInformation();var data=input.readDatasetUntilPixelData();
    row.addProperty("metadataStatus","readable");row.addProperty("part10",meta!=null);
    String sop=data.getString(Tag.SOPClassUID,meta==null?null:meta.getString(Tag.MediaStorageSOPClassUID));
    row.addProperty("sopClassUID",sop);row.addProperty("sopClassName",sop==null?null:UID.nameOf(sop));
    row.addProperty("transferSyntaxUID",input.getTransferSyntax());row.addProperty("modality",data.getString(Tag.Modality));
    row.addProperty("rows",data.getInt(Tag.Rows,0));row.addProperty("columns",data.getInt(Tag.Columns,0));
    row.addProperty("frames",data.getInt(Tag.NumberOfFrames,1));row.addProperty("bitsAllocated",data.getInt(Tag.BitsAllocated,0));
    row.addProperty("bitsStored",data.getInt(Tag.BitsStored,0));row.addProperty("pixelRepresentation",data.getInt(Tag.PixelRepresentation,0));
    row.addProperty("photometricInterpretation",data.getString(Tag.PhotometricInterpretation));
   }catch(Exception error){row.addProperty("metadataStatus","unreadable");row.addProperty("errorType",error.getClass().getSimpleName());}
   result.add(row);
  }
  Files.writeString(Path.of(args[1]),new GsonBuilder().serializeNulls().setPrettyPrinting().create().toJson(result)+"\n");
 }
}
'''


def probe_metadata(probes: list[dict], work: Path, jar: Path) -> list[dict]:
    files = [row for row in probes if row["kind"] not in ("zip", "7z", "rar", "gzip")]
    source = work_path(work, "SampleMetadataProbe.java")
    source.write_text(JAVA_PROBE, encoding="utf-8")
    inputs, output = work_path(work, "probe-inputs.json"), work_path(work, "metadata-probe.json")
    inputs.write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")
    with work_path(work, "probe-process.txt").open("wb") as log:
        subprocess.run(["javac", "-cp", str(jar), "-d", str(work), str(source)], stdout=log, stderr=log, check=True, timeout=60)
        subprocess.run(["java", "-Dorg.slf4j.simpleLogger.defaultLogLevel=off", "-cp", str(work)+os.pathsep+str(jar),
                        "SampleMetadataProbe", str(inputs), str(output)], stdout=log, stderr=log, check=True, timeout=120)
    return json.loads(output.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("in"))
    parser.add_argument("--work", type=Path, default=Path("target/additional-samples"))
    parser.add_argument("--jar", type=Path, default=Path("dist/dicom-pdf-0.49.0.jar"))
    parser.add_argument("--include-existing", action="store_true", help="Also stage samples mentioned in previous conversion reports")
    parser.add_argument("--no-probe", action="store_true", help="Skip the optional Java metadata-only compatibility scan")
    args = parser.parse_args()
    root = args.input.resolve(strict=True)
    allowed = Path(__file__).resolve().parents[1] / "target/additional-samples"
    work = args.work.resolve()
    if work != allowed and allowed not in work.parents:
        raise ValueError("Inventory artifacts must remain under target/additional-samples")
    if root == work or root in work.parents:
        raise ValueError("Work directory must be outside supplied inputs")
    work.mkdir(parents=True, exist_ok=True)
    before = input_inventory(root)
    known_hashes, known_paths = prior_inputs(root, [Path("target/series-checks/summary.json"), Path("target/real-world-checks/summary.json")])
    probes, archives, loose = [], [], []
    budget = SessionBudget()
    for row in before:
        if row["status"] != "inventoried":
            continue
        row["priorConversionEvidence"] = "hash-match" if row["sha256"] in known_hashes else "path-reported" if row["sourcePath"] in known_paths else "not-reported"
        row["additionalSample"] = row["priorConversionEvidence"] == "not-reported"
        path = root / row["sourcePath"]
        selected = args.include_existing or row["additionalSample"]
        if row["kind"] == "zip":
            if selected:
                stage_zip(path, work, row["sourceID"], budget, results=archives, probe_files=probes)
        elif row["kind"] == "7z":
            if selected:
                stage_7z(path, work, row["sourceID"], budget, results=archives, probe_files=probes)
        elif row["kind"] in ("rar", "gzip"):
            archives.append({"sourceID": row["sourceID"], "status": "unsupported-archive", "kind": row["kind"],
                             "archive": str(path), "archiveSha256": row["sha256"], "reason": "ZIP stager does not expand this archive type"})
        else:
            probes.append({"sourceID": row["sourceID"], "path": str(path), "relativePath": row["sourcePath"],
                           "sourceBytes": row["size"], "sha256": row["sha256"], "kind": row["kind"]})
            if selected:
                try:
                    loose.append(stage_loose(path, work, row))
                except Exception as error:
                    loose.append({"sourceID": row["sourceID"], "status": "rejected", "errorType": type(error).__name__, "reason": str(error)})
    metadata, probe_error = [], None
    if not args.no_probe:
        try:
            metadata = probe_metadata(probes, work, args.jar)
        except Exception as error:
            probe_error = {"errorType": type(error).__name__, "reason": "Metadata probe failed; see private local probe-process.txt"}
    after = input_inventory(root)
    snapshot = lambda rows: {(row["sourcePath"], row["kind"], row["size"], row["sha256"]) for row in rows}
    unchanged = snapshot(before) == snapshot(after)
    report = {"schemaVersion": 1, "input": str(root), "sourceFiles": before, "sourceFilesAfter": after,
              "archives": archives, "looseStaging": loose,
              "metadata": metadata, "metadataProbeError": probe_error, "inputsUnchanged": unchanged,
              "limits": {"archiveDepth": MAX_ARCHIVE_DEPTH, "archives": MAX_ARCHIVES, "sessionFiles": MAX_SESSION_FILES,
                         "sessionExpandedBytes": MAX_SESSION_BYTES, "looseStagingBytes": MAX_LOOSE_BYTES},
              "deidentification": "Not assessed; supplied files are never transformed or certified de-identified"}
    work_path(work, "inventory.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {"inputFiles": len(before), "additionalInputs": sum(row.get("additionalSample", False) for row in before),
               "sourceBytes": sum(row["size"] or 0 for row in before), "inputsUnchanged": unchanged,
               "archiveStatuses": dict(Counter(row["status"] for row in archives)), "looseStatuses": dict(Counter(row["status"] for row in loose)),
               "metadataStatuses": dict(Counter(row["metadataStatus"] for row in metadata)), "metadataProbeFailed": probe_error is not None}
    work_path(work, "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0 if unchanged and probe_error is None else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as failure:
        # Do not expose a file-derived exception/path in console output.
        print(json.dumps({"status": "failed", "errorType": type(failure).__name__}))
        raise SystemExit(1)
