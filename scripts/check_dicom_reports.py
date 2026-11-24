#!/usr/bin/env python3
"""Check synthetic encapsulated-PDF/SR viewing from loose files and a PDF package.

Generate inputs with fixtures/reports/generate.mjs and convert them to
target/viewer-test-pdfs/synthetic-reports.pdf first. Browser profiles, screenshots, downloads and
reports go under target/. No supplied originals or build assets are modified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode=True
from check_extension import launch, extension_identity, viewer_frame


PROBE=r"""(() => {
  const state=globalThis.__reportProbe={models:[],documents:[],documentRequests:0,workers:[]};
  const Original=globalThis.Worker;
  globalThis.Worker=class extends Original {
    constructor(url,options){
      super(url,options);const name=new URL(String(url),document.baseURI).pathname.split('/').pop();
      state.workers.push(name);this.__reportWorker=name;
      this.addEventListener('message',async event=>{
        const message=event.data||{};
        if(message.type==='result'&&message.result?.inputKind==='direct-dicom')state.models.push(message.result.entries.map(entry=>({
          attachment:entry.attachment,sourcePath:entry.sourcePath,size:entry.size,sha256:entry.sha256,
          sopInstanceUID:entry.sopInstanceUID,fields:entry.fields
        })));
        if(message.type==='document'&&message.result?.kind){
          const result=message.result,record={kind:result.kind,sopInstanceUID:result.sopInstanceUID,sopClassUID:result.sopClassUID};
          if(result.kind==='pdf'){
            const hash=await crypto.subtle.digest('SHA-256',result.bytes.slice());
            record.sha256=Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
            record.byteLength=result.bytes.byteLength;
          }
          if(result.kind==='sr'){record.text=result.text;record.unsupportedContentItems=result.unsupportedContentItems;}
          state.documents.push(record);
        }
      });
    }
    postMessage(message,...args){if(message?.type==='document')state.documentRequests++;return super.postMessage(message,...args);}
  };
})();"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pixel_digest(frame):
    return frame.locator("#viewport canvas").first.evaluate("""async canvas=>{
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const hash=await crypto.subtle.digest('SHA-256',pixels);
      return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
    }""")


def wait_image(frame,entry,index):
    expect(frame.locator("#image-list")).to_have_value(str(index))
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment",entry["attachment"],timeout=30000)
    expect(frame.locator("#image-view")).to_be_visible()
    expect(frame.locator("#reset")).to_be_enabled()


def check_page_text(frame):
    toggle=frame.get_by_role('button',name='Page text',exact=True)
    expect(toggle).to_be_enabled();toggle.click()
    text=frame.locator('.attachment-preview-page-text')
    expect(text).to_contain_text('SYNTHETIC REPORT')
    expect(text).to_contain_text('Software test fixture. No clinical findings.')
    toggle.click();expect(frame.locator('.attachment-preview-pdf-canvas')).to_be_visible()
    expect(text).to_be_hidden()


def select_image(frame,entries):
    index=next(index for index,entry in enumerate(entries) if entry["sourcePath"].endswith("01-image.dcm"))
    frame.locator("#image-list").select_option(str(index));wait_image(frame,entries[index],index)
    return index


def download_original(page,frame,entry,destination,expected):
    expect(frame.locator('#download-original')).to_be_enabled()
    with page.expect_download(timeout=30000) as event:
        frame.locator('#download-original').click()
    destination.parent.mkdir(parents=True,exist_ok=True);event.value.save_as(destination)
    recovered=destination.read_bytes();assert recovered==expected,"Viewing a report changed its recoverable source bytes"
    assert sha(recovered)==entry["sha256"]


def wait_probe(page,frame,key,minimum):
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        if frame.evaluate('key=>__reportProbe[key].length',key)>=minimum:return
        page.wait_for_timeout(50)
    raise AssertionError('Expected report worker result did not arrive')


