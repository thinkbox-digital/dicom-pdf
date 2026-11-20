#!/usr/bin/env python3
"""Check optional image information, source orientation and live display state.

Reports contain counts/booleans/performance measurements only. Source metadata
is compared in memory; recovered files and profiles stay under target/.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import tempfile
import time
import traceback

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_direct_inputs import PROBE as INPUT_PROBE, wait_model
from check_extension import extension_identity, launch
from check_pane_inventory import download_selected
from check_scroll_performance import PROBE as SCROLL_PROBE, physical_order, select_source, summarize, wheel_pattern
from convert_archives import fingerprint
from sample_inventory import work_path


# Observe the actual Canvas2D source-pixel transform, independent of the app's
# indexToWorld/worldToCanvas overlay calculation. This adds no application API.
DRAW_PROBE=r"""(() => {
  const p=globalThis.__overlayProbe={draw:null,draws:0};
  const original=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){
    const result=original.apply(this,args);
    if(this.canvas.closest?.('#viewport')){
      const m=this.getTransform(),r=this.canvas.getBoundingClientRect();
      const sx=r.width/this.canvas.width,sy=r.height/this.canvas.height;
      let dx=1,dy=1;
      if(args.length===9){dx=args[7]/args[3];dy=args[8]/args[4];}
      else if(args.length===5){dx=args[3]/args[0].width;dy=args[4]/args[0].height;}
      p.draw={x:Math.hypot(m.a*sx,m.b*sy)*dx,y:Math.hypot(m.c*sx,m.d*sy)*dy,
        tx:m.e*sx,ty:m.f*sy};p.draws++;
    }
    return result;
  };
})();"""


def poll(page,condition,message,timeout=10):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=condition()
        if value:return value
        page.wait_for_timeout(30)
    raise AssertionError(message)


def overlay(page):
    return page.locator('#image-overlays').evaluate("element=>({visible:!element.hidden,top:document.querySelector('#overlay-top-left').textContent,bottom:document.querySelector('#overlay-bottom-left').textContent,display:document.querySelector('#overlay-bottom-right').textContent,markers:Object.fromEntries(['top','right','bottom','left'].map(side=>[side,document.querySelector('#orientation-'+side).textContent]))})")


def safe_text(value,limit=80):
    if not isinstance(value,str):return ''
    value=re.sub(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]',' ',value)
    value=' '.join(value.split())
    return value if len(value)<=limit else value[:limit-1]+'…'


def expected_heading(entry):
    fields={**entry.get('navigationFields',{}),**entry.get('fields',{})};lines=[]
    description=safe_text(fields.get('SeriesDescription'));number=safe_text(fields.get('SeriesNumber'),12)
    number=number if re.fullmatch(r'[+-]?\d+',number) else ''
    if description or number:lines.append(' · '.join(piece for piece in [('Series '+number) if number else '',description] if piece))
    raw=fields.get('StudyDate','').strip()
    if re.fullmatch(r'\d{8}',raw):
        try:
            date=datetime.datetime.strptime(raw,'%Y%m%d')
            lines.append(f'Study {date.day} '+date.strftime('%b %Y'))
        except ValueError:pass
    return '\n'.join(lines)


def expected_markers(iop,rotation=0):
    if iop is None:return {side:'' for side in ['top','right','bottom','left']}
    if isinstance(iop,str):iop=[float(value) for value in iop.split('\\')]
    row,column=iop[:3],iop[3:];angle=math.radians(rotation)
    right=[a*math.cos(angle)-b*math.sin(angle) for a,b in zip(row,column)]
    bottom=[a*math.sin(angle)+b*math.cos(angle) for a,b in zip(row,column)]
    def direction(vector):
        values=[(abs(value),axis,('LPH' if value>0 else 'RAF')[axis]) for axis,value in enumerate(vector) if abs(value)>0.0001]
        return ''.join(value[2] for value in sorted(values,key=lambda value:(-value[0],value[1])))
    return {side:direction(vector) for side,vector in [('top',[-value for value in bottom]),('right',right),('bottom',bottom),('left',[-value for value in right])]}


def assert_context(page,entry,index,total,frame=1,frames=1,markers=None):
    expect(page.locator('#image-overlays')).to_be_visible()
    expect(page.locator('#overlay-top-left')).to_have_text(expected_heading(entry))
    bottom=f'Image {index+1} of {total}'+(f'\nFrame {frame} of {frames}' if frames>1 else '')
    expect(page.locator('#overlay-bottom-left')).to_have_text(bottom)
    if markers is not None:
        for side,text in markers.items():expect(page.locator('#orientation-'+side)).to_have_text(text or '')
    # Exact heading comparison guarantees no patient/name/identifier fields or
    # filenames have slipped into these visible information lines.
    assert page.locator('#image-overlays').get_attribute('aria-live') is None,'Overlay announces every rendering update'
    assert page.locator('#image-overlays').evaluate('element=>getComputedStyle(element).pointerEvents')=='none'
    assert page.locator('#image-overlays').evaluate("element=>{const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return [...element.children].filter(child=>child.textContent).every(child=>{const b=child.getBoundingClientRect();return !(b.x<=x&&b.right>=x&&b.y<=y&&b.bottom>=y);});}"),'An information label covers the image center'


def displayed_numbers(page):
    text=overlay(page)['display'];window=re.search(r'WL ([-+\d.]+) · WW ([-+\d.]+)',text)
    zoom=re.search(r'Zoom ([\d.]+)%(?: × ([\d.]+)%)?',text)
    assert window and zoom,'Live window and source-pixel zoom are absent'
    return {'center':float(window[1]),'width':float(window[2]),'x':float(zoom[1])/100,'y':float(zoom[2] or zoom[1])/100}


def actual_zoom(page):
    return poll(page,lambda:page.evaluate('__overlayProbe.draw'),'Actual image canvas transform was not observed')


def assert_zoom(page,ratio=None):
    actual=actual_zoom(page);shown=displayed_numbers(page)
    assert abs(actual['x']-shown['x'])<=0.000011 and abs(actual['y']-shown['y'])<=0.000011,'Zoom overlay differs from the drawn source-pixel transform'
    if ratio is not None:assert abs(actual['y']/actual['x']-ratio)<0.00001,'Non-square source-pixel scale is incorrect'
    return actual


def controls(page,markers):
    baseline=page.locator('#viewport').evaluate('element=>({center:Number(element.dataset.windowCenter),width:Number(element.dataset.windowWidth)})')
    before=assert_zoom(page)
    for identifier,value in [('brightness',25),('contrast',175)]:
        page.locator('#'+identifier).evaluate('(element,value)=>{element.value=String(value);element.dispatchEvent(new Event("input",{bubbles:true}));}',value)
    page.wait_for_timeout(60);shown=displayed_numbers(page)
    assert abs(shown['center']-(baseline['center']-baseline['width']*0.25))<0.0011,'WL does not follow current brightness'
    assert abs(shown['width']-max(1,baseline['width']/1.75))<0.0011,'WW does not follow current contrast'
    page.locator('#zoom-in').click();page.wait_for_timeout(70);after=assert_zoom(page)
    assert abs(after['x']/before['x']-1.25)<0.00001,'Zoom button did not update the actual source-pixel scale'
    page.locator('#rotate-right').click();page.wait_for_timeout(70)
    rotated={'top':markers['left'],'right':markers['top'],'bottom':markers['right'],'left':markers['bottom']}
    for side,text in rotated.items():expect(page.locator('#orientation-'+side)).to_have_text(text or '')
    assert_zoom(page)
    page.locator('#rotate-left').click();page.wait_for_timeout(50)
    for side,text in markers.items():expect(page.locator('#orientation-'+side)).to_have_text(text or '')
    canvas=page.locator('#viewport canvas').first
    before_pan=actual_zoom(page);bounds=canvas.bounding_box();x=bounds['x']+bounds['width']/2;y=bounds['y']+bounds['height']/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+40,y+25,steps=5);page.mouse.up();page.wait_for_timeout(60)
    after_pan=assert_zoom(page)
    assert abs(after_pan['tx']-before_pan['tx'])>10 or abs(after_pan['ty']-before_pan['ty'])>10,'Information overlay intercepts pan gestures'
    page.keyboard.down('Control');page.mouse.wheel(0,-100);page.keyboard.up('Control');page.wait_for_timeout(80)
    after_wheel=assert_zoom(page)
    assert abs(after_wheel['x']/after_pan['x']-1.1)<0.00001,'Information overlay intercepts Ctrl+wheel zoom'
    page.locator('#reset').click();page.wait_for_timeout(80);assert_zoom(page)
    return {'liveWindowLevel':True,'actualSourcePixelZoom':True,'rotatedOrientationMarkers':True,'panAndCtrlWheelUnblocked':True}


def new_page(context,location):
    page=context.new_page();page.set_viewport_size({'width':2524,'height':1100});page.goto(location,wait_until='domcontentloaded')
    return page


def ct_case(context,location,path,report):
    reader=PdfReader(path);manifest=json.loads(reader.attachments['manifest.json'][0]);entries=manifest['images']
    order=physical_order(entries,[index for index,entry in enumerate(entries) if entry.get('status')=='rendered'])
    middle=order[len(order)//2];entry=entries[middle]
    expected=expected_markers(entry['fields']['ImageOrientationPatient'])
    aliases={hashlib.sha256(value['attachment'].encode()).hexdigest():f'source-{index+1:03}' for index,value in enumerate(entries)}
    page=new_page(context,location)
    try:
        page.evaluate('map=>__scrollProbe.map=map',aliases);page.locator('#pdf-file').set_input_files(path)
        expect(page.locator('#image-list option')).to_have_count(len(order),timeout=60000)
        select_source(page,middle,entry);assert_context(page,entry,order.index(middle),len(order),markers=expected)
        changes=controls(page,expected)
        page.locator('#toggle-overlays').click();expect(page.locator('#image-overlays')).not_to_be_visible()
        expect(page.locator('#toggle-overlays')).to_have_attribute('aria-pressed','false')
        second=order[order.index(middle)+1];select_source(page,second,entries[second]);expect(page.locator('#image-overlays')).not_to_be_visible()
        page.locator('#show-pdf').click();expect(page.locator('#image-overlays')).not_to_be_visible()
        expect(page.locator('#page-number')).to_have_value(str(entries[second]['referencePage']))
        page.locator('#show-image').click();expect(page.locator('#image-overlays')).not_to_be_visible()
        page.locator('#toggle-overlays').click();assert_context(page,entries[second],order.index(second),len(order),markers=expected_markers(entries[second]['fields']['ImageOrientationPatient']))
        page.locator('#show-pdf').click();expect(page.locator('#image-overlays')).not_to_be_visible()
        page.locator('#show-image').click();expect(page.locator('#image-overlays')).to_be_visible()
        # A single-frame stack plus Info must retain the requested wide one-row controls.
        assert page.locator('#controls').evaluate("element=>{const children=[...element.children].filter(child=>child.getClientRects().length&&!child.closest('[hidden]'));const centers=children.map(child=>{const r=child.getBoundingClientRect();return r.y+r.height/2;});return Math.max(...centers)-Math.min(...centers)<2;}"),'Info forces a second wide control row'
        select_source(page,middle,entry);page.evaluate('__scrollProbe.begin()')
        wheel_pattern(page,[1]*12+[-1]*12,70);page.wait_for_timeout(400);raw=page.evaluate('__scrollProbe.end()');performance=summarize(raw)
        assert performance['acceptedWheels']==24 and performance['commitCount']==24,'Overlay work causes wheel requests to be dropped'
        assert not performance['blankAnimationFrames'] and not performance['blackCanvasSamples'] and not performance['emptyOverlaySamples'],'Overlay update causes a blank image during normal wheel scrolling'
        assert performance['requestToCommit'].get('p95Ms',0)<70,'Overlay work regressed normal scroll response'
        expect(page.locator('#image-list')).to_have_value(str(middle));assert_context(page,entry,order.index(middle),len(order),markers=expected)
        download_selected(page,entry,reader.attachments[entry['attachment']][0],report/'ct-original.dcm')
        return {'status':'PASS','case':'ct-pdf','images':len(order),'sourceCountsAndWhitelistedHeading':True,
            **changes,'infoPersistsAcrossSourcesAndModes':True,'wideToolbarOneRow':True,'originalsByteIdentical':1,'wheel':performance}
    finally:page.close()


def synthetic_case(context,location,inputs,expectations,report,basic=False):
    names=list(expectations['files']);names=[names[0],names[-1]] if basic else names
    paths=[inputs/name for name in names];page=new_page(context,location)
    try:
        page.locator('#dicom-files').set_input_files(paths);model=wait_model(page);entries=model['entries']
        assert len(entries)==len(names),'Synthetic inputs were dropped'
        frame_checks=0;recovered=0;controls_checked=False
        for name in names:
            index=next(index for index,entry in enumerate(entries) if entry['sourcePath']==name);entry=entries[index];golden=expectations['files'][name]
            select_source(page,index,entry)
            for frame in golden['frames']:
                if frame['frame']>1:
                    page.locator('#frame-number').fill(str(frame['frame']));page.locator('#frame-number').press('Enter')
                    expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(frame['frame']))
                    page.wait_for_timeout(70)
                assert_context(page,entry,0,1,frame['frame'],golden['frameCount'],frame['markers'])
                assert_zoom(page,golden['pixelAspectRatio']);frame_checks+=1
            if not controls_checked:
                controls(page,golden['frames'][0]['markers']);controls_checked=True
            download_selected(page,entry,(inputs/name).read_bytes(),report/f'synthetic-original-{recovered+1}.dcm');recovered+=1
        page.locator('#toggle-overlays').click();expect(page.locator('#image-overlays')).not_to_be_visible()
        select_source(page,0,entries[0]);expect(page.locator('#image-overlays')).not_to_be_visible()
        page.locator('#toggle-overlays').click();expect(page.locator('#image-overlays')).to_be_visible()
        return {'case':'standalone-synthetic' if basic else 'synthetic-orientation','status':'PASS','files':len(names),'frameChecks':frame_checks,
            'malformedAndQuadrupedMarkersHidden':not basic,'actualNonSquareScaleCorrect':True,'whitelistedHeading':True,
            'infoPersistsAcrossSources':True,'liveDisplayControls':controls_checked,'originalsByteIdentical':recovered}
    finally:page.close()


def unsupported_case(context,location,project,inputs,report):
    source=project/'fixtures/expanded/mr-explicit-le-signed16.dcm';data=source.read_bytes();syntax=b'1.2.840.10008.1.2.1\x00'
    assert data.count(syntax)==1
    unsupported=report/'unsupported-syntax.dcm';unsupported.write_bytes(data.replace(syntax,b'1.2.840.10008.1.2.9\x00',1))
    page=new_page(context,location)
    try:
        page.locator('#dicom-files').set_input_files([inputs/'01-axial.dcm',unsupported]);model=wait_model(page);entries=model['entries']
        good=next(index for index,entry in enumerate(entries) if entry['sourcePath']=='01-axial.dcm')
        bad=next(index for index,entry in enumerate(entries) if entry['sourcePath']=='unsupported-syntax.dcm')
        select_source(page,good,entries[good]);expect(page.locator('#image-overlays')).to_be_visible()
        page.locator('#image-list').select_option(str(bad));expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment','')
        expect(page.locator('#image-overlays')).not_to_be_visible()
        expect(page.locator('#viewport')).to_contain_text(re.compile('unsupported|not supported|retained',re.I))
        download_selected(page,entries[bad],unsupported.read_bytes(),report/'unsupported-original.dcm')
        return {'case':'unsupported-image','status':'PASS','overlayHidden':True,'failureLabeled':True,'originalsByteIdentical':1}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('out/ct-abdomen-c4kc-kits-series.pdf'))
    parser.add_argument('--inputs',type=Path,default=Path('target/overlay-inputs'))
    parser.add_argument('--expectations',type=Path,default=Path('target/overlay-fixtures/expectations.json'))
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--standalone',type=Path,default=Path('src/main/resources/viewer.html'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/image-overlay-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    golden=json.loads(args.expectations.read_text());assert golden['synthetic'] is True
    inputs=args.inputs.resolve(strict=True);sources={inputs/name:row['sha256'] for name,row in golden['files'].items()}
    sources[args.pdf.resolve(strict=True)]=fingerprint(args.pdf)
    assert all(fingerprint(path)==digest for path,digest in sources.items())
    extension=args.extension.resolve(strict=True);assets={extension/name:fingerprint(extension/name) for name in ['viewer.js','viewer.html','viewer.css']}
    assets[args.standalone.resolve(strict=True)]=fingerprint(args.standalone)
    result={'httpRequests':0,'pageErrors':0,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            context.set_offline(True);context.add_init_script(SCROLL_PROBE+'\n'+INPUT_PROBE+'\n'+DRAW_PROBE)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            location=f'chrome-extension://{extension_identity(context)}/viewer.html'
            cases=[('ct',lambda:ct_case(context,location,args.pdf,report)),
                ('synthetic',lambda:synthetic_case(context,location,inputs,golden,report)),
                ('unsupported',lambda:unsupported_case(context,location,project,inputs,report)),
                ('standalone',lambda:synthetic_case(context,args.standalone.resolve().as_uri(),inputs,golden,report,True))]
            for label,run in cases:
                try:result['cases'].append(run())
                except Exception as error:
                    result['cases'].append({'case':label,'status':'FAIL','errorType':type(error).__name__,
                        'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_image_overlays.py')]})
                (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps({'completedCases':len(result['cases']),'passedCases':sum(case['status']=='PASS' for case in result['cases'])}),flush=True)
        finally:context.close()
    result['sourcesUnchanged']=all(fingerprint(path)==digest for path,digest in sources.items())
    result['assetsUnchanged']=all(fingerprint(path)==digest for path,digest in assets.items())
    result['status']='PASS' if all(case['status']=='PASS' for case in result['cases']) and result['sourcesUnchanged'] and result['assetsUnchanged'] and not result['httpRequests'] and not result['pageErrors'] else 'FAIL'
    (report/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['status','sourcesUnchanged','assetsUnchanged','httpRequests','pageErrors']}))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'FAIL','errorType':type(error).__name__}));raise SystemExit(1)
