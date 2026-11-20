#!/usr/bin/env python3
"""Independently exercise the patient workflow in the built, offline extension.

Browser profiles, screenshots, exported ZIP/PNG files and the result report are
written beneath target/. Supplied originals and converted PDFs stay unchanged.
This supplements check_extension.py; it does not replace that regression suite.
"""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import struct
import sys
import tempfile
import zipfile
from urllib.parse import urlparse

from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect

sys.dont_write_bytecode=True
from check_extension import launch, extension_identity
from check_viewer import check_source_inventory


WORKER_OBSERVER = """() => {
  const OriginalWorker=window.Worker;
  window.__patientWorkerCheck={created:[],sent:{},received:{}};
  window.Worker=class extends OriginalWorker {
    constructor(url,options){
      super(url,options);
      const name=new URL(String(url),document.baseURI).pathname.split('/').pop();
      window.__patientWorkerCheck.created.push(name);
      this.__patientWorkerName=name;
      this.addEventListener('message',event=>{
        const type=event.data?.type;
        if(name==='dicom.worker.mjs'&&typeof type==='string'){
          const counts=window.__patientWorkerCheck.received;counts[type]=(counts[type]||0)+1;
        }
      });
    }
    postMessage(message,...args){
      if(this.__patientWorkerName==='dicom.worker.mjs'&&typeof message?.type==='string'){
        const counts=window.__patientWorkerCheck.sent;counts[message.type]=(counts[message.type]||0)+1;
      }
      return super.postMessage(message,...args);
    }
  };
}"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pixels(frame, export_background=False):
    return frame.locator("#viewport canvas").first.evaluate("""async (canvas, exportBackground) => {
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      if(exportBackground){
        const copy=document.createElement("canvas");
        copy.width=canvas.width;copy.height=canvas.height;
        const ctx=copy.getContext("2d");ctx.fillStyle="#101722";
        ctx.fillRect(0,0,copy.width,copy.height);ctx.drawImage(canvas,0,0);canvas=copy;
      }
      const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const hash=await crypto.subtle.digest('SHA-256',bytes);
      return {width:canvas.width,height:canvas.height,sha256:Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('')};
    }""",export_background)


def loaded(frame, entries, index):
    expect(frame.locator("#image-list")).to_have_value(str(index))
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[index]["attachment"], timeout=120000)
    expect(frame.locator("#selected-source")).to_have_text(entries[index].get("sourcePath") or entries[index]["attachment"])
    expect(frame.locator("#reset")).to_be_enabled()


def select(frame, entries, index):
    frame.locator("#image-list").select_option(str(index))
    loaded(frame, entries, index)


def control_checks(page, frame, entries, report):
    initial=int(frame.locator("#image-list").input_value())
    viewport=frame.locator("#viewport")
    baseline=pixels(frame)
    frame.locator("#rotate-right").click()
    expect(viewport).to_have_attribute("data-rotation", "90")
    assert pixels(frame)["sha256"]!=baseline["sha256"], "Rotation did not change displayed pixels"
    frame.locator("#rotate-left").click()
    expect(viewport).to_have_attribute("data-rotation", "0")
    assert pixels(frame)==baseline, "Inverse rotation did not restore exact source display"
    frame.locator("#rotate-left").click()
    expect(viewport).to_have_attribute("data-rotation", "270")
    frame.locator("#reset").click()
    assert pixels(frame)==baseline, "Reset did not restore rotation"
    frame.locator("#invert").click()
    expect(frame.locator("#invert")).to_have_attribute("aria-pressed", "true")
    expect(viewport).to_have_attribute("data-inverted", "true")
    assert pixels(frame)["sha256"]!=baseline["sha256"], "Invert did not change displayed pixels"
    frame.locator("#reset").click()
    expect(frame.locator("#invert")).to_have_attribute("aria-pressed", "false")
    assert pixels(frame)==baseline, "Reset did not restore original polarity"
    for name,value in [("brightness",30),("contrast",180)]:
        frame.locator("#"+name).evaluate("(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}",value)
    frame.locator("#zoom-in").click()
    assert pixels(frame)["sha256"]!=baseline["sha256"]
    frame.locator("#reset").click()
    assert frame.locator("#brightness").input_value()=="0" and frame.locator("#contrast").input_value()=="100"
    assert pixels(frame)==baseline, "Reset callback did not restore brightness/contrast/camera"
    frame.locator("#zoom-in").click()
    assert pixels(frame)["sha256"]!=baseline["sha256"]
    frame.locator("#fit-view").click()
    assert pixels(frame)==baseline, "Fit did not restore the baseline camera"
    viewport.focus();page.keyboard.press("]")
    expect(viewport).to_have_attribute("data-rotation", "90")
    page.keyboard.press("i");expect(viewport).to_have_attribute("data-inverted", "true")
    page.keyboard.press("r");assert pixels(frame)==baseline
    page.keyboard.press("+");assert pixels(frame)["sha256"]!=baseline["sha256"]
    page.keyboard.press("r");assert pixels(frame)==baseline
    page.keyboard.press("Shift+ArrowRight");assert pixels(frame)["sha256"]!=baseline["sha256"]
    page.keyboard.press("r");assert pixels(frame)==baseline
    # Select a neighboring image through the keyboard and reverse that action.
    page.keyboard.press("ArrowRight")
    expect(frame.locator("#image-list")).not_to_have_value(str(initial),timeout=120000)
    next_index=int(frame.locator("#image-list").input_value());loaded(frame,entries,next_index)
    viewport.focus();page.keyboard.press("ArrowLeft");loaded(frame,entries,initial)
    # Editable controls handle their own keys without rotating/navigating images.
    frame.locator("#brightness").focus();page.keyboard.press("]");page.keyboard.press("i");page.keyboard.press("ArrowRight")
    assert frame.locator("#image-list").input_value()==str(initial)
    expect(viewport).to_have_attribute("data-rotation", "0")
    expect(viewport).to_have_attribute("data-inverted", "false")
    frame.locator("#reset").click();assert pixels(frame)==baseline
    # A viewing copy includes the actual current rendered pixels and a footer.
    frame.locator("#rotate-right").click();frame.locator("#invert").click()
    if frame.locator("#toggle-overlays").get_attribute("aria-pressed")=="true":
        frame.locator("#toggle-overlays").click()
    expect(frame.locator("#image-overlays")).to_be_hidden()
    current=pixels(frame,export_background=True)
    frame.locator('#save-menu > summary').click()
    with page.expect_download(timeout=30000) as event:
        frame.locator("#save-view").click()
    destination=report/"downloads"/"dicom-view-copy.png";destination.parent.mkdir(parents=True,exist_ok=True)
    event.value.save_as(destination);data=destination.read_bytes()
    assert data[:8]==b"\x89PNG\r\n\x1a\n", "Viewing copy is not a PNG"
    width,height=struct.unpack(">II",data[16:24]);assert (width,height)==(current["width"],current["height"]+36)
    copy=frame.evaluate("""async ({data,height}) => {
      const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const hash=await crypto.subtle.digest('SHA-256',context.getImageData(0,0,canvas.width,canvas.height).data);
      return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
    }""",{"data":base64.b64encode(data).decode("ascii"),"height":current["height"]})
    assert copy==current["sha256"], "Saved PNG did not contain the current displayed image"
    frame.locator("#reset").click();assert pixels(frame)==baseline
    fullscreen="unsupported"
    frame.locator("#fullscreen").click();page.wait_for_timeout(250)
    if frame.evaluate("Boolean(document.fullscreenElement)"):
        fullscreen="checked"
        expect(frame.locator("#fullscreen")).to_have_attribute("aria-pressed","true")
        assert frame.evaluate("document.fullscreenElement.id")=="image-view"
        frame.locator("#fullscreen").click()
        expect(frame.locator("#fullscreen")).to_have_attribute("aria-pressed","false")
        page.wait_for_timeout(150);frame.locator("#reset").click()
        assert pixels(frame)==baseline, "Fullscreen roundtrip changed baseline display"
    else:
        expect(frame.locator("#status")).to_contain_text("Fullscreen is unavailable")
    return {"rotation":True,"sourcePolarityReset":True,"brightnessContrastReset":True,"fit":True,
            "keyboardNavigation":True,"keyboardDisplay":True,"editableInputExclusion":True,
            "pngCurrentPixels":True,"pngDimensions":[width,height],"fullscreen":fullscreen,"baseline":baseline}


def navigation_checks(page, frame, entries):
    expect(frame.locator("#study-navigation")).to_be_visible()
    original_options=frame.locator("#image-list option").evaluate_all("options=>options.map(option=>option.value)")
    _, ancillary = check_source_inventory(frame,entries)
    initial=int(frame.locator("#image-list").input_value())
    cards=frame.locator(".series-card");assert 0<cards.count()<=40
    expect(frame.locator('.series-card[aria-current="true"]')).to_have_count(1)
    first_index=int(cards.first.get_attribute("data-source-index"))
    cards.first.click();loaded(frame,entries,first_index)
    expect(cards.first).to_have_attribute("aria-current","true")
    expect(frame.locator(".series-thumbnail canvas").first).to_be_visible(timeout=120000)
    thumbnails=frame.locator(".series-thumbnail canvas").evaluate_all("canvases=>canvases.map(canvas=>({width:canvas.width,height:canvas.height,pixels:canvas.toDataURL()}))")
    assert all(0<item["width"]<=160 and 0<item["height"]<=160 for item in thumbnails)
    frame.locator("#rotate-right").click();frame.locator("#invert").click()
    after=frame.locator(".series-thumbnail canvas").evaluate_all("canvases=>canvases.map(canvas=>({width:canvas.width,height:canvas.height,pixels:canvas.toDataURL()}))")
    assert after==thumbnails, "Interactive adjustments mutated baseline thumbnails"
    frame.locator("#reset").click()
    selected=frame.locator("#image-list").input_value()
    search_visible=frame.locator(".series-search").is_visible()
    if search_visible:
        frame.locator(".series-search").fill("no matching supplied series 8bbd36")
        expect(cards).to_have_count(0)
        assert frame.locator("#image-list").input_value()==selected
        frame.locator(".series-search").fill("");assert cards.count()>0
    # Native image selection must continue to update the selected card.
    select(frame,entries,initial)
    expect(frame.locator('.series-card[aria-current="true"]')).to_have_count(1)
    assert set(frame.locator("#image-list option").evaluate_all("options=>options.map(option=>option.value)"))==set(original_options)
    if entries[initial].get("referencePage"):
        frame.locator("#show-pdf").click()
        expect(frame.locator("#page-number")).to_have_value(str(entries[initial]["referencePage"]))
        frame.locator("#show-image").click();loaded(frame,entries,initial)
        expect(frame.locator('.series-card[aria-current="true"]')).to_have_count(1)
    return {"sourceOptionCount":len(original_options),"studyCount":frame.locator(".study-picker option:not(:disabled)").count(),
            "seriesCards":cards.count(),"thumbnailCount":len(thumbnails),"thumbnailBaselineUnchanged":True,
            "cardSelectsOriginal":True,"nativeSelectionTracked":True,"pdfRoundtrip":True,
            "searchPreservesSource":True if search_visible else "hidden for small series list","otherSourceCount":len(ancillary)}


def zip_check(page, frame, manifest, attachments, raw_manifest, report, scope):
    entries=manifest["images"];index=int(frame.locator("#image-list").input_value());selected=entries[index]
    if scope=="all":expected=entries
    elif scope=="selected":expected=[selected]
    elif scope=="study":
        study=selected["fields"]["StudyInstanceUID"]
        expected=[entry for entry in entries if entry.get("fields",{}).get("StudyInstanceUID")==study]
    else:
        fields=selected.get("fields",{});series=fields.get("SeriesInstanceUID")
        expected=[entry for entry in entries if entry.get("fields",{}).get("SeriesInstanceUID")==series
                  and (entry.get("fields",{}).get("StudyInstanceUID") or "")== (fields.get("StudyInstanceUID") or "")] if series else [selected]
    frame.locator("#save-menu > summary").click()
    frame.locator("#export-originals").click();expect(frame.locator("#originals-export-dialog")).to_be_visible()
    frame.locator("#originals-export-scope").select_option(scope)
    with page.expect_download(timeout=120000) as event:
        frame.locator("#originals-export-confirm").click()
    destination=report/"downloads"/("originals-"+scope+".zip");destination.parent.mkdir(parents=True,exist_ok=True)
    event.value.save_as(destination)
    with zipfile.ZipFile(destination) as archive:
        names=archive.namelist();assert len(names)==len(set(names)),"ZIP contains duplicate paths"
        for name in names:
            assert not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts and "\\" not in name
        inventory=json.loads(archive.read("scope.json"));assert inventory["schemaVersion"]==1 and inventory["scope"]==scope
        assert inventory["completeOriginalInventory"]==(scope=="all")
        assert inventory["clinicalCompleteness"]=="not-assessed"
        assert len(inventory["originals"])==len(expected)
        assert {row["attachment"] for row in inventory["originals"]}=={entry["attachment"] for entry in expected}
        expected_names={"scope.json","RECOVERY.txt"}
        for entry in expected:
            name="originals/"+entry["sourcePath"];expected_names.add(name)
            recovered=archive.read(name);original=attachments[entry["attachment"]][0]
            assert recovered==original, "Recovered original differs from embedded original"
            assert len(recovered)==entry["size"] and sha(recovered)==entry["sha256"]
            row=next(row for row in inventory["originals"] if row["attachment"]==entry["attachment"])
            assert row["sourcePath"]==entry["sourcePath"] and row["zipPath"]==name and row["sha256"]==entry["sha256"]
            assert row["size"]==entry["size"] and row["sopInstanceUID"]==entry.get("sopInstanceUID")
        if scope=="all":
            assert archive.read("package/manifest.json")==raw_manifest
            originals={entry["attachment"] for entry in entries}
            for name,values in attachments.items():
                if name in originals:continue
                expected_names.add("package/"+name);assert archive.read("package/"+name)==values[0]
        else:
            assert inventory["originalManifest"] is None
            assert inventory["sourceManifestSha256"]==sha(raw_manifest)
            assert not any(name.startswith("package/") for name in names)
        assert set(names)==expected_names,"ZIP contains unexpected or missing files"
        instructions=archive.read("RECOVERY.txt").decode("utf-8")
        assert "SHA-256" in instructions and "unchanged bytes" in instructions and "de-identified" in instructions
        assert ("every supplied" if scope=="all" else "selected subset") in instructions
    frame.locator("#originals-export-cancel").click()
    return {"scope":scope,"originals":len(expected),"allBytesMatch":True,"sourcePathsRetained":True,
            "manifestDigestMatches":True,"fullManifestIncluded":scope=="all","subsetExplicit":scope!="all","zipFiles":len(names)}


def worker_checks(frame):
    observed=frame.evaluate("window.__patientWorkerCheck")
    assert observed and "dicom.worker.mjs" in observed["created"],"DICOM worker was never created"
    assert observed["sent"].get("decode",0)>0 and observed["sent"].get("register",0)>0,"No source was decoded in the worker"
    assert observed["received"].get("decoded",0)>0,"Worker returned no decoded image"
    return observed


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension",type=Path,default=Path("target/chrome-extension"))
    parser.add_argument("--pdf",type=Path,nargs="+",default=[Path("target/viewer-test-pdfs/metadata-sample.pdf")])
    parser.add_argument("--chromium",help="Path to Chromium (defaults to Playwright’s installed Chromium)")
    parser.add_argument("--report",type=Path,default=Path("target/patient-workflow-checks"))
    parser.add_argument("--skip-narrow-collapse",action="store_true",help="Allow an older build that predates default narrow-pane collapse")
    args=parser.parse_args();extension=args.extension.resolve(strict=True);args.report.mkdir(parents=True,exist_ok=True);report=args.report.resolve()
    tracked=["manifest.json","viewer.html","viewer.css","viewer.js","dicom.worker.mjs","pdf.worker.mjs"]
    build_hashes={name:sha((extension/name).read_bytes()) for name in tracked}
    result={"viewerVersion":json.loads((extension/"manifest.json").read_text())["version"],"offline":True,"httpRequests":[],"browserErrorCount":0,"cases":[],"assets":build_hashes}
    errors=[]
    try:
        with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix="profile-",dir=report) as profile:
            context=launch(playwright,args.chromium or playwright.chromium.executable_path,extension,profile)
            try:
                result["browserVersion"]=context.browser.version;extension_id=extension_identity(context)
                context.set_offline(True);context.add_init_script("("+WORKER_OBSERVER+")()")
                page=context.pages[0];page.on("pageerror",lambda error:errors.append(type(error).__name__))
                page.on("request",lambda request:result["httpRequests"].append(urlparse(request.url).scheme) if request.url.startswith(("http:","https:")) else None)
                for ordinal,path in enumerate(args.pdf):
                    reader=PdfReader(path);attachments=reader.attachments;raw_manifest=attachments["manifest.json"][0];manifest=json.loads(raw_manifest);entries=manifest["images"]
                    case_report=report/("case-"+str(ordinal));case_report.mkdir(exist_ok=True)
                    page.goto(f"chrome-extension://{extension_id}/viewer.html",wait_until="domcontentloaded")
                    frame=page.main_frame;frame.locator("#pdf-file").set_input_files(path.resolve())
                    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment",re.compile(".+"),timeout=120000)
                    expect(frame.locator("#loading-dialog")).not_to_be_visible(timeout=120000)
                    initial=int(frame.locator("#image-list").input_value())
                    loaded(frame,entries,initial)
                    worker=worker_checks(frame)
                    print(f"Case {ordinal+1}: initial display and dedicated decoder worker passed",flush=True)
                    case={"pdf":path.name,"automaticInitialImage":True,"openRoute":"picker","worker":worker}
                    if ordinal==0:
                        first_case_initial=initial
                        assert frame.locator("#pdf-file").evaluate("input=>input.files.length")==0
                    case["navigation"]=navigation_checks(page,frame,entries)
                    print(f"Case {ordinal+1}: navigation passed",flush=True)
                    if ordinal==0:
                        case["controls"]=control_checks(page,frame,entries,case_report)
                        print(f"Case {ordinal+1}: display controls, keyboard and PNG copy passed",flush=True)
                    scopes=["all","series","selected"]
                    if entries[initial].get("fields",{}).get("StudyInstanceUID"): scopes.append("study")
                    case["archives"]=[zip_check(page,frame,manifest,attachments,raw_manifest,case_report,scope) for scope in scopes]
                    page.screenshot(path=str(case_report/"workflow-1440.png"))
                    page.set_viewport_size({"width":500,"height":900})
                    # A fresh viewer route is needed to check the initial narrow defaults.
                    page.goto(f"chrome-extension://{extension_id}/viewer.html",wait_until="domcontentloaded")
                    frame=page.main_frame;frame.locator("#pdf-file").set_input_files(path.resolve());loaded(frame,entries,initial)
                    if not args.skip_narrow_collapse:
                        expect(frame.locator("#details-panel")).not_to_be_visible();expect(frame.locator("#show-details")).to_be_visible()
                    size=frame.evaluate("({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,viewport:document.querySelector('#viewport').getBoundingClientRect().width})")
                    assert size["scroll"]<=size["width"] and size["viewport"]>200,"Narrow view is obscured or overflows"
                    page.screenshot(path=str(case_report/"workflow-500.png"));case["narrowLayout"]=size
                    page.set_viewport_size({"width":1440,"height":1000});result["cases"].append(case)
                    (report/"patient-workflow-checks.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
                    print(f"Case {ordinal+1}: initial display, worker, navigation and original recovery scopes passed",flush=True)
                # Refuse to display if the dedicated decoder cannot start. There is
                # deliberately no synchronous main-thread decoder fallback.
                negative=context.new_page();negative.add_init_script("""(() => {
                  const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{
                    constructor(url,options){if(String(url).includes('dicom.worker.mjs'))throw new Error('Synthetic worker refusal');super(url,options);}
                  };
                })()""")
                negative.on("pageerror",lambda error:errors.append(type(error).__name__))
                negative.goto(f"chrome-extension://{extension_id}/viewer.html",wait_until="domcontentloaded")
                negative.locator("#pdf-file").set_input_files(args.pdf[0].resolve())
                expect(negative.locator("#viewport")).to_have_attribute("data-input-kind","pdf-package",timeout=120000)
                expect(negative.locator("#loading-dialog")).not_to_be_visible(timeout=120000)
                negative.locator("#image-list").select_option(str(first_case_initial))
                expect(negative.locator("#status")).to_contain_text(re.compile("decoder|could not display|could not open",re.I),timeout=10000)
                expect(negative.locator("#viewport")).to_have_attribute("data-loaded-attachment","")
                expect(negative.locator("#reset")).to_be_disabled();result["workerRequiredNoMainThreadFallback"]=True
                negative.close()
                assert not result["httpRequests"],"Normal patient workflow attempted a network request"
                assert not errors,"Browser runtime errors occurred"
            finally:
                context.close()
        assert all(sha((extension/name).read_bytes())==value for name,value in build_hashes.items()),"Extension assets changed during the workflow test"
        result["passed"]=True
    except Exception as error:
        # Source-derived text and browser exceptions can contain identifiers.
        # Keep reports to the exception class and the assertion written here.
        result["passed"]=False;result["failureType"]=type(error).__name__
        if isinstance(error,AssertionError):result["failure"]=str(error)
        raise
    finally:
        result["browserErrorCount"]=len(errors)
        (report/"patient-workflow-checks.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(f"Chrome {result['browserVersion']}: patient workflow passed offline with unchanged original recovery")


if __name__=="__main__":
    main()
