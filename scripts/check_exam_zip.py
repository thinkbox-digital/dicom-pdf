#!/usr/bin/env python3
"""Offline exam-only ZIP recovery from synthetic inputs and a multi-exam PDF."""
import hashlib
import json
import struct
import tempfile
import zipfile
from pathlib import Path
from pypdf import PdfReader
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def missing_exam(source, destination):
    data = bytearray(source.read_bytes())
    at = 132
    while at < len(data):
        tag = struct.unpack_from('<HH', data, at)
        vr = data[at+4:at+6].decode('ascii')
        long = vr in {'OB','OD','OF','OL','OV','OW','SQ','UC','UN','UR','UT','SV','UV'}
        header = 12 if long else 8
        size = struct.unpack_from('<I' if long else '<H', data, at+8 if long else at+6)[0]
        assert size != 0xffffffff and at+header+size <= len(data)
        if tag == (0x20, 0x0d):
            data[at+header:at+header+size] = b'\0'*size
            destination.write_bytes(data)
            return
        at += header+size
    raise AssertionError('Synthetic base fixture has no study UID')


def export_exam(page, report, label, expected, manifest=None):
    page.locator('#export-originals').click()
    assert not page.locator('#originals-export-scope option[value="study"]').evaluate('option=>option.disabled')
    page.locator('#originals-export-scope').select_option('study')
    expect(page.locator('#originals-export-status')).to_contain_text(f'{len(expected)} unchanged original files')
    with page.expect_download() as event:
        page.locator('#originals-export-confirm').click()
    assert event.value.suggested_filename == 'dicom-originals-exam.zip'
    archive = report / f'{label}.zip'
    event.value.save_as(archive)
    with zipfile.ZipFile(archive) as z:
        scope = json.loads(z.read('scope.json'))
        assert scope['scope'] == 'study' and not scope['completeOriginalInventory']
        assert scope['clinicalCompleteness'] == 'not-assessed'
        assert scope['originalManifest'] is None and scope['packageFiles'] == []
        assert not any(name.startswith('package/') for name in z.namelist())
        assert len(scope['originals']) == len(expected)
        for entry in scope['originals']:
            actual = z.read(entry['zipPath'])
            assert actual == expected[entry['sourcePath']]
            assert hashlib.sha256(actual).hexdigest() == entry['sha256']
        if manifest is not None:
            assert scope['sourceManifestSha256'] == hashlib.sha256(manifest).hexdigest()
    page.locator('#originals-export-cancel').click()
    return {'case': label, 'originalsByteExact': len(expected), 'unrelatedPackageMetadataOmitted': True}


def main():
    report = Path('target/exam-zip-checks')
    report.mkdir(parents=True, exist_ok=True)
    sources = sorted(Path('target/report-inputs').glob('*.dcm'))
    assert len(sources) == 3
    unrelated = Path('target/overlay-inputs/01-axial.dcm')
    unknown = report / 'missing-exam-id.dcm'
    missing_exam(Path('fixtures/expanded/sc-native-gray8.dcm'), unknown)
    result = {'httpRequests': 0, 'pageErrors': 0, 'cases': []}
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
            page.locator('#dicom-files').set_input_files([path.resolve() for path in [*sources, unrelated, unknown]])
            option = page.locator('#image-list option').filter(has_text='01-image.dcm')
            expect(option).to_have_count(1, timeout=30000)
            page.locator('#image-list').select_option(option.get_attribute('value'))
            expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
            result['cases'].append(export_exam(page, report, 'synthetic-mixed-exams', {s.name: s.read_bytes() for s in sources}))
            option = page.locator('#image-list option').filter(has_text=unknown.name)
            page.locator('#image-list').select_option(option.get_attribute('value'))
            expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
            page.locator('#export-originals').click()
            assert page.locator('#originals-export-scope option[value="study"]').evaluate('option=>option.disabled')
            assert not page.locator('#originals-export-scope option[value="selected"]').evaluate('option=>option.disabled')
            page.locator('#originals-export-cancel').click()
            pdf = Path('out/supplied-ct-samples.pdf')
            attachments = PdfReader(pdf).attachments
            manifest_bytes = attachments['manifest.json'][0]
            entries = json.loads(manifest_bytes)['images']
            index = next(i for i, e in enumerate(entries) if e['status'] == 'rendered' and e['fields'].get('StudyInstanceUID'))
            study = entries[index]['fields']['StudyInstanceUID']
            expected = {e['sourcePath']: attachments[e['attachment']][0] for e in entries if e['fields'].get('StudyInstanceUID') == study}
            assert len(expected) < len(entries), 'Fixture must contain multiple supplied exams'
            page.locator('#pdf-file').set_input_files(pdf.resolve())
            expect(page.locator('#export-originals')).to_be_enabled(timeout=30000)
            page.locator('#image-list').select_option(str(index))
            expect(page.locator('#download-original')).to_be_enabled(timeout=30000)
            result['cases'].append(export_exam(page, report, 'multi-exam-pdf', expected, manifest_bytes))
            result.update({'browserVersion': context.browser.version, 'unknownExamNotGrouped': True})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
