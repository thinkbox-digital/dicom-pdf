#!/usr/bin/env python3
"""Check slice-ordered navigation, the PDF picker, save dialogs and metadata offline."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright
from check_extension import launch, extension_identity
from check_scroll_performance import physical_order


def close_report(page):
    if page.locator('#archive-integrity-dialog').is_visible():
        page.locator('#close-archive-check').click()


def check_page(context, location, pdf, manifest, reader, report):
    page=context.new_page();errors=[];requests=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('request',lambda request:requests.append(request.url) if request.url.startswith(('http:','https:')) else None)
    try:
        page.goto(location)
        expect(page.locator('#show-metadata')).to_be_disabled()
        expect(page.locator('#controls #save-view, #preview-save-copy')).to_have_count(0)
        expect(page.locator('#save-menu .save-options button')).to_have_count(3)
        for control in page.locator('#save-menu .save-options button').all():expect(control).to_be_disabled()
        expect(page.locator('#open-menu, #dicom-files, #dicom-folder')).to_have_count(0)
        page.locator('#save-menu > summary').click()
        page.locator('.brand').click()
        assert not page.locator('#save-menu').evaluate('element=>element.open')
        page.locator('#save-menu > summary').click()
        page.keyboard.press('Escape');expect(page.locator('#save-menu > summary')).to_be_focused()
        with page.expect_file_chooser() as event:
            page.locator('#open-pdf').click()
        event.value.set_files(pdf.resolve())
        expect(page.locator('#download-original')).to_be_enabled(timeout=60000)
        expect(page.locator('#document-name:is([data-integrity="PASS"], [data-integrity="UNKNOWN"])')).to_be_visible(timeout=60000)
        close_report(page)
        indices=page.locator('#image-list option').evaluate_all('options=>options.map(option=>Number(option.value))')
        ordered=physical_order(manifest['images'],indices)
        assert indices==ordered,'Sidebar differs from DICOM slice order'
        assert len(indices)==len(set(indices))
        labels=page.locator('#image-list option').all_text_contents()
        assert all(label.startswith(f'{position}. ') for position,label in enumerate(labels,1))
        expect(page.locator('#image-list')).to_have_value(str(indices[0]))
        expect(page.locator('#stack-position')).to_have_value('1')
        position=min(105,len(indices)-3)
        def selected(at):
            entry=manifest['images'][indices[at]]
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'],timeout=30000)
            expect(page.locator('#image-list')).to_have_value(str(indices[at]))
            expect(page.locator('#stack-position')).to_have_value(str(at+1))
            assert page.locator('#image-list').evaluate('element=>element.selectedIndex')==at
            return entry
        page.locator('#image-list').select_option(str(indices[position]));selected(position)
        box=page.locator('#viewport').bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
        page.mouse.wheel(0,120);selected(position+1)
        page.wait_for_timeout(40);page.mouse.wheel(0,-120);selected(position)
        page.locator('#next-image').click();selected(position+1)
        page.locator('#previous-image').click();entry=selected(position)
        page.locator('#show-pdf').click()
        expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
        page.locator('#save-menu > summary').click();expect(page.locator('#save-view')).to_be_disabled()
        page.keyboard.press('Escape')
        page.locator('#show-image').click();selected(position)
        page.locator('#save-menu > summary').click()
        expect(page.locator('#save-view')).to_be_enabled()
        with page.expect_download() as event:page.locator('#save-view').click()
        copy=report/'dicom-view-copy.png';event.value.save_as(copy)
        assert copy.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
        assert not page.locator('#save-menu').evaluate('element=>element.open')
        page.locator('#save-menu > summary').click()
        with page.expect_download() as event:page.locator('#download-original').click()
        original=report/'original.dcm';event.value.save_as(original)
        assert hashlib.sha256(original.read_bytes()).hexdigest()==entry['sha256']
        assert original.read_bytes()==reader.attachments[entry['attachment']][0]
        expect(page.locator('#export-originals')).to_have_text('Originals ZIP…')
        expect(page.locator('#export-originals svg')).to_have_count(0)
        page.locator('#save-menu > summary').click();page.locator('#export-originals').click()
        assert not page.locator('#save-menu').evaluate('element=>element.open')
        expect(page.locator('#originals-export-dialog')).to_be_visible()
        page.locator('#originals-export-scope').select_option('selected')
        with page.expect_download() as event:page.locator('#originals-export-confirm').click()
        saved=report/'selected-original.zip';event.value.save_as(saved)
        with zipfile.ZipFile(saved) as files:
            assert any(hashlib.sha256(files.read(name)).hexdigest()==entry['sha256'] for name in files.namelist())
        page.locator('#originals-export-cancel').click()
        expect(page.locator('#save-menu > summary')).to_be_focused()
        if not page.locator('#other-files-section').evaluate('element=>element.open'):
            page.locator('#other-files-section > summary').click()
        gap=page.evaluate('''()=>document.querySelector('#inventory-section').getBoundingClientRect().top-document.querySelector('#other-files-section').getBoundingClientRect().bottom''')
        assert abs(gap)<3,'Supporting files push inventory to the bottom'
        page.locator('#inventory-section > summary').click()
        text=page.locator('#inventory-summary').inner_text()
        assert '\n\n' in text and len(text.splitlines())>=10
        page.screenshot(path=str(report/'inventory.png'))
        page.locator('#show-metadata').click()
        expect(page.locator('#metadata-section')).to_be_visible()
        expect(page.locator('#metadata-fields')).to_contain_text(entry['sourcePath'])
        expect(page.locator('#close-metadata')).to_be_focused()
        header=page.locator('#selected-metadata-title').bounding_box()
        page.locator('.selected-metadata-content').evaluate('element=>element.scrollTop=element.scrollHeight')
        assert abs(page.locator('#selected-metadata-title').bounding_box()['y']-header['y'])<1
        expect(page.locator('#close-metadata')).to_be_in_viewport()
        page.screenshot(path=str(report/'metadata.png'))
        page.keyboard.press('Escape');expect(page.locator('#metadata-section')).not_to_be_visible()
        expect(page.locator('#show-metadata')).to_be_focused()
        page.locator('#show-metadata').click();page.locator('#close-metadata').click()
        for width in [390,850,1440]:
            page.set_viewport_size({'width':width,'height':900})
            if not page.locator('#details-panel').is_visible():page.locator('#show-details').click()
            page.locator('#show-metadata').click()
            expect(page.locator('#close-metadata')).to_be_in_viewport()
            assert page.locator('#metadata-section').bounding_box()['width']<=width
            page.locator('#close-metadata').click()
            expect(page.locator('#open-pdf')).to_be_in_viewport()
            page.locator('#save-menu > summary').click()
            for control in page.locator('.save-options button').all():expect(control).to_be_in_viewport()
            page.keyboard.press('Escape')
        assert not errors,errors
        assert not requests,requests
        return {'passed':True,'sidebarSlices':len(indices),'oneSlicePerWheel':True,'pdfReferenceTracking':True,
                'originalByteExact':True,'selectedZipVerified':True,'saveMenuPng':True,'saveMenuKeyboard':True,'inventoryLineBreaks':True,'metadataDialog':True,
                'responsiveWidths':[390,850,1440],'openPdfPicker':True,'pageErrors':len(errors),'httpRequests':len(requests)}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('out/ct-pancreas-pancreas-ct-series.pdf'))
    args=parser.parse_args()
    report=Path('target/viewer-navigation-checks');report.mkdir(parents=True,exist_ok=True)
    reader=PdfReader(args.pdf);manifest=json.loads(reader.attachments['manifest.json'][0])
    result={'version':json.loads(Path('viewer/package.json').read_text())['version']}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        context.set_offline(True)
        try:
            locations={'extension':f'chrome-extension://{extension_identity(context)}/viewer.html',
                       'standalone':Path('src/main/resources/viewer.html').resolve().as_uri()}
            for name,location in locations.items():
                destination=report/name;destination.mkdir(exist_ok=True)
                result[name]=check_page(context,location,args.pdf,manifest,reader,destination)
                print(f'{name}: passed',flush=True)
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
