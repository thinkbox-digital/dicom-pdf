#!/usr/bin/env python3
"""Profile real CT wheel scrolling offline; reports contain numeric source IDs only."""
import argparse
import base64
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import statistics
import tempfile
import time

from pypdf import PdfReader
from PIL import Image
from playwright.sync_api import expect, sync_playwright

from check_extension import launch, extension_identity
from convert_archives import fingerprint
from sample_inventory import work_path


PROBE = r"""(() => {
  const p=globalThis.__scrollProbe={enabled:false,map:{},events:[],worker:[],longTasks:[],raf:[],pixels:[],start:0,lastTick:0,maxHeartbeatGap:0,camera:null,voi:null};
  const source=()=>{const n=Number(document.querySelector('#image-list')?.value);return Number.isInteger(n)&&n>=0?'source-'+String(n+1).padStart(3,'0'):null;};
  const imageSource=id=>{const m=/^dicom:\d+-(\d+)-\d+$/.exec(id||'')||/^thumbnail:\d+-(\d+)$/.exec(id||'');return m?'source-'+String(Number(m[1])+1).padStart(3,'0'):null;};
  const at=()=>performance.now()-p.start;
  p.begin=()=>{p.events=[];p.worker=[];p.longTasks=[];p.raf=[];p.pixels=[];p.start=performance.now();p.lastTick=p.start;p.maxHeartbeatGap=0;p.enabled=true;};
  p.end=()=>{p.enabled=false;return {events:p.events,worker:p.worker,longTasks:p.longTasks,raf:p.raf,pixelSamples:p.pixels,maxHeartbeatGapMs:p.maxHeartbeatGap,elapsedMs:at(),selectedSource:source()};};
  setInterval(()=>{if(!p.enabled)return;const n=performance.now();p.maxHeartbeatGap=Math.max(p.maxHeartbeatGap,n-p.lastTick);p.lastTick=n;},10);
  const sampleCanvas=document.createElement('canvas');sampleCanvas.width=sampleCanvas.height=32;const sampleContext=sampleCanvas.getContext('2d',{willReadFrequently:true});let frameCount=0;
  function pixels(){
    if(!p.enabled)return;const viewport=document.querySelector('#viewport'),canvas=viewport?.querySelector('canvas');
    const row={at:at(),hasCanvas:!!canvas,nonBlackPixels:0,overlayVisible:false};
    const empty=viewport?.querySelector('.empty-state');if(empty){const style=getComputedStyle(empty);row.overlayVisible=style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0;}
    try{if(canvas&&canvas.width&&canvas.height){sampleContext.clearRect(0,0,32,32);sampleContext.drawImage(canvas,0,0,32,32);const data=sampleContext.getImageData(0,0,32,32).data;for(let index=0;index<data.length;index+=4)if(data[index]>4||data[index+1]>4||data[index+2]>4)row.nonBlackPixels++;}}catch{row.error=true;}
    p.pixels.push(row);
  }
  function frame(){if(p.enabled){p.raf.push({at:at(),blank:!document.querySelector('#viewport')?.dataset.loadedAttachment});if(++frameCount%3===0)setTimeout(pixels,0);}requestAnimationFrame(frame);}requestAnimationFrame(frame);
  try{new PerformanceObserver(list=>{if(p.enabled)for(const e of list.getEntries())p.longTasks.push({at:e.startTime-p.start,durationMs:e.duration});}).observe({type:'longtask'});}catch{}
  const keySources=new Map(),registrations=new Map(),pending=new Map(),Original=globalThis.Worker;
  globalThis.Worker=class extends Original {
    constructor(url,options){super(url,options);this.dicom=String(url).split('?')[0].endsWith('/dicom.worker.mjs');if(this.dicom)this.addEventListener('message',e=>{
      const m=e.data||{},request=pending.get(m.id);
      if(request&&['registered','decoded','cancelled','error'].includes(m.type)){
        request.durationMs=performance.now()-request.started;request.reply=m.type;if(m.type!=='registered')pending.delete(m.id);
      }
    });}
    postMessage(m,...rest){
      if(this.dicom&&m){
        if(m.type==='register'){
          const row={type:'register',at:at(),sourceID:keySources.get(m.key)||null,bytes:m.bytes?.byteLength||0,started:performance.now()};
          if(p.enabled)p.worker.push(row);registrations.set(m.key,row);pending.set(m.id,row);
        }else if(m.type==='decode'){
          const id=imageSource(m.imageId);keySources.set(m.key,id);const registered=registrations.get(m.key);if(registered)registered.sourceID=id;
          const row={type:'decode',at:at(),sourceID:id,priority:m.priority||'foreground',started:performance.now()};if(p.enabled)p.worker.push(row);pending.set(m.id,row);
        }else if(m.type==='cancel'&&p.enabled)p.worker.push({type:'cancel',at:at(),sourceID:pending.get(m.id)?.sourceID||null});
      }
      return super.postMessage(m,...rest);
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const viewport=document.querySelector('#viewport');if(!viewport)return;
    viewport.addEventListener('wheel',e=>{if(!p.enabled)return;const row={type:'wheel',at:at(),direction:Math.sign(e.deltaY),beforeSource:source(),controlsDisabled:!!document.querySelector('#controls input')?.disabled,blank:!viewport.dataset.loadedAttachment};p.events.push(row);setTimeout(()=>{row.afterSource=source();row.accepted=row.afterSource!==row.beforeSource;},0);},{capture:true});
    document.querySelector('#image-list')?.addEventListener('change',()=>{if(p.enabled)p.events.push({type:'selection',at:at(),sourceID:source()});},{capture:true});
    new MutationObserver(records=>{
      for(let i=0;i<records.length;i++){
        const value=i+1<records.length?records[i+1].oldValue:viewport.dataset.loadedAttachment;
        if(!p.enabled)continue;const row={type:value?'commit':'blank',at:at(),selectedSource:source()};p.events.push(row);
        if(value)crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)).then(hash=>{const key=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');row.sourceID=p.map[key]||'unmapped';});
      }
    }).observe(viewport,{attributes:true,attributeFilter:['data-loaded-attachment'],attributeOldValue:true});
    let stackSource=null;
    viewport.addEventListener('CORNERSTONE_CAMERA_MODIFIED',event=>{p.camera=structuredClone(event.detail?.camera||null);});
    viewport.addEventListener('CORNERSTONE_VOI_MODIFIED',event=>{p.voi=structuredClone(event.detail?.range||null);});
    for(const type of ['CORNERSTONE_STACK_NEW_IMAGE','CORNERSTONE_IMAGE_RENDERED'])viewport.addEventListener(type,event=>{
      const detail=event.detail||{},id=detail.imageId||detail.viewport?.getCurrentImageId?.();if(type==='CORNERSTONE_STACK_NEW_IMAGE')stackSource=imageSource(id);
      if(!p.enabled)return;p.events.push({type:type==='CORNERSTONE_STACK_NEW_IMAGE'?'stack-image':'paint',at:at(),sourceID:imageSource(id)||stackSource,selectedSource:source()});
    });
  });
})();"""


