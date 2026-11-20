#!/usr/bin/env python3
"""Offline synthetic PNG export check; generated files stay under target/."""
import json
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity

def main():
    report=Path('target/viewing-copy-checks');report.mkdir(parents=True,exist_ok=True)
    source=Path('target/overlay-inputs/01-axial.dcm')
    result={'httpRequests':0,'pageErrors':0}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        try:
            context.set_offline(True)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            page=context.pages[0];page.on('pageerror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.locator('#dicom-files').set_input_files(source.resolve())
            expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
            expect(page.locator('#image-overlays')).to_be_visible()
            def save(name):
                with page.expect_download() as event:page.locator('#save-view').click()
                path=report/name;event.value.save_as(path);return list(path.read_bytes())
            before=page.locator('#viewport canvas').first.evaluate('async c=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",c.getContext("2d").getImageData(0,0,c.width,c.height).data)))')
            on=save('info-on.png');page.locator('#toggle-overlays').click()
            expect(page.locator('#image-overlays')).to_be_hidden();off=save('info-off.png')
            comparison=page.evaluate('''async ({on,off})=>{
              async function read(bytes){const b=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
                const c=document.createElement('canvas');c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(b,0,0);b.close();return c;}
              const a=await read(on),b=await read(off),source=document.querySelector('#viewport canvas');
              if(a.width!==source.width||a.height!==source.height+36||b.width!==a.width||b.height!==a.height)throw Error('Copy dimensions differ');
              const original=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
              const x=a.getContext('2d').getImageData(0,0,source.width,source.height).data;
              const y=b.getContext('2d').getImageData(0,0,source.width,source.height).data;
              let overlayPixels=0,offMismatch=0;
              for(let i=0;i<original.length;i+=4){if(x[i]!==y[i]||x[i+1]!==y[i+1]||x[i+2]!==y[i+2])overlayPixels++;
                for(let channel=0;channel<4;channel++)if(y[i+channel]!==original[i+channel])offMismatch++;}
              return {overlayPixels,offMismatch,width:a.width,height:a.height};
            }''',{'on':on,'off':off})
            assert comparison['overlayPixels']>0 and comparison['offMismatch']==0,comparison
            after=page.locator('#viewport canvas').first.evaluate('async c=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",c.getContext("2d").getImageData(0,0,c.width,c.height).data)))')
            assert before==after,'Export changed displayed source pixels'
            with page.expect_download() as event:page.locator('#download-original').click()
            recovered=report/'recovered.dcm';event.value.save_as(recovered);assert recovered.read_bytes()==source.read_bytes()
            result.update(comparison);result.update({'sourceCanvasUnchanged':True,'originalByteExact':True,'browserVersion':context.browser.version})
            # A save requested while cine runs must pause and capture one stable
            # committed frame, with pixels matching the paused viewport.
            multiframe=Path('target/overlay-inputs/02-enhanced-two-frames.dcm')
            page.locator('#dicom-files').set_input_files(multiframe.resolve())
            expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
            expect(page.locator('#image-overlays')).to_be_hidden()
            captures=[]
            for fps in [10,60]:
                page.locator('#cine-fps').fill(str(fps));page.locator('#cine-fps').dispatch_event('change')
                page.locator('#cine-play').click()
                expect(page.locator('#cine-play')).to_have_attribute('aria-pressed','true')
                page.wait_for_timeout(180)
                png=save(f'cine-{fps}fps.png')
                expect(page.locator('#cine-play')).to_have_attribute('aria-pressed','false')
                frame=page.locator('#viewport').get_attribute('data-source-frame')
                page.wait_for_timeout(250)
                assert page.locator('#viewport').get_attribute('data-source-frame')==frame
                pixels=page.evaluate('''async bytes=>{
                  const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
                  const source=document.querySelector('#viewport canvas'),copy=document.createElement('canvas');
                  copy.width=bitmap.width;copy.height=bitmap.height;copy.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
                  if(copy.width!==source.width||copy.height!==source.height+36)throw Error('Unexpected cine copy dimensions');
                  const a=copy.getContext('2d').getImageData(0,0,source.width,source.height).data;
                  const b=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
                  let differences=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])differences++;
                  return {channels:a.length,differences};
                }''',png)
                assert pixels['differences']==0,pixels
                captures.append({'fps':fps,'frame':int(frame),'paused':True,**pixels})
            with page.expect_download() as event:page.locator('#download-original').click()
            cine_original=report/'cine-original.dcm';event.value.save_as(cine_original)
            assert cine_original.read_bytes()==multiframe.read_bytes()
            result.update({'cineCaptures':captures,'cineOriginalByteExact':True})
            assert result['httpRequests']==0 and result['pageErrors']==0,result
            result['passed']=True
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':main()
