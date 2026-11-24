#!/usr/bin/env python3
"""Check packaged decoder Workers against synthetic fixtures, entirely offline.

Uses the unpacked Chrome extension. Reports and screenshots stay under target/.
Requires scripts/requirements.txt and Playwright Chromium. Pass --chromium to
select a different Chromium executable.
Only run this audit against synthetic or approved de-identified test packages.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time

from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect

from check_extension import extension_identity, launch


AUDIT = """() => {
  const audit={workers:[],requests:[],responses:[],startupErrors:[],policyViolations:[]};globalThis.__decoderAudit=audit;
  globalThis.addEventListener('securitypolicyviolation',event=>audit.policyViolations.push({directive:event.violatedDirective,blocked:event.blockedURI}));
  const NativeWorker=globalThis.Worker;
  globalThis.Worker=class extends NativeWorker {
    constructor(url,options){
      super(url,options);this.auditId=audit.workers.length;
      audit.workers.push({url:String(url),type:options?.type||'classic'});
      this.addEventListener('error',event=>audit.startupErrors.push({worker:this.auditId,message:event.message,filename:event.filename,line:event.lineno,column:event.colno}));
      this.addEventListener('message',event=>{
        const message=event.data;if(message?.type!=='decoded')return;
        const result=message.result,image=result.image,pixels=result.pixels;
        let minimum=Infinity,maximum=-Infinity;for(let i=0;i<pixels.length;i++){minimum=Math.min(minimum,pixels[i]);maximum=Math.max(maximum,pixels[i]);}
        const points=[[0,0],[1,0],[63,0],[0,47],[63,47],[10,10],[32,10],[54,10]];
        const components=image.numberOfComponents||1;
        audit.responses.push({worker:this.auditId,id:message.id,imageId:image.imageId,sourceFrame:result.sourceFrame,
          sopInstanceUID:result.sopInstanceUID,rows:image.rows,columns:image.columns,windowCenter:image.windowCenter,
          windowWidth:image.windowWidth,invert:image.invert,slope:image.slope,intercept:image.intercept,
          components,minimum,maximum,pixelType:pixels.constructor.name,
          samples:points.map(([x,y])=>({x,y,values:Array.from(pixels.slice((y*image.columns+x)*components,(y*image.columns+x+1)*components))}))});
      });
    }
    postMessage(message,...rest){
      if(['register','decode','cancel','clear'].includes(message?.type))audit.requests.push({worker:this.auditId,
        type:message.type,id:message.id,key:message.key,imageId:message.imageId,sourceFrame:message.sourceFrame,
        priority:message.priority,byteLength:message.bytes?.byteLength});
      return super.postMessage(message,...rest);
    }
  };
}"""

CANVAS = """canvas => {
  const {width,height}=canvas,pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
  let lit=0,minimum=255,maximum=0,total=0;
  for(let i=0;i<pixels.length;i+=4){const v=Math.max(pixels[i],pixels[i+1],pixels[i+2]);
    minimum=Math.min(minimum,v);maximum=Math.max(maximum,v);total+=v;if(v>8&&pixels[i+3]>0)lit++;}
  return {width,height,minimum,maximum,lit,mean:total/(width*height)};
}"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_manifest(pdf):
    return json.loads(PdfReader(pdf).attachments["manifest.json"][0])