def distribution(values):
    if not values:
        return {"count": 0}
    ordered = sorted(values)
    return {"count": len(values), "minMs": round(ordered[0], 2), "medianMs": round(statistics.median(values), 2),
            "p95Ms": round(ordered[min(len(ordered)-1, int(len(ordered)*0.95))], 2), "maxMs": round(ordered[-1], 2)}


def physical_order(entries, indices):
    def numbers(value, count):
        try:
            result = [float(piece) for piece in value.split("\\")]
            return result if len(result) == count else None
        except (AttributeError, ValueError):
            return None
    orientation = numbers(entries[indices[0]].get("fields", {}).get("ImageOrientationPatient"), 6)
    positions = {index:numbers(entries[index].get("fields", {}).get("ImagePositionPatient"), 3) for index in indices}
    if orientation and all(positions.values()):
        a,b,c,d,e,f = orientation
        normal = (b*f-c*e,c*d-a*f,a*e-b*d)
        if any(abs(value)>0.0001 for value in normal):
            return sorted(indices, key=lambda index:sum(x*y for x,y in zip(normal,positions[index])))
    try:
        return sorted(indices, key=lambda index:float(entries[index]["fields"]["InstanceNumber"]))
    except (KeyError, ValueError):
        return indices


def summarize(raw):
    wheels = [event for event in raw["events"] if event["type"] == "wheel"]
    commits = [event for event in raw["events"] if event["type"] == "commit"]
    starts = [event for event in raw["events"] if event["type"] == "selection" or event["type"] == "wheel" and event.get("accepted")]
    latencies, paint_latencies, after_decode, blanks, blank_start = [], [], [], [], None
    for event in raw["events"]:
        if event["type"] == "blank" and blank_start is None:
            blank_start = event["at"]
        if event["type"] == "commit":
            if blank_start is not None:
                blanks.append(event["at"]-blank_start);blank_start=None
            possible = [start for start in starts if start["at"] <= event["at"] and (start.get("afterSource") or start.get("sourceID")) == event.get("sourceID")]
            if possible:
                latencies.append(event["at"]-possible[-1]["at"])
            requested_at = possible[-1]["at"] if possible else event["at"]
            replies = [row["at"]+row["durationMs"] for row in raw["worker"] if row["type"] == "decode" and row.get("priority") != "thumbnail" and row.get("sourceID") == event.get("sourceID") and "durationMs" in row and row["at"] >= requested_at and row["at"]+row["durationMs"]<=event["at"]]
            if replies:
                after_decode.append(event["at"]-replies[-1])
        if event["type"] == "paint":
            possible = [start for start in starts if start["at"] <= event["at"] and (start.get("afterSource") or start.get("sourceID")) == event.get("sourceID")]
            if possible:
                paint_latencies.append(event["at"]-possible[-1]["at"])
    for row in raw["worker"]:
        row.pop("started", None)
    final = commits[-1].get("sourceID") if commits else None
    reverse_at = next((event["at"] for event in wheels if event["direction"]<0), None)
    return {"wheels": len(wheels), "acceptedWheels": sum(event.get("accepted", False) for event in wheels),
            "ignoredWhileDisabled": sum(event["controlsDisabled"] for event in wheels), "commitCount": len(commits),
            "wheelIntervals": distribution([right["at"]-left["at"] for left, right in zip(wheels, wheels[1:])]),
            "requestToCommit": distribution(latencies), "requestToPaint": distribution(paint_latencies), "decodeReplyToCommit": distribution(after_decode),
            "blankDurations": distribution(blanks), "totalBlankMs": round(sum(blanks), 2),
            "blankAnimationFrames": sum(frame["blank"] for frame in raw["raf"]), "animationFrames": len(raw["raf"]),
            "canvasPixelSamples": len(raw.get("pixelSamples",[])),
            "blackCanvasSamples": sum(not sample["hasCanvas"] or not sample["nonBlackPixels"] or sample.get("error",False) for sample in raw.get("pixelSamples",[])),
            "emptyOverlaySamples": sum(sample["overlayVisible"] for sample in raw.get("pixelSamples",[])),
            "workerOperations": dict(Counter(row["type"] for row in raw["worker"])),
            "foregroundDecodes": sum(row["type"] == "decode" and row.get("priority") != "thumbnail" for row in raw["worker"]),
            "prefetchDecodes": sum(row["type"] == "decode" and row.get("priority") == "thumbnail" for row in raw["worker"]),
            "reverseWorkerOperations": dict(Counter(row["type"] for row in raw["worker"] if reverse_at is not None and row["at"] >= reverse_at)),
            "workerDecode": distribution([row["durationMs"] for row in raw["worker"] if row["type"] == "decode" and "durationMs" in row]),
            "workerRegister": distribution([row["durationMs"] for row in raw["worker"] if row["type"] == "register" and "durationMs" in row]),
            "longTasks": distribution([task["durationMs"] for task in raw["longTasks"]]),
            "maxHeartbeatGapMs": round(raw["maxHeartbeatGapMs"], 2), "finalSelectedSource": raw["selectedSource"], "finalCommittedSource": final,
            "staleCommits": sum(event.get("sourceID") != event["selectedSource"] for event in commits),
            "latestSelectionCommitted": final == raw["selectedSource"]}


