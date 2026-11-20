#!/usr/bin/env python3
"""Verify pinned source context survives frame, document and layout changes offline."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report = Path('target/comparison-context-checks')
    report.mkdir(parents=True, exist_ok=True)
    pinned = Path('target/overlay-inputs/02-enhanced-two-frames.dcm')
    other = Path('target/overlay-inputs/01-axial.dcm')
    expected = 'Series 2 · Synthetic per-frame orientation · Study 15 Nov 2026'
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
            page.locator('#dicom-files').set_input_files(pinned.resolve())
            expect(page.locator('#compare-current')).to_be_enabled(timeout=30000)
            page.locator('#compare-current').click()
            expect(page.locator('#comparison-next')).to_be_enabled(timeout=30000)
            expect(page.locator('#comparison-context')).to_have_text(expected)
            expect(page.locator('#comparison-context')).to_be_visible()
            page.locator('#comparison-next').click()
            expect(page.locator('#comparison-viewport')).to_have_attribute('data-source-frame', '2')
            expect(page.locator('#comparison-context')).to_have_text(expected)
            page.locator('#dicom-files').set_input_files(other.resolve())
            expect(page.locator('#compare-current')).to_be_enabled(timeout=30000)
            expect(page.locator('#selected-source')).to_have_text(other.name)
            expect(page.locator('#comparison-source')).to_have_text(pinned.name)
            expect(page.locator('#comparison-context')).to_have_text(expected)
            expect(page.locator('#comparison-viewport')).to_have_attribute('data-source-frame', '2')
            page.locator('#toggle-details').focus()
            page.set_viewport_size({'width': 500, 'height': 1000})
            expect(page.locator('#details-panel')).to_be_hidden()
            expect(page.locator('#show-details')).to_be_focused()
            # Opening metadata is still available by keyboard, and resizing
            # within the narrow range must respect that explicit choice.
            page.keyboard.press('Enter')
            expect(page.locator('#details-panel')).to_be_visible()
            expect(page.locator('#toggle-details')).to_be_focused()
            page.set_viewport_size({'width': 600, 'height': 1000})
            expect(page.locator('#details-panel')).to_be_visible()
            page.keyboard.press('Enter')
            expect(page.locator('#details-panel')).to_be_hidden()
            expect(page.locator('#show-details')).to_be_focused()
            page.set_viewport_size({'width': 1200, 'height': 1000})
            expect(page.locator('#details-panel')).to_be_hidden()
            page.keyboard.press('Enter')
            expect(page.locator('#details-panel')).to_be_visible()
            expect(page.locator('#toggle-details')).to_be_focused()
            page.set_viewport_size({'width': 500, 'height': 1000})
            expect(page.locator('#details-panel')).to_be_hidden()
            expect(page.locator('#show-details')).to_be_focused()
            page.locator('#toggle-navigation').focus()
            page.keyboard.press('Enter')
            expect(page.locator('#navigation-panel')).to_be_hidden()
            expect(page.locator('#show-navigation')).to_be_focused()
            page.keyboard.press('Enter')
            expect(page.locator('#navigation-panel')).to_be_visible()
            expect(page.locator('#toggle-navigation')).to_be_focused()
            page.locator('#comparison-context').scroll_into_view_if_needed()
            expect(page.locator('#comparison-context')).to_be_visible()
            assert page.locator('#comparison-context').get_attribute('title') == expected
            bounds = page.locator('#comparison-context').bounding_box()
            assert bounds and bounds['width'] <= 500 and bounds['height'] > 0
            page.screenshot(path=str(report / 'narrow.png'))
            with page.expect_download() as event:
                page.locator('#comparison-save').click()
            recovered = report / 'pinned.dcm'
            event.value.save_as(recovered)
            assert recovered.read_bytes() == pinned.read_bytes()
            page.locator('#close-comparison').click()
            expect(page.locator('#comparison-context')).to_be_hidden()
            expect(page.locator('#comparison-context')).to_have_text('')
            result.update({'browserVersion': context.browser.version, 'sourceContextMatches': True,
                           'retainedAcrossFrameAndDocument': True, 'narrowLayoutVisible': True,
                           'resizeCollapsesMetadata': True, 'keyboardPaneFocusRestored': True,
                           'explicitNarrowChoiceRetained': True,
                           'pinnedOriginalByteExact': True, 'closeClearsContext': True})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
