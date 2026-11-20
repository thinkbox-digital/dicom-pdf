#!/usr/bin/env python3
"""Prove complete Cornerstone stacks, native wheel events and PDF/source tracking offline."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity, first_supported
from check_scroll_performance import physical_order


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('out/ct-abdomen-c4kc-kits-series.pdf'))
    args=parser.parse_args()
    report=Path('target/cornerstone-stack-checks');report.mkdir(parents=True,exist_ok=True)
    reader=PdfReader(args.pdf);manifest=json.loads(reader.attachments['manifest.json'][0])
    result={'httpRequests':0,'pageErrors':0}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        try:
            context.set_offline(True)
            context.on('request',lambda r:result.__setitem__('httpRequests',result['httpRequests']+1) if r.url.startswith(('http:','https:')) else None)
            page=context.pages[0];page.on('pageerror',lambda e:result.__setitem__('pageErrors',result['pageErrors']+1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.evaluate('''()=>{
              window.csStackProof={sets:[],scrolls:[],commits:[]};const e=document.getElementById('viewport');
              e.addEventListener('CORNERSTONE_VIEWPORT_NEW_IMAGE_SET',v=>csStackProof.sets.push(v.detail.imageIds.length));
              e.addEventListener('CORNERSTONE_STACK_VIEWPORT_SCROLL',v=>csStackProof.scrolls.push(v.detail.newImageIdIndex));
              e.addEventListener('CORNERSTONE_STACK_NEW_IMAGE',v=>csStackProof.commits.push(v.detail.imageId));
            }''')
            page.locator('#pdf-file').set_input_files(args.pdf.resolve())
            initial=first_supported(manifest);expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',manifest['images'][initial]['attachment'],timeout=30000)
            size=int(page.locator('#viewport').get_attribute('data-cornerstone-stack-size'))
            assert size>1 and page.evaluate('csStackProof.sets[0]')==size
            # Jump beyond the small neighbor cache, then native-wheel back.
            indices=[int(v) for v in page.locator('#image-list option').evaluate_all('options=>options.map(o=>o.value)')]
            target=indices[-2];page.locator('#image-list').select_option(str(target))
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',manifest['images'][target]['attachment'],timeout=30000)
            before=page.locator('#viewport').get_attribute('data-loaded-attachment')
            box=page.locator('#viewport').bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
            native_before=page.evaluate('csStackProof.scrolls.length');page.mouse.wheel(0,-120)
            page.wait_for_function('(old)=>document.getElementById("viewport").dataset.loadedAttachment!==old',arg=before)
            assert page.evaluate('csStackProof.scrolls.length')>native_before
            assert page.evaluate('csStackProof.sets.length')==1,'Navigation replaced the full stack instead of scrolling it'
            # A wheel in the same turn as a cold picker change must use the new
            # selection, not the native viewport's previously displayed index.
            chosen=indices[len(indices)//3]
            order=physical_order(manifest['images'],indices)
            wanted=order[order.index(chosen)+1]
            page.wait_for_timeout(40)
            page.evaluate('''index=>{
              const list=document.getElementById('image-list');list.value=String(index);list.dispatchEvent(new Event('change'));
              document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
            }''',chosen)
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',manifest['images'][wanted]['attachment'],timeout=30000)
            selected=int(page.locator('#image-list').input_value());entry=manifest['images'][selected]
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'])
            page.locator('#show-pdf').click();expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
            page.locator('#show-image').click();expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'])
            with page.expect_download() as event:page.locator('#download-original').click()
            recovered=report/'original.dcm';event.value.save_as(recovered)
            assert recovered.read_bytes()==reader.attachments[entry['attachment']][0]
            assert hashlib.sha256(recovered.read_bytes()).hexdigest()==entry['sha256']
            result.update({'browserVersion':context.browser.version,'stackImages':size,'stackSets':page.evaluate('csStackProof.sets.length'),
                'nativeScrollEvents':page.evaluate('csStackProof.scrolls.length'),'sourcePdfTracking':True,'originalByteExact':True,'pickerWheelSupersession':True})
            assert result['httpRequests']==result['pageErrors']==0,result
            result['passed']=True
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main()