def select_source(page, index, entry):
    page.locator("#image-list").select_option(str(index))
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"], timeout=60000)
    page.wait_for_timeout(100)


def assess(result, report, label, compositor_only=False):
    cases=result['cases']
    checks=all(case['latestSelectionCommitted'] and not case['staleCommits'] for case in cases)
    if compositor_only:
        return checks and all(case['compositorFrames']>=3 and not case['compositorBlankFrames'] for case in cases)
    if label=='baseline':
        return checks
    checks=checks and all(not case['blankAnimationFrames'] and not case['blankDurations']['count']
        and case['acceptedWheels']==case['wheels'] and case['canvasPixelSamples']>0 and not case['emptyOverlaySamples']
        and case.get('adjustmentsPreserved',True) and case.get('adjustedPixelsIdenticalOnReturn',True) for case in cases)
    normal=[case for case in cases if case['case']!='selection-supersession-10ms']
    checks=checks and all(not case['blackCanvasSamples'] for case in normal)
    stress_black=sum(case['blackCanvasSamples'] for case in cases if case['case']=='selection-supersession-10ms')
    result['stressInternalBlackCanvasReads']=stress_black
    if stress_black:
        confirmation_path=report/'compositor-check.json'
        confirmed=False
        if confirmation_path.is_file():
            confirmation=json.loads(confirmation_path.read_text(encoding='utf-8'))
            confirmed=(confirmation.get('status')=='PASS' and confirmation.get('pdfSha256')==result['pdfSha256']
                and confirmation.get('extensionViewerSha256')==result['extensionViewerSha256']
                and all(case.get('compositorFrames',0)>=3 and case.get('compositorBlankFrames')==0 for case in confirmation['cases']))
        result['stressCompositorVisibilityConfirmed']=confirmed
        result['pixelVisibilityAssessment']='Normal wheel/reversal/pose samples stay visible. Artificial picker stress had internal black reads between renderer paints; repeat compositor capture is recorded separately.'
        checks=checks and confirmed
    return checks


