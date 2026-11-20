#!/usr/bin/env python3
"""Independent output checks using Poppler, SHA-256, XML/JSON, and veraPDF CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(command, **kwargs):
    return subprocess.run([str(part) for part in command], check=True, capture_output=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--report", type=Path, default=Path("target/verification"))
    parser.add_argument("--verapdf", default=os.environ.get("VERAPDF", "verapdf"))
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    pdf = args.pdf.resolve(strict=True)
    report = args.report.resolve()
    report.mkdir(parents=True, exist_ok=True)
    checked = []
    with tempfile.TemporaryDirectory(prefix="dicompdf-extracted-") as temp:
        extracted = Path(temp)
        run(["pdfdetach", "-saveall", "-o", extracted, pdf])
        manifest = json.loads((extracted / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["schemaVersion"] in (1, 2), "Unknown manifest version"
        if manifest["schemaVersion"] == 2:
            for resource in ("inventory.txt", "profile.json", "field-mapping.json", "dicom-xmp.rng", "RECOVERY.txt", "manifest.sha256"):
                assert (extracted / resource).is_file(), f"Missing package support file: {resource}"
            assert (extracted / "manifest.sha256").read_text(encoding="utf-8").split()[0] == hashlib.sha256((extracted / "manifest.json").read_bytes()).hexdigest(), "Manifest checksum differs"
            for resource, expected in manifest.get("artifactSha256", {}).items():
                assert hashlib.sha256((extracted / resource).read_bytes()).hexdigest() == expected, f"Package artifact hash differs: {resource}"
        inventory = {str(p.relative_to(source)).replace(os.sep, "/"): p
                     for p in source.rglob("*") if p.is_file()}
        assert len(manifest["images"]) == len(inventory), "Manifest/input count differs"
        seen = set()
        pages = set()
        for image in manifest["images"]:
            relative = image["sourcePath"]
            assert relative in inventory and relative not in seen, "Unexpected/repeated original"
            seen.add(relative)
            # Embedded originals use flat names so ordinary attachment dialogs can save them.
            attachment = extracted / image["attachment"]
            assert attachment.resolve().is_relative_to(extracted.resolve()), "Unsafe attachment name"
            original = inventory[relative].read_bytes()
            payload = attachment.read_bytes()
            assert payload == original, f"Extracted bytes differ: {relative}"
            digest = hashlib.sha256(original).hexdigest()
            assert image["sha256"] == digest, f"Manifest digest differs: {relative}"
            page = image["referencePage"]
            assert isinstance(page, int) and page > 1 and page not in pages, "Invalid reference page"
            pages.add(page)
            if image["status"] != "rendered":
                assert image.get("reason"), f"Unrendered source has no diagnostic: {relative}"
            checked.append({"sourcePath": relative, "attachment": image["attachment"],
                            "bytes": len(original), "sha256": digest,
                            "referencePage": page, "status": image["status"]})
        assert seen == set(inventory), "Not all supplied originals were retained"
        (report / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        viewer = extracted / "viewer.html"
        if viewer.exists():
            shutil.copy2(viewer, report / "viewer.html")
        else:
            bundles = list(extracted.glob("*viewer*.zip"))
            assert bundles, "No attached offline viewer"
            shutil.copy2(bundles[0], report / bundles[0].name)
    # Poppler is independent of the Java generation library and renders every page.
    for previous in report.glob("page-*.png"):
        previous.unlink()
    run(["pdftoppm", "-r", "36", "-png", pdf, report / "page"])
    images = list(report.glob("page-*.png"))
    assert len(images) == max(pages), "Poppler page count differs from reference mapping"
    assert len(run(["pdftotext", pdf, "-"]).stdout.strip()) > 0, "No selectable ordinary-reader text"
    info = run(["pdfinfo", pdf]).stdout.decode("utf-8")
    (report / "pdfinfo.txt").write_text(info, encoding="utf-8")
    validation = run([args.verapdf, "--format", "json", "--flavour", "4f", pdf]).stdout
    (report / "verapdf.json").write_bytes(validation)
    result = json.loads(validation)
    jobs = result.get("report", result).get("jobs", [])
    assert jobs, "veraPDF returned no validation jobs"
    checks = [job["validationResult"][0] for job in jobs]
    assert all(check["compliant"] for check in checks), "veraPDF PDF/A-4f validation failed"
    summary = {"originalCount": len(checked), "renderedCount": sum(x["status"] == "rendered" for x in checked),
               "unrenderedCount": sum(x["status"] != "rendered" for x in checked),
               "ordinaryReader": "Poppler pdftoppm + pdftotext", "pdfa4fCompliant": True,
               "profileVersion": manifest.get("profileVersion"), "sourceRole": manifest.get("sourceRole"),
               "unresolvedReferences": [r for r in manifest.get("references", []) if r["status"] != "resolved"],
               "originals": checked}
    (report / "verification.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(checked)} byte-identical originals, {len(images)} readable pages, PDF/A-4f compliant")


if __name__ == "__main__":
    main()
