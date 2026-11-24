#!/usr/bin/env python3
"""Safely stage ZIP series and convert each complete archive into one preservation PDF.

Only converted PDFs are written to out/. Staging, logs, recovered files and
reports stay under target/. Original ZIP files are never edited.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile

MAX_FILES = 10000
# Staging and conversion use streams; reserve disk for capture and final output.
_staging_headroom = shutil.disk_usage(Path(__file__).resolve().parents[1]).free // 4
MAX_FILE_BYTES = _staging_headroom
MAX_TOTAL_BYTES = _staging_headroom


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def member_path(info: zipfile.ZipInfo) -> Path:
    original = info.orig_filename
    name = info.filename
    if "\x00" in original or "\\" in name or ":" in name or name.startswith("/"):
        raise ValueError(f"Unsafe ZIP member path: {name!r}")
    normalized = name[:-1] if info.is_dir() else name
    parts = normalized.split("/")
    if not normalized or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Unsafe ZIP member path: {name!r}")
    kind = stat.S_IFMT(info.external_attr >> 16)
    if (kind not in (0, stat.S_IFREG, stat.S_IFDIR)
            or kind == stat.S_IFDIR and not info.is_dir()
            or info.is_dir() and (kind == stat.S_IFREG or info.file_size != 0)):
        raise ValueError(f"ZIP member is not an ordinary file/directory: {name!r}")
    if info.flag_bits & 1:
        raise ValueError(f"Encrypted ZIP member is unsupported: {name!r}")
    return Path(*parts)


def safe_extract(archive: Path, destination: Path, *, reserve=lambda _: None, check=lambda: None) -> dict:
    """Preflight all members and stage a new directory; no existing path is overwritten."""
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Staging directory already exists: {destination}")
    before = fingerprint(archive)
    destination.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".series-stage-", dir=destination.parent))
    published = False
    try:
        with zipfile.ZipFile(archive) as source:
            members = []
            used = set()
            total = 0
            count = 0
            for info in source.infolist():
                check()
                relative = member_path(info)
                portable_key = relative.as_posix().casefold()
                if portable_key in used:
                    raise ValueError(f"Duplicate ZIP member path: {info.filename!r}")
                used.add(portable_key)
                members.append((info, relative))
                if info.is_dir():
                    continue
                count += 1
                total += info.file_size
                if count > MAX_FILES or info.file_size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
                    raise ValueError("Archive exceeds staging entry or available-disk budget")
            if not count:
                raise ValueError("Archive contains no files")
            reserve(info.file_size for info, _ in members if not info.is_dir())
            # Prevent a directory entry from colliding with any file or its descendants.
            file_names = {relative.as_posix().casefold() for info, relative in members if not info.is_dir()}
            for _, relative in members:
                for parent in relative.parents:
                    if parent == Path("."):
                        break
                    if parent.as_posix().casefold() in file_names:
                        raise ValueError(f"File/directory collision in ZIP: {relative}")
            inventory = []
            actual_total = 0
            for info, relative in members:
                check()
                target = staged / relative
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                actual = 0
                with source.open(info) as input_file, target.open("xb") as output_file:
                    for block in iter(lambda: input_file.read(1024 * 1024), b""):
                        check()
                        actual += len(block)
                        actual_total += len(block)
                        if actual > MAX_FILE_BYTES or actual_total > MAX_TOTAL_BYTES:
                            raise ValueError("Expanded ZIP bytes exceed the available-disk budget")
                        digest.update(block)
                        output_file.write(block)
                if actual != info.file_size:
                    raise ValueError(f"Expanded ZIP size differs from directory: {relative}")
                inventory.append({"path": relative.as_posix(), "size": actual, "sha256": digest.hexdigest()})
        after = fingerprint(archive)
        if before != after:
            raise ValueError("Original ZIP changed during extraction")
        staged.rename(destination)
        published = True
        return {"archive": str(archive), "archiveSha256": before, "files": inventory,
                "fileCount": count, "expandedBytes": actual_total, "staging": str(destination)}
    finally:
        if not published:
            shutil.rmtree(staged)


def verify_stage(inventory: dict, archive: Path, stage: Path) -> None:
    if fingerprint(archive) != inventory["archiveSha256"]:
        raise ValueError("Original ZIP differs from staging fingerprint")
    expected = {item["path"]: item for item in inventory["files"]}
    actual = set()
    for path in stage.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symlink in staging: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(stage).as_posix()
        actual.add(relative)
        if relative not in expected or path.stat().st_size != expected[relative]["size"] or fingerprint(path) != expected[relative]["sha256"]:
            raise ValueError(f"Staged bytes differ: {relative}")
    if actual != set(expected):
        raise ValueError("Staged file inventory differs from original ZIP")


def command(arguments: list[str], report: Path, name: str, accepted=(0,)) -> tuple[int, float]:
    start = time.monotonic()
    with (report / f"{name}-stdout.txt").open("wb") as output, (report / f"{name}-stderr.txt").open("wb") as error:
        result = subprocess.run(arguments, stdout=output, stderr=error)
    elapsed = time.monotonic() - start
    if result.returncode not in accepted:
        raise RuntimeError(f"{name} failed with exit {result.returncode}; see {report}")
    return result.returncode, elapsed


def convert_archive(archive: Path, args) -> dict:
    start = time.monotonic()
    stage = args.staging / archive.stem
    report = args.reports / archive.stem
    report.mkdir(parents=True, exist_ok=True)
    inventory_file = report / "extraction.json"
    if stage.exists():
        if not args.reuse_staging or not inventory_file.is_file():
            raise FileExistsError(f"Staging exists; use --reuse-staging to verify and reuse: {stage}")
        inventory = json.loads(inventory_file.read_text(encoding="utf-8"))
        verify_stage(inventory, archive, stage)
    else:
        inventory = safe_extract(archive, stage)
        inventory_file.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    if args.stage_only:
        print(f"{archive.name}: staged {inventory['fileCount']} files, {inventory['expandedBytes']} bytes; original ZIP unchanged", flush=True)
        return inventory
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / (archive.stem + ".pdf")
    base = ["java", "-Djava.awt.headless=true", "-jar", str(args.jar)]
    _, conversion_seconds = command(base + ["create", "--input", str(stage), "--output", str(output)], report, "create")
    exit_code, verification_seconds = command(base + ["verify", "--input", str(output), "--sources", str(stage),
        "--verapdf", args.verapdf, "--output", str(report / "verification.json")], report, "verify", (0, 2))
    checks = json.loads((report / "verification.json").read_text(encoding="utf-8"))
    for category in ["pdfa4f", "sourceBytes", "externalSources", "metadataAccuracy"]:
        if checks[category]["status"] != "PASS":
            raise RuntimeError(f"{category} did not pass for {archive.name}")
    recovery = args.recovery / archive.stem
    suffix = 1
    while recovery.exists() or recovery.is_symlink():
        suffix += 1
        recovery = args.recovery / f"{archive.stem}-{suffix}"
    _, recovery_seconds = command(base + ["extract", "--input", str(output), "--output", str(recovery)], report, "extract")
    for item in inventory["files"]:
        relative = Path(item["path"])
        original = stage / relative
        restored = recovery / "originals" / relative
        # Direct comparisons are independent of the PDF's own hash inventory.
        if original.read_bytes() != restored.read_bytes() or fingerprint(restored) != item["sha256"]:
            raise RuntimeError(f"Recovered bytes differ from extracted ZIP input: {relative}")
    verify_stage(inventory, archive, stage)
    manifest = json.loads((recovery / "package/manifest.json").read_text(encoding="utf-8"))
    if len(manifest["images"]) != inventory["fileCount"]:
        raise RuntimeError("Converted package did not inventory every archive file")
    result = {"archive": archive.name, "archiveSha256": inventory["archiveSha256"], "archiveUnchanged": True,
        "output": str(output), "outputBytes": output.stat().st_size,
        "supplied": inventory["fileCount"], "embedded": len(manifest["images"]),
        "displayed": sum(image["status"] == "rendered" for image in manifest["images"]),
        "rejectedForDisplay": sum(image["status"] != "rendered" for image in manifest["images"]),
        "expandedBytes": inventory["expandedBytes"], "recoveredByteIdentically": True,
        "verification": {key: value["status"] for key, value in checks.items()}, "verificationExitCode": exit_code,
        "unresolvedReferenceCount": sum(ref["status"] != "resolved" for ref in manifest["references"]),
        "recovery": str(recovery), "conversionSeconds": round(conversion_seconds, 3),
        "verificationSeconds": round(verification_seconds, 3), "recoverySeconds": round(recovery_seconds, 3),
        "totalSeconds": round(time.monotonic() - start, 3)}
    (report / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"{archive.name}: {result['supplied']} supplied/embedded, {result['displayed']} displayed, "
          f"{result['rejectedForDisplay']} display diagnostics, {result['outputBytes']} PDF bytes; "
          f"PDF/A/bytes/metadata PASS, references {checks['unresolvedReferences']['status']}; "
          f"{result['totalSeconds']} seconds", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--jar", type=Path, default=Path("dist/dicom-pdf-0.54.0.jar"))
    parser.add_argument("--verapdf", default=os.environ.get("VERAPDF", "verapdf"))
    parser.add_argument("--staging", type=Path, default=Path("target/series-inputs"))
    parser.add_argument("--output", type=Path, default=Path("out"))
    parser.add_argument("--reports", type=Path, default=Path("target/series-checks"))
    parser.add_argument("--recovery", type=Path, default=Path("target/series-recovery"))
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--reuse-staging", action="store_true")
    args = parser.parse_args()
    args.reports.mkdir(parents=True, exist_ok=True)
    results = [convert_archive(archive, args) for archive in args.archives]
    (args.reports / ("staging-summary.json" if args.stage_only else "summary.json")).write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