def wheel_pattern(page, directions, interval):
    box = page.locator("#viewport").bounding_box()
    page.mouse.move(box["x"]+box["width"]/2, box["y"]+box["height"]/2)
    target = time.monotonic()
    for direction in directions:
        wait = target-time.monotonic()
        if wait>0:
            time.sleep(wait)
        page.mouse.wheel(0, 120*direction)
        target+=interval/1000


def display_state(page):
    return page.evaluate("({camera:__scrollProbe.camera,voi:__scrollProbe.voi,brightness:document.querySelector('#brightness').value,contrast:document.querySelector('#contrast').value,rotation:document.querySelector('#viewport').dataset.rotation,inverted:document.querySelector('#invert').getAttribute('aria-pressed')})")


def close_numbers(first, second, tolerance=1e-6):
    if isinstance(first, (int, float)) and isinstance(second, (int, float)):
        return abs(first-second) <= tolerance
    if isinstance(first, list) and isinstance(second, list):
        return len(first) == len(second) and all(close_numbers(a,b,tolerance) for a,b in zip(first,second))
    if isinstance(first, dict) and isinstance(second, dict):
        return first.keys() == second.keys() and all(close_numbers(first[key],second[key],tolerance) for key in first)
    return first == second


def adjustment_and_recovery(page, entries, middle, report, pdf):
    select_source(page, middle, entries[middle])
    page.locator("#brightness").evaluate("input=>{input.value='25';input.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.locator("#contrast").evaluate("input=>{input.value='170';input.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.locator("#zoom-in").click();page.locator("#zoom-in").click()
    box=page.locator("#viewport").bounding_box();x=box["x"]+box["width"]/2;y=box["y"]+box["height"]/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+65,y+35,steps=5);page.mouse.up()
    page.locator("#rotate-right").click();page.locator("#invert").click();page.wait_for_timeout(100)
    before = display_state(page)
    assert before["camera"] is not None and before["voi"] is not None, "Camera/VOI observation failed"
    pixels_before = hashlib.sha256(page.locator("#viewport canvas").first.screenshot()).hexdigest()
    page.evaluate("__scrollProbe.begin()")
    wheel_pattern(page, [1]*5+[-1]*5, 90)
    page.wait_for_timeout(400)
    raw = page.evaluate("__scrollProbe.end()")
    after = display_state(page)
    pixels_after = hashlib.sha256(page.locator("#viewport canvas").first.screenshot()).hexdigest()
    # Cornerstone's native tools use Float32 world vectors. Permit sub-pixel
    # camera rounding only; VOI/control values and returned PNG bytes stay strict.
    comparisons = {key:close_numbers(before[key],after[key],1e-4 if key=='camera' else 1e-6) for key in before}
    camera_keys = ('parallelScale','scale','position','focalPoint','viewUp','viewPlaneNormal','flipHorizontal','flipVertical')
    diagnostics = {"action":"five native wheel steps forward and five back at90ms", "controlMatches":comparisons,
        "before":{**{key:value for key,value in before.items() if key!='camera'},"camera":{key:value for key,value in before['camera'].items() if key in camera_keys}},
        "after":{**{key:value for key,value in after.items() if key!='camera'},"camera":{key:value for key,value in after['camera'].items() if key in camera_keys}}}
    (report / "adjustment-diagnostics.json").write_text(json.dumps(diagnostics,indent=2)+"\n",encoding="utf-8")
    expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", entries[middle]["attachment"])
    with page.expect_download() as event:
        page.locator("#download-original").click()
    recovered = report / "final-original.dcm";event.value.save_as(recovered)
    original = PdfReader(pdf).attachments[entries[middle]["attachment"]][0]
    assert recovered.read_bytes() == original and fingerprint(recovered) == entries[middle]["sha256"], "Final browser download differs from the selected unchanged source"
    expected = entries[middle]["sourcePath"]
    expect(page.locator("#selected-source")).to_have_text(expected)
    return {"case":"display-adjustments-and-recovery", **summarize(raw), "adjustmentsPreserved":all(comparisons.values()),
            "controlMatches":comparisons,"adjustedPixelsIdenticalOnReturn":pixels_before==pixels_after,"captionMatchesVisibleSource":True,"originalBytesAndSha256Match":True}


