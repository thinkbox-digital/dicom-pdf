#!/usr/bin/env python3
"""Offline ZIP recovery hierarchy refusal and subset-recovery regression."""
import json
import tempfile
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report = Path('target/zip-hierarchy-checks')
    report.mkdir(parents=True, exist_ok=True)
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
            downloads = []
            page.on('download', lambda download: downloads.append(download))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.locator('#pdf-file').set_input_files(Path('target/viewer-test-pdfs/synthetic-recovery-paths.pdf').resolve())
            expect(page.locator('#download-original')).to_be_enabled(timeout=30000)
            page.locator('#export-originals').click()
            page.locator('#originals-export-confirm').click()
            expect(page.locator('#originals-export-status')).to_contain_text('both a file and a directory')
            assert len(downloads) == 0, 'Conflicting ZIP was downloaded'
            expect(page.locator('#originals-export-confirm')).to_be_enabled()
            page.locator('#originals-export-scope').select_option('selected')
            with page.expect_download() as event:
                page.locator('#originals-export-confirm').click()
            archive = report / 'selected.zip'
            event.value.save_as(archive)
            with zipfile.ZipFile(archive) as recovered:
                scope = json.loads(recovered.read('scope.json'))
                assert scope['scope'] == 'selected' and not scope['completeOriginalInventory']
                assert len(scope['originals']) == 1
                original = scope['originals'][0]
                expected = (Path('target/zip-hierarchy-input') / original['sourcePath']).read_bytes()
                assert recovered.read(original['zipPath']) == expected
                assert len([n for n in recovered.namelist() if n.startswith('originals/')]) == 1
            page.locator('#originals-export-cancel').click()
            with page.expect_download() as event:
                page.locator('#download-original').click()
            single = report / 'original.dcm'
            event.value.save_as(single)
            assert single.read_bytes() == expected
            result.update({'browserVersion': context.browser.version, 'conflictingZipRefused': True,
                           'selectedZipByteExact': True, 'singleOriginalByteExact': True,
                           'subsetInventoryAccurate': True})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
