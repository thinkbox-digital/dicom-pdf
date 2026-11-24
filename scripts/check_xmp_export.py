#!/usr/bin/env python3
"""Check complete XMP metadata export, CSV fidelity, legacy fallback and recovery.

Only counts/hashes are printed. XML, CSVs, modified test PDFs and recovered
originals stay under target/xmp-export-checks. Supplied inputs are never changed.
"""
import argparse
import csv
import io
import json
from pathlib import Path
import re
import tempfile
import traceback
import xml.etree.ElementTree as ET

from pypdf import PdfReader,PdfWriter
from pypdf.generic import DecodedStreamObject,NameObject
from playwright.sync_api import expect,sync_playwright

from check_extension import launch,extension_identity,first_supported
from check_pane_inventory import all_originals,download_selected,spreadsheet
from convert_archives import fingerprint
from sample_inventory import work_path
import hashlib


NS='https://thinkbox.digital/ns/dicom/2.0/'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def xml(packet):
    assert b'<!DOCTYPE' not in packet.upper(),'Unexpected XML document type'
    return ET.fromstring(packet)


def properties(packet):
    root=xml(packet);result={}
    for element in root.iter():
        if element.tag.startswith('{'+NS+'}'):
            name=element.tag.split('}',1)[1]
            assert name not in result,'Repeated custom XMP property'
            result[name]=''.join(element.itertext())
        for key,value in element.attrib.items():
            if key.startswith('{'+NS+'}'):
                result[key.split('}',1)[1]]=value
    return result


def pdf_inventory(path):
    reader=PdfReader(path);manifest=json.loads(reader.attachments['manifest.json'][0])
    metadata=json.loads(reader.attachments['dicom-metadata.json'][0])
    packet=reader.trailer['/Root']['/Metadata'].get_object().get_data()
    originals={entry['attachment']:reader.attachments[entry['attachment']][0] for entry in manifest['images']}
    return reader,manifest,metadata,packet,originals


def variant(source,destination,kind):
    writer=PdfWriter(clone_from=source)
    if kind=='no-sidecar':
        names=writer._root_object['/Names']['/EmbeddedFiles']['/Names']
        for index in range(len(names)-2,-1,-2):
            if str(names[index])=='dicom-metadata.json':del names[index:index+2]
        associated=writer._root_object.get('/AF')
        if associated is not None:
            for index in range(len(associated)-1,-1,-1):
                spec=associated[index].get_object()
                if str(spec.get('/UF',spec.get('/F','')))=='dicom-metadata.json':del associated[index]
    else:
        packet=writer._root_object['/Metadata'].get_object().get_data()
        for _,(prefix,uri) in ET.iterparse(io.BytesIO(packet),events=('start-ns',)):
            ET.register_namespace(prefix,uri)
        root=xml(packet)
        name='metadataSha256' if kind=='bad-digest' else 'metadataJson'
        nodes=[element for element in root.iter() if element.tag=='{'+NS+'}'+name]
        assert len(nodes)==1,'Full-XMP fixture property missing'
        if kind=='bad-digest':nodes[0].text='0'*64
        else:
            for parent in root.iter():
                if nodes[0] in list(parent):parent.remove(nodes[0]);break
        stream=DecodedStreamObject();stream.set_data(ET.tostring(root,encoding='utf-8'))
        stream[NameObject('/Type')]=NameObject('/Metadata');stream[NameObject('/Subtype')]=NameObject('/XML')
        writer._root_object[NameObject('/Metadata')]=writer._add_object(stream)
    with destination.open('wb') as output:writer.write(output)
    if kind=='no-sidecar':assert 'dicom-metadata.json' not in PdfReader(destination).attachments


def open_export(page):
    page.locator('#export-csv').click()
    expect(page.locator('#metadata-export-dialog')).to_be_visible()


def close_export(page):
    if page.locator('#metadata-export-dialog').is_visible():page.locator('#export-csv-cancel').click()


def packet_download(page,destination):
    open_export(page)
    expect(page.locator('#export-xmp')).to_be_visible();expect(page.locator('#export-xmp')).to_be_enabled()
    with page.expect_download() as event:page.locator('#export-xmp').click()
    event.value.save_as(destination);close_export(page)
    data=destination.read_bytes();data.decode('utf-8')
    return data,properties(data)


def csv_download(page,destination,layout,xmp):
    open_export(page);page.locator('#export-image-scope').select_option('all')
    page.locator('#export-field-scope').select_option('all');page.locator('#export-csv-layout').select_option(layout)
    expect(page.locator('#export-csv-confirm')).to_be_enabled(timeout=60000)
    text=page.locator('#export-csv-status').inner_text()
    assert ('metadata from PDF XMP' in text)==xmp,'CSV used an unexpected metadata source'
    with page.expect_download() as event:page.locator('#export-csv-confirm').click()
    event.value.save_as(destination)
    with destination.open(encoding='utf-8-sig',newline='') as stream:
        parsed=csv.DictReader(stream);rows=list(parsed);return parsed.fieldnames,rows


