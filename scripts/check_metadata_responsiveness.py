#!/usr/bin/env python3
"""Measure large-MR metadata UI phases offline without exposing source values.

Uses the already converted input-006 preservation package. Reports and recovered
CSV files remain private local artifacts under target/metadata-responsiveness.
Performance findings are separate from functional correctness and byte integrity.
"""
import argparse
import csv
import json
from pathlib import Path
import re
import tempfile
import time

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_extension import launch, extension_identity
from convert_archives import fingerprint
from sample_inventory import work_path


PROBE = r"""(() => {
  const probe=globalThis.__metaBench={current:null,marks:{}};
  probe.begin=name=>{probe.current={name,last:performance.now(),ticks:0,maxGapMs:0,gapsOver50ms:0};};
  probe.end=()=>{const result=probe.current;probe.current=null;return result;};
  setInterval(()=>{const p=probe.current;if(!p)return;const now=performance.now(),gap=now-p.last;p.last=now;p.ticks++;p.maxGapMs=Math.max(p.maxGapMs,gap);p.maxRenderedOptions=Math.max(p.maxRenderedOptions||0,document.querySelector('#export-metadata-fields')?.options.length||0);if(gap>50)p.gapsOver50ms++;},10);
})();"""


def spreadsheet(value):
    text = "" if value is None else str(value)
    return "'"+text if re.match(r"^\s*[=+@-]|^[\t\r\n]", text) else text


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        parsed = csv.DictReader(stream)
        rows = list(parsed)
        return parsed.fieldnames, rows


def save_csv(page, destination):
    with page.expect_download() as event:
        page.locator("#export-csv-confirm").click()
    event.value.save_as(destination)
    return read_csv(destination)


def ready(page):
    expect(page.locator("#metadata-export-dialog")).to_be_visible()
    expect(page.locator("#export-csv-confirm")).to_be_enabled(timeout=60000)


def open_dialog(page):
    page.locator("#export-csv").click()
    ready(page)


def identity(row, entry):
    assert row["Source file"] == spreadsheet(entry["sourcePath"]), "CSV source path differs from the unchanged original"
    assert row["SHA-256"] == entry["sha256"], "CSV source SHA-256 differs from the original"
    assert row["SOP Instance UID"] == spreadsheet(entry["sopInstanceUID"]), "CSV instance identifier differs from the original"


def displayed_paths(page):
    return page.locator("#export-metadata-fields").evaluate("select=>[...select.options].map(option=>option.value)")


def search_path(page, path):
    page.locator("#metadata-field-search").fill(path)
    expect(page.locator("#export-metadata-fields option").first).to_have_attribute("value", path)
    expect(page.locator("#export-metadata-fields option")).to_have_count(1)
    assert displayed_paths(page) == [path], "Search did not expose the exact metadata path"


def select_paths(page, paths, paged):
    if not paged:
        page.locator("#export-metadata-fields").select_option(paths)
        return
    for path in paths:
        search_path(page, path)
        page.locator("#export-metadata-fields").select_option(path)


def measure(page, report, name, action):
    page.evaluate("name=>__metaBench.begin(name)", name)
    start = time.monotonic()
    value = action()
    page.wait_for_timeout(50)
    stats = page.evaluate("__metaBench.end()")
    stats.pop("last", None)
    stats["wallMs"] = round((time.monotonic()-start)*1000, 1)
    stats["maxGapMs"] = round(stats["maxGapMs"], 1)
    report["phases"].append(stats)
    print(json.dumps({"phase": name, "maxHeartbeatGapMs": stats["maxGapMs"], "wallMs": stats["wallMs"]}), flush=True)
    return value


