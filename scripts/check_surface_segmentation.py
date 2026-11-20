#!/usr/bin/env python3
"""Check Surface Segmentation archives in both offline viewer artifacts."""

import argparse
import base64
import json
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from check_extension import extension_identity, manifest_for


SURFACE_STORAGE = '1.2.840.10008.5.1.4.1.1.66.5'
WEBGL2_SUPPORTED = "() => !!document.createElement('canvas').getContext('webgl2')"


def capture(page, canvas):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    return canvas.screenshot(animations='disabled')


def scene_pixels(page, png, reference=None):
    return page.evaluate("""async ([png, reference]) => {
        async function read(encoded) {
            const bytes = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0));
            const image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            image.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height);
        }
        const {data: pixels, width} = await read(png);
        const before = reference ? (await read(reference)).data : null;
        const distance = (a, i, b, j) => Math.max(
            Math.abs(a[i] - b[j]), Math.abs(a[i+1] - b[j+1]), Math.abs(a[i+2] - b[j+2]));
        let foreground = 0, changed = 0, xSum = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (distance(pixels, i, pixels, 0) > 12) {
                foreground++;
                xSum += (i / 4) % width;
            }
            if (before && distance(pixels, i, before, i) > 12) changed++;
        }
        return {foreground, changed, centerX: foreground ? xSum / foreground : 0};
    }""", [base64.b64encode(image).decode('ascii') if image else None for image in (png, reference)])


def open_archive(page, pdf):
    page.locator('#pdf-file').set_input_files(pdf.resolve())
    expect(page.locator('#document-name')).to_have_text(pdf.name, timeout=30000)
    expect(page.locator('#loading-dialog')).to_be_hidden(timeout=30000)


def check_original(page, original):
    page.locator('#save-menu summary').click()
    expect(page.locator('#download-original')).to_be_enabled()
    expect(page.locator('#save-view')).to_be_disabled()
    with page.expect_download() as event:
        page.locator('#download-original').click()
    assert event.value.suggested_filename == original.name
    assert event.value.path().read_bytes() == original.read_bytes(), 'The downloaded mesh differs from the original'
    menu = page.locator('#save-menu')
    if menu.evaluate('element => element.open'):
        menu.locator('summary').click()


def check_mesh(page, entry, original, image_pdf):
    mesh = page.locator('.surface-segmentation')
    canvas = mesh.locator('.surface-segmentation-canvas canvas')
    expect(canvas).to_be_visible(timeout=30000)
    expect(page.locator('#selected-source')).to_have_text(entry['sourcePath'])
    expect(page.locator('#show-image')).to_have_text('3D surface')
    baseline = capture(page, canvas)
    initial = scene_pixels(page, baseline)
    foreground = initial['foreground']
    assert foreground > 1000, f'Initial surface scene has only {foreground} foreground pixels'

    mesh.get_by_role('button', name='Rotate left', exact=True).click()
    rotated = capture(page, canvas)
    orbit = scene_pixels(page, rotated, baseline)
    assert orbit['changed'] > 1000, 'Rotate did not change the rendered mesh'
    mesh.get_by_role('button', name='Zoom in', exact=True).click()
    zoomed = capture(page, canvas)
    assert scene_pixels(page, zoomed)['foreground'] > orbit['foreground'], 'Zoom in did not enlarge the mesh'
    reset = mesh.get_by_role('button', name='Reset view', exact=True)

    def reset_camera():
        reset.click()
        changed = scene_pixels(page, capture(page, canvas), baseline)['changed']
        assert changed < foreground / 100, f'Reset left {changed} pixels significantly changed'

    reset_camera()

    box = canvas.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

    def drag():
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 100, y + 40, steps=8)
        page.mouse.up()

    drag()
    assert scene_pixels(page, capture(page, canvas), baseline)['changed'] > 1000, 'Drag did not rotate the mesh'
    reset_camera()
    page.keyboard.down('Shift')
    try:
        drag()
    finally:
        page.keyboard.up('Shift')
    panned = scene_pixels(page, capture(page, canvas))
    # Headless pointer movement can coalesce. Check direction and similar area.
    shift = panned['centerX'] - initial['centerX']
    assert shift > 10, f'Shift + drag moved the mesh {shift:.1f} pixels right'
    assert abs(panned['foreground'] - foreground) < foreground * 0.1, 'Pan changed the mesh area'
    reset_camera()
    page.mouse.move(x, y)
    page.mouse.wheel(0, -120)
    assert scene_pixels(page, capture(page, canvas))['foreground'] > foreground, 'Wheel did not zoom in'

    page.locator('#show-pdf').click()
    expect(page.locator('#pdf-canvas')).to_be_visible()
    expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
    expect(mesh).to_be_hidden()
    page.locator('#show-image').click()
    expect(canvas).to_be_visible(timeout=30000)
    assert scene_pixels(page, capture(page, canvas))['foreground'] > 1000, 'Surface did not render on return from PDF'
    check_original(page, original)

    open_archive(page, image_pdf)
    expect(page.locator('#viewport canvas').first).to_be_visible(timeout=30000)
    expect(page.locator('#reset')).to_be_enabled()
    expect(page.locator('#show-image')).to_have_text('DICOM image')
    expect(mesh).to_have_count(0)
    return {'foregroundPixels': foreground, 'orbitPanZoomReset': True, 'pdfReferenceReturn': True,
            'originalByteExact': True, 'imageArchiveAfterSurface': True}