def identity(row,entry):
    assert row['Source file']==spreadsheet(entry['sourcePath']) and row['Attachment']==entry['attachment'],'CSV source identity differs'
    assert row['SHA-256']==entry['sha256'] and row['SOP Instance UID']==spreadsheet(entry.get('sopInstanceUID')),'CSV instance/hash differs'


def column_value(element):
    value=element.get('value');encoding=element.get('encoding','')
    if value is None:return spreadsheet('['+encoding+']' if encoding else '')
    text=str(value)
    if 'base64' in encoding or encoding.startswith(('omitted-','unreadable-','undecodable-','unsupported-','ambiguous-')) or encoding=='sequence-item-count':
        text='['+encoding+']'+(' '+text if text else '')
    return spreadsheet(text)


def check_csv(page,manifest,metadata,golden,destination,xmp):
    by_attachment={entry['attachment']:entry for entry in manifest['images']}
    headers,rows=csv_download(page,destination/'columns.csv','columns',xmp)
    assert len(rows)==len(by_attachment),'CSV dropped original source records'
    assert {row['Attachment'] for row in rows}==set(by_attachment),'CSV original inventory differs'
    for row in rows:identity(row,by_attachment[row['Attachment']])
    if golden:
        assert len(rows)==1
        record=metadata['images'][0];elements={element['path']:element for element in record['elements']}
        for path,expected in golden['expectedElements'].items():
            element=elements[path]
            assert all(element.get(key)==value for key,value in expected.items()),'XMP source inventory differs from synthetic expectations'
            label=f"{element.get('keyword') or element.get('tag') or path} [{path}]"
            assert label in headers and rows[0][label]==column_value(element),'Spreadsheet CSV omitted or altered a full metadata field'
        _,detail=csv_download(page,destination/'details.csv','rows',xmp)
        actual={row['Path']:row for row in detail if not row['Path'].startswith('package/')}
        assert len(actual)==len(record['elements']) and set(actual)==set(elements),'Detailed CSV omitted or invented metadata paths'
        for path,element in elements.items():
            row=actual[path];identity(row,by_attachment[row['Attachment']])
            assert all(row[name]==spreadsheet(element.get(key)) for name,key in [('Value','value'),('Tag','tag'),('Keyword','keyword'),('VR','vr'),('Encoding','encoding')]),'Detailed CSV changed metadata value/VR/encoding'
    return {'sourceRows':len(rows),'spreadsheetColumns':len(headers),'csvSha256':fingerprint(destination/'columns.csv'),'metadataSource':'xmp' if xmp else 'legacy'}


def original_recovery(page,manifest,originals,destination):
    first=next((index for index,entry in enumerate(manifest['images']) if entry.get('status')=='rendered'),0)
    page.locator('#image-list').select_option(str(first));entry=manifest['images'][first]
    download_selected(page,entry,originals[entry['attachment']],destination/'selected-original.dcm')
    return all_originals(page,manifest['images'],originals,destination)