def benchmark(page, pdf, entry, metadata, destination, report):
    page.locator("#pdf-file").set_input_files(pdf)
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"], timeout=120000)
    expect(page.locator("#frame-count")).to_have_text("184")
    measure(page, report, "open-dialog", lambda: open_dialog(page))
    field_list = page.locator("#export-metadata-fields")
    context = page.locator("#metadata-fields").evaluate("element=>Object.fromEntries([...element.querySelectorAll('dt')].map(term=>[term.textContent,term.nextElementSibling.textContent]))")
    original_paths = page.evaluate("paths=>[...new Set(paths)].sort((a,b)=>a.localeCompare(b))",
        [*[element["path"] for element in metadata["elements"]], *["package/selected-original/"+label for label in context]])
    paged = page.locator("#metadata-field-search").count() > 0
    expected_visible = original_paths[:200] if paged else original_paths
    assert displayed_paths(page) == expected_visible and len(original_paths) > 12000, "Metadata selector omitted, reordered or duplicated source paths"
    report["selectorFields"] = len(original_paths)
    report["pagedFieldPicker"] = paged
    header, rows = measure(page, report, "all-fields-csv", lambda: save_csv(page, destination / "all-fields.csv"))
    assert len(rows) == 1 and len(header) == 12929, "All-fields CSV must contain its source row and all 12,929 columns"
    identity(rows[0], entry)
    frame_header = next(name for name in header if name.startswith("NumberOfFrames [dataset/"))
    assert rows[0][frame_header] == "184", "Frame count differs from the DICOM source"
    report["allFieldsCsv"] = {"rows": len(rows), "columns": len(header), "bytes": (destination / "all-fields.csv").stat().st_size}
    measure(page, report, "reopen-dialog", lambda: open_dialog(page))
    measure(page, report, "selected-field-scope", lambda: page.locator("#export-field-scope").select_option("selected"))
    expect(field_list).to_be_enabled()
    measure(page, report, "select-all-fields", lambda: page.locator("#export-fields-all").click())
    assert field_list.evaluate("select=>select.selectedOptions.length") == len(expected_visible)
    if paged:
        search_path(page, original_paths[-1])
        assert field_list.evaluate("select=>select.options[0].selected"), "Select all omitted fields outside the current page"
        page.locator("#metadata-field-search").fill("")
        expect(field_list.locator("option")).to_have_count(len(expected_visible))
    measure(page, report, "clear-field-selection", lambda: page.locator("#export-fields-none").click())
    assert field_list.evaluate("select=>select.selectedOptions.length") == 0
    per_frame = [element for element in metadata["elements"] if element["path"].startswith("dataset/(5200,9230)[184]/")
                 and element["encoding"] == "dicom-value-string"][-3:]
    assert len(per_frame) == 3, "Original metadata lacks the expected final-frame fields"
    selected = list(dict.fromkeys([*original_paths[-4:], *[element["path"] for element in per_frame]]))
    measure(page, report, "select-tail-and-frame-fields", lambda: select_paths(page, selected, paged))
    page.locator("#export-csv-layout").select_option("rows")
    header, rows = measure(page, report, "selected-fields-csv", lambda: save_csv(page, destination / "selected-final-frame-fields.csv"))
    assert {row["Path"] for row in rows} == set(selected), "Selected CSV omitted tail/final-frame paths or leaked unselected fields"
    by_path = {element["path"]: element for element in metadata["elements"]}
    for row in rows:
        identity(row, entry)
        if row["Path"].startswith("package/selected-original/"):
            label = row["Path"].removeprefix("package/selected-original/")
            assert row["Value"] == spreadsheet(context[label]), "Selected-original CSV context differs from the details pane"
        else:
            original = by_path[row["Path"]]
            assert all(row[name] == spreadsheet(original[key]) for name, key in (("Value", "value"), ("Tag", "tag"), ("Keyword", "keyword"), ("VR", "vr"), ("Encoding", "encoding"))), "Final-frame metadata differs from the unchanged source inventory"
    report["selectedFieldsCsv"] = {"rows": len(rows), "columns": len(header), "finalFrameFields": len(per_frame), "lastSelectorPathsChecked": 4}
    if paged:
        # Compare cancellation with the same unfiltered catalog as the baseline.
        page.locator("#metadata-field-search").evaluate("input=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));}")
        page.wait_for_timeout(120)

    def cancel_in_flight():
        page.evaluate("""() => {
          __metaBench.marks.cancelRequested=performance.now();document.querySelector('#export-csv').click();
          setTimeout(()=>{__metaBench.marks.cancelApplied=performance.now();document.querySelector('#export-csv-cancel').click();},15);
        }""")
        expect(page.locator("#metadata-export-dialog")).not_to_be_visible(timeout=60000)
        page.wait_for_timeout(100)
        assert not page.locator("#metadata-export-dialog").evaluate("dialog=>dialog.open"), "Cancelled metadata dialog reopened from a stale callback"
    measure(page, report, "cancel-during-population", cancel_in_flight)
    marks = page.evaluate("__metaBench.marks")
    report["cancelTimerDriftMs"] = round(max(0, marks["cancelApplied"]-marks["cancelRequested"]-15), 1)

    def scope_race():
        page.evaluate("""() => {
          const start=performance.now();__metaBench.marks.scopeStart=start;__metaBench.marks.scopeApplied=[];
          document.querySelector('#export-csv').click();
          for(const [delay,value] of [[10,'all'],[20,'selected']])setTimeout(()=>{
            __metaBench.marks.scopeApplied.push({delay,at:performance.now()-start});
            const scope=document.querySelector('#export-image-scope');scope.value=value;scope.dispatchEvent(new Event('change',{bubbles:true}));
          },delay);
        }""")
        ready(page)
        page.wait_for_timeout(80)
        ready(page)
        expect(page.locator("#export-image-scope")).to_have_value("selected")
        if paged:
            page.locator("#metadata-field-search").fill("")
        expect(field_list.locator("option")).to_have_count(len(expected_visible))
        paths = displayed_paths(page)
        assert paths == expected_visible and len(paths) == len(set(paths)), "A stale scope request changed or duplicated field options"
    measure(page, report, "scope-change-race", scope_race)
    marks = page.evaluate("__metaBench.marks")
    report["scopeTimerDriftMs"] = [round(max(0, value["at"]-value["delay"]), 1) for value in marks["scopeApplied"]]
    page.locator("#export-field-scope").select_option("all")
    page.locator("#export-csv-layout").select_option("columns")
    header, rows = measure(page, report, "post-race-all-fields-csv", lambda: save_csv(page, destination / "post-race-all-fields.csv"))
    assert len(rows) == 1 and len(header) == 12929, "Cancellation/scope replacement changed the export inventory"
    identity(rows[0], entry)
    report["cancelAndScopeRace"] = "PASS"
    report["maxRenderedFieldOptions"] = max(phase.get("maxRenderedOptions", 0) for phase in report["phases"])
    if paged:
        assert report["maxRenderedFieldOptions"] <= 200, "Paged metadata picker exceeded its rendered-option bound"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", choices=("baseline", "after"), required=True)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    parser.add_argument("--max-gap-ms", type=float, default=100)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    destination = project / "target/metadata-responsiveness" / args.label
    work_path(destination, ".")
    destination.mkdir(parents=True, exist_ok=True)
    conversion = json.loads((project / "target/additional-samples/conversion-summary.json").read_text(encoding="utf-8"))
    package = next(row for row in conversion["packages"] if row["sourceID"] == "input-006")
    pdf = Path(package["output"])
    reader = PdfReader(pdf)
    manifest = json.loads(reader.attachments["manifest.json"][0])
    entry = manifest["images"][0]
    metadata = json.loads(reader.attachments["dicom-metadata.json"][0])["images"][0]
    source = Path(package["staging"]) / entry["sourcePath"]
    before = fingerprint(source)
    assert before == entry["sha256"] == metadata["sha256"] and entry["sopInstanceUID"] == metadata["sopInstanceUID"]
    extension = args.extension.resolve(strict=True)
    asset_hash = fingerprint(extension / "viewer.js")
    report = {"label": args.label, "sourceID": "input-006", "sourceBytes": source.stat().st_size, "sourceSha256": before,
              "extensionViewerSha256": asset_hash, "heartbeatIntervalMs": 10, "performanceBudgetMs": args.max_gap_ms,
              "httpRequests": 0, "pageErrors": 0, "phases": []}
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=destination) as profile:
        context = launch(playwright, args.chromium, extension, profile)
        try:
            report["browserVersion"] = context.browser.version
            extension_id = extension_identity(context)
            context.set_offline(True)
            context.add_init_script(PROBE)
            context.on("request", lambda request: report.__setitem__("httpRequests", report["httpRequests"]+1) if request.url.startswith(("http:", "https:")) else None)
            context.on("weberror", lambda error: report.__setitem__("pageErrors", report["pageErrors"]+1))
            page = context.new_page()
            page.goto(f"chrome-extension://{extension_id}/viewer.html", wait_until="domcontentloaded")
            try:
                benchmark(page, pdf, entry, metadata, destination, report)
                report["functionalStatus"] = "PASS"
            except Exception as error:
                report["functionalStatus"] = "FAIL"
                report["failure"] = {"errorType": type(error).__name__, "reason": str(error)}
        finally:
            context.close()
    report["sourceUnchanged"] = fingerprint(source) == before
    report["extensionUnchanged"] = fingerprint(extension / "viewer.js") == asset_hash
    report["performanceStatus"] = "WITHIN_BUDGET" if report["phases"] and all(phase["maxGapMs"] <= args.max_gap_ms for phase in report["phases"]) else "OVER_BUDGET"
    report["status"] = "PASS" if report["functionalStatus"] == "PASS" and report["sourceUnchanged"] and report["extensionUnchanged"] and not report["httpRequests"] and not report["pageErrors"] else "FAIL"
    (destination / "summary.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("label", "status", "performanceStatus", "sourceUnchanged", "httpRequests", "pageErrors")}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "FAIL", "errorType": type(error).__name__}))
        raise SystemExit(1)
