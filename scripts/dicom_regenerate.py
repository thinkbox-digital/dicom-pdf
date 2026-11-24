#!/usr/bin/env python3
"""Regenerate DICOM PDFs from in/ and from the modality example archives.

By default, convert only entries in in/ that have no matching PDF in out/.
Default paths are repository-relative, including when launched from scripts/.
Supplied inputs stay unchanged. Only finished PDFs are published to out/ or
examples/. Temporary inputs, logs and reports stay under target/dicom-regenerate/.
"""
from __future__ import annotations

import argparse
import bz2
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime, timezone
import gzip
import hashlib
import json
import lzma
import multiprocessing
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

import convert_archives as archives
import sample_inventory as samples

PROJECT = Path(__file__).resolve().parents[1]
REPORTS = Path("target/dicom-regenerate")
ARCHIVAL_MASTER = "archival-master"
SOURCE_ROLES = (ARCHIVAL_MASTER, "deidentified-copy")
ARCHIVE_KINDS = {"zip", "7z", "gzip", "bzip2", "xz"}
MAX_DEPTH = 8
MAX_FILES = 100000
MAX_BYTES = min(8 * 1024**3, archives.MAX_TOTAL_BYTES)
MIB = 1024**2
JAVA_HEAP_MIB = 4096
JVM_OVERHEAD_MIB = 512
JVM_MEMORY_MIB = JAVA_HEAP_MIB + JVM_OVERHEAD_MIB
worker_cancelled = None


def cgroup_limits():
    """Read the Linux cgroup v2 limits inherited by this process."""
    root = Path("/sys/fs/cgroup")
    try:
        groups = Path("/proc/self/cgroup").read_text().splitlines()
    except OSError:
        return
    group = next((line[3:] for line in groups if line.startswith("0::/")), None)
    if group is None:
        return
    path = root / group.lstrip("/")
    for directory in (path, *path.parents):
        if not directory.is_relative_to(root):
            break
        yield directory