def settle(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def expected_samples(entry, response, frame):
    """Independent mathematical fixture values, not the JavaScript decoder."""
    name = Path(entry["sourcePath"]).name
    native16 = {"ct-deflated-16.dcm", "ct-explicit-be-16.dcm", "ct-explicit-le-16.dcm", "ct-jpeg2000-lossless16.dcm",
                "mr-implicit-le-16.dcm", "sc-jpegls-lossless-gray16.dcm", "mr-enhanced-functional-groups.dcm"}
    gray8 = {"sc-native-gray8.dcm", "sc-rle-gray8.dcm", "sc-jpegls-lossless-gray8.dcm", "sc-multiframe-gray8.dcm"}
    tolerance = 2 if name == "sc-jpegls-near-lossless-gray8.dcm" else 0
    for sample in response["samples"]:
        x, y, values = sample["x"], sample["y"], sample["values"]
        if name in native16:
            value = 32*x + 16*y
        elif name == "mr-explicit-le-signed16.dcm":
            value = 32*x + 16*y - 1024
        elif name in gray8 or tolerance:
            value = (3*x + 5*y) & 255
            if name == "sc-multiframe-gray8.dcm" and frame == 2:
                value = 255-value
        elif name == "sc-signed8.dcm":
            value = ((3*x + 5*y) & 255)-128
        elif name == "sc-single-bit.dcm":
            value = 0 if x < 32 else 1
        elif name in {"sc-jpeg-lossless-sv1-gray8.dcm", "sc-jpeg-lossless14-gray8.dcm"}:
            value = 100
        elif name == "sc-jpeg-lossless-sv1-gray12.dcm":
            value = 1000
        else:
            continue
        assert abs(values[0]-value) <= tolerance, "Decoded mathematical sample differs from the fixture"
    if response["components"] == 4:
        color_samples = response["samples"][-3:]
        for channel, sample in enumerate(color_samples):
            values = sample["values"]
            assert values[channel] > 150 and all(values[other] < 90 for other in range(3) if other != channel), "Decoded color bar channels differ"
            assert values[3] == 255, "Decoded color pixels are not opaque"


def selection(page, manifest, index, frame_number=1):
    entry = manifest["images"][index]
    if frame_number == 1:
        page.locator("#image-list").select_option(str(index))
    else:
        # Set the value once without a second pending native blur/change event.
        page.locator("#frame-number").evaluate("(input,value)=>{input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}", frame_number)
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"], timeout=30000)
    expect(page.locator("#viewport")).to_have_attribute("data-source-frame", str(frame_number), timeout=30000)
    expect(page.locator("#viewport canvas").first).to_be_visible()
    expect(page.locator("#reset")).to_be_enabled()
    assert "SHA-256 verified" in page.locator("#status").inner_text()
    response = page.evaluate("""({index,frame}) => [...__decoderAudit.responses].reverse().find(result =>
      result.imageId.startsWith('dicom:') && result.imageId.endsWith(`-${index}-${frame}`))""", {"index": index, "frame": frame_number})
    assert response, "No matching original/frame returned by the local DICOM Worker"
    assert response["sopInstanceUID"] == entry["sopInstanceUID"], "Worker SOP Instance UID differs from manifest"
    assert response["sourceFrame"] == frame_number, "Worker source frame differs from selection"
    assert response["rows"] == int(entry["fields"]["Rows"]) and response["columns"] == int(entry["fields"]["Columns"])
    if entry["status"] == "rendered" and frame_number == (entry.get("sourceFrame") or 1):
        display = entry["displayAdjustments"]
        for name in ("windowCenter", "windowWidth"):
            assert response[name] == float(display[name]), "Source window differs from its recorded PDF baseline"
        assert response["invert"] == (display["invert"] == "true"), "Source polarity differs from the PDF baseline"
    expected_samples(entry, response, frame_number)
    settle(page)
    pixels = page.locator("#viewport canvas").first.evaluate(CANVAS)
    assert pixels["maximum"] > 16 and pixels["lit"] > 100 and pixels["mean"] > 1, "Viewport is blank or too dark to identify"
    return {"sourcePath": entry["sourcePath"], "attachment": entry["attachment"], "transferSyntax": entry["fields"]["TransferSyntaxUID"],
            "sourceFrame": frame_number, "pdfPreview": entry["status"] == "rendered", "identityMatches": True,
            "workerResponse": response, "visibleCanvas": pixels}


def check_pdf(page, pdf, report, result):
    manifest = read_manifest(pdf)
    page.locator("#pdf-file").set_input_files(pdf.resolve())
    expect(page.locator("#image-list option")).to_have_count(len(manifest["images"]), timeout=30000)
    first = next(index for index, entry in enumerate(manifest["images"]) if entry["status"] == "rendered")
    expect(page.locator("#image-list")).to_have_value(str(first))
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", manifest["images"][first]["attachment"], timeout=30000)
    result["initialAutomaticLoad"] = True
    for index, entry in enumerate(manifest["images"]):
        checked = selection(page, manifest, index)
        result["images"].append(checked)
        (report / "checks.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
        print(f"  image {index+1}/{len(manifest['images'])} checked", flush=True)
        if int(entry.get("fields", {}).get("NumberOfFrames", "1")) > 1:
            second = selection(page, manifest, index, 2)
            if Path(entry["sourcePath"]).name == "mr-enhanced-functional-groups.dcm":
                response = second["workerResponse"]
                assert (response["windowCenter"], response["windowWidth"], response["slope"], response["intercept"]) == (1000, 2000, 2, -1000)
            result["images"].append(second)
    # Show that the transferred decoded pixels remain interactive on the UI side.
    index = next(index for index, entry in enumerate(manifest["images"]) if Path(entry["sourcePath"]).name == "sc-native-gray8.dcm")
    selection(page, manifest, index)
    viewport = page.locator("#viewport")
    baseline = hashlib.sha256(viewport.screenshot()).hexdigest()
    page.locator("#brightness").evaluate("input=>{input.value=35;input.dispatchEvent(new Event('input',{bubbles:true}));}")
    settle(page)
    adjusted = hashlib.sha256(viewport.screenshot()).hexdigest()
    assert baseline != adjusted, "Brightness did not alter the displayed Worker-decoded image"
    page.locator("#reset").click()
    settle(page)
    assert hashlib.sha256(viewport.screenshot()).hexdigest() == baseline, "Reset did not restore the transferred source image"
    result["brightnessAndReset"] = True


def check_mono1(page, pdf, result):
    if not pdf or not pdf.exists():
        result["monochrome1"] = {"checked": False, "reason": "No MONOCHROME1 synthetic package supplied"}
        return
    manifest = read_manifest(pdf)
    index = next((i for i, e in enumerate(manifest["images"]) if e.get("fields", {}).get("PhotometricInterpretation") == "MONOCHROME1" and e["status"] == "rendered"), None)
    if index is None:
        result["monochrome1"] = {"checked": False, "reason": "Package has no displayed MONOCHROME1 original"}
        return
    page.locator("#pdf-file").set_input_files(pdf.resolve())
    expect(page.locator("#image-list option")).to_have_count(len(manifest["images"]), timeout=30000)
    image = selection(page, manifest, index)
    assert image["workerResponse"]["invert"] is True
    assert page.locator("#invert").get_attribute("aria-pressed") == "false", "Source MONOCHROME1 was mistaken for a user inversion"
    viewport = page.locator("#viewport")
    baseline = hashlib.sha256(viewport.screenshot()).hexdigest()
    page.locator("#invert").click();settle(page)
    assert hashlib.sha256(viewport.screenshot()).hexdigest() != baseline
    page.locator("#reset").click();settle(page)
    assert hashlib.sha256(viewport.screenshot()).hexdigest() == baseline
    result["monochrome1"] = {"checked": True, "sourcePolarity": True, "invertAndReset": True, "image": image}


def audit_result(page, result):
    audit = page.evaluate("__decoderAudit")
    decoder_workers = sorted({request["worker"] for request in audit["requests"] if request["type"] == "decode"})
    result["workerAudit"] = {"workers": audit["workers"], "decoderWorkerIndices": decoder_workers,
                             "registrations": sum(request["type"] == "register" for request in audit["requests"]),
                             "decodes": sum(request["type"] == "decode" for request in audit["requests"]),
                             "startupErrors": audit["startupErrors"], "policyViolations": audit["policyViolations"]}
    assert decoder_workers, "No local DICOM Worker was used"
    for index in decoder_workers:
        worker = audit["workers"][index]
        assert worker["url"].startswith("chrome-extension:"), "Worker was loaded from an unexpected origin"
        assert worker["type"] == "module"


def exercise(context, page, url, args, label, version):
    report = args.report / label
    report.mkdir(parents=True, exist_ok=True)
    result = {"case": label, "browserVersion": version, "offline": True, "images": [], "httpRequests": 0, "browserErrors": 0,
              "packagedDicomWorkerSha256": digest(args.extension / "dicom.worker.mjs")}
    context.set_offline(True)
    context.add_init_script("("+AUDIT+")();")
    context.on("request", lambda request: result.__setitem__("httpRequests", result["httpRequests"]+1) if request.url.startswith(("http:", "https:")) else None)
    page.on("pageerror", lambda error: result.__setitem__("browserErrors", result["browserErrors"]+1))
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        check_pdf(page, args.pdf, report, result)
        check_mono1(page, args.mono1_pdf, result)
        audit_result(page, result)
        assert result["httpRequests"] == 0, "Normal offline viewing attempted an HTTP request"
        assert result["browserErrors"] == 0, "Browser reported an unhandled error"
        page.screenshot(path=str(report / "viewer.png"))
        result["passed"] = True
        print(f"{label} {version}: {len(result['images'])} source/frame checks, local Workers, zero HTTP requests", flush=True)
    except Exception as error:
        result["passed"] = False
        result["failureType"] = type(error).__name__
        result["failure"] = str(error)
        try:
            result["statusAtFailure"] = page.locator("#status").inner_text(timeout=2000)
            audit_result(page, result)
            page.screenshot(path=str(report / "failure.png"))
        except Exception:
            pass
        print(f"{label}: FAILED ({type(error).__name__}); see {report / 'checks.json'}", flush=True)
    finally:
        (report / "checks.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=Path("target/viewer-test-pdfs/expanded-formats.pdf"))
    parser.add_argument("--mono1-pdf", type=Path, default=Path("target/viewer-test-pdfs/sample-images.pdf"))
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--chromium", help="Chromium executable (defaults to Playwright Chromium)")
    parser.add_argument("--report", type=Path, default=Path("target/worker-viewing-checks"))
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=args.report) as profile:
        chromium = args.chromium or playwright.chromium.executable_path
        with launch(playwright, chromium, args.extension.resolve(strict=True), profile) as context:
            address = f"chrome-extension://{extension_identity(context)}/viewer.html"
            result = exercise(context, context.pages[0], address, args, "extension-chromium", context.browser.version)
    results = [result]
    (args.report / "summary.json").write_text(json.dumps(results, indent=2)+"\n", encoding="utf-8")
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