def check_unavailable(page, original):
    expect(page.get_by_text('Surface segmentation: viewing unavailable', exact=True)).to_be_visible(timeout=30000)
    expect(page.locator('#selected-source')).to_have_text(original.name)
    check_original(page, original)
    return {'webglUnavailableMessage': True, 'originalByteExact': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=Path('out/LASegSample.dcm.pdf'))
    parser.add_argument('--original', type=Path, default=Path('in/LASegSample.dcm'))
    parser.add_argument('--image-pdf', type=Path, default=Path('target/viewer-test-pdfs/sample-images.pdf'))
    parser.add_argument('--viewer', type=Path, default=Path('src/main/resources/viewer.html'))
    parser.add_argument('--extension', type=Path, default=Path('target/chrome-extension'))
    parser.add_argument('--chromium', help='Browser executable. Defaults to Playwright Chromium.')
    parser.add_argument('--report', type=Path, default=Path('target/surface-segmentation-checks'))
    args = parser.parse_args()
    report = args.report.resolve()
    if not report.is_relative_to(Path('target').resolve()):
        raise ValueError('Reports must stay under target/')
    report.mkdir(parents=True, exist_ok=True)
    extension = args.extension.resolve(strict=True)
    manifest, _ = manifest_for(args.pdf)
    entry, = (entry for entry in manifest['images']
              if entry.get('fields', {}).get('SOPClassUID') == SURFACE_STORAGE)
    chromium = {'executable_path': args.chromium} if args.chromium else {'channel': 'chromium'}
    results = {}
    with sync_playwright() as playwright:
        for mode in ('standalone', 'extension', 'webgl-unavailable'):
            flags = ['--enable-unsafe-swiftshader']
            if mode == 'extension':
                flags += [f'--disable-extensions-except={extension}', f'--load-extension={extension}']
            if mode == 'webgl-unavailable':
                flags = ['--disable-webgl']
            with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
                context = playwright.chromium.launch_persistent_context(
                    profile, headless=True, accept_downloads=True, downloads_path=profile, args=flags,
                    ignore_default_args=['--disable-extensions'], viewport={'width': 1440, 'height': 1000},
                    **chromium)
                try:
                    context.set_offline(True)
                    requests, errors = [], []
                    context.on('request', lambda request: requests.append(request.url)
                               if request.url.startswith(('http:', 'https:')) else None)
                    page = context.pages[0]
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    address = (f'chrome-extension://{extension_identity(context)}/viewer.html'
                               if mode == 'extension' else args.viewer.resolve().as_uri())
                    page.goto(address)
                    assert page.evaluate(WEBGL2_SUPPORTED) == (mode != 'webgl-unavailable'), 'Unexpected WebGL support'
                    open_archive(page, args.pdf)
                    checks = (check_unavailable(page, args.original) if mode == 'webgl-unavailable'
                              else check_mesh(page, entry, args.original, args.image_pdf))
                    assert not requests and not errors, {'requests': requests, 'errors': errors}
                    results[mode] = {'browserVersion': context.browser.version,
                                     'httpRequests': len(requests), 'pageErrors': len(errors), **checks}
                finally:
                    context.close()
    (report / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
