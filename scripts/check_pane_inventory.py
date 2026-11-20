#!/usr/bin/env python3
"""Check study-data/support pane separation and unchanged recovery offline.

All reports, CSVs and recovered files stay under target/pane-inventory-checks.
Supplied paths, patient values and instance identifiers are never printed.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import tempfile
import time
import traceback
import zipfile

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_extension import launch, extension_identity
from check_direct_inputs import PROBE, wait_model
from check_scroll_performance import physical_order
from convert_archives import fingerprint
from sample_inventory import work_path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def spreadsheet(value):
    text='' if value is None else str(value)
    return "'"+text if re.match(r'^\s*[=+@-]|^[\t\r\n]',text) else text


def data_kind(entry, data):
    """Independent expectation from standard SOPs/pixel attributes and magic bytes."""
    fields=entry.get('fields',{});sop=fields.get('SOPClassUID','')
    if sop=='1.2.840.10008.1.3.10' or sop.startswith(('1.2.840.10008.5.1.4.1.1.66.','1.2.840.10008.5.1.4.1.1.481.')):
        return None
    if sop=='1.2.840.10008.5.1.4.1.1.104.1' or sop.startswith('1.2.840.10008.5.1.4.1.1.88.'):
        return 'dicom-report'
    try:
        if sop and int(fields.get('Rows',0))>0 and int(fields.get('Columns',0))>0:
            return 'dicom-image'
    except (ValueError,TypeError):
        pass
    if data.startswith((b'\xff\xd8\xff',b'\x89PNG\r\n\x1a\n',b'GIF87a',b'GIF89a',b'BM')) or data.startswith(b'RIFF') and data[8:12]==b'WEBP':
        return 'image'
    if data.startswith(b'%PDF-'):
        return 'pdf'
    return None


def open_section(page, identifier):
    section=page.locator('#'+identifier)
    if section.count() and section.is_visible() and not section.evaluate('element=>element.open'):
        section.locator('summary').first.click()
    return section


def selected_context(page):
    return page.locator('#metadata-fields').evaluate("element=>Object.fromEntries([...element.querySelectorAll('dt')].map(term=>[term.textContent,term.nextElementSibling.textContent]))")


def original_context(page,entry):
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        actual=selected_context(page)
        if actual.get('Attachment')==entry['attachment'] and actual.get('SHA-256')==entry['sha256']:
            break
        page.wait_for_timeout(50)
    else:
        raise AssertionError('Selected-original context does not map to the global option value')
    assert actual.get('Source file')==entry['sourcePath'],'Selected-original source path differs'
    if entry.get('sopInstanceUID'):
        assert actual.get('SOPInstanceUID')==entry['sopInstanceUID'],'Selected-original instance ID differs'
    else:
        assert actual.get('SOPInstanceUID') in (None,'','Not supplied'),'A source without an instance ID acquired one'
    page_value='Not supplied' if entry.get('referencePage') is None else str(entry['referencePage'])
    assert actual.get('PDF reference page')==page_value,'Selected-original PDF page mapping differs'


def source_selected(page,entries,index,kind,pdf_package):
    entry=entries[index]
    page.locator('#image-list').select_option(str(index))
    expect(page.locator('#image-list')).to_have_value(str(index))
    if kind=='dicom-image':
        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'],timeout=30000)
        expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(entry.get('sourceFrame') or 1))
    else:
        expect(page.locator('#attachment-view')).to_be_visible(timeout=30000)
        if kind=='image':
            expect(page.locator('#attachment-content img')).to_be_visible()
            assert page.locator('#attachment-content img').evaluate('image=>image.complete&&image.naturalWidth>0')
        elif kind=='pdf' or entry.get('fields',{}).get('SOPClassUID')=='1.2.840.10008.5.1.4.1.1.104.1':
            expect(page.locator('#attachment-content canvas')).to_be_visible(timeout=30000)
        else:
            expect(page.locator('#attachment-content pre')).to_be_visible(timeout=30000)
    original_context(page,entry)
    if pdf_package and entry.get('referencePage'):
        page.locator('#show-pdf').click()
        expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
        expect(page.locator('#image-list')).to_have_value(str(index))
        page.locator('#show-image').click()
        page.locator('#image-list').select_option(str(index))
        if kind=='dicom-image':
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'])
        else:
            expect(page.locator('#attachment-view')).to_be_visible(timeout=30000)


def download_selected(page,entry,content,destination):
    open_section(page,'save-menu')
    expect(page.locator('#download-original')).to_be_enabled()
    with page.expect_download() as event:
        page.locator('#download-original').click()
    event.value.save_as(destination)
    assert destination.read_bytes()==content and fingerprint(destination)==entry['sha256'],'Selected data download changed or selected the wrong original'


def pane_membership(page,entries,kinds,generated):
    data_indices=[index for index,kind in enumerate(kinds) if kind]
    other_indices=[index for index,kind in enumerate(kinds) if not kind]
    expect(page.locator('#image-list option')).to_have_count(len(data_indices))
    actual=page.locator('#image-list option').evaluate_all('options=>options.map(option=>option.value)')
    assert actual==[str(index) for index in data_indices],'Left options must keep original global indices after filtering'
    assert not page.locator('#navigation-panel .other-supplied-files').count(),'Left pane still contains the Other supplied files button'
    expect(page.locator('#image-count')).to_have_text(str(len(data_indices)))
    open_section(page,'files-section')
    expect(page.locator('#files-section')).not_to_be_visible()
    rows=page.locator('#details-panel [data-attachment]').evaluate_all('rows=>rows.map(row=>row.dataset.attachment)')
    expected=set(generated)|{entries[index]['attachment'] for index in other_indices}
    assert len(rows)==len(set(rows)) and set(rows)==expected,'Right pane omitted/duplicated files or repeats left-hand data'
    assert not set(rows)&{entries[index]['attachment'] for index in data_indices},'A study-data original is duplicated in the right pane'
    for name in generated:
        assert rows.count(name)==1,'Generated package metadata is absent from the right pane'
    other=page.locator('#other-files-section')
    if other_indices:
        expect(other).to_be_visible()
        expect(page.locator('#other-file-count')).to_have_text(str(len(other_indices)))
        open_section(page,'other-files-section')
        other_rows=page.locator('#other-supplied-files [data-attachment]').evaluate_all('rows=>rows.map(row=>row.dataset.attachment)')
        assert set(other_rows)=={entries[index]['attachment'] for index in other_indices},'Other disclosure membership differs from supplied support files'
        other.locator('summary').first.click();assert not other.evaluate('element=>element.open')
        other.locator('summary').first.click();assert other.evaluate('element=>element.open')
    return data_indices,other_indices


def support_actions(page,entries,contents,others,report):
    checked=0;viewed=0
    for index in others:
        entry=entries[index]
        # Attribute values are passed as DOM data, never interpolated into CSS.
        button=page.locator('#other-supplied-files button[data-download-attachment]')
        ordinal=button.evaluate_all('(buttons,name)=>buttons.findIndex(button=>button.dataset.downloadAttachment===name)',entry['attachment'])
        assert ordinal>=0,'Other original has no individual download'
        with page.expect_download() as event:
            button.nth(ordinal).click()
        destination=report/f'other-{index:03}.original';event.value.save_as(destination)
        assert destination.read_bytes()==contents[entry['attachment']],'Other original download changed its bytes'
        checked+=1
        view=page.locator('#other-supplied-files button[data-view-attachment]')
        view_index=view.evaluate_all('(buttons,name)=>buttons.findIndex(button=>button.dataset.viewAttachment===name)',entry['attachment'])
        if view_index>=0:
            selected=page.locator('#image-list').input_value();view.nth(view_index).click()
            expect(page.locator('#attachment-view')).to_be_visible(timeout=30000)
            assert page.locator('#image-list').input_value()==selected,'Supporting-file preview corrupted the data selection'
            viewed+=1
    expect(page.locator('#files-section')).not_to_be_visible()
    return {'individualSupportDownloads':checked,'supportPreviews':viewed,'technicalFilesHidden':True}


def all_metadata(page,entries,report):
    page.locator('#export-csv').click();expect(page.locator('#metadata-export-dialog')).to_be_visible()
    page.locator('#export-image-scope').select_option('all')
    page.locator('#export-field-scope').select_option('all')
    expect(page.locator('#export-csv-confirm')).to_be_enabled(timeout=60000)
    with page.expect_download() as event:
        page.locator('#export-csv-confirm').click()
    destination=report/'all-source-metadata.csv';event.value.save_as(destination)
    with destination.open(encoding='utf-8-sig',newline='') as stream:
        rows=list(csv.DictReader(stream))
    expected={entry['attachment']:entry for entry in entries}
    assert len(rows)==len(entries),'All-source metadata dropped excluded-left originals'
    assert {row['Attachment'] for row in rows}==set(expected),'All-source metadata inventory differs from supplied originals'
    for row in rows:
        entry=expected[row['Attachment']]
        assert row['SHA-256']==entry['sha256'] and row['Source file']==spreadsheet(entry['sourcePath']),'All-source metadata maps to a different original'
        assert row['SOP Instance UID']==spreadsheet(entry.get('sopInstanceUID')),'All-source metadata changed a supplied instance identifier'
    return len(rows)


def all_originals(page,entries,contents,report):
    open_section(page,'save-menu')
    page.locator('#export-originals').click();page.locator('#originals-export-scope').select_option('all')
    with page.expect_download(timeout=60000) as event:
        page.locator('#originals-export-confirm').click()
    destination=report/'all-originals.zip';event.value.save_as(destination)
    expected={entry['attachment']:entry for entry in entries}
    with zipfile.ZipFile(destination) as archive:
        scope=json.loads(archive.read('scope.json'))
        assert len(scope['originals'])==len(entries),'Original ZIP dropped files excluded from the left pane'
        assert {row['attachment'] for row in scope['originals']}==set(expected),'ZIP recovery inventory differs from supplied originals'
        for row in scope['originals']:
            entry=expected[row['attachment']];data=archive.read(row['zipPath'])
            assert data==contents[entry['attachment']] and sha(data)==entry['sha256'],'Recovered ZIP original bytes differ'
    page.locator('#originals-export-cancel').click()
    return len(entries)


def wheel_mapping(page,entries,kinds,data_indices):
    images=[index for index in data_indices if kinds[index]=='dicom-image']
    if len(images)<2:
        return {'checked':False}
    order=physical_order(entries,images);start=order[len(order)//2]
    source_selected(page,entries,start,kinds[start],False)
    box=page.locator('#viewport').bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
    target=order[min(len(order)-1,order.index(start)+1)]
    if target==start:
        target=order[order.index(start)-1];direction=-1
    else:
        direction=1
    page.mouse.wheel(0,120*direction)
    expect(page.locator('#image-list')).to_have_value(str(target))
    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entries[target]['attachment'])
    page.wait_for_timeout(100);page.mouse.wheel(0,-120*direction)
    expect(page.locator('#image-list')).to_have_value(str(start))
    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entries[start]['attachment'])
    return {'checked':True,'startingGlobalIndex':start,'adjacentGlobalIndex':target,'reverseReturnsToOriginal':True}


def run_case(page,label,entries,contents,generated,report,pdf_package):
    kinds=[data_kind(entry,contents[entry['attachment']]) for entry in entries]
    data_indices,others=pane_membership(page,entries,kinds,generated)
    if label=='ct':
        assert data_indices==list(range(1,102)) and others==[0],'CT README/global-index classification differs'
    checked=[]
    samples=list(dict.fromkeys([*data_indices[:2],*data_indices[-2:]]))
    for index in samples:
        source_selected(page,entries,index,kinds[index],pdf_package)
        download_selected(page,entries[index],contents[entries[index]['attachment']],report/f'data-{index:03}.original')
        checked.append(index)
    mapping=wheel_mapping(page,entries,kinds,data_indices)
    support=support_actions(page,entries,contents,others,report)
    metadata_count=all_metadata(page,entries,report)
    recovered=all_originals(page,entries,contents,report)
    return {'case':label,'status':'PASS','suppliedOriginals':len(entries),'leftData':len(data_indices),'rightOriginals':len(others),
            'rightGenerated':len(generated),'leftGlobalValues':data_indices,'checkedGlobalMappings':checked,'wheelMapping':mapping,
            'allSourceMetadataRows':metadata_count,'byteIdenticalRecoveredOriginals':recovered,**support}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/pane-inventory-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    inventory=json.loads((project/'target/additional-samples/inventory.json').read_text())
    zip_source=next(row for row in inventory['sourceFiles'] if row['sourceID']=='input-002')
    input_zip=Path(inventory['input'])/zip_source['sourcePath'];zip_before=fingerprint(input_zip)
    cases=[('ct',project/'out/ct-abdomen-c4kc-kits-series.pdf'),('metadata',project/'target/viewer-test-pdfs/metadata-sample.pdf'),
           ('reports',project/'target/viewer-test-pdfs/synthetic-reports.pdf'),('reports-only',project/'target/viewer-test-pdfs/synthetic-reports-only.pdf'),
           ('direct-zip',input_zip),('direct-directory',project/'fixtures/spec-directory'),
           ('direct-plain-pdf',project/'target/report-fixtures/expected-report.pdf')]
    extension=args.extension.resolve(strict=True);asset=fingerprint(extension/'viewer.js')
    result={'httpRequests':0,'pageErrors':0,'extensionViewerSha256':asset,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            result['browserVersion']=context.browser.version;extension_id=extension_identity(context)
            context.set_offline(True);context.add_init_script(PROBE)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            for label,path in cases:
                destination=report/label;destination.mkdir(exist_ok=True);page=context.new_page()
                try:
                    page.goto(f'chrome-extension://{extension_id}/viewer.html',wait_until='domcontentloaded')
                    if not label.startswith('direct-'):
                        reader=PdfReader(path);attachments=reader.attachments;manifest=json.loads(attachments['manifest.json'][0]);entries=manifest['images']
                        contents={entry['attachment']:attachments[entry['attachment']][0] for entry in entries}
                        generated=set(attachments)-set(contents)
                        if reader.trailer['/Root'].get('/Metadata') is not None:generated.add('document-metadata.xmp')
                        page.locator('#pdf-file').set_input_files(path)
                    else:
                        if label=='direct-directory':
                            page.locator('#dicom-folder').set_input_files(path)
                        else:
                            page.locator('#dicom-files').set_input_files(path)
                        model=wait_model(page)
                        entries=[*model['entries'],*[{**entry,'fields':{}} for entry in model['containers']]]
                        if label=='direct-zip':
                            with zipfile.ZipFile(path) as archive:
                                original={member.filename:archive.read(member) for member in archive.infolist() if not member.is_dir()}
                            original[path.name]=path.read_bytes()
                        elif label=='direct-directory':
                            original={item.relative_to(path).as_posix():item.read_bytes() for item in path.rglob('*') if item.is_file()}
                        else:
                            original={path.name:path.read_bytes()}
                        contents={entry['attachment']:original[entry['sourcePath']] for entry in entries};generated={'manifest.json'}
                    for entry in entries:
                        assert sha(contents[entry['attachment']])==entry['sha256'],'Test input bytes differ from source inventory'
                    expect(page.locator('#image-list option')).to_have_count(sum(bool(data_kind(entry,contents[entry['attachment']])) for entry in entries),timeout=60000)
                    result['cases'].append(run_case(page,label,entries,contents,generated,destination,not label.startswith('direct-')))
                except Exception as error:
                    result['cases'].append({'case':label,'status':'FAIL','errorType':type(error).__name__,
                        'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_pane_inventory.py')]})
                finally:
                    page.close()
                (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps({'completedCases':len(result['cases']),'passedCases':sum(case['status']=='PASS' for case in result['cases'])}),flush=True)
        finally:
            context.close()
    result['extensionUnchanged']=fingerprint(extension/'viewer.js')==asset;result['suppliedZipUnchanged']=fingerprint(input_zip)==zip_before
    result['status']='PASS' if all(case['status']=='PASS' for case in result['cases']) and result['extensionUnchanged'] and result['suppliedZipUnchanged'] and not result['httpRequests'] and not result['pageErrors'] else 'FAIL'
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ('status','extensionUnchanged','suppliedZipUnchanged','httpRequests','pageErrors')}))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__}))
        raise SystemExit(1)