def report_views(page,frame,entries,expected,source_bytes,report):
    image_index=select_image(frame,entries);image=entries[image_index];baseline=pixel_digest(frame)
    if not frame.locator("#details-panel").is_visible():frame.locator("#show-details").click()
    right_names=frame.locator('#details-panel [data-attachment]').evaluate_all('rows=>rows.map(row=>row.dataset.attachment)')
    assert not set(right_names)&{entry['attachment'] for entry in entries},'Study data is duplicated in the right pane'
    results=[]
    for filename,kind in [("02-encapsulated-pdf.dcm","pdf"),("03-structured-report.dcm","sr")]:
        index=next(index for index,entry in enumerate(entries) if entry["sourcePath"].endswith(filename));entry=entries[index]
        before=frame.evaluate("__reportProbe.documents.length")
        frame.locator('#image-list').select_option(str(index));expect(frame.locator("#attachment-view")).to_be_visible(timeout=30000)
        expect(frame.locator("#show-attachment")).to_have_attribute("aria-selected","true")
        expect(frame.locator("#status")).to_contain_text("Viewing "+entry["attachment"],timeout=30000)
        wait_probe(page,frame,'documents',before+1)
        document=frame.evaluate("__reportProbe.documents.at(-1)")
        assert document["kind"]==kind and document["sopInstanceUID"]==entry["sopInstanceUID"]
        assert document["sopClassUID"]==entry["fields"]["SOPClassUID"]
        assert frame.locator("#image-list").input_value()==str(index),'Report did not retain its original global option value'
        if kind=="pdf":
            canvas=frame.locator(".attachment-preview-pdf-canvas");expect(canvas).to_be_visible()
            expect(frame.locator(".attachment-preview-pdf-controls")).to_contain_text("Page 1 of 1")
            assert document["sha256"]==expected["pdf"]["sha256"] and document["byteLength"]==expected["pdf"]["size"]
            visible=canvas.evaluate("""canvas=>{
              const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;
              for(let offset=0;offset<pixels.length;offset+=4)if(pixels[offset+3]&&Math.min(pixels[offset],pixels[offset+1],pixels[offset+2])<100)dark++;
              return {width:canvas.width,height:canvas.height,darkPixels:dark};
            }""")
            page.screenshot(path=str(report/(kind+"-preview.png")))
            assert visible["width"]>0 and visible["height"]>0 and visible["darkPixels"]>50,"Encapsulated PDF rendered blank"
            check_page_text(frame)
        else:
            text=frame.locator(".attachment-preview-text");expect(text).to_be_visible()
            actual=text.inner_text();assert expected["sr"]["literalText"] in actual
            assert expected["sr"]["unsupportedMarker"] in actual and expected["sr"]["imageReferenceUID"] in actual
            assert document["unsupportedContentItems"]>=1
            assert frame.locator("#attachment-content img, #attachment-content script, #attachment-content iframe").count()==0
            assert frame.evaluate("globalThis.__reportScriptRan===undefined"),"Report text executed as HTML"
        page.screenshot(path=str(report/(kind+"-preview.png")))
        download_original(page,frame,entry,report/(filename+".recovered"),source_bytes[filename])
        assert frame.locator("#image-list").input_value()==str(index)
        frame.locator("#image-list").select_option(str(image_index));wait_image(frame,image,image_index)
        assert pixel_digest(frame)==baseline
        results.append({"kind":kind,"workerIdentityMatches":True,"originalBytesMatch":True,"leftSelection":True,
                        "rightDataDuplicates":False,"selectedReportPreserved":True,"imageRoundtripPixelsMatch":True,
                        "unicodeInertText":True if kind=="sr" else None,"unsupportedContentLabeled":True if kind=="sr" else None,
                        "pdfPayloadMatches":True if kind=="pdf" else None})
    download_original(page,frame,image,report/"image.recovered",source_bytes["01-image.dcm"])
    workers=frame.evaluate("({requests:__reportProbe.documentRequests,workers:__reportProbe.workers})")
    assert workers["requests"]>=2
    assert workers["workers"].count("pdf.worker.mjs")>=2
    assert frame.evaluate("globalThis.__reportScriptRan===undefined")
    return {"reports":results,"documentRequests":workers["requests"],"pdfWorkerCount":workers["workers"].count("pdf.worker.mjs")}


