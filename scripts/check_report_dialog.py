#!/usr/bin/env python3
"""Check report opening, scrolling, permanent close, and downloads in real browsers."""
import argparse
import json
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def opening_state(page):
    return page.evaluate("""() => ({
        dialogScroll: document.getElementById('archive-integrity-dialog').scrollTop,
        reportScroll: document.getElementById('archive-check-panel').scrollTop,
        focused: document.activeElement.id
    })""")


def assert_open_at_top(page):
    expect(page.locator('#archive-integrity-dialog')).to_be_visible()
    state = opening_state(page)
    assert state == {'dialogScroll': 0, 'reportScroll': 0, 'focused': 'close-archive-check'}, state
    expect(page.locator('#archive-integrity-title')).to_be_in_viewport()
    expect(page.get_by_role('button', name='Close validation report', exact=True)).to_be_in_viewport()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--report', type=Path, default=Path('target/report-dialog-fix/browser'))
    parser.add_argument('--chromium', default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args = parser.parse_args()
    report = args.report.resolve()
    if not report.is_relative_to(Path('target').resolve()):
        raise ValueError('Reports must stay under target/')
    report.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as playwright:
        mode = 'extension'
        with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
            context = launch(playwright, args.chromium, Path('target/chrome-extension').resolve(), profile)
            address = f'chrome-extension://{extension_identity(context)}/viewer.html'
            requests, errors = [], []
            try:
                context.set_offline(True)
                context.on('request', lambda request: requests.append(request.url)
                           if request.url.startswith(('http:', 'https:')) else None)
                page = context.pages[0]
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(address)
                page.locator('#pdf-file').set_input_files(args.pdf.resolve())
                expect(page.locator('#document-name:is([data-integrity="PASS"], [data-integrity="UNKNOWN"])')).to_be_visible(timeout=120000)
                for viewport in [{'width': 1000, 'height': 600}, {'width': 1440, 'height': 1000}, {'width': 1000, 'height': 400}]:
                    page.set_viewport_size(viewport)
                    page.locator('#document-name').click()
                    assert_open_at_top(page)
                    close = page.locator('#close-archive-check')
                    header = page.locator('#archive-integrity-dialog .archive-report-header')
                    initial = close.bounding_box()
                    dialog_box = page.locator('#archive-integrity-dialog').bounding_box()
                    assert initial['x'] > dialog_box['x'] + dialog_box['width'] / 2
                    assert initial['y'] + initial['height'] <= header.bounding_box()['y'] + header.bounding_box()['height']
                    stem = f'{mode}-{viewport["width"]}x{viewport["height"]}'
                    page.screenshot(path=str(report/f'{stem}-top.png'))

                    geometry = page.locator('#archive-check-panel').evaluate("""element => {
                        element.scrollTop = element.scrollHeight;
                        return {scrollTop:element.scrollTop,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};
                    }""")
                    assert geometry['scrollTop'] > 0, geometry
                    expect(close).to_be_in_viewport()
                    after = close.bounding_box()
                    assert abs(after['x'] - initial['x']) < 1 and abs(after['y'] - initial['y']) < 1, (initial, after)
                    save = page.locator('#save-archive-check')
                    expect(save).to_be_in_viewport()
                    assert save.bounding_box()['y'] >= header.bounding_box()['y']
                    assert save.bounding_box()['y'] + save.bounding_box()['height'] <= header.bounding_box()['y'] + header.bounding_box()['height']
                    page.screenshot(path=str(report/f'{stem}-bottom.png'))
                    with page.expect_download() as event:
                        save.click()
                    destination = report/f'{stem}-report.json'
                    event.value.save_as(destination)
                    assert json.loads(destination.read_text())['integrity'] == 'PASS'

                    close.click()
                    expect(page.locator('#archive-integrity-dialog')).not_to_be_visible()
                    page.locator('#document-name').click()
                    assert_open_at_top(page)
                    page.keyboard.press('Escape')
                    expect(page.locator('#archive-integrity-dialog')).not_to_be_visible()
                    expect(page.locator('#document-name')).to_be_focused()
                    page.keyboard.press('Enter')
                    assert_open_at_top(page)
                    close.click()
                    results.append({'mode': mode, 'viewport': viewport, 'opensAtTop': True,
                                    'closeStaysVisible': True, 'saveStaysVisible': True,
                                    'reportDownload': True, 'reopenResetsScroll': True,
                                    'keyboardCloseAndReopen': True, 'passed': True})
                assert not requests and not errors, {'requests': requests, 'errors': errors}
            finally:
                context.close()
    (report/'summary.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
