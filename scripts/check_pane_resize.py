#!/usr/bin/env python3
"""Offline browser proof for draggable/keyboard pane sizing and unchanged sources."""
import json
from pathlib import Path
import tempfile
from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity, first_supported


def main():
    report = Path('target/pane-resize-checks')
    report.mkdir(parents=True, exist_ok=True)
    pdf = Path('out/desktop-handover-20261116.pdf')
    reader = PdfReader(pdf)
    manifest = json.loads(reader.attachments['manifest.json'][0])
    results = []
    with sync_playwright() as p:
        for mode in ['extension', 'standalone']:
            with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
                context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome', Path('target/chrome-extension').resolve(), profile)
                result = {'mode': mode, 'httpRequests': 0, 'pageErrors': 0}
                try:
                    context.set_offline(True)
                    context.on('request', lambda r: result.__setitem__('httpRequests', result['httpRequests'] + 1) if r.url.startswith(('http:', 'https:')) else None)
                    page = context.pages[0]
                    page.on('pageerror', lambda e: result.__setitem__('pageErrors', result['pageErrors'] + 1))
                    page.set_viewport_size({'width': 1600, 'height': 1050})
                    page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html' if mode == 'extension' else Path('src/main/resources/viewer.html').resolve().as_uri())
                    page.locator('#pdf-file').set_input_files(pdf.resolve())
                    entry = manifest['images'][first_supported(manifest)]
                    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', entry['attachment'], timeout=30000)
                    expect(page.locator('.originals-split')).to_have_count(1)
                    expect(page.locator('.source-panel #download-original')).to_have_count(0)
                    left, right = page.locator('#resize-navigation'), page.locator('#resize-details')
                    expect(left).to_be_visible()
                    expect(right).to_be_visible()

                    def size(selector):
                        return page.locator(selector).bounding_box()['width']

                    def restore_overlay(selector, side):
                        button = page.locator(selector)
                        if mode == 'extension':
                            expect(button).to_be_visible()
                            arrow = button.bounding_box()
                            reader = page.locator('.reader-panel').bounding_box()
                            toolbar = page.locator('.reader-toolbar').bounding_box()
                            tabs = page.locator('.view-tabs').bounding_box()
                            assert toolbar['y'] == reader['y']
                            assert 0 <= arrow['y'] - reader['y'] <= 12
                            if side == 'left':
                                assert 0 <= arrow['x'] - reader['x'] <= 12
                                assert arrow['x'] + arrow['width'] <= tabs['x']
                            else:
                                assert 0 <= reader['x'] + reader['width'] - arrow['x'] - arrow['width'] <= 12
                                assert arrow['x'] >= tabs['x'] + tabs['width']
                        return button

                    def drag(handle, dx):
                        box = handle.bounding_box()
                        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + 100)
                        page.mouse.down()
                        page.mouse.move(box['x'] + box['width'] / 2 + dx, box['y'] + 100, steps=8)
                        page.mouse.up()
                        page.wait_for_timeout(120)

                    initial_left, initial_right = size('.source-panel'), size('#details-panel')
                    drag(left, 80)
                    assert abs(size('.source-panel') - initial_left - 80) <= 2
                    drag(right, -90)
                    assert abs(size('#details-panel') - initial_right - 90) <= 2
                    assert size('.reader-panel') >= 320
                    right.focus()
                    before = size('#details-panel')
                    page.keyboard.press('ArrowLeft')
                    assert abs(size('#details-panel') - before - 10) <= 2
                    assert int(right.get_attribute('aria-valuenow')) == round(size('#details-panel'))
                    left.focus()
                    page.keyboard.press('Home')
                    assert abs(size('.source-panel') - 180) <= 2
                    page.keyboard.press('End')
                    assert size('.reader-panel') >= 320
                    page.keyboard.press('Enter')
                    assert abs(size('.source-panel') - initial_left) <= 2
                    right.dblclick(position={'x': 4, 'y': 100})
                    assert abs(size('#details-panel') - initial_right) <= 2
                    drag(left, 40)
                    wanted = size('.source-panel')
                    viewport_y = page.locator('#viewport').bounding_box()['y']
                    page.locator('#toggle-navigation').click()
                    expect(left).to_be_hidden()
                    restore_data = restore_overlay('#show-navigation', 'left')
                    if mode == 'extension':
                        expect(restore_data).to_be_focused()
                        assert page.locator('#viewport').bounding_box()['y'] == viewport_y
                        restore_data.press('Enter')
                        expect(page.locator('#toggle-navigation')).to_be_focused()
                    else:
                        restore_data.click()
                    expect(left).to_be_visible()
                    assert abs(size('.source-panel') - wanted) <= 2
                    page.locator('#toggle-details').click()
                    expect(right).to_be_hidden()
                    restore_overlay('#show-details', 'right').click()
                    expect(right).to_be_visible()
                    page.locator('#show-pdf').click()
                    drag(right, -20)
                    expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
                    page.locator('#show-image').click()
                    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', entry['attachment'])
                    page.screenshot(path=report / f'{mode}-wide.png')
                    page.set_viewport_size({'width': 480, 'height': 900})
                    page.wait_for_timeout(150)
                    assert size('.reader-panel') >= 180
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    expect(right).to_be_hidden()
                    restore_overlay('#show-details', 'right').click()
                    expect(right).to_be_visible()
                    drag(right, 70)
                    assert 200 <= size('#details-panel') <= 456
                    page.locator('#toggle-details').click()
                    with page.expect_download() as event:
                        page.locator('#download-original').click()
                    original = report / f'{mode}-original.dcm'
                    event.value.save_as(original)
                    assert original.read_bytes() == reader.attachments[entry['attachment']][0]
                    result.update({'browserVersion': context.browser.version, 'drag': True, 'keyboard': True, 'reset': True,
                                   'collapseRestore': True, 'pdfSourceTracking': True, 'narrowLayout': True, 'originalByteExact': True})
                    assert result['httpRequests'] == result['pageErrors'] == 0, result
                    result['passed'] = True
                    results.append(result)
                finally:
                    context.close()
    (report / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
