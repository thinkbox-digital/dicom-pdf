#!/usr/bin/env python3
"""Exercise permanent raster controls offline, including DICOM-to-image transitions."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import tempfile

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright
from check_extension import extension_identity, launch


def toolbar_visible(page):
    toolbar = page.locator('#preview-image-controls')
    expect(toolbar).to_be_in_viewport(ratio=1)
    for control in toolbar.locator('button,input').all():
        expect(control).to_be_enabled()
        expect(control).to_be_in_viewport(ratio=1)
    value = toolbar.evaluate('(e)=>({bottom:e.getBoundingClientRect().bottom,window:innerHeight})')
    assert value['bottom'] <= value['window'] + 1, value


def fitted(page):
    page.wait_for_function("""() => {
      const s=document.querySelector('.raster-preview-stage'),i=s?.querySelector('img');
      if(!i?.complete||!i.naturalWidth)return false;
      const a=s.getBoundingClientRect(),b=i.getBoundingClientRect();
      return b.width>0&&b.height>0&&b.left>=a.left-1&&b.right<=a.right+1&&b.top>=a.top-1&&b.bottom<=a.bottom+1;
    }""")
    toolbar_visible(page)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--image-index', type=int, default=1)
    parser.add_argument('--dicom-index', type=int)
    parser.add_argument('--report', type=Path, default=Path('target/raster-preview-controls/interaction'))
    parser.add_argument('--chromium', default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args = parser.parse_args()
    source, report = args.pdf.resolve(), args.report.resolve()
    if not report.is_relative_to(Path('target').resolve()):
        raise ValueError('Reports and recovered files must stay under target/')
    report.mkdir(parents=True, exist_ok=True)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    reader = PdfReader(source)
    manifest = json.loads(reader.attachments['manifest.json'][0])
    entry = manifest['images'][args.image_index]
    original = reader.attachments[entry['attachment']][0]
    results = []
    with sync_playwright() as p:
        mode = 'extension'
        with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
            context = launch(p, args.chromium, Path('target/chrome-extension').resolve(), profile)
            requests, errors = [], []
            context.set_offline(True)
            context.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
            page = context.pages[0]
            page.on('pageerror', lambda e: errors.append(str(e)))
            address = f'chrome-extension://{extension_identity(context)}/viewer.html'
            try:
                for viewport in [{'width':1600,'height':900}, {'width':1000,'height':400}, {'width':1000,'height':600}, {'width':480,'height':720}]:
                    page.set_viewport_size(viewport)
                    page.goto(address)
                    page.locator('#pdf-file').set_input_files(source)
                    expect(page.locator('#image-list option').first).to_be_attached(timeout=30000)
                    if args.dicom_index is not None:
                        page.locator('#image-list').select_option(str(args.dicom_index))
                        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', manifest['images'][args.dicom_index]['attachment'], timeout=30000)
                    page.locator('#image-list').select_option(str(args.image_index))
                    expect(page.locator('#preview-zoom-in')).to_be_enabled(timeout=30000)
                    if viewport['width'] <= 850 and page.locator('#details-panel').is_visible():
                        page.locator('#toggle-details').click()
                    fitted(page)
                    surface = page.locator('.attachment-preview-raster')
                    image = surface.locator('img')
                    scale = float(surface.get_attribute('data-preview-scale'))
                    page.locator('#preview-zoom-in').click()
                    assert float(surface.get_attribute('data-preview-scale')) > scale
                    assert surface.get_attribute('data-preview-fit') == 'false'
                    toolbar_visible(page)
                    for _ in range(4):
                        page.locator('#preview-zoom-in').click()
                    stage = page.locator('.raster-preview-stage')
                    position = stage.evaluate('(e)=>({x:e.scrollLeft,y:e.scrollTop})')
                    box = stage.bounding_box()
                    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                    page.mouse.down()
                    page.mouse.move(box['x'] + box['width'] / 2 - 15, box['y'] + box['height'] / 2 - 15, steps=4)
                    page.mouse.up()
                    moved = stage.evaluate('(e)=>({x:e.scrollLeft,y:e.scrollTop})')
                    assert moved != position, {'before':position,'after':moved}
                    scale = float(surface.get_attribute('data-preview-scale'))
                    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                    page.keyboard.down('Control')
                    page.mouse.wheel(0,-120)
                    page.keyboard.up('Control')
                    expect(surface).not_to_have_attribute('data-preview-scale',str(scale))
                    toolbar_visible(page)
                    page.locator('#preview-zoom-out').click()
                    page.locator('#preview-fit').click()
                    fitted(page)
                    for name, value in [('brightness','20'),('contrast','150')]:
                        page.locator('#preview-' + name).evaluate('(e,value)=>{e.value=value;e.dispatchEvent(new Event("input",{bubbles:true}));}', value)
                    page.locator('#preview-invert').click()
                    expect(page.locator('#preview-invert')).to_have_attribute('aria-pressed','true')
                    assert 'brightness(1.2)' in image.get_attribute('style')
                    assert 'contrast(1.5)' in image.get_attribute('style')
                    assert 'invert(1)' in image.get_attribute('style')
                    page.locator('#preview-rotate-right').click()
                    expect(surface).to_have_attribute('data-preview-rotation','90')
                    fitted(page)
                    dimensions = image.evaluate('(i)=>({width:i.naturalWidth,height:i.naturalHeight})')
                    expect(page.locator('#preview-save-copy, #controls #save-view')).to_have_count(0)
                    page.locator('#save-menu > summary').click()
                    with page.expect_download() as download:
                        page.locator('#save-view').click()
                    saved = report / f'{mode}-{viewport["width"]}-viewing-copy.png'
                    download.value.save_as(saved)
                    png = saved.read_bytes()
                    assert png.startswith(b'\x89PNG\r\n\x1a\n')
                    assert struct.unpack('>II', png[16:24]) == (dimensions['height'], dimensions['width'] + 36)
                    page.locator('#preview-reset').click()
                    expect(surface).to_have_attribute('data-preview-rotation','0')
                    expect(page.locator('#preview-brightness')).to_have_value('0')
                    expect(page.locator('#preview-contrast')).to_have_value('100')
                    expect(page.locator('#preview-invert')).to_have_attribute('aria-pressed','false')
                    fitted(page)
                    page.locator('#preview-fullscreen').click()
                    page.wait_for_function('document.fullscreenElement?.classList.contains("attachment-preview-raster")')
                    toolbar_visible(page)
                    page.locator('#preview-fullscreen').click()
                    page.wait_for_function('!document.fullscreenElement')
                    fitted(page)
                    page.locator('#save-menu > summary').click()
                    with page.expect_download() as download:
                        page.locator('#download-original').click()
                    recovered = report / f'{mode}-{viewport["width"]}-original.bin'
                    download.value.save_as(recovered)
                    assert recovered.read_bytes() == original
                    page.locator('#preview-image-controls').screenshot(path=str(report / f'{mode}-{viewport["width"]}-controls.png'))
                    if args.dicom_index is not None:
                        page.locator('#image-list').select_option(str(args.dicom_index))
                        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', manifest['images'][args.dicom_index]['attachment'])
                        expect(page.locator('#controls')).to_be_in_viewport(ratio=1)
                        expect(page.locator('#preview-image-controls')).to_have_count(0)
                        page.locator('#image-list').select_option(str(args.image_index))
                        expect(page.locator('#preview-zoom-in')).to_be_enabled()
                        expect(page.locator('#preview-brightness')).to_have_value('0')
                        fitted(page)
                    results.append({'mode':mode,'viewport':viewport,'permanentControls':True,'zoomRotateAdjustReset':True,'dragPanAndCtrlWheelZoom':True,'viewingCopy':True,'fullscreen':True,'originalByteExact':True,'dicomTransition':args.dicom_index is not None,'passed':True})
                assert not requests and not errors, {'requests':requests,'errors':errors}
            finally:
                context.close()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    (report / 'summary.json').write_text(json.dumps({'sourceUnchanged':True,'cases':results,'httpRequests':0,'pageErrors':0}, indent=2) + '\n')
    print(json.dumps({'cases':len(results),'sourceUnchanged':True,'passed':True}))


if __name__ == '__main__':
    main()