def available_resources():
    try:
        affinity = sorted(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        affinity = []
    processors = len(affinity) or os.cpu_count() or 1
    try:
        available = next(int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()
                         if line.startswith("MemAvailable:"))
    except (OSError, StopIteration):
        try:
            available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        except (AttributeError, OSError, ValueError):
            available = 0
        if available <= 0:
            available = (JVM_MEMORY_MIB + 512) * MIB  # Budget one JVM if memory cannot be detected.

    for directory in cgroup_limits():
        try:
            quota, period = (directory / "cpu.max").read_text().split()
            if quota != "max":
                processors = min(processors, int(quota) // int(period))
        except (OSError, ValueError):
            pass
        try:
            limit = (directory / "memory.max").read_text().strip()
            if limit != "max":
                remaining = int(limit) - int((directory / "memory.current").read_text())
                available = min(available, remaining)
        except (OSError, ValueError):
            pass

    available_mib = max(0, available // MIB)
    os_reserve_mib = min(max(512, available_mib // 10), available_mib // 4)
    return max(1, processors - 1), affinity[:-1], available_mib - os_reserve_mib


def configure_worker(cancelled, affinity):
    global worker_cancelled
    worker_cancelled = cancelled
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if affinity:
        try:
            os.sched_setaffinity(0, affinity)
        except OSError:
            pass  # The CPU budget still applies through the JVM processor count.


def check_cancelled():
    if worker_cancelled is not None and worker_cancelled.value:
        raise RuntimeError("Regeneration cancelled")


def file_kind(path: Path) -> str:
    with path.open("rb") as source:
        header = source.read(132)
    # DICOM images can contain an embedded ZIP payload.
    if header[128:132] == b"DICM":
        return "dicom"
    if zipfile.is_zipfile(path):
        return "zip"
    for signature, kind in ((b"7z\xbc\xaf\x27\x1c", "7z"), (b"\x1f\x8b", "gzip"),
                            (b"BZh", "bzip2"), (b"\xfd7zXZ\0", "xz"), (b"Rar!", "rar")):
        if header.startswith(signature):
            return kind
    return "file"


class Budget:
    def __init__(self):
        self.files = self.bytes = 0

    def reserve(self, sizes):
        check_cancelled()
        sizes = list(sizes)
        self.files += len(sizes)
        self.bytes += sum(sizes)
        if (any(size < 0 or size > archives.MAX_FILE_BYTES for size in sizes)
                or self.files > MAX_FILES or self.bytes > MAX_BYTES):
            raise ValueError("Input expansion exceeds file/count/available-disk limits")


def copy_input(source: Path, destination: Path, size: int) -> str:
    def open_source(path, flags):
        fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("Source is not a regular file")
            return fd
        except BaseException:
            os.close(fd)
            raise

    digest = hashlib.sha256()
    copied = 0
    with open(source, 'rb', opener=open_source) as original, destination.open('xb') as output:
        for block in iter(lambda: original.read(1024 * 1024), b''):
            check_cancelled()
            copied += len(block)
            if copied > size:
                raise ValueError("Source grew during staging")
            digest.update(block)
            output.write(block)
    if copied != size:
        raise ValueError("Source size changed during staging")
    return digest.hexdigest()


def source_inventory(source: Path, *, stage: Path | None = None, budget: Budget | None = None) -> list[dict]:
    folder = source.is_dir() and not source.is_symlink()
    paths = sorted(source.rglob("*")) if folder else [source]
    result = []
    if stage is not None:
        stage.mkdir()
    for path in paths:
        check_cancelled()
        info = path.lstat()
        relative = path.relative_to(source) if folder else Path(path.name)
        if stat.S_ISDIR(info.st_mode):
            if stage is not None:
                (stage / relative).mkdir()
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Source contains a symbolic link or special file")
        if stage is None:
            sha256 = archives.fingerprint(path)
        else:
            budget.reserve([info.st_size])
            sha256 = copy_input(path, stage / relative, info.st_size)
        result.append({"path": relative.as_posix(), "size": info.st_size, "sha256": sha256})
    if not result:
        raise ValueError("Input contains no ordinary files")
    return result


def unpack(source: Path, destination: Path, kind: str, budget: Budget) -> dict | None:
    if destination.exists() or destination.is_symlink():
        raise ValueError("Archive expansion path collides with an existing input")
    if kind == "zip":
        return archives.safe_extract(source, destination, reserve=budget.reserve, check=check_cancelled)
    elif kind == "7z":
        members = samples.seven_members(source)
        budget.reserve(item["size"] for item in members if not item["directory"])
        destination.mkdir(parents=True)
        samples.extract_seven_members(source, destination, members, check=check_cancelled)
    else:
        opener = {"gzip": gzip.open, "bzip2": bz2.open, "xz": lzma.open}[kind]
        destination.mkdir(parents=True)
        name = source.stem if source.suffix.lower() in {".gz", ".bz2", ".xz"} else source.name + ".expanded"
        size = 0
        with opener(source, "rb") as input_file, (destination / name).open("xb") as output:
            for block in iter(lambda: input_file.read(1024 * 1024), b""):
                check_cancelled()
                size += len(block)
                if size > archives.MAX_FILE_BYTES or budget.bytes + size > MAX_BYTES:
                    raise ValueError("Compressed stream exceeds expansion limits")
                output.write(block)
        budget.reserve([size])
    return None


def expand_nested(stage: Path, budget: Budget, depth=0) -> None:
    for path in sorted(stage.rglob("*")):
        if not path.is_file():
            continue
        kind = file_kind(path)
        if kind == "rar":
            raise ValueError("RAR inputs are unsupported; unpack them separately first")
        if kind in ARCHIVE_KINDS:
            if depth >= MAX_DEPTH:
                raise ValueError("Nested archive depth limit exceeded")
            destination = path.with_name(path.name + ".contents")
            unpack(path, destination, kind, budget)
            # The original nested archive is retained alongside its expanded
            # contents, so the PDF preserves the compressed supplied bytes too.
            expand_nested(destination, budget, depth + 1)


def stage_input(source: Path, stage: Path) -> tuple[dict | None, list[dict]]:
    budget = Budget()
    receipt = None
    info = source.lstat()
    if stat.S_ISDIR(info.st_mode):
        expected = source_inventory(source, stage=stage, budget=budget)
    elif not stat.S_ISREG(info.st_mode):
        raise ValueError("Source contains a symbolic link or special file")
    else:
        kind = file_kind(source)
        if kind == "rar":
            raise ValueError("RAR inputs are unsupported; unpack them separately first")
        if kind == "zip":
            inventory = unpack(source, stage / "contents", kind, budget)
            expected = [{"path": source.name, "size": info.st_size, "sha256": inventory["archiveSha256"]}]
            receipt = {"schemaVersion": 1, "kind": "ZIP_IMPORT", "basis": "LOCAL_CONTAINER_EXTRACTION",
                       "sourceName": source.name, "sourceBytes": info.st_size,
                       "sourceSha256": inventory["archiveSha256"], "containerEmbedded": False,
                       "memberRoot": "contents/", "memberCount": inventory["fileCount"]}
        elif kind in ARCHIVE_KINDS:
            expected = source_inventory(source)
            unpack(source, stage, kind, budget)
        else:
            expected = source_inventory(source, stage=stage, budget=budget)
    expand_nested(stage, budget)
    if receipt and budget.files != receipt["memberCount"]:
        # For nested expansion keep the outer ZIP and its original membership.
        budget.reserve([expected[0]["size"]])
        container_directory = stage / "containers"
        container_directory.mkdir()
        copied = copy_input(source, container_directory / source.name, expected[0]["size"])
        if copied != expected[0]["sha256"]:
            raise ValueError("Original ZIP changed during staging")
        receipt = None
    if source_inventory(source) != expected:
        raise ValueError("Original input changed during staging")
    return receipt, expected


def select_inputs(root: Path, sample: str | None, *, allow_empty=False, allow_missing=False) -> list[Path]:
    if allow_missing and not root.exists() and not root.is_symlink():
        return []
    if root.is_symlink() or not root.is_dir():
        raise ValueError("--input must be an ordinary directory")
    candidates = sorted(root.iterdir())
    if sample is not None:
        if sample:
            path = Path(sample)
            if not path.is_absolute():
                path = root / path
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError("Selected entry must be inside its input directory")
            candidates = [path]
        else:
            loose = [path for path in candidates if not path.is_symlink() and path.is_file()
                     and (file_kind(path) == "dicom" or path.suffix.lower() in {".dcm", ".dicom"})]
            candidates = (loose or candidates)[:1]
    if not candidates and not allow_empty:
        raise ValueError("No input entries found")
    for path in candidates:
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Input entry is missing, linked or not an ordinary file/directory")
        if any(parent.is_symlink() for parent in path.parents if parent != root.parent):
            raise ValueError("Input path contains a symbolic link")
    return candidates


def select_examples(root: Path, name: str | None, *, allow_empty=False) -> list[Path]:
    if allow_empty and not root.exists() and not root.is_symlink():
        return []
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Example root must be an ordinary directory")
    selection = select_inputs(root, name)[0] if name else root
    candidates = sorted(selection.rglob("*")) if selection.is_dir() else [selection]
    pdfs = [path for path in candidates if path.suffix.lower() == ".pdf"
            and (path.is_symlink() or not path.is_dir())]
    if not pdfs and not allow_empty:
        raise ValueError("No example PDFs found")
    if any(path.is_symlink() or not path.is_file() for path in pdfs):
        raise ValueError("Example PDF is linked or is not an ordinary file")
    return pdfs


def signing_files(config: Path) -> set[tuple[int, str]]:
    if not config.is_file():
        raise ValueError("PAdES is on. Supply a PADES_B_LTA policy with --security-config, "
                         "set DICOM_REGENERATE_SECURITY_CONFIG, or use --pades off.")
    with config.open("rb") as stream:
        data = stream.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("PAdES security configuration exceeds 1 MiB")
    policy = json.loads(data)
    if not isinstance(policy, dict) or policy.get("protection") != "PADES_B_LTA":
        raise ValueError("PAdES security configuration must set protection to PADES_B_LTA")
    protected = set()
    for key in ("pkcs12", "passphraseFile"):
        value = policy.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"PAdES security configuration requires {key}")
        path = config.parent / value
        if not path.is_file():
            raise ValueError(f"PAdES security configuration references a missing {key} file")
        size = path.stat().st_size
        if size:
            protected.add((size, archives.fingerprint(path)))
    return protected


def run_java(args, report: Path, processors: int, operation: str,
             source: Path, output: Path, *options: str) -> None:
    check_cancelled()
    command = [args.java, "-Xms64m", f"-Xmx{JAVA_HEAP_MIB}m", f"-XX:ActiveProcessorCount={processors}",
               f"-Ddicompdf.workers={processors}", f"-Djava.io.tmpdir={output.parent}",
               "-Djava.awt.headless=true", "-jar", str(args.jar),
               operation, "--input", str(source), "--output", str(output), *options]
    with (report / f"{operation}-stdout.txt").open("wb") as stdout, (report / f"{operation}-stderr.txt").open("wb") as stderr:
        with subprocess.Popen(command, cwd=args.project, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                              start_new_session=True) as process:
            deadline = time.monotonic() + args.timeout
            try:
                while True:
                    check_cancelled()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(command, args.timeout)
                    try:
                        process.wait(timeout=min(0.25, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
    if process.returncode != 0:
        raise RuntimeError(f"Java {operation} exited with status {process.returncode}. See {operation}-stderr.txt.")


def has_pdf_output(path: Path) -> bool:
    return not path.is_symlink() and path.is_file()


def publish_pdf(pending: Path, output: Path, *, new_only: bool) -> str:
    if not new_only:
        os.replace(pending, output)
        return "created"
    # A second regeneration run may have published this PDF after selection.
    try:
        os.link(pending, output)
    except FileExistsError:
        if not has_pdf_output(output):
            raise
        return "skipped"
    return "created"


def run_job(source: Path, output: Path, report: Path, args, processors: int, *, example: bool) -> dict:
    result = {"input": str(source), "output": str(output), "status": "failed",
              "processors": processors, "javaHeapMiB": JAVA_HEAP_MIB}
    report.mkdir()
    try:
        output_root = args.example_output if example else args.output
        if (not output.parent.resolve().is_relative_to(output_root) or output.is_symlink()
                or (output.exists() and not output.is_file())):
            raise ValueError("PDF output must be an ordinary file inside the output directory")
        with tempfile.TemporaryDirectory(prefix="staging-", dir=report) as temporary:
            work = Path(temporary)
            source_role = args.source_role
            stage = work / "input"
            receipt_path = work / "import-source.json"
            if example:
                expected = source_inventory(source)
                if any((item["size"], item["sha256"]) in args.protected_files for item in expected):
                    raise ValueError("Signing credentials and passphrases must be outside archival inputs")
                recovered = work / "recovered"
                run_java(args, report, processors, "extract", source, recovered)
                stage = recovered / "originals"
                manifest = json.loads((recovered / "package/manifest.json").read_text(encoding="utf-8"))
                if source_role is None:
                    if manifest.get("sourceRole") in SOURCE_ROLES:
                        source_role = manifest["sourceRole"]
                previous_receipt = recovered / "package/import-source.json"
                expected_receipt = (manifest.get("artifactSha256") or {}).get(previous_receipt.name)
                if previous_receipt.exists() or expected_receipt:
                    if (not previous_receipt.is_file() or previous_receipt.stat().st_size > 64 * 1024
                            or archives.fingerprint(previous_receipt) != expected_receipt):
                        raise ValueError("The previous archive's ZIP import receipt does not match its manifest")
                    receipt_path = previous_receipt
            else:
                receipt, expected = stage_input(source, stage)
                if any((item["size"], item["sha256"]) in args.protected_files for item in expected):
                    raise ValueError("Signing credentials and passphrases must be outside archival inputs")
                if receipt:
                    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False), encoding="utf-8")
            result["sourceFiles"] = expected
            if args.protected_files:
                # Staging copies files, so the Java path/hard-link checks alone
                # cannot exclude credentials or passphrases from staged inputs.
                sizes = {size for size, _ in args.protected_files}
                for path in stage.rglob("*"):
                    if path.is_file():
                        size = path.stat().st_size
                        if size in sizes and (size, archives.fingerprint(path)) in args.protected_files:
                            raise ValueError("Signing credentials and passphrases must be outside archival inputs")
            result["sourceRole"] = source_role or ARCHIVAL_MASTER
            pending = work / "converted.pdf"
            options = ["--source-role", result["sourceRole"], "--c2pa", args.c2pa]
            if receipt_path.is_file():
                options.extend(["--import-provenance", str(receipt_path)])
            if args.pades == "on":
                options.extend(["--security-config", str(args.security_config)])
            run_java(args, report, processors, "create", stage, pending, *options)
            counts = re.search(r": (\d+) supplied and embedded; (\d+) displayed; (\d+) rejected for display\.",
                               (report / "create-stdout.txt").read_text(encoding="utf-8"))
            if counts:
                result.update(embeddedFiles=int(counts[1]), displayed=int(counts[2]), notDisplayed=int(counts[3]))
            with pending.open("rb") as pdf:
                if pdf.read(5) != b"%PDF-":
                    raise ValueError("Converter did not produce a PDF")
            if source_inventory(source) != expected:
                raise ValueError("Original input changed during conversion")
            output_size = pending.stat().st_size
            output_hash = archives.fingerprint(pending)
            # Existing PDFs survive every staging/conversion failure. Publish
            # only a completed conversion from the staging directory.
            output.parent.mkdir(parents=True, exist_ok=True)
            with worker_cancelled.get_lock():
                check_cancelled()
                status = publish_pdf(pending, output, new_only=args.new_only)
        if status == "created":
            result.update(outputBytes=output_size, outputSha256=output_hash)
        result["status"] = status
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    (report / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def run_batch(plans, run: Path, args, summary: dict, processors: int, affinity: list[int], memory_mib: int) -> None:
    jobs = min(len(plans), processors, memory_mib // JVM_MEMORY_MIB)
    summary["resources"] = {"processors": processors, "memoryMiB": memory_mib, "parallelJobs": jobs}
    parallel_jobs = f"{jobs} PDF" if jobs == 1 else f"up to {jobs} PDFs at once"
    print(f"Conversion budget: {processors} logical processors and {memory_mib} MiB for {parallel_jobs}.", flush=True)

    context = multiprocessing.get_context("spawn")
    cancelled = context.Value("b", False)
    pending = {}
    completed = {}
    next_job = 0
    free_processors = processors
    # Separate processes also keep the 7z reader's resource-limit setup safe before exec.
    with ProcessPoolExecutor(max_workers=jobs, mp_context=context,
                             initializer=configure_worker, initargs=(cancelled, affinity)) as pool:
        try:
            while next_job < len(plans) or pending:
                ready = min(len(plans) - next_job, jobs - len(pending))
                for remaining in range(ready, 0, -1):
                    job_processors = free_processors // remaining
                    source, destination, label, example = plans[next_job]
                    next_job += 1
                    print(f"[{next_job}/{len(plans)}] Converting {label}", flush=True)
                    future = pool.submit(run_job, source, destination, run / f"input-{next_job:04}", args,
                                         job_processors, example=example)
                    pending[future] = next_job, destination, job_processors
                    free_processors -= job_processors

                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    number, destination, job_processors = pending.pop(future)
                    free_processors += job_processors
                    result = future.result()
                    completed[number] = result
                    detail = f" ({result['displayed']}/{result['embeddedFiles']} displayed)" if "embeddedFiles" in result else ""
                    if result["status"] == "failed":
                        report = (run / f"input-{number:04}").relative_to(args.project)
                        detail = f" (see {report}/result.json)"
                    print(f"  {result['status']}: {destination.name}{detail}", flush=True)
                summary["results"] = [completed[number] for number in sorted(completed)]
                (run / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        except BaseException:
            cancelled.value = True
            for future in pending:
                future.cancel()
            raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, prog="dicom-regenerate",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""How to regenerate PDFs
  dicom-regenerate                            Convert new entries in in/ (the default).
  dicom-regenerate --dry-run                  List new entries to convert.
  dicom-regenerate --sample                   Convert the first loose DICOM in in/.
  dicom-regenerate --sample exam.zip          Convert one named input.
  dicom-regenerate --all                      Convert every entry in in/.
  dicom-regenerate --example CT               Rebuild the CT examples from their embedded originals.
  dicom-regenerate --example                  Rebuild all example PDFs in place under examples/.
  dicom-regenerate --everything --dry-run     List the input and example PDFs to rebuild.
  dicom-regenerate --everything               Rebuild both collections with C2PA and PAdES.
  dicom-regenerate --all --pades off          Keep C2PA and skip PAdES signing.

PAdES uses a PADES_B_LTA JSON policy with a signing identity and TSA settings.
Choose a policy with --security-config or DICOM_REGENERATE_SECURITY_CONFIG.
The repository default is target/dicom-regenerate/signing.json.
""")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--new", dest="new_only", action="store_true",
                           help="convert entries in in/ without a matching PDF (default)")
    selection.add_argument("--sample", nargs="?", const="", metavar="NAME",
                           help="convert one named input or the first loose DICOM")
    selection.add_argument("--all", action="store_true", help="rebuild PDFs for all entries in in/")
    selection.add_argument("--example", nargs="?", const="", metavar="PATH",
                           help="rebuild all example PDFs, a modality directory, or one PDF")
    selection.add_argument("--everything", action="store_true", help="convert all inputs and rebuild all examples")
    parser.add_argument("--input", type=Path, help="override in/, or the examples/ root with --example")
    parser.add_argument("--output", type=Path,
                        help="override the PDF directory under out/, with examples in its examples/ subdirectory")
    parser.add_argument("--jar", type=Path, default=PROJECT / "dist/dicom-pdf-0.47.0.jar")
    parser.add_argument("--java", default="java")
    parser.add_argument("--source-role", choices=SOURCE_ROLES,
                        help="override the role (default: archival-master or the role declared by an example)")
    parser.add_argument("--c2pa", choices=("on", "off"), default="on", help="include C2PA Content Credentials (default: on)")
    parser.add_argument("--pades", choices=("on", "off"), default="on", help="apply PAdES B-LTA signing (default: on)")
    parser.add_argument("--security-config", type=Path, help="local PAdES B-LTA signing JSON")
    parser.add_argument("--timeout", type=int, default=1800, help="maximum seconds per Java operation (default: 1800)")
    parser.add_argument("--dry-run", action="store_true", help="list planned PDFs without converting or replacing anything")
    args = parser.parse_args(argv)
    example_only = args.example is not None
    rebuild_examples = example_only or args.everything
    output_override = args.output is not None
    if output_override or not example_only:
        args.output = (args.output or PROJECT / "out").resolve()
        if not args.output.is_relative_to(PROJECT / "out"):
            parser.error("--output must stay under the repository's out/ directory")
    examples = PROJECT / "examples"
    args.example_output = args.output / "examples" if output_override else examples
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    reports = PROJECT / REPORTS
    args.new_only = args.new_only or not (args.all or args.everything or args.sample is not None or example_only)
    root = (args.input or PROJECT / "in").absolute()
    example_root = root if example_only and args.input else examples
    input_roots = [] if example_only else [root.resolve()]
    source_roots = input_roots + ([example_root.resolve()] if rebuild_examples else [])
    output_roots = [reports.resolve()]
    if args.output is not None:
        output_roots.append(args.output)
    if any(path.is_relative_to(source_root) for path in output_roots for source_root in source_roots):
        parser.error("input must not contain output or regeneration reports")
    plans = []
    if not example_only:
        allow_missing = args.input is None and (args.new_only or args.everything)
        for source in select_inputs(root, args.sample, allow_empty=args.new_only or allow_missing,
                                    allow_missing=allow_missing):
            # Retain extensions to distinguish images, archives and folders with the same stem.
            plans.append((source, args.output / (source.name + ".pdf"), source.relative_to(root), False))
    if rebuild_examples:
        for source in select_examples(example_root, args.example, allow_empty=args.everything):
            relative = source.relative_to(example_root)
            plans.append((source, args.example_output / relative, Path("examples") / relative, True))
    if not plans and not args.new_only:
        parser.error("No input entries or example PDFs found")
    destinations = []
    for source, path, _, example in plans:
        destination = path.resolve()
        protected_roots = source_roots
        if example and not output_override and destination == source.resolve():
            # An example may replace its own source PDF after a successful conversion.
            protected_roots = input_roots
        if any(destination.is_relative_to(source_root) for source_root in protected_roots):
            parser.error("planned PDFs must be outside the input directories")
        destinations.append(destination)
    if len({str(path).casefold() for path in destinations}) != len(plans):
        parser.error("selected PDF output paths would collide")
    if args.new_only:
        plans = [plan for plan in plans if not has_pdf_output(plan[1])]
    for _, destination, label, _ in plans:
        print(f"{label} -> {destination.relative_to(PROJECT)}", flush=True)
    if args.dry_run:
        print(f"Dry run: {len(plans)} PDFs; no files changed.")
        return 0
    if not plans:
        print("No new inputs to convert.")
        return 0
    args.jar = args.jar.resolve()
    if not args.jar.is_file():
        parser.error("CLI JAR missing; build it first or specify --jar")
    if shutil.which(args.java) is None:
        parser.error("Java executable missing; install Java 21 or specify --java")
    args.protected_files = set()
    if args.pades == "on":
        args.security_config = Path(args.security_config or os.environ.get("DICOM_REGENERATE_SECURITY_CONFIG")
                                    or reports / "signing.json").resolve()
        args.protected_files = signing_files(args.security_config)
    processors, affinity, memory_mib = available_resources()
    if memory_mib < JVM_MEMORY_MIB:
        parser.error(f"Regeneration needs {JVM_MEMORY_MIB} MiB of available RAM after the OS reserve "
                     f"({JAVA_HEAP_MIB} MiB Java heap plus {JVM_OVERHEAD_MIB} MiB JVM overhead)")
    args.project = PROJECT
    reports.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"), dir=reports))
    summary = {"input": str(example_root if example_only else root),
               "output": str(args.example_output if example_only else args.output),
               "sourceRole": args.source_role or ARCHIVAL_MASTER,
               "c2pa": args.c2pa, "pades": args.pades, "jar": str(args.jar), "results": []}
    if rebuild_examples:
        summary["examples"] = str(example_root)
        summary["exampleOutput"] = str(args.example_output)
    # Each job starts its own JVM. Keep the JAR available until every worker
    # stops, even if a new release replaces it in dist/ during the batch.
    with tempfile.TemporaryDirectory(prefix="cli-", dir=run) as temporary:
        run_jar = Path(temporary) / args.jar.name
        shutil.copyfile(args.jar, run_jar)
        args.jar = run_jar
        print(f"Reports: {run.relative_to(PROJECT)}", flush=True)
        run_batch(plans, run, args, summary, processors, affinity, memory_mib)
    created = sum(result["status"] == "created" for result in summary["results"])
    failed = sum(result["status"] == "failed" for result in summary["results"])
    skipped = len(plans) - created - failed
    skipped_detail = f"; {skipped} already published" if skipped else ""
    print(f"Created {created} PDFs; {failed} failed{skipped_detail}. Reports: {run.relative_to(PROJECT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit("Cancelled. Completed PDFs remain published; unfinished conversions do not replace existing PDFs.")
    except Exception as error:
        sys.exit(f"Regeneration failed: {error}")
