#!/usr/bin/env python3
"""Convert safely staged additional samples, keeping private checks below target/.

Run sample_inventory.py first. Originals remain archival masters; this does not
de-identify or certify supplied samples. Only converted PDFs are written to out/.
Console messages contain aggregate counts only, never file-derived text.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

import convert_archives as archive_tools
import sample_inventory as sample_tools


def relative_path(value: str) -> Path:
    info = zipfile.ZipInfo(value)
    return archive_tools.member_path(info)


def same_bytes(first: Path, second: Path) -> bool:
    if first.stat().st_size != second.stat().st_size:
        return False
    with first.open("rb") as left, second.open("rb") as right:
        while True:
            block = left.read(1024*1024)
            if block != right.read(1024*1024):
                return False
            if not block:
                return True


def verify_files(stage: Path, expected: list[dict]) -> None:
    if stage.is_symlink() or not stage.is_dir():
        raise ValueError("Staging must be an ordinary directory")
    known = {}
    for item in expected:
        relative = relative_path(item["path"]).as_posix()
        if relative in known:
            raise ValueError("Duplicate staged inventory path")
        known[relative] = item
    seen = set()
    for path in stage.rglob("*"):
        if path.is_symlink():
            raise ValueError("Staging contains a symbolic link")
        if path.is_dir():
            continue
        relative = path.relative_to(stage).as_posix()
        if not path.is_file() or relative not in known:
            raise ValueError("Staging contains an unexpected file")
        item = known[relative]
        if path.stat().st_size != item["size"] or archive_tools.fingerprint(path) != item["sha256"]:
            raise ValueError("Staging differs from original input inventory")
        seen.add(relative)
    if seen != set(known):
        raise ValueError("Staging is missing supplied files")


def source_unchanged(inventory: dict) -> bool:
    root = Path(inventory["input"])
    current = sample_tools.input_inventory(root)
    snapshot = lambda rows: {(row["sourcePath"], row["size"], row["sha256"]) for row in rows}
    return snapshot(current) == snapshot(inventory["sourceFiles"])


def load_packages(inventory: dict, work: Path) -> list[dict]:
    if inventory.get("inputsUnchanged") is not True:
        raise ValueError("Inventory did not confirm unchanged supplied inputs")
    archives = {row["sourceID"]: row for row in inventory["archives"] if row.get("parentArchiveID") is None}
    loose = {row["sourceID"]: row for row in inventory["looseStaging"]}
    packages = []
    for source in inventory["sourceFiles"]:
        if not source.get("additionalSample"):
            continue
        identifier = source["sourceID"]
        if not re.fullmatch(r"input-\d{3,}", identifier):
            raise ValueError("Inventory source identifier is not portable")
        row = archives.get(identifier) or loose.get(identifier)
        if row is None or row.get("status") != "staged":
            raise ValueError("An additional input was not safely staged")
        stage = Path(row["staging"]).absolute()
        if not stage.resolve().is_relative_to((work / "staged").resolve()):
            raise ValueError("Staged input escapes the private staging directory")
        sample_tools.work_path(work, str(stage.relative_to(work)))
        if "files" in row:
            expected = row["files"]
        else:
            staged_file = Path(row["file"]).absolute()
            expected = [{"path": staged_file.relative_to(stage).as_posix(), "size": source["size"], "sha256": source["sha256"]}]
        verify_files(stage, expected)
        packages.append({"sourceID": identifier, "source": source, "staging": stage, "files": expected})
    if not packages:
        raise ValueError("No additional staged inputs were selected")
    return packages


def command(arguments: list[str], report: Path, name: str, *, accepted=(0,), timeout=300) -> tuple[int, float]:
    start = time.monotonic()
    with (report / f"{name}-stdout.txt").open("wb") as output, (report / f"{name}-stderr.txt").open("wb") as error:
        result = subprocess.run([str(part) for part in arguments], stdout=output, stderr=error, timeout=timeout)
    if result.returncode not in accepted:
        raise RuntimeError(f"{name} did not complete successfully; see private command logs")
    return result.returncode, round(time.monotonic()-start, 3)


def compare_recovery(stage: Path, recovery: Path, expected: list[dict]) -> dict:
    checked = []
    for item in expected:
        relative = relative_path(item["path"])
        original, restored = stage / relative, recovery / relative
        if restored.is_symlink() or not restored.is_file() or not same_bytes(original, restored):
            raise ValueError("Recovered original bytes differ from supplied bytes")
        digest = archive_tools.fingerprint(restored)
        if digest != item["sha256"]:
            raise ValueError("Recovered original differs from pre-conversion SHA-256")
        checked.append({"sourcePath": relative.as_posix(), "bytes": item["size"], "sha256": digest})
    return {"status": "PASS", "count": len(checked), "originals": checked}


def compare_poppler(stage: Path, detached: Path, manifest: dict, expected: list[dict]) -> dict:
    known = {item["path"]: item for item in expected}
    checked, seen = [], set()
    for image in manifest["images"]:
        relative = relative_path(image["sourcePath"]).as_posix()
        attachment = relative_path(image["attachment"])
        if len(attachment.parts) != 1 or relative in seen or relative not in known:
            raise ValueError("PDF manifest does not map each supplied original exactly once")
        original, restored = stage / relative, detached / attachment
        item = known[relative]
        if restored.is_symlink() or not restored.is_file() or not same_bytes(original, restored):
            raise ValueError("Independent Poppler recovery differs from supplied original")
        digest = archive_tools.fingerprint(restored)
        if digest != item["sha256"] or image["sha256"] != digest or image["size"] != item["size"]:
            raise ValueError("Independent byte recovery disagrees with manifest/inventory SHA-256")
        checked.append({"sourcePath": relative, "attachment": str(attachment), "bytes": item["size"], "sha256": digest})
        seen.add(relative)
    if seen != set(known):
        raise ValueError("PDF does not embed every supplied original")
    if manifest.get("sourceRole") != "archival-master":
        raise ValueError("PDF does not identify sources as archival masters")
    return {"status": "PASS", "count": len(checked), "originals": checked}


def convert_package(package: dict, args, run: Path) -> dict:
    identifier, stage, expected = package["sourceID"], package["staging"], package["files"]
    report = sample_tools.work_path(run, identifier)
    report.mkdir()
    output = args.output / f"additional-{identifier}.pdf"
    if output.is_symlink() or (output.exists() and not args.replace):
        raise FileExistsError("Generated PDF exists; --replace is required to regenerate it")
    verify_files(stage, expected)
    base = ["java", "-Xmx1536m", "-Djava.awt.headless=true", "-jar", str(args.jar)]
    result = {"sourceID": identifier, "source": package["source"], "sourceRole": "archival-master", "output": str(output),
              "staging": str(stage), "reportDirectory": str(report), "supplied": len(expected), "checks": {}, "timingSeconds": {}}
    _, result["timingSeconds"]["create"] = command(base + ["create", "--input", str(stage), "--output", str(output),
                                                        "--source-role", "archival-master"], report, "create")
    result["outputBytes"] = output.stat().st_size
    result["outputSha256"] = archive_tools.fingerprint(output)
    exit_code, result["timingSeconds"]["verify"] = command(base + ["verify", "--input", str(output), "--sources", str(stage),
        "--verapdf", args.verapdf, "--output", str(report / "verification.json")], report, "verify", accepted=(0, 1, 2))
    verification = json.loads((report / "verification.json").read_text(encoding="utf-8"))
    result["verificationExitCode"] = exit_code
    result["checks"].update({key: value["status"] for key, value in verification.items()})
    recovered = report / "recovered"
    _, result["timingSeconds"]["extract"] = command(base + ["extract", "--input", str(output), "--output", str(recovered)], report, "extract")
    result["javaRecovery"] = compare_recovery(stage, recovered / "originals", expected)
    detached = report / "poppler-attachments"
    detached.mkdir()
    _, result["timingSeconds"]["pdfdetach"] = command(["pdfdetach", "-saveall", "-o", str(detached), str(output)], report, "pdfdetach")
    manifest = json.loads((detached / "manifest.json").read_text(encoding="utf-8"))
    result["independentRecovery"] = compare_poppler(stage, detached, manifest, expected)
    manifest_digest = (detached / "manifest.sha256").read_text(encoding="utf-8").split()[0]
    if archive_tools.fingerprint(detached / "manifest.json") != manifest_digest:
        raise ValueError("Independently recovered manifest hash differs")
    result["embedded"] = len(manifest["images"])
    result["displayed"] = sum(image["status"] == "rendered" for image in manifest["images"])
    result["notDisplayed"] = result["embedded"]-result["displayed"]
    result["unresolvedReferences"] = dict(Counter(ref["status"] for ref in manifest.get("references", []) if ref["status"] != "resolved"))
    _, result["timingSeconds"]["independentVeraPDF"] = command([args.verapdf, "--format", "json", "--flavour", "4f", str(output)],
        report, "verapdf", accepted=(0, 1, 2))
    vera = json.loads((report / "verapdf-stdout.txt").read_text(encoding="utf-8"))
    jobs = vera.get("report", vera).get("jobs", [])
    checks = [check for job in jobs for check in job.get("validationResult", [])]
    result["independentPdfa4f"] = "PASS" if jobs and checks and all(check.get("compliant") is True for check in checks) else "FAIL"
    command(["pdfinfo", str(output)], report, "pdfinfo")
    info = (report / "pdfinfo-stdout.txt").read_text(encoding="utf-8")
    match = re.search(r"^Pages:\s*(\d+)", info, re.MULTILINE)
    page_count = int(match.group(1)) if match else 0
    command(["pdftotext", str(output), str(report / "ordinary-reader.txt")], report, "pdftotext")
    _, result["timingSeconds"]["ordinaryRender"] = command(["pdftoppm", "-r", "24", "-png", str(output), str(report / "page")], report, "pdftoppm")
    rendered_pages = len(list(report.glob("page-*.png")))
    result["ordinaryReader"] = {"status": "PASS" if page_count > 0 and rendered_pages == page_count and (report / "ordinary-reader.txt").stat().st_size > 0 else "FAIL",
                                "tool": "Poppler pdfinfo/pdftotext/pdftoppm", "pages": page_count, "renderedPages": rendered_pages}
    verify_files(stage, expected)
    required = ("sourceBytes", "externalSources", "metadataAccuracy", "pdfa4f")
    result["status"] = "PASS" if (all(result["checks"].get(key) == "PASS" for key in required)
        and result["independentPdfa4f"] == "PASS" and result["ordinaryReader"]["status"] == "PASS") else "FAIL"
    (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=Path("target/additional-samples/inventory.json"))
    parser.add_argument("--jar", type=Path, default=Path("dist/dicom-pdf-0.59.0.jar"))
    parser.add_argument("--verapdf", default=os.environ.get("VERAPDF", "verapdf"))
    parser.add_argument("--replace", action="store_true", help="Regenerate only the additional-input-NNN.pdf outputs")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    work = project / "target/additional-samples"
    inventory_path = args.inventory.absolute()
    sample_tools.work_path(work, str(inventory_path.relative_to(work)))
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if not source_unchanged(inventory):
        raise ValueError("Supplied inputs changed after inventory; regenerate the inventory first")
    packages = load_packages(inventory, work)
    args.jar = args.jar.resolve(strict=True)
    args.output = project / "out"
    if args.output.is_symlink():
        raise ValueError("PDF output directory must not be a symlink")
    args.output.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="conversion-", dir=work))
    results = []
    for package in packages:
        try:
            result = convert_package(package, args, run)
        except Exception as error:
            result = {"sourceID": package["sourceID"], "status": "FAIL", "errorType": type(error).__name__, "reason": str(error)}
            (run / f"{package['sourceID']}-failure.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
        results.append(result)
        print(json.dumps({"completedPackages": len(results), "plannedPackages": len(packages),
                          "packageStatuses": dict(Counter(row["status"] for row in results))}), flush=True)
    unchanged = source_unchanged(inventory)
    report = {"schemaVersion": 1, "jarSha256": archive_tools.fingerprint(args.jar), "inventory": str(inventory_path),
              "reportDirectory": str(run), "inputsUnchanged": unchanged, "sourceRole": "archival-master",
              "deidentification": "Not assessed; supplied files were never transformed or certified de-identified", "packages": results}
    (run / "summary.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    sample_tools.work_path(work, "conversion-summary.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    summary = {"packages": len(results), "packageStatuses": dict(Counter(row["status"] for row in results)), "inputsUnchanged": unchanged,
               "supplied": sum(row.get("supplied", 0) for row in results), "embedded": sum(row.get("embedded", 0) for row in results),
               "displayed": sum(row.get("displayed", 0) for row in results), "notDisplayed": sum(row.get("notDisplayed", 0) for row in results),
               "independentRecoveryMatches": sum(row.get("independentRecovery", {}).get("count", 0) for row in results),
               "independentPdfa4fPass": sum(row.get("independentPdfa4f") == "PASS" for row in results),
               "ordinaryReaderPass": sum(row.get("ordinaryReader", {}).get("status") == "PASS" for row in results)}
    (run / "aggregate.json").write_text(json.dumps(summary, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0 if unchanged and all(row["status"] == "PASS" for row in results) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as failure:
        print(json.dumps({"status": "failed", "errorType": type(failure).__name__}))
        raise SystemExit(1)
