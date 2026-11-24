#!/usr/bin/env python3
"""Check initial raster fitting and DICOM toolbar visibility with synthetic images."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import uuid
import zlib

from playwright.sync_api import expect, sync_playwright
from check_extension import extension_identity, launch


def pixels(width, height):
    return bytes((x // 10 + y // 20) % 256 for y in range(height) for x in range(width))


def png(path, width, height):
    data = pixels(width, height)
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)
    raw = b''.join(b'\0' + data[y * width:(y + 1) * width] for y in range(height))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def dicom(path, width, height):
    def field(group, element, vr, value):
        if isinstance(value, str):
            value = value.encode('ascii')
        if len(value) % 2:
            value += b'\0' if vr in ['UI', 'OB'] else b' '
        prefix = struct.pack('<HH', group, element) + vr.encode()
        return prefix + (b'\0\0' + struct.pack('<I', len(value)) if vr in ['OB', 'OW']
                         else struct.pack('<H', len(value))) + value
    def uid():
        return '2.25.' + str(uuid.uuid4().int)
    sop, instance = '1.2.840.10008.5.1.4.1.1.7', uid()
    meta = b''.join([field(2, 1, 'OB', b'\0\1'), field(2, 2, 'UI', sop), field(2, 3, 'UI', instance),
                     field(2, 16, 'UI', '1.2.840.10008.1.2.1'), field(2, 18, 'UI', uid())])
    fields = [(8, 22, 'UI', sop), (8, 24, 'UI', instance), (8, 96, 'CS', 'OT'),
              (16, 16, 'PN', 'SYNTHETIC^LAYOUT'), (16, 32, 'LO', 'SYNTHETIC-NOT-PATIENT'),
              (32, 13, 'UI', uid()), (32, 14, 'UI', uid()), (32, 17, 'IS', '1'), (32, 19, 'IS', '1'),
              (40, 2, 'US', struct.pack('<H', 1)), (40, 4, 'CS', 'MONOCHROME2'),
              (40, 16, 'US', struct.pack('<H', height)), (40, 17, 'US', struct.pack('<H', width)),
              (40, 256, 'US', struct.pack('<H', 8)), (40, 257, 'US', struct.pack('<H', 8)),
              (40, 258, 'US', struct.pack('<H', 7)), (40, 259, 'US', struct.pack('<H', 0)),
              (32736, 16, 'OB', pixels(width, height))]
    path.write_bytes(b'\0' * 128 + b'DICM' + field(2, 0, 'UL', struct.pack('<I', len(meta)))
                     + meta + b''.join(field(*value) for value in fields))


GEOMETRY = """() => {
  const box = element => {const r=element.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const c=document.getElementById('attachment-content'),stage=c.querySelector('.raster-preview-stage'),image=c.querySelector('img'),style=getComputedStyle(stage);
  return {windowHeight:innerHeight,windowWidth:innerWidth,bodyHeight:document.body.scrollHeight,
    bodyWidth:document.body.scrollWidth,footer:box(document.querySelector('.app-footer')),
    toolbar:box(document.querySelector('.attachment-toolbar')),imageControls:box(document.getElementById('preview-image-controls')),content:box(c),stage:box(stage),
    availableWidth:stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
    availableHeight:stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),
    scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,image:box(image),
    naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight};
}"""


def preview_geometry(page, width, height):
    page.wait_for_function('([w,h])=>{const i=document.querySelector("#attachment-content img"),s=i?.closest(".attachment-preview-raster");return i?.complete&&i.naturalWidth===w&&i.naturalHeight===h&&Number(s?.dataset.previewScale)>0;}', arg=[width, height])
    expect(page.locator('#close-attachment')).to_be_in_viewport()
    expect(page.locator('#preview-image-controls')).to_be_in_viewport(ratio=1)
    for control in page.locator('#preview-image-controls button, #preview-image-controls input').all():
        expect(control).to_be_in_viewport(ratio=1)
        expect(control).to_be_enabled()
    value = page.evaluate(GEOMETRY)
    assert value['bodyHeight'] <= value['windowHeight'] + 1, value
    assert value['bodyWidth'] <= value['windowWidth'] + 1, value
    assert value['scrollHeight'] <= value['clientHeight'] + 1, value
    expected = min(1, value['availableWidth'] / width, value['availableHeight'] / height)
    assert abs(value['image']['height'] - height * expected) < 2, value
    assert abs(value['image']['width'] - width * expected) < 2, value
    assert value['image']['y'] >= value['stage']['y'], value
    assert value['image']['bottom'] <= value['imageControls']['y'] + 1, value
    assert value['imageControls']['bottom'] <= value['footer']['y'] + 1, value
    return value


def create_archive(inputs, pdf):
    pdf.unlink(missing_ok=True)
    created = subprocess.run(['java', '-jar', 'dist/dicom-pdf-0.61.0.jar', 'create', '--input', str(inputs),
                              '--output', str(pdf), '--c2pa', 'off'], capture_output=True, text=True, timeout=90)
    log = pdf.with_suffix('.log')
    log.write_text(created.stdout + created.stderr)
    assert created.returncode == 0, f'Synthetic archive creation failed; see {log}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=Path('target/tall-image-layout/browser'))
    parser.add_argument('--chromium', default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args = parser.parse_args()
    report = args.report.resolve()
    if not report.is_relative_to(Path('target').resolve()):
        raise ValueError('Reports and synthetic inputs must stay under target/')
    report.mkdir(parents=True, exist_ok=True)
    inputs = report / 'raster-inputs'
    inputs.mkdir(exist_ok=True)
    shapes = [('00-tall.png', 300, 5000), ('01-wide.png', 5000, 300), ('02-small.png', 64, 32)]
    for name, width, height in shapes:
        png(inputs / name, width, height)
    dicom_inputs = report / 'dicom-inputs'
    dicom_inputs.mkdir(exist_ok=True)
    dicom(dicom_inputs / 'synthetic-tall.dcm', 300, 5000)
    pdf = report / 'synthetic-tall-preview.pdf'
    dicom_pdf = report / 'synthetic-tall-dicom.pdf'
    create_archive(inputs, pdf)
    create_archive(dicom_inputs, dicom_pdf)
    results = []
    version = json.loads(Path('viewer/package.json').read_text())['version']
    def check_version(page):
        indicator = page.locator('#viewer-version')
        expect(indicator).to_have_text('Viewer ' + version)
        expect(indicator).to_be_in_viewport(ratio=1)
        assert page.locator('meta[name="application-version"]').get_attribute('content') == version
        geometry = indicator.bounding_box()
        footer = page.locator('.app-footer').bounding_box()
        assert geometry['x'] + geometry['width'] >= footer['width'] - 20
        assert geometry['y'] >= footer['y']
    with sync_playwright() as p:
        for mode in ['extension', 'standalone']:
            with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
                context = launch(p, args.chromium, Path('target/chrome-extension').resolve(), profile)
                requests, errors = [], []
                context.set_offline(True)
                context.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
                page = context.pages[0]
                page.on('pageerror', lambda e: errors.append(str(e)))
                address = f'chrome-extension://{extension_identity(context)}/viewer.html' if mode == 'extension' else Path('src/main/resources/viewer.html').resolve().as_uri()
                try:
                    for viewport in [{'width':1600,'height':900}, {'width':1000,'height':400}, {'width':760,'height':500}, {'width':480,'height':720}]:
                        page.set_viewport_size(viewport)
                        page.goto(address)
                        check_version(page)
                        page.locator('#pdf-file').set_input_files(pdf)
                        expect(page.locator('#attachment-content img')).to_be_visible(timeout=30000)
                        if viewport['width'] <= 850 and page.locator('#details-panel').is_visible():
                            page.locator('#toggle-details').click()
                        cases = []
                        for index, (_, width, height) in enumerate(shapes):
                            if index:
                                page.locator('#image-list').select_option(str(index))
                            cases.append(preview_geometry(page, width, height))
                        page.locator('#image-list').select_option('0')
                        preview_geometry(page, 300, 5000)
                        check_version(page)
                        page.locator('#save-menu summary').click()
                        with page.expect_download() as download:
                            page.locator('#download-original').click()
                        recovered = report / f'{mode}-{viewport["width"]}-original.png'
                        download.value.save_as(recovered)
                        assert recovered.read_bytes() == (inputs / shapes[0][0]).read_bytes()
                        page.screenshot(path=str(report / f'{mode}-{viewport["width"]}-fit.png'))
                        page.locator('#pdf-file').set_input_files(dicom_pdf)
                        expect(page.locator('#viewport')).to_have_attribute('data-source-frame','1',timeout=30000)
                        expect(page.locator('#fit-view')).to_be_enabled()
                        expect(page.locator('#controls')).to_be_in_viewport(ratio=1)
                        geometry = page.locator('#controls').evaluate('(e)=>({bottom:e.getBoundingClientRect().bottom,window:innerHeight,viewport:document.getElementById("viewport").clientHeight})')
                        assert geometry['bottom'] <= geometry['window'] and geometry['viewport'] > 40, geometry
                        page.locator('#fit-view').click()
                        check_version(page)
                        results.append({'mode':mode,'viewport':viewport,'viewerVersion':version,'versionVisible':True,'rasterCases':cases,'originalByteExact':True,'dicomControlsVisible':True,'passed':True})
                    assert not requests and not errors, {'requests':requests,'errors':errors}
                finally:
                    context.close()
    (report / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'cases':len(results),'rasterShapesPerCase':len(shapes),'httpRequests':0,'pageErrors':0,'passed':True}))


if __name__ == '__main__':
    main()
