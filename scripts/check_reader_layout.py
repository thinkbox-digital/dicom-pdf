#!/usr/bin/env python3
"""Check loaded-study toolbar geometry and source tracking entirely offline.

Only ordinal source IDs, geometry and aggregate results are reported. Browser
profiles and reports stay under target/reader-layout-checks; inputs are read only.
"""
import argparse
import json
from pathlib import Path
import tempfile
import traceback

from playwright.sync_api import expect, sync_playwright

from check_extension import extension_identity, launch, manifest_for
from check_pane_inventory import original_context
from convert_archives import fingerprint
from sample_inventory import work_path


GEOMETRY = """() => {
  const visible = element => !!element && !element.closest('[hidden]') && element.getClientRects().length > 0;
  const box = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,
      centerY:rect.y+rect.height/2,visible:visible(element),overflowX:style.overflowX,
      whiteSpace:style.whiteSpace,flexBasis:style.flexBasis,borderLeft:parseFloat(style.borderLeftWidth)};
  };
  const controls = document.querySelector('#controls');
  const children = [...controls.children].filter(visible).map(box);
  const rows = [];
  for (const child of children) {
    if (!rows.some(value => Math.abs(value-child.centerY)<8)) rows.push(child.centerY);
  }
  const padding = getComputedStyle(controls);
  return {windowWidth:innerWidth,viewportWidth:document.documentElement.clientWidth,
    documentScrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,
    reader:box(document.querySelector('.reader-panel')),toolbar:box(document.querySelector('.reader-toolbar')),
    tabs:box(document.querySelector('.view-tabs')),source:box(document.querySelector('#selected-source')),
    offline:box(document.querySelector('.offline-label')),controls:box(controls),children,controlRows:rows.length,
    controlContentWidth:controls.clientWidth-parseFloat(padding.paddingLeft)-parseFloat(padding.paddingRight),
    controlGap:parseFloat(padding.columnGap),hint:box(document.querySelector('.gesture-hint')),
    controlsOverflow:controls.scrollWidth>controls.clientWidth+1,
    viewport:box(document.querySelector('#viewport')),
    sourceEllipsis:getComputedStyle(document.querySelector('#selected-source')).textOverflow==='ellipsis',
    hintInsideControls:document.querySelector('.gesture-hint').parentElement===controls};
}"""


def source_state(page, entry, index):
    expect(page.locator('#image-list')).to_have_value(str(index))
    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', entry['attachment'], timeout=30000)
    expect(page.locator('#viewport')).to_have_attribute('data-source-frame', str(entry.get('sourceFrame') or 1))
    expect(page.locator('#selected-source')).to_have_text(entry['sourcePath'])
    expect(page.locator('#selected-source')).to_have_attribute('title', entry['sourcePath'])


def check_tracking(page, entries, indices):
    for index in indices:
        entry=entries[index]
        page.locator('#image-list').select_option(str(index));source_state(page,entry,index)
        original_context(page,entry)
        page.locator('#show-pdf').click()
        expect(page.locator('#pdf-view')).to_be_visible()
        expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
        expect(page.locator('#image-list')).to_have_value(str(index))
        expect(page.locator('#selected-source')).to_have_text(entry['sourcePath'])
        page.locator('#show-image').click();source_state(page,entry,index)
    # Changing the PDF reference itself must update the DICOM source on return.
    index=indices[0];entry=entries[index]
    page.locator('#show-pdf').click()
    page.locator('#page-number').fill(str(entry['referencePage']))
    page.locator('#page-number').press('Enter')
    expect(page.locator('#image-list')).to_have_value(str(index))
    page.locator('#show-image').click();source_state(page,entry,index)
    return {'selectedSourceChecks':len(indices)+1,'pdfReferenceChecks':len(indices)+1,
        'sourceIds':[f'source-{index:03d}' for index in indices], 'status':'PASS'}


def usable_controls(page):
    checked=0
    for element in page.locator('#controls button, #controls input').all():
        if not element.is_visible() or not element.is_enabled():continue
        element.scroll_into_view_if_needed()
        element.click(trial=True, timeout=5000)
        element.focus()
        assert element.evaluate('element=>document.activeElement===element'),'A control cannot receive keyboard focus'
        checked+=1
    brightness=page.locator('#brightness');brightness.focus();brightness.press('ArrowRight')
    assert brightness.input_value()=='1','Brightness slider is not keyboard operable'
    page.locator('#invert').click();expect(page.locator('#invert')).to_have_attribute('aria-pressed','true')
    page.locator('#reset').click();expect(brightness).to_have_value('0')
    expect(page.locator('#invert')).to_have_attribute('aria-pressed','false')
    return checked


