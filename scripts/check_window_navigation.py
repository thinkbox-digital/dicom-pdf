#!/usr/bin/env python3
"""Verify stack scrubbing and file-provided display windows offline.

The scalar pixel oracle is independent of the viewer modules. Only aggregate
results and timings are reported; recovered originals/profiles stay in target/.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
import traceback

from pypdf import PdfReader
from playwright.sync_api import expect, sync_playwright

from check_direct_inputs import PROBE as INPUT_PROBE, wait_model
from check_extension import extension_identity, launch
from check_image_overlays import displayed_numbers, poll
from check_pane_inventory import download_selected, original_context
from check_scroll_performance import PROBE as SCROLL_PROBE, close_numbers, display_state, physical_order, select_source, summarize, wheel_pattern
from convert_archives import fingerprint
from sample_inventory import work_path


PROBE=r"""(() => {
  const p=globalThis.__windowProbe={capturePixels:false,main:null,pinned:null,draws:0,decodeDelay:0,delayedReplies:0,actions:[]};
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){
    const result=draw.apply(this,args),kind=this.canvas.closest?.('#viewport')?'main':this.canvas.closest?.('#comparison-viewport')?'pinned':null;
    if(kind&&p.capturePixels&&args[0] instanceof HTMLCanvasElement){
      const source=args[0],context=source.getContext('2d');
      if(source.width&&source.height&&context)p[kind]={width:source.width,height:source.height,rgba:Array.from(context.getImageData(0,0,source.width,source.height).data),draw:++p.draws};
    }
    return result;
  };
  const Original=globalThis.Worker;
  globalThis.Worker=class extends Original {
    addEventListener(type,listener,options){
      if(type!=='message'||!listener)return super.addEventListener(type,listener,options);
      this.__windowListeners??=new Map();
      let wrapped=this.__windowListeners.get(listener);
      if(!wrapped){wrapped=event=>{
        const invoke=()=>typeof listener==='function'?listener.call(this,event):listener.handleEvent(event);
        const delay=event.data?.type==='decoded'?p.decodeDelay:0;
        if(delay>0){p.delayedReplies++;setTimeout(invoke,delay);}else invoke();
      };this.__windowListeners.set(listener,wrapped);}
      return super.addEventListener(type,wrapped,options);
    }
    removeEventListener(type,listener,options){return super.removeEventListener(type,this.__windowListeners?.get(listener)||listener,options);}
  };
})();"""


def dicom_gray(stored,slope,intercept,window,invert=False):
    """PS3.3 C.11.2 scalar output, then Uint8Clamp and black compositing.

    LINEAR uses the half-unit center/width adjustment; LINEAR_EXACT has none.
    Python round implements the nearest-even conversion used by Uint8ClampedArray.
    """
    value=stored*slope+intercept;center=window['center'];width=window['width'];kind=window['function']
    if kind=='SIGMOID':
        exponent=-4*(value-center)/width
        gray=0 if exponent>709 else 255 if exponent< -709 else 255/(1+math.exp(exponent))
    elif kind=='LINEAR_EXACT':gray=255*min(1,max(0,(value-center)/width+0.5))
    else:
        low=center-0.5-(width-1)/2;high=center-0.5+(width-1)/2
        gray=0 if value<=low else 255 if value>high else 255*((value-center+0.5)/(width-1)+0.5)
    return int(round(max(0,min(255,255-gray if invert else gray))))


def oracle(frame,window):
    return [dicom_gray(value,frame['slope'],frame['intercept'],window,frame['invert']) for value in frame['storedPixels']]


def displayed_canvas(page,kind='main'):
    return poll(page,lambda:page.evaluate('(kind)=>__windowProbe[kind]',kind),'Rendered source canvas was not observed')


def assert_pixels(page,row,frame,window,kind='main'):
    source=displayed_canvas(page,kind)
    assert (source['width'],source['height'])==(row['columns'],row['rows']),'Renderer source canvas dimensions differ from the original matrix'
    rgba=source['rgba'];expected=oracle(frame,window)
    assert len(rgba)==4*len(expected),'Renderer source canvas has the wrong pixel count'
    # Stock Cornerstone uses white RGB with a grayscale alpha; the custom path
    # uses grayscale RGB with opaque alpha. Both are compared over black.
    mismatches=0;maximum=0
    for index,gray in enumerate(expected):
        for channel in range(3):
            actual=round(rgba[index*4+channel]*rgba[index*4+3]/255)
            difference=abs(actual-gray);maximum=max(maximum,difference)
            if difference:mismatches+=1
    assert mismatches==0,f'Independent window oracle mismatch: {mismatches} channels, maximum difference {maximum}'
    return len(expected)


def range_value(page,value,change=True):
    page.locator('#stack-position').evaluate('(element,request)=>{element.value=String(request.value);element.dispatchEvent(new Event("input",{bubbles:true}));if(request.change)element.dispatchEvent(new Event("change",{bubbles:true}));}',{'value':value,'change':change})


def current_source(page,entries,index,frame=1):
    expect(page.locator('#image-list')).to_have_value(str(index),timeout=30000)
    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment',entries[index]['attachment'],timeout=60000)
    expect(page.locator('#viewport')).to_have_attribute('data-source-frame',str(frame))
    expect(page.locator('#selected-source')).to_have_text(entries[index]['sourcePath'])
    expect(page.locator('#selected-source')).to_have_attribute('title',entries[index]['sourcePath'])
    expect(page.locator('#viewport')).to_have_attribute('aria-busy','false',timeout=30000)


def new_page(context,location,capture=False):
    page=context.new_page();page.set_viewport_size({'width':2524,'height':1100});page.goto(location,wait_until='domcontentloaded')
    page.evaluate('value=>__windowProbe.capturePixels=value',capture)
    return page


def ct_navigation(context,location,path,single_input,report):
    reader=PdfReader(path);manifest=json.loads(reader.attachments['manifest.json'][0]);entries=manifest['images']
    order=physical_order(entries,[index for index,entry in enumerate(entries) if entry.get('status')=='rendered']);assert len(order)==101
    page=new_page(context,location)
    try:
        page.evaluate('map=>__scrollProbe.map=map',{hashlib.sha256(entry['attachment'].encode()).hexdigest():f'source-{index+1:03}' for index,entry in enumerate(entries)})
        page.locator('#pdf-file').set_input_files(path);expect(page.locator('#stack-position-control')).to_be_visible(timeout=60000)
        expect(page.locator('#stack-position')).to_have_attribute('max','101')
        for position in [1,51,101]:
            range_value(page,position);index=order[position-1];current_source(page,entries,index)
            expect(page.locator('#stack-position')).to_have_value(str(position));expect(page.locator('#stack-position')).to_have_attribute('aria-valuetext',f'Image {position} of 101')
            expect(page.locator('#stack-position-label')).to_have_text(f'{position} of 101');original_context(page,entries[index])
            page.locator('#show-pdf').click();expect(page.locator('#page-number')).to_have_value(str(entries[index]['referencePage']))
            page.locator('#show-image').click();current_source(page,entries,index)
        slider=page.locator('#stack-position');slider.focus();slider.press('Home');current_source(page,entries,order[0])
        slider.focus();slider.press('ArrowRight');current_source(page,entries,order[1]);expect(slider).to_have_value('2')
        range_value(page,51);current_source(page,entries,order[50])
        for identifier,value in [('brightness',25),('contrast',170)]:
            page.locator('#'+identifier).evaluate('(element,value)=>{element.value=String(value);element.dispatchEvent(new Event("input",{bubbles:true}));}',value)
        page.locator('#zoom-in').click();page.locator('#rotate-right').click();page.locator('#invert').click()
        box=page.locator('#viewport').bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
        page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+45,y+25,steps=4);page.mouse.up();page.wait_for_timeout(100)
        before=display_state(page)
        range_value(page,61);current_source(page,entries,order[60]);range_value(page,51);current_source(page,entries,order[50]);page.wait_for_timeout(100)
        assert close_numbers(before,display_state(page)),'Stack scrub resets camera or display adjustments'
        page.evaluate('__scrollProbe.begin()');wheel_pattern(page,[1]*6+[-1]*6,70);page.wait_for_timeout(350)
        performance=summarize(page.evaluate('__scrollProbe.end()'))
        assert performance['acceptedWheels']==12 and performance['commitCount']==12 and performance['staleCommits']==0,'Stack controls regress wheel reversal'
        assert not performance['blankAnimationFrames'] and not performance['blackCanvasSamples'],'Stack controls cause visible blank wheel frames'
        assert close_numbers(before,display_state(page)),'Wheel reversal resets the scrubbed display pose'
        expect(slider).to_have_value('51')
        # Delay real worker decoded replies so multiple requests overlap while
        # the UI uses the same actual cancellation and latest-target path.
        page.evaluate('__windowProbe.decodeDelay=180;__windowProbe.actions=[];__scrollProbe.begin()')
        page.evaluate("()=>[10,80,20,90].forEach((position,index)=>setTimeout(()=>{const slider=document.querySelector('#stack-position');__windowProbe.actions.push({disabled:slider.disabled});slider.value=String(position);slider.dispatchEvent(new Event('input',{bubbles:true}));},index*20))")
        current_source(page,entries,order[89]);page.wait_for_timeout(250)
        pending=page.evaluate('({delayed:__windowProbe.delayedReplies,actions:__windowProbe.actions,events:__scrollProbe.end()})')
        assert pending['delayed']>0,'Pending-decode cancellation was not exercised'
        assert all(not action['disabled'] for action in pending['actions']),'Stack slider is disabled while users scrub'
        commits=[event for event in pending['events']['events'] if event['type']=='commit']
        final_alias=f'source-{order[89]+1:03}'
        assert commits and all(event.get('sourceID')==final_alias for event in commits),'A superseded scrub committed an obsolete source'
        # A mode switch cancels an in-progress scrub while PDF mapping continues
        # to follow the requested original; returning opens that mapped original.
        page.evaluate('__windowProbe.decodeDelay=250');range_value(page,35)
        expect(page.locator('#viewport')).to_have_attribute('aria-busy','true')
        page.locator('#show-pdf').click();expect(page.locator('#page-number')).to_have_value(str(entries[order[34]]['referencePage']))
        page.wait_for_timeout(550);expect(page.locator('#image-overlays')).not_to_be_visible()
        page.evaluate('__windowProbe.decodeDelay=0');page.locator('#show-image').click();current_source(page,entries,order[34])
        expect(slider).to_have_value('35');original_context(page,entries[order[34]])
        download_selected(page,entries[order[34]],reader.attachments[entries[order[34]]['attachment']][0],report/'ct-original.dcm')
        page.evaluate('__windowProbe.decodeDelay=250');range_value(page,76)
        expect(page.locator('#viewport')).to_have_attribute('aria-busy','true')
        page.locator('#dicom-files').set_input_files(single_input);model=wait_model(page);assert len(model['entries'])==1
        current_source(page,model['entries'],0);page.wait_for_timeout(600);current_source(page,model['entries'],0)
        expect(page.locator('#stack-position-control')).not_to_be_visible()
        return {'case':'ct-stack-navigation','status':'PASS','physicalPositionsChecked':3,'keyboardNavigation':True,'poseAndInfoPreserved':True,
            'coalescedLatestRequestWins':True,'pdfSwitchWhilePending':True,'sourceChangeCancelsPending':True,
            'onePositionSliderHidden':True,'originalsByteIdentical':1,'wheel':performance}
    finally:page.close()


def window_menu(page,frame,color=False):
    presets=[] if color else frame['sourceWindowPresets']['presets'];values=['initial']+[f'source:{item["index"]}' for item in presets]
    assert page.locator('#window-preset option').evaluate_all('options=>options.map(option=>option.value)')==values,'Source window menu changed multiplicity indices or invented presets'
    baseline=frame['baselineWindow'];hidden=color or not any(any(preset[key]!=baseline[key] for key in ['center','width','function']) for preset in presets)
    if hidden:expect(page.locator('#window-preset-control')).not_to_be_visible()
    else:expect(page.locator('#window-preset-control')).to_be_visible()
    for preset in presets:
        text=page.locator(f'#window-preset option[value="source:{preset["index"]}"]').text_content()
        assert 'WL ' in text and 'WW ' in text,'A file window lacks its numeric source parameters'
        if preset.get('label') and len(preset['label'])<25:assert preset['label'] in text,'A file-provided window label was discarded'
    return hidden


def choose_window(page,value,window):
    page.locator('#window-preset').select_option(value);page.wait_for_timeout(70)
    expect(page.locator('#viewport')).to_have_attribute('data-window-preset',value)
    expect(page.locator('#viewport')).to_have_attribute('data-window-function',window['function'])
    expect(page.locator('#brightness')).to_have_value('0');expect(page.locator('#contrast')).to_have_value('100')
    shown=displayed_numbers(page)
    assert abs(shown['center']-window['center'])<0.0011 and abs(shown['width']-window['width'])<0.0011,'Info reports the renderer surrogate rather than the actual logical window'


def thumbnail_oracle(page,index,row,frame):
    canvas=page.locator(f'.series-card[data-source-index="{index}"] .series-thumbnail canvas')
    card=page.locator(f'.series-card[data-source-index="{index}"]')
    if not card.count():return False
    card.scroll_into_view_if_needed();expect(canvas).to_have_count(1,timeout=15000)
    data=canvas.evaluate('canvas=>({width:canvas.width,height:canvas.height,rgba:Array.from(canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data)})')
    full=oracle(frame,frame['baselineWindow'])
    expected=[]
    for y in range(data['height']):
        for x in range(data['width']):
            expected.append(full[min(row['rows']-1,y*row['rows']//data['height'])*row['columns']+min(row['columns']-1,x*row['columns']//data['width'])])
    assert all(data['rgba'][4*index:4*index+4]==[gray,gray,gray,255] for index,gray in enumerate(expected)),'Source thumbnail does not match independent baseline VOI oracle'
    return True


def pin_window(page,entry,row,frame,window,report):
    page.locator('#compare-current').click();expect(page.locator('#comparison-viewport')).to_have_attribute('data-loaded-attachment',entry['attachment'],timeout=30000)
    page.wait_for_timeout(100);pixels=assert_pixels(page,row,frame,window,'pinned')
    page.locator('#comparison-reset').click();page.wait_for_timeout(80);assert_pixels(page,row,frame,frame['baselineWindow'],'pinned')
    with page.expect_download() as event:page.locator('#comparison-save').click()
    destination=report/'pinned-original.dcm';event.value.save_as(destination)
    assert fingerprint(destination)==entry['sha256'],'Pinned source bytes changed after selecting a window'
    page.locator('#close-comparison').click();return pixels


def synthetic_windows(context,location,inputs,golden,report):
    page=new_page(context,location,True);paths=[inputs/name for name in golden['files']]
    try:
        page.locator('#dicom-files').set_input_files(paths);model=wait_model(page);entries=model['entries']
        assert len(entries)==len(paths)
        frames_checked=0;windows_checked=0;pixel_checks=0;thumbnails=0;recovered=0;pinned=False;multiframe=False;functions=set()
        for name,row in golden['files'].items():
            # A flat multiple-file picker exposes File.name, while directory
            # input retains relative paths. The fixture basenames are unique.
            index=next(index for index,entry in enumerate(entries) if entry['sourcePath'] in {name,Path(name).name});entry=entries[index]
            select_source(page,index,entry)
            color=row['samplesPerPixel']>1
            for frame in row['frames']:
                number=frame['frame']
                if number>1:range_value(page,number);current_source(page,entries,index,number);page.wait_for_timeout(80)
                hidden=window_menu(page,frame,color);frames_checked+=1
                if row['frameCount']>1:
                    expect(page.locator('#stack-position-control')).to_be_visible();expect(page.locator('#stack-position')).to_have_value(str(number))
                    expect(page.locator('#stack-position')).to_have_attribute('aria-valuetext',f'Frame {number} of {row["frameCount"]}')
                elif '/stack/' not in '/'+name:
                    expect(page.locator('#stack-position-control')).not_to_be_visible()
                if color:continue
                # Each frame's baseline must be tested before alternate choices;
                # resets explicitly restore source/PDF initial display identity.
                page.locator('#reset').click();page.wait_for_timeout(80)
                expect(page.locator('#window-preset')).to_have_value('initial')
                pixel_checks+=assert_pixels(page,row,frame,frame['baselineWindow']);windows_checked+=1;functions.add(frame['baselineWindow']['function'])
                if number==1:thumbnails+=thumbnail_oracle(page,index,row,frame)
                if not hidden:
                    for preset in frame['sourceWindowPresets']['presets']:
                        value=f'source:{preset["index"]}';choose_window(page,value,preset)
                        pixel_checks+=assert_pixels(page,row,frame,preset);windows_checked+=1;functions.add(preset['function'])
                        if not pinned and preset['function']!='LINEAR':
                            pixel_checks+=pin_window(page,entry,row,frame,preset,report);pinned=True
                        # Exercise sub-unit windows with manual adjustments. The
                        # logical width must stay fractional for exact/sigmoid.
                        if preset['width']<1:
                            page.locator('#contrast').evaluate('element=>{element.value="200";element.dispatchEvent(new Event("input",{bubbles:true}));}')
                            page.wait_for_timeout(70);adjusted={**preset,'width':preset['width']/2}
                            shown=displayed_numbers(page);assert abs(shown['width']-adjusted['width'])<0.0011
                            pixel_checks+=assert_pixels(page,row,frame,adjusted);windows_checked+=1
                    page.locator('#reset').click();page.wait_for_timeout(70);assert_pixels(page,row,frame,frame['baselineWindow'])
            if row['frameCount']>1 and not multiframe:
                range_value(page,1);current_source(page,entries,index,1)
                page.locator('#window-preset').select_option('source:1');page.wait_for_timeout(70)
                range_value(page,2);current_source(page,entries,index,2);expect(page.locator('#window-preset')).to_have_value('source:1')
                frame=row['frames'][1];preset=next(item for item in frame['sourceWindowPresets']['presets'] if item['index']==1)
                pixel_checks+=assert_pixels(page,row,frame,preset)
                page.locator('#cine-fps').fill('2');page.locator('#cine-fps').press('Tab');page.locator('#cine-play').click()
                poll(page,lambda:page.locator('#frame-number').input_value()=='1','Cine did not advance to another frame')
                page.locator('#cine-play').click();page.wait_for_timeout(100)
                current=int(page.locator('#frame-number').input_value());expect(page.locator('#stack-position')).to_have_value(str(current))
                expect(page.locator('#stack-position')).to_have_attribute('aria-valuetext',f'Frame {current} of {row["frameCount"]}')
                page.wait_for_timeout(600);expect(page.locator('#frame-number')).to_have_value(str(current));multiframe=True
            download_selected(page,entry,(inputs/name).read_bytes(),report/f'original-{recovered+1:02}.dcm');recovered+=1
        assert functions=={'LINEAR','LINEAR_EXACT','SIGMOID'} and pinned and multiframe
        return {'case':'synthetic-windows','status':'PASS','files':len(paths),'framesChecked':frames_checked,'windowsChecked':windows_checked,
            'oraclePixelsCompared':pixel_checks,'baselineThumbnailsChecked':thumbnails,'voiFunctionsChecked':len(functions),
            'subUnitAndNegativeFractionalRescale':True,'sourceLabelsAndIndicesPreserved':True,'malformedAndColorMenusHidden':True,
            'mainAndPinnedSamePreset':True,'resetsRestoreInitialDisplay':True,'multiframePresetAndCineSliderSync':True,'originalsByteIdentical':recovered+1}
    finally:page.close()


def pdf_baseline(context,location,path,golden,report):
    reader=PdfReader(path);manifest=json.loads(reader.attachments['manifest.json'][0]);entries=manifest['images']
    page=new_page(context,location,True)
    try:
        page.locator('#pdf-file').set_input_files(path);expect(page.locator('#image-list option')).to_have_count(len(entries),timeout=30000)
        pixel_checks=0;resets=0;recovered=0;historical=0
        for index,entry in enumerate(entries):
            row=golden['files'][entry['sourcePath']];frame=row['frames'][0]
            select_source(page,index,entry);current_source(page,entries,index,entry.get('sourceFrame') or 1)
            if entry['status']!='rendered':historical+=1
            if row['samplesPerPixel']==1:
                recipe=entry.get('displayAdjustments',{})
                baseline={'center':float(recipe['windowCenter']),'width':float(recipe['windowWidth']),'function':recipe['voiLUTFunction']} if entry['status']=='rendered' else frame['baselineWindow']
                pixel_checks+=assert_pixels(page,row,frame,baseline)
                if page.locator('#window-preset-control').is_visible():
                    alternate=next((preset for preset in frame['sourceWindowPresets']['presets'] if any(preset[key]!=baseline[key]for key in ['center','width','function'])),None)
                    if alternate:
                        choose_window(page,f'source:{alternate["index"]}',alternate);pixel_checks+=assert_pixels(page,row,frame,alternate)
                page.locator('#reset').click();page.wait_for_timeout(70)
                expect(page.locator('#window-preset')).to_have_value('initial')
                pixel_checks+=assert_pixels(page,row,frame,baseline);resets+=1
            page.locator('#show-pdf').click();expect(page.locator('#page-number')).to_have_value(str(entry['referencePage']))
            page.locator('#show-image').click();current_source(page,entries,index,entry.get('sourceFrame') or 1)
            download_selected(page,entry,reader.attachments[entry['attachment']][0],report/f'pdf-original-{recovered+1:02}.dcm');recovered+=1
        return {'case':'preservation-pdf-baselines','status':'PASS','suppliedOriginals':len(entries),'historicalPreviewRejectionsStillViewable':historical,
            'referencePagesTracked':len(entries),'initialDisplayResetsChecked':resets,'oraclePixelsCompared':pixel_checks,
            'originalsByteIdentical':recovered}
    finally:page.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf',type=Path,default=Path('out/ct-abdomen-c4kc-kits-series.pdf'))
    parser.add_argument('--inputs',type=Path,default=Path('target/window-inputs'))
    parser.add_argument('--expectations',type=Path,default=Path('target/window-fixtures/expectations.json'))
    parser.add_argument('--window-pdf',type=Path,default=Path('target/viewer-test-pdfs/synthetic-windows.pdf'))
    parser.add_argument('--extension',type=Path,default=Path('target/chrome-extension'))
    parser.add_argument('--chromium',default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    args=parser.parse_args();project=Path(__file__).resolve().parents[1]
    report=project/'target/window-navigation-checks';work_path(report,'.');report.mkdir(parents=True,exist_ok=True)
    golden=json.loads(args.expectations.read_text());assert golden['synthetic'] is True
    inputs=args.inputs.resolve(strict=True);sources={inputs/name:row['sha256'] for name,row in golden['files'].items()}
    sources[args.pdf.resolve(strict=True)]=fingerprint(args.pdf)
    sources[args.window_pdf.resolve(strict=True)]=fingerprint(args.window_pdf)
    assert all(fingerprint(path)==digest for path,digest in sources.items())
    extension=args.extension.resolve(strict=True);assets={extension/name:fingerprint(extension/name) for name in ['viewer.js','viewer.html','viewer.css']}
    result={'httpRequests':0,'pageErrors':0,'cases':[]}
    with sync_playwright() as playwright,tempfile.TemporaryDirectory(prefix='profile-',dir=report) as profile:
        context=launch(playwright,args.chromium,extension,profile)
        try:
            context.set_offline(True);context.add_init_script(SCROLL_PROBE+'\n'+INPUT_PROBE+'\n'+PROBE)
            context.on('request',lambda request:result.__setitem__('httpRequests',result['httpRequests']+1) if request.url.startswith(('http:','https:')) else None)
            context.on('weberror',lambda error:result.__setitem__('pageErrors',result['pageErrors']+1))
            location=f'chrome-extension://{extension_identity(context)}/viewer.html'
            single=inputs/next(iter(golden['files']))
            for label,run in [('ct',lambda:ct_navigation(context,location,args.pdf,single,report)),('windows',lambda:synthetic_windows(context,location,inputs,golden,report)),
                    ('pdf-baselines',lambda:pdf_baseline(context,location,args.window_pdf,golden,report))]:
                try:result['cases'].append(run())
                except Exception as error:
                    result['cases'].append({'case':label,'status':'FAIL','errorType':type(error).__name__,
                        'checks':[{'function':frame.name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if frame.filename.endswith('check_window_navigation.py')]})
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