def report_only_views(page,frame,entries,expected,source_bytes,report):
    first=entries[0]
    expect(frame.locator("#image-list")).to_have_value("0")
    expect(frame.locator("#attachment-view")).to_be_visible(timeout=30000)
    expect(frame.locator("#status")).to_contain_text("Viewing "+first["attachment"],timeout=30000)
    expect(frame.locator(".attachment-preview-pdf-canvas")).to_be_visible()
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment","")
    expect(frame.locator("#reset")).to_be_disabled()
    for index,entry in enumerate(entries):
        frame.locator("#image-list").select_option(str(index))
        expect(frame.locator("#status")).to_contain_text("Viewing "+entry["attachment"],timeout=30000)
        if entry["sourcePath"].endswith("03-structured-report.dcm"):
            text=frame.locator(".attachment-preview-text");expect(text).to_be_visible()
            assert expected["sr"]["literalText"] in text.text_content() and expected["sr"]["unsupportedMarker"] in text.text_content()
        else:
            canvas=frame.locator(".attachment-preview-pdf-canvas");expect(canvas).to_be_visible()
            assert canvas.evaluate("canvas=>{const p=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;for(let i=0;i<p.length;i+=4)if(p[i]<100&&p[i+3])dark++;return dark;}")>50
            check_page_text(frame)
        filename=entry["sourcePath"].split('/')[-1]
        download_original(page,frame,entry,report/(filename+".recovered"),source_bytes[filename])
    assert frame.locator("#attachment-content img,#attachment-content script,#attachment-content iframe").count()==0
    assert frame.evaluate("globalThis.__reportScriptRan===undefined")
    page.screenshot(path=str(report/"report-only.png"))
    return {"automaticFirstReport":True,"nativeSelectionOpensReport":True,"reports":len(entries),"originalBytesMatch":True,"imageControlsDisabled":True,"inertUnicode":True}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension",type=Path,default=Path("target/chrome-extension"))
    parser.add_argument("--sources",type=Path,default=Path("target/report-inputs"))
    parser.add_argument("--expectations",type=Path,default=Path("target/report-fixtures/expectations.json"))
    parser.add_argument("--pdf",type=Path,default=Path("target/viewer-test-pdfs/synthetic-reports.pdf"))
    parser.add_argument("--report",type=Path,default=Path("target/dicom-report-checks"))
    parser.add_argument("--report-only-sources",type=Path,default=Path("target/report-only-inputs"))
    parser.add_argument("--report-only-pdf",type=Path,default=Path("target/viewer-test-pdfs/synthetic-reports-only.pdf"))
    parser.add_argument("--chromium",default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    args=parser.parse_args();args.report.mkdir(parents=True,exist_ok=True);report=args.report.resolve();extension=args.extension.resolve(strict=True)
    expected=json.loads(args.expectations.read_text());assert expected["synthetic"] is True
    source_bytes={name:(args.sources/name).read_bytes() for name in expected["files"]}
    for name,data in source_bytes.items():assert sha(data)==expected["files"][name]["sha256"]
    package=PdfReader(args.pdf);raw_manifest=package.attachments["manifest.json"][0];manifest=json.loads(raw_manifest)
    for entry in manifest["images"]:
        assert package.attachments[entry["attachment"]][0]==source_bytes[entry["sourcePath"]]
    asset_names=["manifest.json","viewer.html","viewer.css","viewer.js","dicom.worker.mjs","dicom-input.worker.mjs","pdf.worker.mjs"]
    assets={name:sha((extension/name).read_bytes()) for name in asset_names};package_hash=sha(args.pdf.read_bytes())
    result={"syntheticOnly":True,"offline":True,"httpRequestCount":0,"runtimeErrorCount":0,"cases":[],"assets":assets};requests=[];errors=[]
    try:
        with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix="profile-",dir=report) as profile:
            context=launch(playwright,args.chromium,extension,profile)
            try:
                result["browserVersion"]=context.browser.version;extension_id=extension_identity(context)
                context.set_offline(True);context.add_init_script(PROBE)
                context.on("request",lambda request:requests.append(True) if request.url.startswith(("http:","https:")) else None)
                page=context.pages[0];page.on("pageerror",lambda error:errors.append(True))
                for mode in ["direct","pdf-package"]:
                    case_report=report/mode;case_report.mkdir(exist_ok=True)
                    if mode=="direct":
                        page.goto(f"chrome-extension://{extension_id}/viewer.html",wait_until="domcontentloaded")
                        page.locator("#dicom-files").set_input_files([args.sources/name for name in source_bytes])
                        wait_probe(page,page.main_frame,'models',1)
                        entries=page.evaluate("__reportProbe.models.at(-1)");frame=page.main_frame
                    else:
                        page.goto(args.pdf.resolve().as_uri(),wait_until="domcontentloaded")
                        frame=viewer_frame(page,extension_id);entries=manifest["images"]
                    expect(frame.locator("#image-list option")).to_have_count(3)
                    image_index=next(index for index,entry in enumerate(entries) if entry["sourcePath"]=="01-image.dcm")
                    wait_image(frame,entries[image_index],image_index)
                    case={"mode":mode,"automaticInitialImage":True,**report_views(page,frame,entries,expected,source_bytes,case_report)}
                    if mode=="pdf-package":
                        frame.locator("#show-pdf").click();expect(frame.locator("#pdf-canvas")).to_be_visible()
                        expect(frame.locator("#page-number")).to_have_value(str(entries[image_index]["referencePage"]))
                        frame.locator("#show-image").click();wait_image(frame,entries[image_index],image_index);case["pdfImageSelectionRoundtrip"]=True
                    result["cases"].append(case);print(f"Synthetic {mode}: PDF/SR viewing, source recovery and image roundtrip passed",flush=True)
                report_only_package=PdfReader(args.report_only_pdf);report_only_manifest=json.loads(report_only_package.attachments["manifest.json"][0])
                for mode in ["direct-report-only","pdf-package-report-only"]:
                    case_report=report/mode;case_report.mkdir(exist_ok=True)
                    if mode=="pdf-package-report-only":
                        page.goto(args.report_only_pdf.resolve().as_uri(),wait_until="domcontentloaded")
                        frame=viewer_frame(page,extension_id);entries=report_only_manifest["images"]
                    else:
                        page.goto(f"chrome-extension://{extension_id}/viewer.html",wait_until="domcontentloaded")
                        page.locator("#dicom-files").set_input_files(sorted(args.report_only_sources.glob('*.dcm')))
                        wait_probe(page,page.main_frame,'models',1)
                        entries=page.evaluate("__reportProbe.models.at(-1)");frame=page.main_frame
                    expect(frame.locator("#image-list option")).to_have_count(2)
                    result["cases"].append({"mode":mode,**report_only_views(page,frame,entries,expected,source_bytes,case_report)})
                    print(f"Synthetic {mode}: report-only automatic opening and source recovery passed",flush=True)
                assert not requests,"Report viewing attempted a network request"
                assert not errors,"Report viewing raised a browser runtime error"
            finally:context.close()
        assert all(sha((extension/name).read_bytes())==value for name,value in assets.items()),"Extension assets changed during report integration checks"
        assert sha(args.pdf.read_bytes())==package_hash
        for name,data in source_bytes.items():assert (args.sources/name).read_bytes()==data
        result["passed"]=True
    except Exception as error:
        result["passed"]=False;result["failureType"]=type(error).__name__
        if isinstance(error,AssertionError):result["failure"]=str(error)
        raise
    finally:
        result["httpRequestCount"]=len(requests);result["runtimeErrorCount"]=len(errors)
        (report/"dicom-report-checks.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(f"Chrome {result['browserVersion']}: synthetic DICOM reports passed offline; all originals unchanged")


if __name__=="__main__":main()