def check_width(page,width,entry,index):
    page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(180)
    # On phone/tablet widths the details pane is an overlay; its existing close
    # control makes the image controls available without changing the viewport.
    overlay_closed=False
    if width<=850 and page.locator('#details-panel').is_visible():
        page.locator('#toggle-details').click();overlay_closed=True
    source_state(page,entry,index)
    geometry=page.evaluate(GEOMETRY)
    assert geometry['documentScrollWidth']<=geometry['viewportWidth']+1,'Reader causes horizontal document overflow'
    assert geometry['bodyScrollWidth']<=geometry['viewportWidth']+1,'Reader causes horizontal body overflow'
    assert not geometry['controlsOverflow'],'Control toolbar overflows horizontally'
    assert geometry['hintInsideControls'],'Scroll hint remains on a separate toolbar'
    assert geometry['hint']['flexBasis']!='100%','Scroll hint still forces its own line'
    assert geometry['hint']['borderLeft']>=1,'Control hint divider is missing'
    assert geometry['sourceEllipsis'],'Long selected-source captions do not truncate with ellipsis'
    for child in geometry['children']:
        assert child['x']>=geometry['controls']['x']-1 and child['right']<=geometry['controls']['right']+1,'A toolbar group is clipped horizontally'
    assert geometry['viewport']['height']>100,'Wrapped controls leave no usable image area'
    if width>=1280:
        assert max(geometry[name]['centerY'] for name in ('tabs','source','offline'))-min(geometry[name]['centerY'] for name in ('tabs','source','offline'))<2,'Tabs, filename and Offline do not share a row'
    if width==2524:
        assert abs(geometry['reader']['width']-1864)<1,'Wide reader geometry changed unexpectedly'
        assert geometry['controlRows']==1,'Wide controls and scroll hint are forced onto multiple rows'
    expect(page.locator('#files-section')).not_to_be_visible()
    expect(page.locator('#download-manifest')).not_to_be_visible()
    expect(page.locator('#metadata-section > summary')).to_have_text('Selected file metadata')
    geometry['usableControls']=usable_controls(page)
    source_state(page,entry,index)
    geometry['detailsOverlayClosedForUse']=overlay_closed
    geometry['status']='PASS'
    return geometry


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('out/ct-abdomen-c4kc-kits-series.pdf'))
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/reader-layout-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    extension=args.extension.resolve(strict=True);source=args.pdf.resolve(strict=True)
    before=fingerprint(source);assets={name:fingerprint(extension/name) for name in ['viewer.js','viewer.css','viewer.html']}
    manifest,_=manifest_for(source);entries=manifest['images']
    supported=[index for index,entry in enumerate(entries) if entry.get('status')=='rendered' and entry.get('referencePage') and not entry.get('displayRejected')]
    assert len(supported)>=3,'The toolbar fixture must include a supported image stack'
    indices=[supported[0],supported[len(supported)//2],supported[-1]];selected=indices[1]
    result={'pdfSha256':before,'viewerAssets':assets,'httpRequests':0,'pageErrors':0,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            context.set_offline(True);result['browserVersion']=context.browser.version
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            page=context.new_page();page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html',wait_until='domcontentloaded')
            page.locator('#pdf-file').set_input_files(source)
            expect(page.locator('#image-list option')).to_have_count(len(supported),timeout=30000)
            result['tracking']=check_tracking(page,entries,indices)
            page.locator('#image-list').select_option(str(selected));source_state(page,entries[selected],selected)
            for width in [2524,1920,1280,900,760,640,480]:
                try:result['cases'].append(check_width(page,width,entries[selected],selected))
                except Exception as error:
                    result['cases'].append({'windowWidth':width,'status':'FAIL','errorType':type(error).__name__,
                        'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_reader_layout.py')]})
                (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps({'completedWidths':len(result['cases']),'passedWidths':sum(case['status']=='PASS' for case in result['cases'])}),flush=True)
        finally:context.close()
    result['pdfUnchanged']=fingerprint(source)==before
    result['assetsUnchanged']=all(fingerprint(extension/name)==digest for name,digest in assets.items())
    result['status']='PASS' if all(case['status']=='PASS' for case in result['cases']) and result['pdfUnchanged'] and result['assetsUnchanged'] and not result['httpRequests'] and not result['pageErrors'] else 'FAIL'
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['status','pdfUnchanged','assetsUnchanged','httpRequests','pageErrors']}))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__}));raise SystemExit(1)
