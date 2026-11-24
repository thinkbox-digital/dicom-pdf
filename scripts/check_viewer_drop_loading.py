#!/usr/bin/env python3
"""Verify viewer-local PDF drops and loading success/error cleanup offline."""
import argparse
import json
from pathlib import Path
import re
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright
from pypdf import PdfWriter
from check_extension import launch, extension_identity


READ_GATE='''() => {
  const original=Blob.prototype.arrayBuffer;
  window.blockPdfReads=false;window.pendingPdfReads=[];
  Blob.prototype.arrayBuffer=async function(){
    if(window.blockPdfReads)await new Promise(resolve=>pendingPdfReads.push(resolve));
    return original.call(this);
  };
  window.releasePdfReads=()=>{window.blockPdfReads=false;for(const resolve of pendingPdfReads.splice(0))resolve();};
}'''


def drop_file(context,page,path):
    session=context.new_cdp_session(page)
    try:
        data={'items':[],'files':[str(path.resolve())],'dragOperationsMask':1}
        for event in ['dragEnter','dragOver','drop']:
            session.send('Input.dispatchDragEvent',{'type':event,'x':400,'y':350,'data':data})
    finally:session.detach()


def check_viewer(context,location,pdf,bad_pdf,ordinary_pdf,zip_input,report):
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    try:
        page.add_init_script('('+READ_GATE+')()')
        page.goto(location)
        expect(page.get_by_role('button', name='Open PDF…', exact=True)).to_be_visible()
        expect(page.locator('#open-menu, #dicom-files, #dicom-folder')).to_have_count(0)
        page.evaluate('window.blockPdfReads=true')
        drop_file(context,page,pdf)
        expect(page.locator('#loading-dialog')).to_be_visible()
        expect(page.locator('#loading-title')).to_have_text('Loading…')
        page.wait_for_function('()=>pendingPdfReads.length>0')
        page.keyboard.press('Escape');expect(page.locator('#loading-dialog')).to_be_visible()
        page.screenshot(path=str(report/'loading.png'))
        page.evaluate('releasePdfReads()')
        expect(page.locator('#loading-dialog')).not_to_be_visible(timeout=60000)
        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',re.compile('.+'),timeout=30000)
        expect(page.locator('#document-name')).to_have_text(pdf.name)
        assert page.url==location,'Dropping a PDF navigated away from the viewer'
        if page.locator('#archive-integrity-dialog').is_visible():page.locator('#close-archive-check').click()
        dicom=Path('fixtures/expanded/sc-native-gray8.dcm')
        for unsupported in (dicom,zip_input):
            page.locator('#status').evaluate("element => element.textContent = ''")
            drop_file(context,page,unsupported)
            expect(page.locator('#status')).to_have_text('Choose one converted DICOM PDF.')
            expect(page.locator('#document-name')).to_have_text(pdf.name)
            expect(page.locator('#loading-dialog')).not_to_be_visible()
            assert page.url==location
        drop_file(context,page,ordinary_pdf)
        expect(page.locator('#status')).to_have_text('This PDF does not contain a supported DICOM archive.')
        expect(page.locator('#document-name')).to_have_text('No PDF open')
        expect(page.locator('#show-pdf')).to_be_disabled()
        expect(page.locator('#pdf-view')).not_to_be_visible()
        page.locator('#pdf-file').set_input_files(bad_pdf.resolve())
        expect(page.locator('#status')).to_contain_text('Unable to open this PDF',timeout=30000)
        expect(page.locator('#loading-dialog')).not_to_be_visible()
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='Open PDF…', exact=True).click()
        chooser.value.set_files(pdf.resolve())
        expect(page.locator('#viewport')).to_have_attribute('data-input-kind','pdf-package',timeout=30000)
        expect(page.locator('#loading-dialog')).not_to_be_visible(timeout=30000)
        expect(page.locator('#download-original')).to_be_enabled()
        assert not errors,errors
        return {'passed':True,'trustedPdfDrop':True,'loadingDuringRead':True,'closesAfterFirstImage':True,
                'closesAfterError':True,'pickerRecovers':True,'rejectsLooseDicomZipAndOrdinaryPdf':True,
                'pageErrors':len(errors)}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('target/viewer-test-pdfs/synthetic-overlays.pdf'))
    args=parser.parse_args()
    report=Path('target/drop-loading-checks');report.mkdir(parents=True,exist_ok=True)
    bad_pdf=report/'invalid.pdf';bad_pdf.write_bytes(b'%PDF-1.7\nnot a PDF document\n')
    ordinary_pdf=report/'ordinary.pdf'
    writer=PdfWriter();writer.add_blank_page(width=200,height=200)
    writer.add_attachment('manifest.json',b'{"project":"ordinary PDF appendix"}')
    with ordinary_pdf.open('wb') as stream:writer.write(stream)
    zip_input=report/'direct-source.zip'
    with zipfile.ZipFile(zip_input,'w') as files:
        files.write('fixtures/expanded/sc-native-gray8.dcm','image.dcm')
    outside_html=report/'outside.html';outside_html.write_text('<!doctype html><title>Ordinary browser page</title><p>Outside the viewer</p>')
    manifest=json.loads(Path('target/chrome-extension/manifest.json').read_text())
    assert 'mime_types_handler' not in manifest and 'content_scripts' not in manifest
    result={'version':manifest['version']}
    with sync_playwright() as p,tempfile.TemporaryDirectory(dir=report,prefix='profile-') as profile:
        context=launch(p,'/snap/chromium/current/usr/lib/chromium-browser/chrome',Path('target/chrome-extension').resolve(),profile)
        context.set_offline(True)
        try:
            identity=extension_identity(context);viewer=f'chrome-extension://{identity}/viewer.html'
            destination=report/'extension';destination.mkdir(exist_ok=True)
            result['extension']=check_viewer(context,viewer,args.pdf,bad_pdf,ordinary_pdf,zip_input,destination)
            print('Extension viewer drop and loading checks passed',flush=True)
            worker=context.service_workers[0]
            # Create an ordinary browser window without involving the viewer.
            with context.expect_page() as opened:
                worker.evaluate('url=>chrome.windows.create({url,width:1000,height:800})',outside_html.resolve().as_uri())
            outside=opened.value;outside.wait_for_load_state('domcontentloaded')
            outside.evaluate('''()=>{window.receivedDrag=null;window.addEventListener('dragover',event=>{
              window.receivedDrag={trusted:event.isTrusted,files:event.dataTransfer.types.includes('Files')};
              queueMicrotask(()=>receivedDrag.prevented=event.defaultPrevented);
            });}''')
            drop_file(context,outside,args.pdf)
            outside.wait_for_function('()=>receivedDrag!==null')
            observed=outside.evaluate('receivedDrag')
            assert observed=={'trusted':True,'files':True,'prevented':False},observed
            assert all(not frame.url.startswith(f'chrome-extension://{identity}/') for tab in context.pages for frame in tab.frames)
            # A normal PDF navigation must use Chrome's handler as well.
            outside.goto(args.pdf.resolve().as_uri(),wait_until='domcontentloaded')
            outside.wait_for_timeout(300)
            assert all(not frame.url.startswith(f'chrome-extension://{identity}/') for frame in outside.frames)
            assert outside.locator('#image-list').count()==0
            result['outsideWindow']={'passed':True,'dropNotIntercepted':True,'noViewerOpened':True,'nativePdfNavigation':True}
            result['browserVersion']=context.browser.version
        finally:context.close()
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
