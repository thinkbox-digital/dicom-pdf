#!/usr/bin/env python3
"""Check local files/folder/ZIP ingestion offline using synthetic inputs only.

Reports, generated ZIPs, profiles and recovered files remain under target/.
No source fixtures are modified. Console output contains aggregate counts only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import tempfile
import time
import zipfile

from playwright.sync_api import expect, sync_playwright

from check_extension import launch, extension_identity
from convert_archives import fingerprint
from sample_inventory import work_path


PROBE = r"""(() => {
  const probe=globalThis.__inputProbe={workers:0,terminated:0,requests:0,uiReads:0,models:[],progress:[],failedCodes:[],failWorker:false};
  const read=Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer=function(...args){probe.uiReads++;return read.apply(this,args);};
  Object.defineProperty(globalThis,'showDirectoryPicker',{configurable:true,value:undefined});
  const Original=globalThis.Worker;
  globalThis.Worker=class extends Original {
    constructor(url,options){
      const input=String(url).split('?')[0].endsWith('/dicom-input.worker.mjs');
      if(probe.failWorker)throw new Error('Synthetic unavailable input worker');
      super(url,options);this.__input=input;if(input)probe.workers++;this.addEventListener('message',event=>{
        const message=event.data||{};
        if(this.__input&&message.type==='progress')probe.progress.push(message.progress?.phase);
        if(this.__input&&message.type==='error')probe.failedCodes.push(message.code);
        if(message.type==='result'&&message.result?.inputKind==='direct-dicom'){
          const m=message.result;
          probe.models.push({inputKind:m.inputKind,preservationStatus:m.preservationStatus,
            entries:m.entries.map(e=>({attachment:e.attachment,sourcePath:e.sourcePath,sha256:e.sha256,size:e.size,kind:e.kind,sopInstanceUID:e.sopInstanceUID,
              fields:e.fields,parsing:e.parsing,displayEligibility:e.displayEligibility,diagnostics:e.diagnostics})),
            containers:m.containers.map(c=>({attachment:c.attachment,sourcePath:c.sourcePath,sha256:c.sha256,size:c.size,status:c.status,diagnostics:c.diagnostics})),
            references:m.references,diagnostics:m.diagnostics});
        }
      });
    }
    postMessage(message,...rest){if(message?.type==='ingest'){if(!this.__input){this.__input=true;probe.workers++;}probe.requests++;}return super.postMessage(message,...rest);}
    terminate(){if(this.__input)probe.terminated++;return super.terminate();}
  };
})();"""


def fixture_inputs(project, report):
    source = project / "fixtures/spec-directory"
    expected = {path.relative_to(source).as_posix(): path.read_bytes() for path in sorted(source.rglob("*")) if path.is_file()}
    archive = report / "inputs/synthetic-media.payload"
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        for name, data in expected.items():
            output.writestr(name, data)
    native = (project / "fixtures/expanded/ct-explicit-le-16.dcm").read_bytes()
    meta_end = 144+struct.unpack_from("<I", native, 140)[0]
    unsupported = (project / "fixtures/expanded/mr-explicit-le-signed16.dcm").read_bytes()
    actual_syntax = b"1.2.840.10008.1.2.1\x00"
    assert unsupported.count(actual_syntax) == 1, "Synthetic source has an unexpected transfer-syntax layout"
    unsupported = unsupported.replace(actual_syntax, b"1.2.840.10008.1.2.9\x00", 1)
    edge = {"copy-a.dcm": native, "copy-b.dcm": native, "raw-without-preamble": native[meta_end:],
            "unsupported-syntax.dcm": unsupported, "DICOMDIR": expected["DICOMDIR"],
            "corrupt.dcm": (project / "fixtures/synthetic/unsupported/corrupt.dcm").read_bytes()}
    edge_folder = report / "inputs/edge-cases"
    edge_folder.mkdir(exist_ok=True)
    for name, data in edge.items():
        (edge_folder / name).write_bytes(data)
    return source, expected, archive, edge_folder, edge


def wait_model(page):
    deadline = time.monotonic()+45
    while time.monotonic()<deadline:
        model = page.evaluate("__inputProbe.models.at(-1)||null")
        if model:
            return model
        page.wait_for_timeout(50)
    raise AssertionError("Input worker returned no normalized source model")


def tree(model):
    return {"entries": sorted([{key: entry.get(key) for key in ("sourcePath", "sha256", "size", "kind", "sopInstanceUID", "fields")}
                               for entry in model["entries"]], key=lambda entry: entry["sourcePath"]),
            "references": sorted([{key: ref.get(key) for key in ("sourcePath", "targetSourcePath", "fileId", "status", "sopInstanceUID")}
                                  for ref in model["references"]], key=lambda ref: ref["sourcePath"])}


def check_mode(page, model):
    assert model["inputKind"] == "direct-dicom" and model["preservationStatus"] == "not-a-preservation-pdf"
    count = len(model["entries"])+len(model["containers"])
    expect(page.locator("#image-list option")).to_have_count(count)
    expect(page.locator("#package-role")).to_have_text("Direct local files · not a preservation PDF")
    expect(page.locator("#viewport")).to_have_attribute("data-input-kind", "direct-dicom")
    expect(page.locator("#show-pdf")).to_be_disabled()
    expect(page.locator("#source-retention-note")).to_contain_text("held in memory")
    first = next((entry for entry in model["entries"] if entry["displayEligibility"]["status"] == "candidate"), None)
    if first:
        expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", first["attachment"], timeout=30000)
        expect(page.locator("#viewport canvas").first).to_be_visible()
    return count


def export_originals(page, report, label, expected):
    page.locator("#export-originals").click()
    expect(page.locator("#originals-export-dialog")).to_be_visible()
    page.locator("#originals-export-scope").select_option("all")
    with page.expect_download() as event:
        page.locator("#originals-export-confirm").click()
    destination = report / f"{label}-originals.zip"
    event.value.save_as(destination)
    with zipfile.ZipFile(destination) as archive:
        scope = json.loads(archive.read("scope.json"))
        assert len(scope["originals"]) == len(expected), "Original ZIP recovery inventory lost supplied files/containers"
        actual = set()
        for row in scope["originals"]:
            name = row["sourcePath"]
            assert name in expected, "ZIP recovery contains an unexpected supplied source path"
            data = archive.read(row["zipPath"])
            assert data == expected[name], "ZIP recovery changed original bytes"
            assert row["sha256"] == hashlib.sha256(data).hexdigest(), "ZIP recovery hash differs from original bytes"
            actual.add(name)
        assert actual == set(expected), "ZIP recovery omitted an original"
        assert "RECOVERY.txt" in archive.namelist()
    page.locator("#originals-export-cancel").click()
    return len(actual)


def new_page(context, extension_id):
    page = context.new_page()
    page.goto(extension_id if extension_id.startswith("file:") else f"chrome-extension://{extension_id}/viewer.html", wait_until="domcontentloaded")
    return page


def worker_checks(page):
    result = page.evaluate("({workers:__inputProbe.workers,terminated:__inputProbe.terminated,requests:__inputProbe.requests,uiReads:__inputProbe.uiReads,progress:__inputProbe.progress,errorCodes:__inputProbe.failedCodes})")
    assert result["workers"] == result["terminated"] == result["requests"] == 1, "Input worker lifecycle did not complete once"
    assert result["uiReads"] == 0, "File bytes were read on the main UI thread"
    assert "complete" in result["progress"] and not result["errorCodes"]
    return result


def media_case(context, extension_id, report, source, expected, archive, packed=False):
    label = "zip" if packed else "folder"
    page = new_page(context, extension_id)
    try:
        if packed:
            page.locator("#dicom-files").set_input_files(archive)
        else:
            with page.expect_file_chooser() as event:
                page.locator("#open-folder").click()
            event.value.set_files(source)
        model = wait_model(page)
        count = check_mode(page, model)
        assert len(model["references"]) == 1 and model["references"][0]["status"] == "resolved", "Supplied DICOMDIR did not resolve its extensionless image"
        known = dict(expected)
        if packed:
            known[archive.name] = archive.read_bytes()
        for entry in model["entries"]:
            assert entry["sha256"] == hashlib.sha256(expected[entry["sourcePath"]]).hexdigest()
        recovered = export_originals(page, report, label, known)
        navigation = page.locator("#study-navigation .series-card").all_text_contents()
        page.screenshot(path=str(report / f"{label}-viewer.png"))
        return {"case": label, "status": "PASS", "fileCount": count, "recoveredOriginals": recovered,
                "tree": tree(model), "navigation": navigation, "worker": worker_checks(page)}
    finally:
        page.close()


def edge_case(context, extension_id, report, folder, expected, drop=False):
    label = "drop" if drop else "files"
    page = new_page(context, extension_id)
    try:
        if drop:
            payload = [{"name": name, "bytes": list(data)} for name, data in expected.items()]
            page.evaluate("files=>{const transfer=new DataTransfer();for(const file of files)transfer.items.add(new File([new Uint8Array(file.bytes)],file.name));document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));}", payload)
        else:
            page.locator("#dicom-files").set_input_files([folder / name for name in expected])
        model = wait_model(page)
        count = check_mode(page, model)
        assert count == len(expected)
        by_name = {entry["sourcePath"]: entry for entry in model["entries"]}
        assert len({entry["attachment"] for entry in model["entries"]}) == count, "Duplicate instances were merged"
        assert any(item["code"] == "DUPLICATE_SOP_INSTANCE_UID" for item in model["diagnostics"])
        raw = by_name["raw-without-preamble"]
        assert raw["parsing"]["mode"] == "raw-dataset" and raw["parsing"]["transferSyntaxSource"] == "assumption"
        assert not raw["fields"].get("TransferSyntaxUID"), "Raw dataset acquired invented file metadata"
        page.locator("#image-list").select_option(str(model["entries"].index(raw)))
        expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", raw["attachment"])
        unsupported = by_name["unsupported-syntax.dcm"]
        assert unsupported["displayEligibility"]["status"] == "unsupported"
        assert "UNSUPPORTED_TRANSFER_SYNTAX" in unsupported["displayEligibility"]["codes"]
        page.locator("#image-list").select_option(str(model["entries"].index(unsupported)))
        expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
        expect(page.locator("#viewport")).to_contain_text(re.compile("not supported|unsupported|retained", re.IGNORECASE))
        expect(page.locator("#download-original")).to_be_enabled()
        with page.expect_download() as event:
            page.locator("#download-original").click()
        downloaded = report / f"{label}-unsupported-original.dcm"
        event.value.save_as(downloaded)
        assert downloaded.read_bytes() == expected["unsupported-syntax.dcm"]
        assert any(ref["status"] == "missing" for ref in model["references"]), "Missing DICOMDIR target was not identified"
        expect(page.locator('#references-list [data-reference-status="missing"]')).to_have_count(1)
        expect(page.locator("#references-list")).to_contain_text(re.compile("Duplicate instance|duplicate.*instance", re.IGNORECASE))
        recovered = export_originals(page, report, label, expected)
        page.screenshot(path=str(report / f"{label}-viewer.png"))
        return {"case": label, "status": "PASS", "fileCount": count, "recoveredOriginals": recovered,
                "rawRendered": True, "unsupportedRetained": True, "duplicateIDsDistinct": True, "missingReferencesLabeled": True,
                "tree": tree(model), "worker": worker_checks(page)}
    finally:
        page.close()


def failed_worker(context, extension_id, source):
    page = new_page(context, extension_id)
    try:
        page.evaluate("__inputProbe.failWorker=true")
        page.locator("#dicom-files").set_input_files(source / "IMAGES/IMG00001")
        expect(page.locator("#status")).to_contain_text("could not start the local file reader")
        expect(page.locator("#image-list option")).to_have_count(0)
        assert page.evaluate("__inputProbe.uiReads") == 0, "Unavailable worker triggered main-thread file parsing"
        return {"case": "unavailable-worker", "status": "PASS", "genericError": True, "uiReads": 0}
    finally:
        page.close()


def corrupt_zip(context, extension_id, report):
    path = report / "inputs/archive.zip"
    data = b"PK\x03\x04synthetic invalid ZIP directory"
    path.write_bytes(data)
    page = new_page(context, extension_id)
    try:
        page.locator("#dicom-files").set_input_files(path)
        model = wait_model(page)
        assert check_mode(page, model) == 1
        assert not model["entries"] and len(model["containers"]) == 1
        container = model["containers"][0]
        assert container["status"] == "unreadable" and any(issue["code"] == "ZIP_CORRUPT" for issue in container["diagnostics"])
        page.locator("#image-list").select_option("0")
        expect(page.locator("#viewport")).to_contain_text(re.compile("ZIP|archive", re.IGNORECASE))
        expect(page.locator("#viewport")).to_contain_text(re.compile("could not|unreadable|corrupt|invalid", re.IGNORECASE))
        expect(page.locator("#reset")).to_be_disabled()
        with page.expect_download() as event:
            page.locator("#download-original").click()
        original = report / "corrupt-zip-original.zip"
        event.value.save_as(original)
        assert original.read_bytes() == data
        recovered = export_originals(page, report, "corrupt-zip", {path.name: data})
        return {"case": "corrupt-zip", "status": "PASS", "archiveLabeledUnreadable": True,
                "originalByteIdentical": True, "recoveredOriginals": recovered, "worker": worker_checks(page)}
    finally:
        page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    parser.add_argument("--standalone", type=Path, help="Run against the generated self-contained viewer.html directly from disk")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    report = project / "target/direct-input-checks"
    if args.standalone:
        report = report / "standalone"
    work_path(report, ".")
    report.mkdir(parents=True, exist_ok=True)
    source, expected, archive, edge_folder, edge = fixture_inputs(project, report)
    originals = {path: fingerprint(path) for path in [*source.rglob("*"), project / "fixtures/expanded/ct-explicit-le-16.dcm",
        project / "fixtures/expanded/mr-explicit-le-signed16.dcm", project / "fixtures/synthetic/unsupported/corrupt.dcm"] if path.is_file()}
    result = {"syntheticOnly": True, "offline": True, "standaloneFromDisk": bool(args.standalone), "httpRequests": 0, "pageErrors": 0, "cases": []}
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=report) as profile:
        context = launch(playwright, args.chromium, args.extension.resolve(strict=True), profile)
        try:
            result["browserVersion"] = context.browser.version
            extension_id = extension_identity(context)
            if args.standalone:
                extension_id = args.standalone.resolve(strict=True).as_uri()
            context.set_offline(True)
            context.add_init_script(PROBE)
            context.on("request", lambda request: result.__setitem__("httpRequests", result["httpRequests"]+1) if request.url.startswith(("http:", "https:")) else None)
            context.on("weberror", lambda error: result.__setitem__("pageErrors", result["pageErrors"]+1))
            cases = [("folder", lambda: media_case(context, extension_id, report, source, expected, archive)),
                     ("zip", lambda: media_case(context, extension_id, report, source, expected, archive, packed=True)),
                     ("files", lambda: edge_case(context, extension_id, report, edge_folder, edge)),
                     ("drop", lambda: edge_case(context, extension_id, report, edge_folder, edge, drop=True)),
                     ("corrupt-zip", lambda: corrupt_zip(context, extension_id, report)),
                     ("unavailable-worker", lambda: failed_worker(context, extension_id, source))]
            for label, run in cases:
                try:
                    result["cases"].append(run())
                except Exception as error:
                    result["cases"].append({"case": label, "status": "FAIL", "errorType": type(error).__name__, "reason": str(error)})
                (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
                print(json.dumps({"completedCases": len(result["cases"]), "passedCases": sum(row["status"] == "PASS" for row in result["cases"])}), flush=True)
        finally:
            context.close()
    media = {case["case"]: case for case in result["cases"] if case["case"] in ("folder", "zip") and case["status"] == "PASS"}
    result["folderZipTreesIdentical"] = len(media) == 2 and media["folder"]["tree"] == media["zip"]["tree"] and media["folder"]["navigation"] == media["zip"]["navigation"]
    result["sourceFixturesUnchanged"] = all(fingerprint(path) == sha for path, sha in originals.items())
    result["status"] = "PASS" if (len(result["cases"]) == 6 and all(case["status"] == "PASS" for case in result["cases"])
        and result["folderZipTreesIdentical"] and result["sourceFixturesUnchanged"] and not result["httpRequests"] and not result["pageErrors"]) else "FAIL"
    (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("status", "httpRequests", "pageErrors", "folderZipTreesIdentical", "sourceFixturesUnchanged")}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "FAIL", "errorType": type(error).__name__}))
        raise SystemExit(1)
