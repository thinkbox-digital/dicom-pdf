#!/usr/bin/env python3
"""Offline extension cine checks using already converted local sample packages.

No samples are modified or uploaded. Private screenshots, profiles, downloads
and detailed reports stay under target/cine-viewing-checks. Console counts only.
Requires the project's existing Playwright/pypdf test environment and Pillow.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
import time

from PIL import Image
from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_extension import launch, extension_identity
from convert_additional_samples import same_bytes
from convert_archives import fingerprint
from sample_inventory import work_path


PROBE = r"""(() => {
  const probe=globalThis.__cineProbe={workers:0,registers:[],frames:[],decoded:[],errors:[],active:0,maxActive:0,maxGap:0,ticks:0,last:performance.now()};
  probe.resetLag=()=>{probe.maxGap=0;probe.ticks=0;probe.last=performance.now();};
  setInterval(()=>{const now=performance.now();probe.maxGap=Math.max(probe.maxGap,now-probe.last);probe.last=now;probe.ticks++;},20);
  const Original=globalThis.Worker;
  globalThis.Worker=class extends Original {
    constructor(url,options){
      super(url,options);this.__dicom=String(url).split('?')[0].endsWith('/dicom.worker.mjs');this.__pending=new Set();
      if(this.__dicom){probe.workers++;this.addEventListener('message',event=>{
        const message=event.data||{};
        if(['decoded','cancelled','error'].includes(message.type)&&this.__pending.delete(message.id)){probe.active--;if(message.type==='decoded')probe.decoded.push(message.result?.sourceFrame);}
        if(message.type==='error')probe.errors.push(message.code||'UNKNOWN');
      });}
    }
    postMessage(message,...rest){
      if(this.__dicom&&message){
        if(message.type==='register')probe.registers.push({bytes:message.bytes?.byteLength||0});
        if(message.type==='decode'){probe.frames.push(message.sourceFrame);this.__pending.add(message.id);probe.active++;probe.maxActive=Math.max(probe.maxActive,probe.active);}
      }
      return super.postMessage(message,...rest);
    }
  };
})();"""


def frame_number(page):
    return int(page.locator("#viewport").get_attribute("data-source-frame") or 0)


def set_frame(page, number):
    page.locator("#frame-number").evaluate("(input,value)=>{input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}", number)
    expect(page.locator("#viewport")).to_have_attribute("data-source-frame", str(number), timeout=60000)
    expect(page.locator("#frame-number")).to_have_value(str(number))
    page.wait_for_timeout(100)


def paused(page):
    expect(page.locator("#cine-play")).to_have_attribute("aria-pressed", "false")
    expect(page.locator("#viewport")).to_have_attribute("data-playing", "false")
    page.wait_for_timeout(200)
    current = frame_number(page)
    page.wait_for_timeout(450)
    assert frame_number(page) == current, "Frames continued changing while playback was paused"
    return current


def start(page):
    page.locator("#cine-play").click()
    expect(page.locator("#cine-play")).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#viewport")).to_have_attribute("data-playing", "true")


def wait_advance(page, old):
    expect(page.locator("#viewport")).not_to_have_attribute("data-source-frame", str(old), timeout=15000)


def set_rate(page, fps):
    page.locator("#cine-fps").evaluate("(input,value)=>{input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}", fps)
    expect(page.locator("#cine-fps")).to_have_value(str(fps))
    expect(page.locator("#cine-status")).to_contain_text("Your playback rate")


def canvas_hash(page, destination):
    canvas = page.locator("#viewport canvas").first
    expect(canvas).to_be_visible()
    data = canvas.screenshot(path=str(destination))
    image = Image.open(io.BytesIO(data)).convert("RGB")
    extrema = image.getextrema()
    assert any(high-low > 10 for low, high in extrema), "Rendered frame has no visible image contrast"
    return {"sha256": hashlib.sha256(image.tobytes()).hexdigest(), "width": image.width, "height": image.height}


def case(context, extension_id, package, report):
    identifier = package["sourceID"]
    pdf, stage = Path(package["output"]), Path(package["staging"])
    reader = PdfReader(pdf)
    manifest = json.loads(reader.attachments["manifest.json"][0])
    assert len(manifest["images"]) == 1, "Cine package must contain one DICOM source"
    entry = manifest["images"][0]
    count = int(entry["fields"]["NumberOfFrames"])
    assert (identifier, count) in (("input-015", 96), ("input-006", 184)), "Unexpected supplied cine test source"
    source = stage / entry["sourcePath"]
    before = fingerprint(source)
    assert before == entry["sha256"], "Source no longer matches its converted package"
    result = {"sourceID": identifier, "frameCount": count, "sourceBytes": source.stat().st_size, "sourceSha256": before, "frames": {}}
    page = context.new_page()
    try:
        page.goto(f"chrome-extension://{extension_id}/viewer.html", wait_until="domcontentloaded")
        page.locator("#pdf-file").set_input_files(pdf)
        expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"], timeout=120000)
        expect(page.locator("#frame-count")).to_have_text(str(count))
        expect(page.locator("#frame-number")).to_have_attribute("max", str(count))
        expect(page.locator("#selected-source")).to_have_text(entry["sourcePath"])
        expect(page.locator("#cine-controls")).to_be_visible()
        expect(page.locator("#frame-control")).to_be_visible()
        assert page.evaluate("!!globalThis.__cineProbe"), "Worker instrumentation was not installed"
        result["sourceTimingLabel"] = page.locator("#cine-status").inner_text()
        result["sourceFps"] = float(page.locator("#cine-fps").input_value())
        expected_fps = 1000/33 if identifier == "input-015" else 10
        assert abs(result["sourceFps"]-expected_fps) < 0.02, "Playback rate differs from supplied FrameTime/default"
        assert ("Source frame time" if identifier == "input-015" else "Viewer default") in result["sourceTimingLabel"]
        page.evaluate("__cineProbe.resetLag()")
        for number in (1, count//2, count):
            start_time = time.monotonic()
            set_frame(page, number)
            result["frames"][str(number)] = {**canvas_hash(page, report / f"{identifier}-frame-{number}.png"),
                                              "openSeconds": round(time.monotonic()-start_time, 3)}
            assert frame_number(page) == number, "Frame labels differ from rendered source frame"
        assert len({item["sha256"] for item in result["frames"].values()}) >= 2, "First/middle/last frames all show identical pixels"
        set_frame(page, count)
        set_rate(page, 5)
        start(page)
        expect(page.locator("#viewport")).to_have_attribute("data-source-frame", re.compile(r"^[1-9]$"), timeout=15000)
        result["loopsToFirstFrame"] = True
        old = frame_number(page)
        set_rate(page, 12)
        wait_advance(page, old)
        page.locator("#brightness").evaluate("input=>{input.value='28';input.dispatchEvent(new Event('input',{bubbles:true}));}")
        page.locator("#contrast").evaluate("input=>{input.value='140';input.dispatchEvent(new Event('input',{bubbles:true}));}")
        page.locator("#rotate-right").click()
        page.locator("#invert").click()
        old = frame_number(page)
        wait_advance(page, old)
        expect(page.locator("#brightness")).to_have_value("28")
        expect(page.locator("#contrast")).to_have_value("140")
        expect(page.locator("#viewport")).to_have_attribute("data-rotation", "90")
        expect(page.locator("#invert")).to_have_attribute("aria-pressed", "true")
        result["adjustmentsPreservedDuringPlayback"] = ["brightness", "contrast", "rotation", "inversion"]
        click_start = time.monotonic()
        page.locator("#toggle-details").click()
        page.locator("#show-details").click()
        result["paneToggleSeconds"] = round(time.monotonic()-click_start, 3)
        assert result["paneToggleSeconds"] < 3, "UI controls stalled during playback"
        page.locator("#cine-play").click()
        result["pausedAtFrame"] = paused(page)
        start(page)
        wait_advance(page, result["pausedAtFrame"])
        page.locator("#show-pdf").click()
        expect(page.locator("#pdf-view")).to_be_visible()
        result["pdfSwitchPausedAtFrame"] = paused(page)
        page.locator("#show-image").click()
        expect(page.locator("#viewport")).to_be_visible()
        start(page)
        old = frame_number(page)
        wait_advance(page, old)
        other = context.new_page()
        try:
            other.goto("about:blank")
            other.bring_to_front()
            deadline = time.monotonic()+1
            while not page.evaluate("document.hidden") and time.monotonic()<deadline:
                page.wait_for_timeout(50)
            native_hidden = page.evaluate("document.hidden")
            result["nativeTabVisibility"] = "PASS" if native_hidden else "NOT_CHECKED"
            if not native_hidden:
                # Automated Chromium can keep every tab visible. Exercise the
                # production handler while documenting that this is simulated.
                page.evaluate("()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}")
                result["visibilityHandlerSimulated"] = True
            result["backgroundPausedAtFrame"] = paused(page)
        finally:
            other.close()
            if result.get("visibilityHandlerSimulated"):
                page.evaluate("()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));}")
        page.bring_to_front()
        paused(page)
        with page.expect_download() as event:
            page.locator("#download-original").click()
        download = report / f"{identifier}-recovered-original.dcm"
        event.value.save_as(download)
        assert same_bytes(source, download) and fingerprint(download) == before, "Browser original download changed source bytes"
        assert fingerprint(source) == before, "Browser checks modified a supplied original"
        result["originalDownloadByteIdentical"] = True
        if identifier == "input-006":
            page.evaluate("__cineProbe.resetLag()")
            export_start = time.monotonic()
            page.locator("#export-csv").click()
            expect(page.locator("#metadata-export-dialog")).to_be_visible()
            expect(page.locator("#export-csv-confirm")).to_be_enabled(timeout=60000)
            with page.expect_download() as event:
                page.locator("#export-csv-confirm").click()
            metadata_file = report / f"{identifier}-metadata.csv"
            event.value.save_as(metadata_file)
            with metadata_file.open(encoding="utf-8-sig", newline="") as stream:
                exported = csv.DictReader(stream)
                rows = list(exported)
                columns = exported.fieldnames
            assert len(rows) == 1 and len(columns) > 20, "Large-original CSV contains headers without its metadata row"
            assert rows[0]["Source file"] == entry["sourcePath"] and rows[0]["SHA-256"] == before
            assert rows[0]["SOP Instance UID"] == entry["sopInstanceUID"]
            frame_column = next(name for name in columns if name.startswith("NumberOfFrames [dataset/"))
            assert rows[0][frame_column] == str(count), "CSV frame metadata differs from the original"
            result["metadataCsv"] = {"rows": len(rows), "columns": len(columns), "bytes": metadata_file.stat().st_size,
                                     "seconds": round(time.monotonic()-export_start, 3)}
        worker = page.evaluate("({workers:__cineProbe.workers,registers:__cineProbe.registers,decodeCount:__cineProbe.frames.length,decodedCount:__cineProbe.decoded.length,maxConcurrent:__cineProbe.maxActive,errorCodes:__cineProbe.errors,maxUiGapMs:__cineProbe.maxGap,uiTicks:__cineProbe.ticks})")
        assert worker["workers"] == 1 and len(worker["registers"]) == 1, "Multiframe playback repeatedly registered/copied its original"
        assert worker["registers"][0]["bytes"] == source.stat().st_size
        assert worker["maxConcurrent"] == 1, "Concurrent foreground decoder requests were observed"
        assert not worker["errorCodes"], "Decoder errors occurred during cine checks"
        assert worker["uiTicks"] > 0 and worker["maxUiGapMs"] < 1500, "Main-thread UI heartbeat stalled during image/metadata handling"
        result["worker"] = worker
        page.screenshot(path=str(report / f"{identifier}-viewer.png"))
        result["status"] = "PASS"
        return result
    finally:
        (report / f"{identifier}-case.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
        page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--conversion-report", type=Path, default=Path("target/additional-samples/conversion-summary.json"))
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    parser.add_argument("--headed", action="store_true", help="Use a local display to check genuine background-tab visibility")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    report = project / "target/cine-viewing-checks"
    work_path(report, ".")
    report.mkdir(parents=True, exist_ok=True)
    packages = json.loads(args.conversion_report.read_text(encoding="utf-8"))["packages"]
    selected = [next(row for row in packages if row["sourceID"] == identifier) for identifier in ("input-015", "input-006")]
    result = {"offline": True, "headed": args.headed, "httpRequestCount": 0, "pageErrorCount": 0, "cases": [],
              "extensionAssets": {name: fingerprint(args.extension / name) for name in ("manifest.json", "viewer.js", "dicom.worker.mjs")}}
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=report) as profile:
        extension = args.extension.resolve(strict=True)
        if args.headed:
            context = playwright.chromium.launch_persistent_context(str(profile), executable_path=args.chromium, headless=False,
                accept_downloads=True, ignore_default_args=["--disable-extensions"],
                args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}", "--no-sandbox"],
                viewport={"width": 1440, "height": 1000}, timeout=30000)
        else:
            context = launch(playwright, args.chromium, extension, profile)
        try:
            result["browserVersion"] = context.browser.version
            extension_id = extension_identity(context)
            context.set_offline(True)
            context.add_init_script(PROBE)
            context.on("request", lambda request: result.__setitem__("httpRequestCount", result["httpRequestCount"]+1) if request.url.startswith(("http:", "https:")) else None)
            context.on("weberror", lambda error: result.__setitem__("pageErrorCount", result["pageErrorCount"]+1))
            for package in selected:
                try:
                    result["cases"].append(case(context, extension_id, package, report))
                except Exception as error:
                    result["cases"].append({"sourceID": package["sourceID"], "status": "FAIL", "errorType": type(error).__name__, "reason": str(error)})
                (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
                print(json.dumps({"completedCases": len(result["cases"]), "passedCases": sum(row["status"] == "PASS" for row in result["cases"])}), flush=True)
        finally:
            context.close()
    success = len(result["cases"]) == 2 and all(row["status"] == "PASS" for row in result["cases"]) and not result["httpRequestCount"] and not result["pageErrorCount"]
    result["status"] = "PASS" if success else "FAIL"
    (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "cases": len(result["cases"]), "httpRequests": result["httpRequestCount"], "pageErrors": result["pageErrorCount"]}))
    return 0 if success else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "FAIL", "errorType": type(error).__name__}))
        raise SystemExit(1)
