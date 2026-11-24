#!/usr/bin/env python3
"""Independent output checks using Poppler, SHA-256, XML/JSON, and veraPDF CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def run(command, **kwargs):
    return subprocess.run([str(part) for part in command], check=True, capture_output=True, **kwargs)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def extracted_file(root, name):
    path = (root / name).resolve()
    require(path.is_relative_to(root), f"Unsafe attachment name: {name}")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--report", type=Path, help="new report directory (default: a fresh run under target/verification)")
    parser.add_argument("--verapdf", default=os.environ.get("VERAPDF", "verapdf"))
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    pdf = args.pdf.resolve(strict=True)
    if not source.is_dir():
        parser.error("--input must be a directory")
    project = Path(__file__).resolve().parents[1]
    report = (args.report or project / "target/verification").resolve()
    if report.is_relative_to(source) or (args.report and source.is_relative_to(report)):
        parser.error("Report destination must be separate from the original source directory")
    if (args.report and pdf.is_relative_to(report)) or report.is_relative_to((project / "out").resolve()):
        parser.error("Report destination must be separate from the input PDF and converted-PDF directory")
    if args.report is None:
        report.mkdir(parents=True, exist_ok=True)
        report = Path(tempfile.mkdtemp(prefix="run-", dir=report))
    else:
        try:
            report.mkdir(parents=True)
        except FileExistsError:
            parser.error("Report destination already exists. Choose a new directory.")
    checked = []
    with tempfile.TemporaryDirectory(prefix=".extracted-", dir=report) as temp:
        extracted = Path(temp).resolve()
        run(["pdfdetach", "-saveall", "-o", extracted, pdf])
        manifest = json.loads((extracted / "manifest.json").read_text(encoding="utf-8"))
        require(manifest["schemaVersion"] in (1, 2), "Unknown manifest version")
        if manifest["schemaVersion"] == 2:
            for resource in ("inventory.txt", "profile.json", "field-mapping.json", "dicom-xmp.rng", "RECOVERY.txt", "manifest.sha256"):
                require((extracted / resource).is_file(), f"Missing package support file: {resource}")
            checksum = (extracted / "manifest.sha256").read_text(encoding="utf-8").split()
            manifest_hash = hashlib.sha256((extracted / "manifest.json").read_bytes()).hexdigest()
            require(checksum and checksum[0] == manifest_hash, "Manifest checksum differs")
            for resource, expected in manifest.get("artifactSha256", {}).items():
                require(hashlib.sha256(extracted_file(extracted, resource).read_bytes()).hexdigest() == expected, f"Package artifact hash differs: {resource}")
        inventory = {str(p.relative_to(source)).replace(os.sep, "/"): p
                     for p in source.rglob("*") if p.is_file()}
        require(len(manifest["images"]) == len(inventory), "Manifest/input count differs")
        seen = set()
        pages = set()
        for image in manifest["images"]:
            relative = image["sourcePath"]
            require(relative in inventory and relative not in seen, "Unexpected/repeated original")
            seen.add(relative)
            # Embedded originals use flat names so ordinary attachment dialogs can save them.
            attachment = extracted_file(extracted, image["attachment"])
            original = inventory[relative].read_bytes()
            payload = attachment.read_bytes()
            require(payload == original, f"Extracted bytes differ: {relative}")
            digest = hashlib.sha256(original).hexdigest()
            require(image["sha256"] == digest, f"Manifest digest differs: {relative}")
            page = image["referencePage"]
            require(isinstance(page, int) and page > 1 and page not in pages, "Invalid reference page")
            pages.add(page)
            if image["status"] != "rendered":
                require(image.get("reason"), f"Unrendered source has no diagnostic: {relative}")
            checked.append({"sourcePath": relative, "attachment": image["attachment"],
                            "bytes": len(original), "sha256": digest,
                            "referencePage": page, "status": image["status"]})
        require(seen == set(inventory), "Not all supplied originals were retained")
        (report / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Poppler is independent of the Java generation library and renders every page.
    run(["pdftoppm", "-r", "36", "-png", pdf, report / "page"])
    images = list(report.glob("page-*.png"))
    require(len(images) == max(pages, default=0), "Poppler page count differs from reference mapping")
    require(len(run(["pdftotext", pdf, "-"]).stdout.strip()) > 0, "No selectable ordinary-reader text")
    info = run(["pdfinfo", pdf]).stdout.decode("utf-8")
    (report / "pdfinfo.txt").write_text(info, encoding="utf-8")
    validation = run([args.verapdf, "--format", "json", "--flavour", "4f", pdf]).stdout
    (report / "verapdf.json").write_bytes(validation)
    result = json.loads(validation)
    jobs = result.get("report", result).get("jobs", [])
    require(jobs, "veraPDF returned no validation jobs")
    checks = [job["validationResult"][0] for job in jobs]
    require(all(check["compliant"] for check in checks), "veraPDF PDF/A-4f validation failed")
    summary = {"originalCount": len(checked), "renderedCount": sum(x["status"] == "rendered" for x in checked),
               "unrenderedCount": sum(x["status"] != "rendered" for x in checked),
               "ordinaryReader": "Poppler pdftoppm + pdftotext", "pdfa4fCompliant": True,
               "profileVersion": manifest.get("profileVersion"), "sourceRole": manifest.get("sourceRole"),
               "unresolvedReferences": [r for r in manifest.get("references", []) if r["status"] != "resolved"],
               "originals": checked}
    (report / "verification.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(checked)} byte-identical originals, {len(images)} readable pages, PDF/A-4f compliant")
    print(f"Reports: {report}")


if __name__ == "__main__":
    main()
