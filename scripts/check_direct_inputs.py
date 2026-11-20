#!/usr/bin/env python3
"""Check explicit PDF input, drops and picker recovery in the offline viewer."""

import argparse
import json
from pathlib import Path
import tempfile
import zipfile

from playwright.sync_api import sync_playwright
from pypdf import PdfWriter

from check_extension import extension_identity, launch
from check_viewer_drop_loading import check_viewer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--chromium", help="Chromium executable (defaults to Playwright’s installed Chromium)")
    parser.add_argument("--standalone", type=Path, help="Check a standalone HTML viewer instead of the extension")
    parser.add_argument("--pdf", type=Path, default=Path("target/viewer-test-pdfs/synthetic-overlays.pdf"))
    parser.add_argument("--report", type=Path, default=Path("target/direct-input-checks"))
    args = parser.parse_args()
    mode = "standalone" if args.standalone else "extension"
    report = args.report / mode
    report.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=report) as temp, sync_playwright() as playwright:
        work = Path(temp)
        invalid = work / "invalid.pdf"
        invalid.write_bytes(b"%PDF-1.7\ninvalid\n")
        ordinary = work / "ordinary.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        writer.write(ordinary)
        loose_zip = work / "sources.zip"
        with zipfile.ZipFile(loose_zip, "w") as archive:
            archive.write("fixtures/expanded/sc-native-gray8.dcm", "image.dcm")
        chromium = args.chromium or playwright.chromium.executable_path
        if args.standalone:
            context = playwright.chromium.launch_persistent_context(str(work / "profile"), executable_path=chromium,
                headless=True, viewport={"width": 1440, "height": 1000})
            location = args.standalone.resolve(strict=True).as_uri()
        else:
            context = launch(playwright, chromium, args.extension.resolve(strict=True), work / "profile")
            location = f"chrome-extension://{extension_identity(context)}/viewer.html"
        try:
            context.set_offline(True)
            requests = []
            context.on("request", lambda request: requests.append(request.resource_type)
                       if request.url.startswith(("http:", "https:")) else None)
            probe = context.new_page()
            probe.goto(location)
            viewer_version = probe.locator('meta[name="application-version"]').get_attribute("content")
            probe.close()
            result = check_viewer(context, location, args.pdf, invalid, ordinary, loose_zip, report)
            assert not requests, "Offline PDF opening attempted a network request"
            result.update(mode=mode, viewerVersion=viewer_version, browserVersion=context.browser.version, httpRequests=len(requests))
        finally:
            context.close()
    (report / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"{mode}: PDF picker, drop, rejection and recovery checks passed")


if __name__ == "__main__":
    main()
