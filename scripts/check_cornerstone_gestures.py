#!/usr/bin/env python3
"""Real mouse/touch checks for the bundled Cornerstone Tools integration."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report=Path('target/cornerstone-gesture-checks');report.mkdir(parents=True,exist_ok=True)
    source=Path('target/overlay-inputs/01-axial.dcm')
    result={'httpRequests':0,'pageErrors':0}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        try:
            context.set_offline(True)
            context.on('request',lambda r:result.__setitem__('httpRequests',result['httpRequests']+1) if r.url.startswith(('http:','https:')) else None)
            page=context.pages[0];page.on('pageerror',lambda e:result.__setitem__('pageErrors',result['pageErrors']+1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.locator('#dicom-files').set_input_files(source.resolve())
            expect(page.locator('#compare-current')).to_be_enabled(timeout=30000)
            page.evaluate('''()=>{window.gestureCameras={};for(const id of ['viewport','comparison-viewport'])
              document.getElementById(id).addEventListener('CORNERSTONE_CAMERA_MODIFIED',e=>gestureCameras[id]=e.detail.camera);}''')
            def camera(id='viewport'):
                return page.evaluate('(id)=>gestureCameras[id]',id)
            def drag(id='viewport',button='left'):
                b=page.locator('#'+id).bounding_box();x=b['x']+b['width']/2;y=b['y']+b['height']/2
                page.mouse.move(x,y);page.mouse.down(button=button);page.mouse.move(x+30,y+30,steps=6);page.mouse.up(button=button)
            page.locator('#fit-view').click();before=camera();drag();after=camera()
            assert before['focalPoint']!=after['focalPoint'] and abs(before['scale']-after['scale'])<1e-6
            page.locator('#rotate-right').click();before=camera();drag();assert camera()['focalPoint']!=before['focalPoint']
            before=camera();drag(button='right');assert abs(camera()['scale']-before['scale'])>1e-4
            session=context.new_cdp_session(page)
            # Tools 2.x suppresses switching mouse/touch for two seconds to
            # prevent compatibility mouse events from duplicating a touch.
            page.wait_for_timeout(2100)
            b=page.locator('#viewport').bounding_box();x=b['x']+b['width']/2;y=b['y']+b['height']/2
            def touch(kind,points):
                session.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[{'id':i+1,'x':px,'y':py} for i,(px,py) in enumerate(points)]})
            before=camera();touch('touchStart',[(x,y)])
            for d in [8,16,24,32]:touch('touchMove',[(x+d,y+d)])
            touch('touchEnd',[]);page.wait_for_timeout(100)
            assert camera()['focalPoint']!=before['focalPoint'],'One-finger pan did not move the camera'
            before=camera();touch('touchStart',[(x-30,y),(x+30,y)])
            for d in [35,40,45,50]:touch('touchMove',[(x-d,y),(x+d,y)])
            touch('touchEnd',[]);page.wait_for_timeout(100)
            assert abs(camera()['scale']-before['scale'])>1e-4,'Pinch did not zoom'
            page.wait_for_timeout(2100)
            page.locator('#compare-current').click();expect(page.locator('#comparison-save')).to_be_enabled(timeout=30000)
            page.wait_for_timeout(100);main_before=camera();drag('comparison-viewport')
            assert camera('comparison-viewport') is not None and camera()==main_before
            with page.expect_download() as event:page.locator('#download-original').click()
            recovered=report/'original.dcm';event.value.save_as(recovered);assert recovered.read_bytes()==source.read_bytes()
            result.update({'browserVersion':context.browser.version,'mousePan':True,'rotatedPan':True,'rightDragZoom':True,
                           'touchPan':True,'pinchZoom':True,'comparisonIsolated':True,'originalByteExact':True})
            assert result['httpRequests']==result['pageErrors']==0,result
            result['passed']=True
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main()
