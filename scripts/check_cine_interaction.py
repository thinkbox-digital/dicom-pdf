#!/usr/bin/env python3
"""Offline synthetic cine keyboard/lifecycle regression in the extension."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report = Path('target/cine-interaction-checks')
    report.mkdir(parents=True, exist_ok=True)
    source = Path('target/overlay-inputs/02-enhanced-two-frames.dcm')
    result = {'httpRequests': 0, 'pageErrors': 0}
    with sync_playwright() as p, tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
        context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome',
                         Path('target/chrome-extension').resolve(), profile)
        try:
            context.set_offline(True)
            context.on('request', lambda r: result.__setitem__('httpRequests', result['httpRequests'] + 1)
                       if r.url.startswith(('http:', 'https:')) else None)
            page = context.pages[0]
            page.on('pageerror', lambda e: result.__setitem__('pageErrors', result['pageErrors'] + 1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.locator('#dicom-files').set_input_files(source.resolve())
            expect(page.locator('#cine-play')).to_be_visible(timeout=30000)
            expect(page.locator('#save-view')).to_be_enabled()
            page.locator('#cine-fps').fill('2')
            page.locator('#cine-fps').dispatch_event('change')
            page.locator('#viewport').focus()
            page.keyboard.down('Space')
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'true')
            for _ in range(9):
                page.keyboard.down('Space')
                expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'true')
            page.keyboard.up('Space')
            page.wait_for_function("()=>document.querySelector('#viewport').dataset.sourceFrame==='2'")
            page.keyboard.down('Space')
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'false')
            for _ in range(9):
                page.keyboard.down('Space')
                expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'false')
            page.keyboard.up('Space')
            page.wait_for_timeout(200)
            before = page.locator('#viewport').get_attribute('data-source-frame')
            page.wait_for_timeout(700)
            assert page.locator('#viewport').get_attribute('data-source-frame') == before
            page.locator('#viewport').dispatch_event('keydown', {'code': 'Space', 'isComposing': True})
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'false')
            page.keyboard.press('Space')
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'true')
            page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))")
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'false')
            page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
            page.wait_for_timeout(700)
            expect(page.locator('#cine-play')).to_have_attribute('aria-pressed', 'false')
            with page.expect_download() as event:
                page.locator('#download-original').click()
            recovered = report / 'recovered.dcm'
            event.value.save_as(recovered)
            assert recovered.read_bytes() == source.read_bytes()
            result.update({'browserVersion': context.browser.version, 'heldSpaceStartsOnce': True,
                           'heldSpacePausesOnce': True, 'composingSpaceIgnored': True,
                           'dispatchedPageHideStops': True, 'dispatchedPageShowDoesNotResume': True,
                           'originalByteExact': True})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