def compositor_burst(context,page,entries,renderable,middle):
    targets=renderable[len(renderable)//2:len(renderable)//2+12]
    for index in targets:
        select_source(page,index,entries[index])
    select_source(page,middle,entries[middle])
    box=page.locator("#viewport canvas").first.bounding_box()
    viewport=page.viewport_size;session=context.new_cdp_session(page);samples=[]
    def captured(event):
        try:
            image=Image.open(io.BytesIO(base64.b64decode(event['data']))).convert('RGB')
            sx,sy=image.width/viewport['width'],image.height/viewport['height']
            crop=image.crop((int((box['x']+4)*sx),int((box['y']+4)*sy),int((box['x']+box['width']-4)*sx),int((box['y']+box['height']-4)*sy)))
            extrema=crop.getextrema();low=min(value[0] for value in extrema);high=max(value[1] for value in extrema)
            samples.append({'frame':len(samples)+1,'hasImageContrast':high-low>20 and high>40})
        finally:
            session.send('Page.screencastFrameAck',{'sessionId':event['sessionId']})
    session.on('Page.screencastFrame',captured)
    session.send('Page.startScreencast',{'format':'png','maxWidth':720,'maxHeight':500,'everyNthFrame':1})
    try:
        page.wait_for_timeout(200);page.evaluate('__scrollProbe.begin()')
        page.evaluate("targets=>targets.forEach((index,ordinal)=>setTimeout(()=>{const select=document.querySelector('#image-list');select.value=String(index);select.dispatchEvent(new Event('change',{bubbles:true}));},ordinal*10))",targets)
        page.wait_for_timeout(1000);raw=page.evaluate('__scrollProbe.end()')
    finally:
        session.send('Page.stopScreencast');session.detach()
    result={'case':'compositor-source-picker-10ms',**summarize(raw),'compositorFrames':len(samples),
            'compositorBlankFrames':sum(not sample['hasImageContrast'] for sample in samples),'compositorSamples':samples}
    assert len(samples)>=3,'Browser compositor emitted too few frames to verify visibility'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--pdf", type=Path, default=Path("out/ct-abdomen-c4kc-kits-series.pdf"))
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--label", choices=("baseline","after","final"), default="baseline")
    parser.add_argument("--adjustments-only",action="store_true",help="Run the isolated pose/window and byte-recovery check")
    parser.add_argument("--compositor-only",action="store_true",help="Distinguish canvas reads between paints from actual compositor output")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    report = project / "target/scroll-performance" / args.label
    work_path(report, ".");report.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(PdfReader(args.pdf).attachments["manifest.json"][0])
    entries = manifest["images"]
    renderable = physical_order(entries, [index for index, entry in enumerate(entries) if entry["status"] == "rendered"])
    middle = renderable[len(renderable)//2]
    aliases = {hashlib.sha256(entry["attachment"].encode()).hexdigest():f"source-{index+1:03}" for index, entry in enumerate(entries)}
    extension = args.extension.resolve(strict=True)
    asset = fingerprint(extension / "viewer.js")
    result = {"pdfSha256": fingerprint(args.pdf), "pdfBytes": args.pdf.stat().st_size, "suppliedSources": len(entries), "renderableSources": len(renderable),
              "extensionViewerSha256": asset, "httpRequests": 0, "pageErrors": 0, "cases": []}
    with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="profile-", dir=report) as profile:
        context = launch(playwright, args.chromium, extension, profile)
        try:
            result["browserVersion"] = context.browser.version
            extension_id = extension_identity(context)
            context.set_offline(True);context.add_init_script(PROBE)
            context.on("request", lambda request: result.__setitem__("httpRequests", result["httpRequests"]+1) if request.url.startswith(("http:", "https:")) else None)
            context.on("weberror", lambda error: result.__setitem__("pageErrors", result["pageErrors"]+1))
            page = context.new_page();page.goto(f"chrome-extension://{extension_id}/viewer.html", wait_until="domcontentloaded")
            page.evaluate("map=>__scrollProbe.map=map", aliases)
            page.locator("#pdf-file").set_input_files(args.pdf)
            initial = next(entry for entry in entries if entry["status"] == "rendered")
            expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", initial["attachment"], timeout=120000)
            if args.compositor_only:
                result['cases'].append(compositor_burst(context,page,entries,renderable,middle))
                print(json.dumps(result['cases'][-1]),flush=True)
            for interval in (() if args.adjustments_only or args.compositor_only else (70, 90, 120)):
                select_source(page, middle, entries[middle]);page.evaluate("__scrollProbe.begin()")
                wheel_pattern(page,[1]*args.steps+[-1]*args.steps,interval)
                page.wait_for_timeout(750);raw=page.evaluate("__scrollProbe.end()")
                summary={"case": f"wheel-{interval}ms", "plannedIntervalMs": interval, **summarize(raw)}
                result["cases"].append(summary)
                (report / f"wheel-{interval}ms-events.json").write_text(json.dumps(raw, indent=2)+"\n", encoding="utf-8")
                (report / "summary.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
                print(json.dumps(summary), flush=True)
            if not args.adjustments_only and not args.compositor_only:
                select_source(page, middle, entries[middle]);page.evaluate("__scrollProbe.begin()")
                targets=renderable[len(renderable)//2:len(renderable)//2+12]
                page.evaluate("targets=>targets.forEach((index,ordinal)=>setTimeout(()=>{const select=document.querySelector('#image-list');select.value=String(index);select.dispatchEvent(new Event('change',{bubbles:true}));},ordinal*10))", targets)
                page.wait_for_timeout(1500);raw=page.evaluate("__scrollProbe.end()")
                summary={"case":"selection-supersession-10ms",**summarize(raw)};result["cases"].append(summary)
                (report / "selection-supersession-events.json").write_text(json.dumps(raw, indent=2)+"\n", encoding="utf-8")
                print(json.dumps(summary), flush=True)
            if args.label != "baseline" and not args.compositor_only:
                if not args.adjustments_only:
                    select_source(page,middle,entries[middle]);page.evaluate("__scrollProbe.begin()")
                    wheel_pattern(page, [direction for _ in range(10) for direction in (1,1,-1,-1)],70)
                    page.wait_for_timeout(500);raw=page.evaluate("__scrollProbe.end()")
                    summary={"case":"abrupt-reversals-70ms",**summarize(raw)};result["cases"].append(summary)
                    (report / "abrupt-reversals-events.json").write_text(json.dumps(raw,indent=2)+"\n",encoding="utf-8")
                    print(json.dumps(summary),flush=True)
                result["cases"].append(adjustment_and_recovery(page,entries,middle,report,args.pdf))
                print(json.dumps(result["cases"][-1]),flush=True)
        finally:
            context.close()
    result["extensionUnchanged"] = fingerprint(extension / "viewer.js") == asset
    checks=assess(result,report,args.label,args.compositor_only)
    result["status"] = "PASS" if checks and result["extensionUnchanged"] and not result["httpRequests"] and not result["pageErrors"] else "FAIL"
    filename='compositor-check.json' if args.compositor_only else 'adjustment-check.json' if args.adjustments_only else 'summary.json'
    (report / filename).write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({key:result[key] for key in ("status","extensionUnchanged","httpRequests","pageErrors")}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status":"FAIL","errorType":type(error).__name__}))
        raise SystemExit(1)
