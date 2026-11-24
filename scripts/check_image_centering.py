#!/usr/bin/env python3
"""Check actual source-to-canvas centering for an asymmetrically padded image.

Synthetic inputs, screenshots and recovered originals stay under target/.
An optional local PDF can be checked without saving screenshots or metadata.
"""
import argparse
import json
from pathlib import Path
import struct
import tempfile

from playwright.sync_api import expect, sync_playwright
from check_extension import extension_identity, launch


PROBE = r"""(() => {
  window.centeringProof={};
  const original=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
    const result=original.call(this,image,...args);
    const host=this.canvas.closest('#viewport,#comparison-viewport');
    if(host){
      const matrix=this.getTransform(),box=this.canvas.getBoundingClientRect();
      centeringProof[host.id]={matrix:[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f],
        canvas:[this.canvas.width,this.canvas.height],css:[box.width,box.height],
        draws:(centeringProof[host.id]?.draws||0)+1};
    }
    return result;
  };
})();"""


def synthetic_topogram(destination):
    def element(group, tag, vr, value):
        if len(value) % 2:
            value += b'\0' if vr in ('UI', 'OB', 'OW') else b' '
        key = struct.pack('<HH', group, tag) + vr.encode()
        return key + (b'\0\0' + struct.pack('<I', len(value)) if vr in ('OB', 'OW') else struct.pack('<H', len(value))) + value

    def text(group, tag, vr, value):
        return element(group, tag, vr, value.encode())

    def number(tag, value):
        return element(0x0028, tag, 'US', struct.pack('<H', value))

    sop_class = '1.2.840.10008.5.1.4.1.1.2'
    uid = '2.25.900000000000000101'
    meta = text(2, 2, 'UI', sop_class) + text(2, 3, 'UI', uid) + text(2, 0x10, 'UI', '1.2.840.10008.1.2.1')
    pixels = b''.join(struct.pack('<H', 950 + (x * 3 + y * 7) % 250 if y < 286 else 0)
                      for y in range(512) for x in range(512))
    data = (text(8, 0x16, 'UI', sop_class) + text(8, 0x18, 'UI', uid) + text(8, 0x60, 'CS', 'CT')
            + text(0x20, 0x0D, 'UI', uid + '1') + text(0x20, 0x0E, 'UI', uid + '2')
            + number(2, 1) + text(0x28, 4, 'CS', 'MONOCHROME2') + number(0x10, 512) + number(0x11, 512)
            + text(0x28, 0x30, 'DS', '1\\1') + number(0x100, 16) + number(0x101, 12)
            + number(0x102, 11) + number(0x103, 0) + text(0x28, 0x1050, 'DS', '50')
            + text(0x28, 0x1051, 'DS', '350') + text(0x28, 0x1052, 'DS', '-1024')
            + text(0x28, 0x1053, 'DS', '1') + element(0x7FE0, 0x10, 'OW', pixels))
    destination.write_bytes(b'\0' * 128 + b'DICM' + element(2, 0, 'UL', struct.pack('<I', len(meta))) + meta + data)


def centered(page, identifier='viewport', fits=True):
    page.wait_for_timeout(100)
    proof = page.evaluate('(id)=>centeringProof[id]', identifier)
    a, b, c, d, e, f = proof['matrix']
    width, height = proof['canvas']
    points = [(a*x+c*y+e, b*x+d*y+f) for x, y in [(0, 0), (512, 0), (512, 286), (0, 286)]]
    center = [sum(p[i] for p in points)/4 for i in (0, 1)]
    error = max(abs(center[0]-width/2), abs(center[1]-height/2))
    assert error < 1, {'phase': identifier, 'center': center, 'canvas': [width, height], 'error': error}
    if fits:
        assert all(-1 <= x <= width+1 and -1 <= y <= height+1 for x, y in points), points
    return {'centerErrorPixels': round(error, 5), 'fullyVisible': fits}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path)
    args = parser.parse_args()
    report = Path('target/image-centering-checks')
    report.mkdir(parents=True, exist_ok=True)
    source = report / 'synthetic-topogram.dcm'
    synthetic_topogram(source)
    results = []
    with sync_playwright() as p:
        mode = 'extension'
        with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
            context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome', Path('target/chrome-extension').resolve(), profile)
            errors, requests = [], []
            try:
                context.set_offline(True)
                context.add_init_script(PROBE)
                context.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
                page = context.pages[0]
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.set_viewport_size({'width': 2502, 'height': 1340})
                page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
                page.locator('#dicom-files').set_input_files(source.resolve())
                expect(page.locator('#fit-view')).to_be_enabled(timeout=30000)
                checks = {'open': centered(page)}
                page.screenshot(path=report / f'{mode}-centered.png')
                page.locator('#zoom-in').click()
                page.locator('#viewport').focus()
                page.keyboard.press('Shift+ArrowDown')
                page.locator('#fit-view').click()
                checks['fitAfterPanZoom'] = centered(page)
                page.locator('#rotate-right').click()
                page.locator('#fit-view').click()
                checks['rotatedFit'] = centered(page)
                page.locator('#reset').click()
                checks['reset'] = centered(page)
                page.set_viewport_size({'width': 1600, 'height': 1000})
                page.locator('#fit-view').click()
                checks['resizedFit'] = centered(page)
                page.locator('#compare-current').click()
                expect(page.locator('#comparison-fit')).to_be_enabled(timeout=30000)
                page.locator('#comparison-fit').click()
                checks['comparisonFit'] = centered(page, 'comparison-viewport')
                page.locator('#comparison-reset').click()
                checks['comparisonReset'] = centered(page, 'comparison-viewport')
                page.locator('#save-menu summary').click()
                with page.expect_download() as event:
                    page.locator('#download-original').click()
                recovered = report / f'{mode}-original.dcm'
                event.value.save_as(recovered)
                assert recovered.read_bytes() == source.read_bytes()
                if args.pdf:
                    page.locator('#close-comparison').click()
                    page.locator('#pdf-file').set_input_files(args.pdf.resolve())
                    expect(page.locator('#fit-view')).to_be_enabled(timeout=90000)
                    page.wait_for_timeout(300)
                    checks['localArchiveOpen'] = centered(page)
                assert not errors and not requests, {'errors': errors, 'requests': requests}
                results.append({'mode': mode, 'checks': checks, 'originalByteExact': True,
                                'httpRequests': 0, 'pageErrors': 0, 'passed': True})
            finally:
                context.close()
    (report / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
