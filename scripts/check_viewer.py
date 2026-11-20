#!/usr/bin/env python3
"""Exercise the extracted attachment directly from disk with Playwright browsers offline.

Requires Python Playwright and its Chromium/Firefox browser installations.
Use --verification for the run directory printed by verify_output.py, or read the attachments directly from the PDF.
"""
import argparse
import json
import tempfile
from collections import Counter
from pathlib import Path

from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect


def check_source_inventory(page, entries):
    data_indices = [int(index) for index in page.locator("#image-list option").evaluate_all("options=>options.map(o=>o.value)")]
    ancillary = page.locator("#other-supplied-files [data-attachment]").evaluate_all("rows=>rows.map(row=>row.dataset.attachment)")
    assert all(0 <= index < len(entries) for index in data_indices), "Invalid source index"
    displayed = [entries[i]["attachment"] for i in data_indices] + ancillary
    assert Counter(displayed) == Counter(e["attachment"] for e in entries), "The two panes must account for every original exactly once"
    return data_indices, ancillary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--viewer", type=Path, help="Override the embedded viewer")
    parser.add_argument("--manifest", type=Path, help="Override the embedded manifest")
    parser.add_argument("--verification", type=Path, help="Directory written by verify_output.py for this PDF")
    parser.add_argument("--report", type=Path, help="Browser report directory (default: a fresh run under target/viewer-checks)")
    parser.add_argument("--browsers", nargs="+", choices=["chromium", "firefox", "webkit"], default=["chromium", "firefox"])
    args = parser.parse_args()
    if args.report is None:
        base = Path("target/viewer-checks")
        base.mkdir(parents=True, exist_ok=True)
        args.report = Path(tempfile.mkdtemp(prefix="run-", dir=base))
    args.report.mkdir(parents=True, exist_ok=True)
    if args.verification:
        args.viewer = args.viewer or args.verification / "viewer.html"
        args.manifest = args.manifest or args.verification / "manifest.json"
    reader = PdfReader(args.pdf)
    embedded_manifest = json.loads(reader.attachments["manifest.json"][0])
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else embedded_manifest
    if manifest != embedded_manifest:
        parser.error("The selected verification manifest differs from this PDF")
    if not args.viewer:
        viewer_dir = Path(tempfile.mkdtemp(prefix="attachment-", dir=args.report))
        args.viewer = viewer_dir / "viewer.html"
        args.viewer.write_bytes(reader.attachments["viewer.html"][0])
    print(f"Browser reports: {args.report}", flush=True)
    entries = manifest["images"]
    results = []
    with sync_playwright() as playwright:
        for name in args.browsers:
            browser = getattr(playwright, name).launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900}, offline=True)
            page = context.new_page()
            errors = []
            network = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: network.append(request.url) if request.url.startswith(("https:", "http:")) else None)
            page.goto(args.viewer.resolve().as_uri())
            viewer_version = page.locator('meta[name="application-version"]').get_attribute("content")
            page.locator("#pdf-file").set_input_files(args.pdf.resolve())
            expect(page.locator("#viewport")).to_have_attribute("data-input-kind", "pdf-package", timeout=120000)
            expect(page.locator("#loading-dialog")).not_to_be_visible(timeout=120000)
            data_indices, ancillary = check_source_inventory(page, entries)
            if manifest.get("schemaVersion") == 2:
                profile_name = "DICOM image" if manifest["profile"] == "dicom-images" else "intraoral"
                profile_label = f"{profile_name} profile {manifest['profileVersion']}"
                if manifest["sourceRole"] == "deidentified-copy":
                    profile_label = f"De-identified copy (caller supplied) · {profile_label}"
                expect(page.locator("#package-role")).to_have_text(profile_label)
            initial_attachment = page.locator("#viewport").get_attribute("data-loaded-attachment")
            if not initial_attachment:
                assert not any(e["status"] == "rendered" and not e.get("displayRejected") for e in entries), "No initial image opened despite a saved DICOM reference"
                expect(page.locator("#reset")).to_be_disabled()
                assert page.locator("#status").inner_text().strip(), "A package with no active image needs a display status"
                assert not network and not errors, "Browser failed the offline check"
                results.append({"browser":name,"version":browser.version,"viewerVersion":viewer_version,"urlScheme":"file","offline":True,
                                "initialAutomaticLoad":None,"imageControlsDisabled":True,"ancillaryCount":len(ancillary)})
                (args.report / "browser-checks.json").write_text(json.dumps(results, indent=2)+"\n")
                context.close()
                browser.close()
                continue
            first_index = int(page.locator("#image-list").input_value())
            initial_entry = entries[first_index]
            assert initial_attachment == initial_entry["attachment"], "Displayed source differs from the automatic selection"
            expect(page.locator("#reset")).to_be_enabled()
            expect(page.locator("#viewport canvas").first).to_be_visible()
            page.screenshot(path=str(args.report / f"viewer-startup-{name}.png"))
            checked = []
            first = None
            for index, entry in enumerate(entries):
                if entry["status"] != "rendered" or entry.get("displayRejected") or index not in data_indices:
                    continue
                page.locator("#image-list").select_option(str(index))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"])
                expect(page.locator("#status")).to_contain_text("SHA-256 verified")
                if manifest.get("schemaVersion") == 2:
                    applied = page.locator("#viewport").evaluate("element => ({...element.dataset})")
                    assert int(applied["sourceFrame"]) == entry["sourceFrame"] == 1
                    assert float(applied["windowCenter"]) == float(entry["displayAdjustments"]["windowCenter"])
                    assert float(applied["windowWidth"]) == float(entry["displayAdjustments"]["windowWidth"])
                checked.append(entry["sourcePath"])
                if first is None:
                    first = index
            if first is None:
                first = first_index
            page.locator("#image-list").select_option(str(first))
            expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[first]["attachment"])
            viewport = page.locator("#viewport")

            def digest():
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                return viewport.locator("canvas").first.evaluate("""async canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
                  const digest=await crypto.subtle.digest('SHA-256',pixels.data);return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');}""")

            page.mouse.move(1, 1)
            baseline = digest()
            page.locator("#brightness").evaluate("input => {input.value=35;input.dispatchEvent(new Event('input',{bubbles:true}));}")
            brightness = digest()
            assert baseline != brightness, "Brightness did not change displayed pixels"
            page.locator("#reset").click()
            assert digest() == baseline, "Reset did not restore brightness"
            page.locator("#contrast").evaluate("input => {input.value=180;input.dispatchEvent(new Event('input',{bubbles:true}));}")
            contrast = digest()
            assert baseline != contrast, "Contrast did not change displayed pixels"
            page.locator("#reset").click()
            assert digest() == baseline, "Reset did not restore contrast"
            page.locator("#zoom-in").click()
            zoom = digest()
            assert baseline != zoom, "Zoom did not change displayed pixels"
            box = viewport.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 60, y + 35, steps=5)
            page.mouse.up()
            pan = digest()
            assert pan != zoom, "Pan did not change displayed pixels"
            page.locator("#reset").click()
            assert digest() == baseline, "Reset did not restore zoom/pan"
            # A supported selection must not remain visible after an unsupported one.
            unavailable = page.locator('#image-list option[data-display="unavailable"]').evaluate_all("options=>options.map(o=>Number(o.value))")
            unsupported = next((i for i in unavailable if entries[i]["status"] != "rendered"), None)
            if unsupported is not None:
                page.locator("#image-list").select_option(str(unsupported))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
                assert page.locator("#reset").is_disabled()
                page.locator("#image-list").select_option(str(first))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[first]["attachment"])
            page.screenshot(path=str(args.report / f"viewer-{name}.png"))
            assert not network, f"Network requests: {network}"
            assert not errors, f"Browser runtime errors: {errors}"
            result = {"browser": name, "version": browser.version, "viewerVersion":viewer_version, "urlScheme": "file",
                      "offline": True, "profileVersion": manifest.get("profileVersion"),
                      "sourceRole": manifest.get("sourceRole"), "networkRequests": network, "renderedOriginals": checked, "ancillaryCount": len(ancillary),
                      "initialAutomaticLoad": initial_entry["attachment"], "noSupportedImages": False,
                      "controls": {"brightness": brightness != baseline, "contrast": contrast != baseline,
                                   "zoom": zoom != baseline, "pan": pan != zoom, "reset": True},
                      "viewportSha256": {"baseline": baseline, "brightness": brightness, "contrast": contrast,
                                         "zoom": zoom, "pan": pan}}
            results.append(result)
            (args.report / "browser-checks.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
            print(f"{name} {browser.version}: {len(checked)} originals displayed, all controls changed pixels offline")
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