def run_case(context,location,label,path,manifest,metadata,originals,golden,report,full=True,invalid=False):
    destination=report/label;destination.mkdir(exist_ok=True);page=context.new_page()
    try:
        page.goto(location,wait_until='domcontentloaded');page.locator('#pdf-file').set_input_files(path)
        if first_supported(manifest) is not None:
            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',re.compile('.+'),timeout=60000)
        expect(page.locator('#files-section')).not_to_be_visible();expect(page.locator('#download-manifest')).not_to_be_visible()
        raw,props=packet_download(page,destination/'document-metadata.xmp')
        if full and not invalid:
            payload=props['metadataJson'].encode('utf-8')
            assert props['metadataVersion']=='1' and props['schemaVersion']=='2'
            assert sha(payload)==props['metadataSha256']==manifest['artifactSha256']['dicom-metadata.json'],'Exported XMP full metadata checksum differs'
            assert json.loads(payload)==metadata and json.loads(props['inventoryJson'])==manifest,'Exported XMP metadata/manifest differs'
        if not full:assert 'metadataJson' not in props,'Legacy fixture unexpectedly contains full XMP'
        if invalid:
            open_export(page)
            expect(page.locator('#export-csv-status')).to_contain_text('could not be verified',timeout=30000)
            expect(page.locator('#export-csv-confirm')).to_be_disabled();expect(page.locator('#export-xmp')).to_be_enabled()
            close_export(page);csv_result={'invalidFullXmpBlocksCsv':True}
        else:csv_result=check_csv(page,manifest,metadata,golden,destination,full)
        recovered=original_recovery(page,manifest,originals,destination)
        return {'case':label,'status':'PASS','normalizedXmpBytes':len(raw),'normalizedXmpSha256':sha(raw),
                'byteIdenticalRecoveredOriginals':recovered,'technicalFilesHidden':True,**csv_result}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('target/viewer-test-pdfs/synthetic-full-xmp.pdf'))
    parser.add_argument('--expectations',type=Path,default=Path('target/full-xmp-input-expectations.json'))
    parser.add_argument('--source',type=Path,default=Path('target/full-xmp-input/metadata.dcm'))
    parser.add_argument('--legacy',type=Path,default=Path('target/viewer-test-pdfs/metadata-sample.pdf'))
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/xmp-export-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    golden=json.loads(args.expectations.read_text());assert golden['synthetic'] is True
    assert fingerprint(args.source)==golden['sourceSha256'] and args.source.stat().st_size==golden['sourceSize']
    reader,manifest,metadata,packet,originals=pdf_inventory(args.pdf);props=properties(packet)
    sidecar=reader.attachments['dicom-metadata.json'][0]
    assert manifest['metadataXmpVersion']==1 and props['metadataVersion']=='1'
    assert props['metadataJson'].encode('utf-8')==sidecar and sha(sidecar)==props['metadataSha256'],'PDF XMP is not the exact compact sidecar JSON'
    elements=metadata['images'][0]['elements'];by_path={element['path']:element for element in elements}
    for path,expected in golden['expectedElements'].items():assert all(by_path[path].get(key)==value for key,value in expected.items())
    categories={'private':sum(bool(re.search(r'/\([0-9A-Fa-f]{3}[13579bBdDfF],',element['path'])) for element in elements),
        'nested':sum('[' in element['path'] for element in elements),'base64':sum(element['encoding']=='base64' for element in elements),
        'omittedPixels':sum(element['encoding']=='omitted-pixel-data' for element in elements),
        'nonselectedNamedFields':sum(bool(element.get('keyword')) and element['keyword'] not in manifest['images'][0].get('fields',{}) and '[' not in element['path'] and element['encoding']=='dicom-value-string' for element in elements)}
    assert all(categories.values()),'Synthetic full inventory does not cover all expected metadata categories'
    assert all(element['encoding']=='omitted-pixel-data' for element in elements if element['encoding'].startswith('omitted-')),'Nonpixel metadata was omitted'
    variants={}
    for kind in ['no-sidecar','bad-digest','missing-full']:
        variants[kind]=report/(kind+'.pdf');variant(args.pdf,variants[kind],kind)
    _,legacy_manifest,legacy_metadata,legacy_packet,legacy_originals=pdf_inventory(args.legacy)
    assert not legacy_manifest.get('metadataXmpVersion') and 'metadataJson' not in properties(legacy_packet)
    extension=args.extension.resolve(strict=True);asset=fingerprint(extension/'viewer.js')
    source_before=fingerprint(args.source);pdf_before=fingerprint(args.pdf)
    result={'syntheticFixture':True,'inventoryElements':len(elements),'categoryCounts':categories,'metadataSha256':sha(sidecar),
            'viewerSha256':asset,'httpRequests':0,'pageErrors':0,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            result['browserVersion']=context.browser.version;extension_id=extension_identity(context);context.set_offline(True)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            location=f'chrome-extension://{extension_id}/viewer.html'
            cases=[('full-xmp',args.pdf,manifest,metadata,originals,golden,True,False,location),
                ('xmp-without-sidecar',variants['no-sidecar'],manifest,metadata,originals,golden,True,False,location),
                ('invalid-digest',variants['bad-digest'],manifest,metadata,originals,None,True,True,location),
                ('missing-required-full',variants['missing-full'],manifest,metadata,originals,None,True,True,location),
                ('legacy-fallback',args.legacy,legacy_manifest,legacy_metadata,legacy_originals,None,False,False,location)]
            for label,path,m,d,o,g,full,invalid,url in cases:
                try:result['cases'].append(run_case(context,url,label,path,m,d,o,g,report,full,invalid))
                except Exception as error:result['cases'].append({'case':label,'status':'FAIL','errorType':type(error).__name__,
                    'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_xmp_export.py')]})
                (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps({'completedCases':len(result['cases']),'passedCases':sum(case['status']=='PASS' for case in result['cases'])}),flush=True)
        finally:context.close()
    result['sourceUnchanged']=fingerprint(args.source)==source_before;result['pdfUnchanged']=fingerprint(args.pdf)==pdf_before
    result['assetsUnchanged']=fingerprint(extension/'viewer.js')==asset
    result['status']='PASS' if all(case['status']=='PASS' for case in result['cases']) and result['sourceUnchanged'] and result['pdfUnchanged'] and result['assetsUnchanged'] and not result['httpRequests'] and not result['pageErrors'] else 'FAIL'
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['status','inventoryElements','categoryCounts','metadataSha256','sourceUnchanged','pdfUnchanged','assetsUnchanged','httpRequests','pageErrors']}))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__}));raise SystemExit(1)
