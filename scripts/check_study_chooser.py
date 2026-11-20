#!/usr/bin/env python3
"""Check single/multiple-study navigation and unchanged originals offline.

The report contains counts and pass/fail flags only. Recovered originals and
isolated browser profiles stay under target/study-chooser-checks.
"""
import argparse
import json
from pathlib import Path
import re
import tempfile
import traceback

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_extension import extension_identity, launch
from check_pane_inventory import all_originals, download_selected, original_context, selected_context
from convert_archives import fingerprint
from sample_inventory import work_path


def selected_source(page, entries, allowed):
    expect(page.locator('#image-list')).to_have_value(re.compile('^(?:'+'|'.join(str(index) for index in sorted(allowed))+')$'),timeout=30000)
    index=int(page.locator('#image-list').input_value())
    assert index in allowed,'Selected original belongs to a different study'
    entry=entries[index]
    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'],timeout=30000)
    expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(entry.get('sourceFrame') or 1))
    expect(page.locator('#selected-source')).to_have_text(entry['sourcePath'])
    expect(page.locator('#selected-source')).to_have_attribute('title',entry['sourcePath'])
    original_context(page,entry)
    assert selected_context(page).get('StudyInstanceUID')==entry['fields']['StudyInstanceUID'],'Selected metadata belongs to a different study'
    return index


def verify_selection(page,entries,allowed,contents,destination):
    index=selected_source(page,entries,allowed);entry=entries[index]
    assert entry.get('referencePage'),'Selected preview has no PDF reference mapping'
    page.locator('#show-pdf').click()
    expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
    expect(page.locator('#image-list')).to_have_value(str(index))
    page.locator('#show-image').click()
    assert selected_source(page,entries,allowed)==index,'Switching viewing modes changed the study source'
    download_selected(page,entry,contents[entry['attachment']],destination)
    return index


def check_case(context,location,path,expected_studies,report):
    before=fingerprint(path);reader=PdfReader(path)
    manifest=json.loads(reader.attachments['manifest.json'][0]);entries=manifest['images']
    contents={entry['attachment']:reader.attachments[entry['attachment']][0] for entry in entries}
    groups={}
    for index,entry in enumerate(entries):
        uid=entry.get('fields',{}).get('StudyInstanceUID')
        if uid:groups.setdefault(uid,set()).add(index)
    assert len(groups)==expected_studies,'The study-count fixture no longer matches the requested case'
    report.mkdir(parents=True,exist_ok=True);page=context.new_page()
    try:
        page.goto(location,wait_until='domcontentloaded');page.locator('#pdf-file').set_input_files(path)
        expect(page.locator('#study-navigation')).to_be_visible(timeout=30000)
        picker=page.locator('.study-picker');heading=page.locator('.study-picker-label')
        expect(picker.locator('option:not([value=""])')).to_have_count(expected_studies)
        expect(page.locator('#files-section')).not_to_be_visible()
        expect(page.locator('#show-metadata')).to_contain_text('Selected file metadata')
        selections=0;card_selections=0;individual_downloads=0
        if expected_studies==1:
            expect(heading).not_to_be_visible();expect(picker).not_to_be_visible()
            cards=page.locator('#study-navigation .series-card')
            expect(cards.first).to_be_visible()
            all_indices=next(iter(groups.values()))
            for ordinal in sorted({0,cards.count()-1}):
                card=cards.nth(ordinal);index=int(card.get_attribute('data-source-index'))
                assert index in all_indices,'Single-study series card maps to another study'
                card.click()
                verify_selection(page,entries,{index},contents,report/f'individual-{individual_downloads+1}.dcm')
                selections+=1;card_selections+=1;individual_downloads+=1
        else:
            expect(heading).to_be_visible();expect(picker).to_be_visible();expect(picker).to_be_enabled()
            options=picker.locator('option:not([value=""])').evaluate_all('options=>options.map(option=>option.value)')
            selected_studies=set()
            for ordinal,value in enumerate(options):
                picker.select_option(value)
                expect(picker).to_have_value(value)
                # The model key is an encoded supplied UID; compare only in
                # memory and never place it or selected source text in reports.
                key=json.loads(value)
                assert len(key)==2 and key[0]=='study' and key[1] in groups,'Chooser does not map to a supplied study'
                allowed=groups[key[1]];selected_studies.add(key[1])
                expect(page.locator('#study-navigation .series-card').first).to_be_visible()
                verify_selection(page,entries,allowed,contents,report/f'individual-{ordinal+1}.dcm')
                selections+=1;individual_downloads+=1
                card=page.locator('#study-navigation .series-card').first
                index=int(card.get_attribute('data-source-index'))
                assert index in allowed,'A series card maps to a different selected exam'
                card.click();selected_source(page,entries,{index});card_selections+=1
            assert len(selected_studies)==expected_studies,'Some supplied studies cannot be selected'
        recovered=all_originals(page,entries,contents,report)
        assert fingerprint(path)==before,'Read-only study check changed its PDF input'
        return {'status':'PASS','studyCount':expected_studies,'suppliedOriginalCount':len(entries),
            'chooserVisible':picker.is_visible(),'chooserHiddenForSingleStudy':expected_studies!=1 or not picker.is_visible(),
            'studySelectionsChecked':selections,'seriesCardSelectionsChecked':card_selections,
            'sourceUidAndFrameMappingsCorrect':True,'pdfReferenceMappingsCorrect':True,
            'individualOriginalsByteIdentical':individual_downloads,'zipOriginalsByteIdentical':recovered,
            'technicalFilesHidden':not page.locator('#files-section').is_visible(),'pdfUnchanged':True}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--single',type=Path,default=Path('out/ct-abdomen-c4kc-kits-series.pdf'))
    parser.add_argument('--multiple',type=Path,default=Path('out/supplied-ct-samples.pdf'))
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/study-chooser-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    extension=args.extension.resolve(strict=True);assets={name:fingerprint(extension/name) for name in ['viewer.js','viewer.css','viewer.html']}
    result={'httpRequests':0,'pageErrors':0,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            context.set_offline(True)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            location=f'chrome-extension://{extension_identity(context)}/viewer.html'
            for path,count,label in [(args.single,1,'single-study'),(args.multiple,4,'multiple-studies')]:
                try:result['cases'].append(check_case(context,location,path.resolve(strict=True),count,report/label))
                except Exception as error:
                    result['cases'].append({'status':'FAIL','studyCount':count,'errorType':type(error).__name__,
                        'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_study_chooser.py')]})
                (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps({'completedCases':len(result['cases']),'passedCases':sum(case['status']=='PASS' for case in result['cases'])}),flush=True)
        finally:context.close()
    result['assetsUnchanged']=all(fingerprint(extension/name)==digest for name,digest in assets.items())
    result['status']='PASS' if all(case['status']=='PASS' for case in result['cases']) and result['assetsUnchanged'] and not result['httpRequests'] and not result['pageErrors'] else 'FAIL'
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['status','assetsUnchanged','httpRequests','pageErrors']}))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__}));raise SystemExit(1)
