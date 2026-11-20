#!/usr/bin/env python3
"""Check the installed local-toolbar handoff offline using synthetic inputs.

Requires the normal extension build, Python Playwright and pypdf. Uses a temporary
browser profile and writes only under target/handoff-checks; no real patient data
or existing browser profile is touched. Unit tests cover expiry/restart timing.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=root / "target/chrome-extension")
    parser.add_argument("--pdf", type=Path, default=root / "target/viewer-test-pdfs/sample-images.pdf")
    parser.add_argument("--report", type=Path, default=root / "target/handoff-checks")
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    staged = args.report / "inputs/Synthetic-identifier/Synthetic-study.pdf"
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.pdf, staged)
    manifest = json.loads(PdfReader(staged).attachments["manifest.json"][0])
    initial = next(entry for entry in manifest["images"] if entry["status"] == "rendered")
    result = {"httpRequests": 0, "browserErrors": 0, "offline": True,
              "backgroundSha256": hashlib.sha256((args.extension / "background.js").read_bytes()).hexdigest()}
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=args.report) as profile:
        extension = args.extension.resolve()
        context = playwright.chromium.launch_persistent_context(profile, executable_path=args.chromium, headless=True,
            ignore_default_args=["--disable-extensions"], args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}", "--no-sandbox"],
            viewport={"width": 1440, "height": 1000})
        try:
            result["browserVersion"] = context.browser.version
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            extension_id = worker.url.split("/")[2]
            viewer = f"chrome-extension://{extension_id}/viewer.html"
            context.set_offline(True)
            context.on("request", lambda request: result.__setitem__("httpRequests", result["httpRequests"]+1) if request.url.startswith(("http:", "https:")) else None)
            context.on("page", lambda page: page.on("pageerror", lambda error: result.__setitem__("browserErrors", result["browserErrors"]+1)))
            # Record only the extension navigation URLs; they should contain no
            # original file location. The capture exists only in this test worker.
            worker.evaluate("""() => {
              globalThis.__testLaunches=[];const create=chrome.tabs.create.bind(chrome.tabs);
              chrome.tabs.create=options=>{__testLaunches.push(options.url);return create(options);};
            }""")

            def launch(source):
                with context.expect_page() as event:
                    # Chrome's event binding exposes dispatch in its isolated
                    # extension worker; this invokes the registered real action.
                    worker.evaluate("source=>chrome.action.onClicked.dispatch({url:source})", source)
                page = event.value
                page.wait_for_load_state("domcontentloaded")
                launch_url = worker.evaluate("__testLaunches.at(-1)")
                assert "source=" not in launch_url and "Synthetic" not in launch_url and "file%3A" not in launch_url
                return page, launch_url

            assert worker.evaluate("chrome.extension.isAllowedFileSchemeAccess()"), "Temporary unpacked profile must allow local file access for this case"
            assert not worker.evaluate("chrome.permissions.contains({origins:['file:///*']})")
            consent, _ = launch(staged.resolve().as_uri())
            allow = consent.get_by_role("button", name="Enable local PDF access for toolbar opening")
            expect(allow).to_be_visible()
            allow.click()
            expect(consent.locator("#viewport")).to_have_attribute("data-loaded-attachment", initial["attachment"], timeout=30000)
            consent.close()
            result["optionalAccessEnabledOnClick"] = True

            page, launch_url = launch(staged.resolve().as_uri())
            expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", initial["attachment"], timeout=30000)
            assert page.locator("body").get_attribute("data-opening-route") == "local-toolbar"
            assert page.url == viewer, "The handoff token was not removed from the final address"
            token = parse_qs(urlparse(launch_url).query)["handoff"][0]
            assert len(token) == 64 and all(character in "0123456789abcdef" for character in token)
            result["automaticLocalToolbar"] = True
            result["sourceNameAbsentFromViewerUrl"] = True
            result["tokenRemovedFromAddress"] = True
            page.screenshot(path=str(args.report / "local-toolbar.png"))

            reused = context.new_page()
            reused.goto(launch_url)
            expect(reused.locator("#status")).to_contain_text("Use Open PDF to select the file")
            assert reused.url == viewer
            expect(reused.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
            reused.locator("#pdf-file").set_input_files(staged.resolve())
            expect(reused.locator("#viewport")).to_have_attribute("data-loaded-attachment", initial["attachment"], timeout=30000)
            result["reusedTokenRefused"] = True
            result["pickerRecovery"] = True

            missing = context.new_page()
            missing.goto(viewer+"?handoff="+"0"*64)
            expect(missing.locator("#status")).to_contain_text("Use Open PDF to select the file")
            assert missing.url == viewer
            result["missingOrRestartedTokenFallback"] = True

            legacy = context.new_page()
            legacy.goto(viewer+"?source=file%3A%2F%2F%2Ftmp%2FSynthetic-study.pdf")
            expect(legacy.locator("#status")).to_contain_text("Use Open PDF to select the file")
            assert legacy.url == viewer
            result["legacyFilenameParameterRemovedAndRefused"] = True

            remote, remote_url = launch("https://example.invalid/Synthetic-study.pdf")
            assert remote_url == viewer
            expect(remote.locator("#status")).to_contain_text("Drop a converted DICOM PDF")
            result["remoteSourceNeverFetched"] = True
            assert result["httpRequests"] == 0
            assert result["browserErrors"] == 0
            result["passed"] = True
        finally:
            context.close()
            (args.report / "handoff-checks.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(f"Chrome {result['browserVersion']}: opaque one-use handoff, automatic local viewing, picker recovery and zero HTTP requests passed")


if __name__ == "__main__":
    main()
