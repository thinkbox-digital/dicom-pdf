#!/usr/bin/env python3
"""Exercise the extracted attachment directly from disk with Playwright browsers offline.

Requires Python Playwright and its Chromium/Firefox browser installations.
Use verify_output.py first to extract viewer.html and manifest.json.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--viewer", type=Path, default=Path("target/verification/viewer.html"))
    parser.add_argument("--manifest", type=Path, default=Path("target/verification/manifest.json"))
    parser.add_argument("--report", type=Path, default=Path("target/verification"))
    parser.add_argument("--browsers", nargs="+", choices=["chromium", "firefox", "webkit"], default=["chromium", "firefox"])
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
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
            page.locator("#pdf-file").set_input_files(args.pdf.resolve())
            expect(page.locator("#image-list option")).to_have_count(len(entries))
            assert page.locator("#image-list option").count() == len(entries), "Viewer inventory differs"
            if manifest.get("schemaVersion") == 2:
                profile_name = "DICOM image" if manifest["profile"] == "dicom-images" else "intraoral"
                profile_label = f"{profile_name} profile {manifest['profileVersion']}"
                if manifest["sourceRole"] == "deidentified-copy":
                    profile_label = f"De-identified copy (caller supplied) · {profile_label}"
                expect(page.locator("#package-role")).to_have_text(profile_label)
            first_rendered = next((index for index, entry in enumerate(entries) if entry["status"] == "rendered" and entry.get("displayRejected") is not True), None)
            # Check startup before touching the image list; manually selecting an image
            # would hide a failure to load the first supported DICOM automatically.
            if first_rendered is None:
                expect(page.locator("#image-list")).to_have_value("")
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
                expect(page.locator("#status")).to_contain_text(re.compile("no supported", re.IGNORECASE))
                for control in page.locator("#controls input, #controls button").all():
                    assert control.is_disabled(), "Unsupported-only package enabled image controls"
                page.screenshot(path=str(args.report / f"viewer-{name}.png"))
                assert not network, f"Network requests: {network}"
                assert not errors, f"Browser runtime errors: {errors}"
                results.append({"browser": name, "version": browser.version, "urlScheme": "file",
                                "offline": True, "profileVersion": manifest.get("profileVersion"),
                                "sourceRole": manifest.get("sourceRole"), "networkRequests": network,
                                "renderedOriginals": [], "initialAutomaticLoad": None,
                                "noSupportedImages": True, "controlsDisabled": True})
                (args.report / "browser-checks.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
                print(f"{name} {browser.version}: no supported images reported clearly, image controls disabled offline")
                context.close()
                browser.close()
                continue
            initial_entry = entries[first_rendered]
            expect(page.locator("#image-list")).to_have_value(str(first_rendered))
            expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", initial_entry["attachment"])
            expect(page.locator("#reset")).to_be_enabled()
            expect(page.locator("#viewport canvas").first).to_be_visible()
            page.screenshot(path=str(args.report / f"viewer-startup-{name}.png"))
            checked = []
            first = None
            for index, entry in enumerate(entries):
                if entry["status"] != "rendered":
                    continue
                page.locator("#image-list").select_option(str(index))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"])
                assert "SHA-256 verified" in page.locator("#status").inner_text()
                if manifest.get("schemaVersion") == 2:
                    applied = page.locator("#viewport").evaluate("element => ({...element.dataset})")
                    assert int(applied["sourceFrame"]) == entry["sourceFrame"] == 1
                    assert float(applied["windowCenter"]) == float(entry["displayAdjustments"]["windowCenter"])
                    assert float(applied["windowWidth"]) == float(entry["displayAdjustments"]["windowWidth"])
                checked.append(entry["sourcePath"])
                if first is None:
                    first = index
            assert first is not None, "No supported images to check"
            page.locator("#image-list").select_option(str(first))
            expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[first]["attachment"])
            viewport = page.locator("#viewport")

            def digest():
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                return hashlib.sha256(viewport.screenshot()).hexdigest()

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
            unsupported = next((i for i, e in enumerate(entries) if e["status"] != "rendered"), None)
            if unsupported is not None:
                page.locator("#image-list").select_option(str(unsupported))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
                assert page.locator("#reset").is_disabled()
                page.locator("#image-list").select_option(str(first))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[first]["attachment"])
            page.screenshot(path=str(args.report / f"viewer-{name}.png"))
            assert not network, f"Network requests: {network}"
            assert not errors, f"Browser runtime errors: {errors}"
            result = {"browser": name, "version": browser.version, "urlScheme": "file",
                      "offline": True, "profileVersion": manifest.get("profileVersion"),
                      "sourceRole": manifest.get("sourceRole"), "networkRequests": network, "renderedOriginals": checked,
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
