#!/usr/bin/env python3
"""Check independent pinned-original comparison in the built extension offline.

Uses synthetic packages plus the optional approved/de-identified multiframe MR
conversion. Browser profiles, screenshots and recovered originals stay in target/.
Source-derived labels, identifiers and exceptions are not written to reports.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.parse import urlparse

from pypdf import PdfReader,apply_configuration
from playwright.sync_api import sync_playwright, expect


def manifest_for(path):
    reader=PdfReader(path)
    return json.loads(reader.attachments["manifest.json"][0]),reader.attachments


def settle(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def pixels(page,selector):
    settle(page)
    return page.locator(selector+" canvas").first.evaluate("""async canvas=>{
      const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      let lit=0;for(let i=0;i<bytes.length;i+=4)if(Math.max(bytes[i],bytes[i+1],bytes[i+2])>12&&bytes[i+3]>0)lit++;
      return {width:canvas.width,height:canvas.height,lit,sha256:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')};
    }""")


def load(page,path):
    manifest,attachments=manifest_for(path)
    page.locator("#pdf-file").set_input_files(path.resolve())
    # These comparison fixtures contain raster DICOMs and optional supporting
    # originals. The image list excludes supporting files and keeps global IDs.
    image_indices=[str(index) for index,entry in enumerate(manifest['images'])
        if int(entry.get('fields',{}).get('Rows',0))>0 and int(entry.get('fields',{}).get('Columns',0))>0]
    expect(page.locator("#image-list option")).to_have_count(len(image_indices),timeout=120000)
    assert page.locator('#image-list option').evaluate_all('options=>options.map(option=>option.value)')==image_indices
    first=next(index for index,entry in enumerate(manifest["images"]) if entry["status"]=="rendered" and entry.get("displayRejected") is not True)
    entry=manifest["images"][first]
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment",entry["attachment"],timeout=120000)
    expect(page.locator("#compare-current")).to_be_enabled()
    return manifest,attachments,first


def pin(page,entry,frame=1):
    page.locator("#compare-current").click()
    expect(page.locator("#comparison-pane")).to_be_visible()
    expect(page.locator("#comparison-viewport")).to_have_attribute("data-loaded-attachment",entry["attachment"],timeout=120000)
    pinned(page,entry,frame)


def pinned(page,entry,frame=1):
    viewport=page.locator("#comparison-viewport")
    expect(viewport).to_have_attribute("data-source-frame",str(frame),timeout=120000)
    assert viewport.get_attribute("data-sha256")==entry["sha256"].lower(),"Pinned source checksum identity differs"
    assert viewport.get_attribute("data-sop-instance-uid")==entry["sopInstanceUID"],"Pinned source instance identity differs"
    assert page.locator("#comparison-source").inner_text()==entry["sourcePath"],"Pinned source label differs"
    image=pixels(page,"#comparison-viewport")
    assert image["width"]>100 and image["height"]>100 and image["lit"]>100,"Pinned viewport is blank or too small"
    return image


def frame(page,entry,number):
    page.evaluate("""() => {
      const probe=globalThis.__comparisonContinuity={active:true,samples:0,hidden:0,loading:0};
      function sample(){if(!probe.active)return;const v=document.getElementById('comparison-viewport'),c=v.querySelector('canvas');
        probe.samples++;if(v.getAttribute('aria-busy')==='true')probe.loading++;
        if(!v.dataset.loadedAttachment||!c||getComputedStyle(c).visibility==='hidden')probe.hidden++;
        requestAnimationFrame(sample);
      }requestAnimationFrame(sample);
    }""")
    page.locator("#comparison-frame").evaluate("(input,value)=>{input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}",number)
    image=pinned(page,entry,number)
    continuity=page.evaluate("() => {const p=__comparisonContinuity;p.active=false;return {samples:p.samples,loading:p.loading,hidden:p.hidden};}")
    assert continuity['hidden']==0,'Pinned frame disappeared while its replacement decoded'
    image['continuity']=continuity
    return image


def recover(page,entry,attachments,destination):
    with page.expect_download() as event:
        page.locator("#comparison-save").click()
    event.value.save_as(destination)
    actual=destination.read_bytes()
    assert hashlib.sha256(actual).hexdigest()==entry["sha256"],"Pinned original download hash differs"
    assert 0<=entry["size"]<=128*1024*1024,"Pinned fixture exceeds the supported source bound"
    # pypdf7 defaults to75MB per Flate stream; the approved MR original is88MB.
    # Keep independent recovery verification bounded by the viewer's128MiB cap.
    with apply_configuration(zlib_maximum_output_length=128*1024*1024,maximum_declared_stream_length=128*1024*1024):
        expected=attachments[entry["attachment"]][0]
    assert actual==expected,"Pinned original download bytes differ"
    return {"bytes":len(actual),"unchanged":True,"recordedChecksumMatches":True}


def controls(page,entry):
    # Pin mirrors the main camera, which can differ from a newly fitted half-pane.
    # Reset establishes the source display baseline used by the following checks.
    page.locator("#comparison-reset").click()
    baseline=pinned(page,entry)
    main=pixels(page,"#viewport")
    for button in ("comparison-rotate-right","comparison-invert"):
        page.locator("#"+button).click()
        assert pixels(page,"#comparison-viewport")["sha256"]!=baseline["sha256"],"Pinned display control did not change pixels"
        assert pixels(page,"#viewport")==main,"Pinned display control altered the current image"
        page.locator("#comparison-reset").click()
        assert pixels(page,"#comparison-viewport")==baseline,"Pinned Reset did not restore the original display"
    for name,value in (("brightness",30),("contrast",180)):
        page.locator("#comparison-"+name).evaluate("(input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));}",value)
        assert pixels(page,"#comparison-viewport")["sha256"]!=baseline["sha256"],"Pinned window control did not change pixels"
        assert pixels(page,"#viewport")==main,"Pinned window control altered the current image"
        page.locator("#comparison-reset").click();assert pixels(page,"#comparison-viewport")==baseline
    page.locator("#comparison-zoom-in").click();zoomed=pixels(page,"#comparison-viewport")
    assert zoomed["sha256"]!=baseline["sha256"],"Pinned zoom did not change pixels"
    box=page.locator("#comparison-viewport").bounding_box();x=box["x"]+box["width"]/2;y=box["y"]+box["height"]/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+35,y+20,steps=5);page.mouse.up()
    assert pixels(page,"#comparison-viewport")["sha256"]!=zoomed["sha256"],"Pinned pan did not change pixels"
    assert pixels(page,"#viewport")==main,"Pinned pan or zoom altered the current image"
    page.locator("#comparison-fit").click();assert pixels(page,"#comparison-viewport")==baseline,"Pinned Fit did not restore its camera"
    page.locator("#comparison-viewport").focus();page.keyboard.press("]")
    expect(page.locator("#comparison-viewport")).to_have_attribute("data-rotation","90")
    page.keyboard.press("r");assert pixels(page,"#comparison-viewport")==baseline
    page.locator("#invert").click();assert pixels(page,"#comparison-viewport")==baseline,"Main inversion altered the pin"
    page.locator("#reset").click()
    return {"brightness":True,"contrast":True,"rotate":True,"invert":True,"zoom":True,"pan":True,"fit":True,"reset":True,"keyboard":True,"independentFromCurrent":True}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension",type=Path,default=Path("target/chrome-extension"))
    parser.add_argument("--pdf",type=Path,default=Path("target/viewer-test-pdfs/metadata-sample.pdf"))
    parser.add_argument("--second-pdf",type=Path,default=Path("target/viewer-test-pdfs/expanded-formats.pdf"))
    parser.add_argument("--mr-pdf",type=Path,default=Path("out/additional-input-006.pdf"))
    parser.add_argument("--report",type=Path,default=Path("target/comparison-checks"))
    parser.add_argument("--chromium",default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    args=parser.parse_args();args.report.mkdir(parents=True,exist_ok=True)
    tracked=["viewer.html","viewer.css","viewer.js","dicom.worker.mjs"]
    hashes={name:hashlib.sha256((args.extension/name).read_bytes()).hexdigest() for name in tracked}
    result={"offline":True,"httpRequests":0,"browserErrors":0,"assets":hashes}
    try:
        with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix="profile-",dir=args.report) as profile:
            extension=args.extension.resolve()
            context=playwright.chromium.launch_persistent_context(profile,executable_path=args.chromium,headless=True,accept_downloads=True,
                ignore_default_args=["--disable-extensions"],args=[f"--disable-extensions-except={extension}",f"--load-extension={extension}","--no-sandbox"],viewport={"width":1600,"height":1100})
            try:
                result["browserVersion"]=context.browser.version
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                extension_id=worker.url.split("/")[2];context.set_offline(True)
                context.on("request",lambda request:result.__setitem__("httpRequests",result["httpRequests"]+1) if urlparse(request.url).scheme in {"http","https"} else None)
                page=context.pages[0];page.on("pageerror",lambda error:result.__setitem__("browserErrors",result["browserErrors"]+1))
                page.goto(f"chrome-extension://{extension_id}/viewer.html")
                manifest,attachments,index=load(page,args.pdf);entry=manifest["images"][index];pin(page,entry)
                result["controls"]=controls(page,entry)
                result["firstRecovery"]=recover(page,entry,attachments,args.report/"pinned-first-original.dcm")
                second,second_attachments,second_index=load(page,args.second_pdf)
                pinned(page,entry);result["survivesSecondPdf"]=True
                other=next(i for i,e in enumerate(second["images"]) if i!=second_index and e["status"]=="rendered")
                page.locator("#image-list").select_option(str(other))
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment",second["images"][other]["attachment"])
                pinned(page,entry);result["survivesCurrentSelection"]=True
                original_names={item['attachment'] for item in second['images']}
                expected_metadata=set(second_attachments)-original_names|{'document-metadata.xmp'}
                actual_metadata=set(page.locator('#package-files .package-file').evaluate_all('rows=>rows.map(row=>row.dataset.attachment)'))
                assert actual_metadata==expected_metadata,"Pin was inserted into the second package inventory"
                result["pinSeparateFromCurrentInventory"]=True
                # Repaint after the main viewer purged its cache for another original.
                page.locator("#comparison-rotate-right").click();page.locator("#comparison-reset").click();pinned(page,entry)
                result["recoveryAfterSecondPdf"]=recover(page,entry,attachments,args.report/"pinned-after-second-original.dcm")
                page.screenshot(path=str(args.report/"comparison-desktop.png"))
                if page.locator("#toggle-details").is_visible():page.locator("#toggle-details").click()
                page.set_viewport_size({"width":500,"height":1000});settle(page)
                bounds=page.evaluate("""()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,
                  primary:(()=>{const b=document.querySelector('.primary-image-pane').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})(),
                  pinned:(()=>{const b=document.querySelector('#comparison-pane').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})()})""")
                assert bounds["scroll"]<=bounds["width"],"Narrow comparison overflows horizontally"
                assert bounds["pinned"]["y"]>=bounds["primary"]["y"]+bounds["primary"]["height"]-2,"Narrow comparison did not stack vertically"
                assert bounds["pinned"]["width"]>200,"Narrow pin is too small to use"
                result["narrowLayout"]=bounds;page.screenshot(path=str(args.report/"comparison-narrow.png"))
                page.locator("#comparison-viewport").scroll_into_view_if_needed();page.screenshot(path=str(args.report/"comparison-narrow-pinned.png"))
                page.set_viewport_size({"width":1600,"height":1100});page.locator("#close-comparison").click()
                expect(page.locator("#comparison-pane")).not_to_be_visible();assert not page.locator("#image-comparison-layout").evaluate("element=>element.classList.contains('has-comparison')")
                pin(page,second["images"][other]);result["closeAndRepin"]=True
                if args.mr_pdf.exists():
                    mr,mr_attachments,mr_index=load(page,args.mr_pdf);mr_entry=mr["images"][mr_index]
                    assert int(mr_entry["fields"].get("NumberOfFrames","1"))>3,"MR fixture is not multiframe"
                    pin(page,mr_entry);first=pinned(page,mr_entry);second_frame=frame(page,mr_entry,2)
                    assert first["sha256"]!=second_frame["sha256"],"Pinned MR frames did not change displayed pixels"
                    third_frame=frame(page,mr_entry,3);load(page,args.second_pdf);pinned(page,mr_entry,3);fourth_frame=frame(page,mr_entry,4)
                    result["multiframe"]={"framesChecked":[1,2,3,4],"retainedAcrossNewPdf":True}
                    result["multiframe"]["continuity"]=[value['continuity'] for value in [second_frame,third_frame,fourth_frame]]
                    result["multiframe"]["sourceRecovery"]=recover(page,mr_entry,mr_attachments,args.report/"pinned-multiframe-original.dcm")
                    page.screenshot(path=str(args.report/"comparison-multiframe.png"))
                assert result["httpRequests"]==0,"Comparison attempted an HTTP request"
                assert result["browserErrors"]==0,"Comparison produced an unhandled browser error"
                result["passed"]=True
            finally:context.close()
        assert all(hashlib.sha256((args.extension/name).read_bytes()).hexdigest()==value for name,value in hashes.items()),"Extension assets changed during comparison checks"
    except Exception as error:
        result["passed"]=False;result["failureType"]=type(error).__name__
        if isinstance(error,AssertionError):result["failure"]=str(error)
    finally:(args.report/"comparison-checks.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(f"Comparison {'passed' if result.get('passed') else 'FAILED'}; report: {args.report/'comparison-checks.json'}")
    raise SystemExit(0 if result.get("passed") else 1)


if __name__=="__main__":main()
