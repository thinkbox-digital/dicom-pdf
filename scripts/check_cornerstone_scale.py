#!/usr/bin/env python3
"""Measure lazy viewing of the synthetic 1,000-frame original; no source modifications."""
import hashlib
import json
from pathlib import Path
import tempfile
import time
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def fingerprint(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda:source.read(1024**2),b''):digest.update(block)
    return digest.hexdigest()


def main():
    source=Path('target/native-stack-scale-inputs/synthetic-1000-frames.dcm')
    pdf=Path('target/viewer-test-pdfs/synthetic-1000-frame-stack.pdf')
    report=Path('target/cornerstone-scale-checks');report.mkdir(parents=True,exist_ok=True)
    original_hash=fingerprint(source)
    result={'synthetic':True,'sourceFiles':1,'sourceFrames':1000,'sourceBytes':source.stat().st_size,'httpRequests':0,'pageErrors':0,'selections':[]}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        try:
            context.set_offline(True)
            context.on('request',lambda r:result.__setitem__('httpRequests',result['httpRequests']+1) if r.url.startswith(('http:','https:')) else None)
            context.add_init_script('''(()=>{
              const Native=Worker;window.decodeScale={registered:0,decoded:0};
              window.Worker=class extends Native {
                constructor(url,options){super(url,options);if(String(url).endsWith('/dicom.worker.mjs'))this.addEventListener('message',e=>{if(e.data?.type==='decoded')decodeScale.decoded++;if(e.data?.type==='registered')decodeScale.registered++;});}
              };
            })()''')
            page=context.pages[0];page.on('pageerror',lambda e:result.__setitem__('pageErrors',result['pageErrors']+1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.evaluate('''()=>{
              window.scale={sets:[],pixels:[],ticks:[],last:performance.now()};const e=document.getElementById('viewport');
              setInterval(()=>{const n=performance.now();scale.ticks.push(n-scale.last);scale.last=n;},10);
              e.addEventListener('CORNERSTONE_VIEWPORT_NEW_IMAGE_SET',v=>scale.sets.push(v.detail.imageIds.length));
              e.addEventListener('CORNERSTONE_STACK_NEW_IMAGE',v=>{
                const frame=Number(v.detail.imageId.split('-').at(-1)),value=v.detail.image.getPixelData()[128*256+128];
                scale.pixels.push({frame,correct:value===((128*9+128*5+(frame-1)*7)&4095)});
              });
            }''')
            session=context.new_cdp_session(page)
            result['mainHeapBefore']=session.send('Runtime.getHeapUsage')
            opened=time.monotonic();page.locator('#pdf-file').set_input_files(pdf.resolve())
            expect(page.locator('#viewport')).to_have_attribute('data-source-frame','1',timeout=60000)
            expect(page.locator('#save-view')).to_be_enabled(timeout=60000)
            result['openSeconds']=round(time.monotonic()-opened,3)
            expect(page.locator('#viewport')).to_have_attribute('data-cornerstone-stack-size','1000')
            result['mainHeapAfterOpen']=session.send('Runtime.getHeapUsage')
            result['openingMaxHeartbeatGapMs']=page.evaluate('Math.max(...scale.ticks)')
            page.evaluate('scale.ticks=[];scale.last=performance.now()')
            for frame in [2,500,999,250,750,1000,1,400,900,100,600,1]:
                started=time.monotonic()
                page.locator('#stack-position').evaluate('''(element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));}''',str(frame))
                expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(frame),timeout=30000)
                expect(page.locator('#viewport')).to_have_attribute('aria-busy','false')
                result['selections'].append({'frame':frame,'seconds':round(time.monotonic()-started,3)})
            box=page.locator('#viewport').bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
            for frame in range(2,12):
                page.mouse.wheel(0,120);expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(frame),timeout=30000);page.wait_for_timeout(40)
            result['mainHeapAfterNavigation']=session.send('Runtime.getHeapUsage')
            proof=page.evaluate('({sets:scale.sets,pixels:scale.pixels,worker:decodeScale,maxGap:Math.max(...scale.ticks)})')
            assert proof['sets']==[1000],proof['sets']
            assert all(row['correct'] for row in proof['pixels']),proof['pixels']
            assert proof['worker']['registered']==1,proof['worker']
            assert proof['worker']['decoded']<100,'Navigation eagerly decoded the entire stack'
            result.update({'stackSets':1,'allObservedSourcePixelsCorrect':True,'workerRegistrations':proof['worker']['registered'],
                'decodedFrames':proof['worker']['decoded'],'navigationMaxHeartbeatGapMs':round(proof['maxGap'],2)})
            with page.expect_download() as event:page.locator('#download-original').click()
            recovered=report/'original.dcm';event.value.save_as(recovered)
            assert recovered.stat().st_size==source.stat().st_size and fingerprint(recovered)==original_hash
            # Hash plus streaming equality independently tests the saved original.
            with source.open('rb') as left,recovered.open('rb') as right:
                while True:
                    a,b=left.read(1024**2),right.read(1024**2);assert a==b
                    if not a:break
            result['originalByteExact']=True;result['browserVersion']=context.browser.version
            result['heapScope']='Main renderer V8 only; excludes worker/native/GPU memory and is not total browser RSS'
            assert result['httpRequests']==result['pageErrors']==0,result
            result['passed']=True
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main()
