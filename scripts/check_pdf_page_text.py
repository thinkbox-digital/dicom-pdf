#!/usr/bin/env python3
"""Offline selectable-text checks for synthetic encapsulated and supplied PDFs."""
import json
import tempfile
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def synthetic_pdf(destination):
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')}))
    for text in ['SYNTHETIC REPORT PAGE ONE', '<script>literal report text</script>', None]:
        page = writer.add_blank_page(width=320, height=220)
        if text:
            page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
            content = DecodedStreamObject()
            content.set_data(f'BT /F1 12 Tf 15 150 Td ({text}) Tj ET'.encode('ascii'))
            page[NameObject('/Contents')] = writer._add_object(content)
    with destination.open('wb') as output:
        writer.write(output)


def main():
    report = Path('target/pdf-page-text-checks')
    report.mkdir(parents=True, exist_ok=True)
    pdf = report / 'synthetic-report.pdf'
    synthetic_pdf(pdf)
    dicom = Path('target/report-inputs/02-encapsulated-pdf.dcm')
    image = Path('fixtures/expanded/sc-native-gray8.dcm')
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
            page.locator('#dicom-files').set_input_files(dicom.resolve())
            toggle = page.get_by_role('button', name='Page text', exact=True)
            text = page.locator('.attachment-preview-page-text')
            expect(toggle).to_be_enabled(timeout=30000)
            toggle.click()
            expect(text).to_contain_text('SYNTHETIC REPORT')
            expect(text).to_contain_text('Software test fixture. No clinical findings.')
            text.focus();expect(text).to_be_focused()
            with page.expect_download() as event:
                page.locator('#download-original').click()
            original = report / 'encapsulated-original.dcm'
            event.value.save_as(original)
            assert original.read_bytes() == dicom.read_bytes()
            page.locator('#dicom-files').set_input_files([image.resolve(), pdf.resolve()])
            option = page.locator('#image-list option').filter(has_text=pdf.name)
            expect(option).to_have_count(1, timeout=30000)
            page.locator('#image-list').select_option(option.get_attribute('value'))
            expect(toggle).to_be_enabled(timeout=30000)
            expect(page.locator('.attachment-preview-pdf-canvas')).to_be_visible()
            scripts_before = page.locator('script').count()
            toggle.click();expect(text).to_have_text('SYNTHETIC REPORT PAGE ONE')
            expect(toggle).to_be_focused()
            previous = page.get_by_role('button', name='Previous page', exact=True)
            next_page = page.get_by_role('button', name='Next page', exact=True)
            expect(previous).to_be_disabled()
            next_page.click();expect(text).to_have_text('<script>literal report text</script>')
            expect(next_page).to_be_focused()
            assert page.locator('script').count() == scripts_before
            next_page.click();expect(text).to_have_text('No selectable text on this page. Use the page image.')
            expect(next_page).to_be_disabled()
            expect(toggle).to_be_focused()
            previous.click();expect(text).to_have_text('<script>literal report text</script>')
            toggle.click();expect(page.locator('.attachment-preview-pdf-canvas')).to_be_visible()
            expect(page.locator('.attachment-preview-pdf-controls')).to_contain_text('Page 2 of 3')
            expect(text).to_be_hidden()
            with page.expect_download() as event:
                page.locator('#download-original').click()
            recovered = report / 'recovered-report.pdf'
            event.value.save_as(recovered)
            assert recovered.read_bytes() == pdf.read_bytes()
            result.update({'browserVersion': context.browser.version, 'encapsulatedTextReadable': True,
                           'threePageNavigation': True, 'emptyPageExplicit': True,
                           'markupInert': True, 'textKeyboardFocusable': True,
                           'imageModeRetainsPage': True, 'originalsByteExact': 2})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
