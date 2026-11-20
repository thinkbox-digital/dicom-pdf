import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompareView} from '../compare-view.mjs';
import {createDecoderClient} from '../decoder-client.mjs';
import {createDecoderWorkerRuntime} from '../dicom-worker.mjs';

const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function until(predicate){for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,0));assert.ok(predicate(),'Expected comparison state.');}
class Element{
  listeners=new Map();attributes=new Map();dataset={};disabled=false;hidden=false;value='';textContent='';title='';clientWidth=640;clientHeight=360;focusCalls=0;
  constructor(){const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)};}
  addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(handler);}
  removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);}
  setAttribute(name,value){this.attributes.set(name,value);}
  getAttribute(name){return this.attributes.get(name)??null;}
  focus(){this.focusCalls++;}
  matches(){return false;}
  setPointerCapture(){}
  dispatch(type,values={}){
    const event={target:this,button:0,pointerId:1,pointerType:'mouse',clientX:0,clientY:0,timeStamp:Date.now(),
      ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...values};
    for(const listener of this.listeners.get(type)||[])listener(event);return event;
  }
}
async function source(value=17,name='SET/synthetic-original.dcm'){
  const bytes=new Uint8Array([value,2,3,255]);return {bytes,entry:{attachment:'input-'+value,sourcePath:name,size:bytes.length,sha256:await sha(bytes),sopInstanceUID:'2.25.1'}};
}
function imageResult(bytes,id,frame,{invert=false}={}){
  const pixels=new Uint16Array([bytes[0],frame]);return {image:{imageId:id,rows:1,columns:2,numberOfComponents:1,windowCenter:128,windowWidth:256,invert,getPixelData:()=>pixels},
    frameCount:3,sourceFrame:frame,sopInstanceUID:'2.25.1',metadata:{transferSyntax:{transferSyntaxUID:'1.2.840.10008.1.2.1'}}};
}
function harness({decode=(bytes,id,recipe,frame)=>imageResult(bytes,id,frame),stack,decoderClient=null,camera=false}={}){
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  $('comparison-pane').hidden=true;$('comparison-brightness').value='0';$('comparison-contrast').value='100';
  const saved=[],released=[],changes=[],calls=[],viewports=[],enabled=[],disabled=[];let clears=0,destroys=0,resizeCalls=0;
  const decoder={decode:async(...args)=>{
    calls.push(args);if(await sha(args[0])!==args[4].key){const error=new Error('Test worker registration refused');error.code='CHECKSUM_MISMATCH';throw error;}return decode(...args);
  },clear:()=>{clears++;},destroy:()=>{destroys++;}};
  const engine={enableElement:options=>{
    enabled.push(options);const state={rotation:0,invert:false,zoom:1,pan:[0,0],renders:0,stack:[],properties:{},focalPoint:[100,60,0],position:[100,60,100],cameraWrites:[]};
    const viewport={state,getRotation:()=>state.rotation,setRotation:value=>{state.rotation=value;},getProperties:()=>({...state.properties,invert:state.invert}),
      setProperties:value=>{state.properties={...state.properties,...value};if('invert' in value)state.invert=value.invert;},
      getZoom:()=>state.zoom,setZoom:value=>{state.zoom=value;},getPan:()=>[...state.pan],setPan:value=>{state.pan=[...value];},
      resetCamera:()=>{state.zoom=1;state.pan=[0,0];},render:()=>{state.renders++;},setStack:async ids=>{if(stack)await stack(ids);state.stack=[...ids];}};
    if(camera){
      viewport.getPan=()=>assert.fail('Comparison must not restore CPU translation through getPan/setPan.');
      viewport.setPan=()=>assert.fail('Comparison must not restore CPU translation through getPan/setPan.');
      viewport.getCamera=()=>({focalPoint:[...state.focalPoint],position:[...state.position],scale:state.zoom,parallelScale:180/state.zoom});
      viewport.setCamera=value=>{
        state.cameraWrites.push(structuredClone(value));
        if(value.scale)state.zoom=value.scale;else if(value.parallelScale)state.zoom=180/value.parallelScale;
        if(value.focalPoint)state.focalPoint=[...value.focalPoint];if(value.position)state.position=[...value.position];
      };
      viewport.resetCamera=()=>{state.zoom=1;state.pan=[0,0];state.focalPoint=[100,60,0];state.position=[100,60,100];};
      viewport.canvasToWorld=point=>{
        const angle=state.rotation*Math.PI/180,dx=(point[0]-320)/state.zoom,dy=(point[1]-180)/state.zoom;
        return [state.focalPoint[0]+Math.cos(angle)*dx+Math.sin(angle)*dy,state.focalPoint[1]-Math.sin(angle)*dx+Math.cos(angle)*dy,state.focalPoint[2]];
      };
    }
    viewports.push(viewport);
  },getViewport:()=>viewports.at(-1),disableElement:id=>disabled.push(id),resize:()=>{resizeCalls++;}};
  const controller=createCompareView({engine,root:{getElementById:$},decoderFactory:()=>decoderClient||decoder,onChange:state=>changes.push(state),
    releaseImage:id=>released.push(id),saveFile:async(bytes,name)=>saved.push({bytes,name})});
  return {controller,$,elements,saved,released,changes,calls,viewports,enabled,disabled,get clears(){return clears;},get destroys(){return destroys;},get resizeCalls(){return resizeCalls;}};
}

const renderedRgba=new WeakMap();

test('pinned series/date context stays with the original snapshot through frame and caller changes',async()=>{
  const h=harness(),input=await source();
  input.entry.fields={SeriesNumber:'3',SeriesDescription:'Synthetic comparison',StudyDate:'20261115',PatientName:'Do not display'};
  const expected='Series 3 · Synthetic comparison · Study 15 Nov 2026';
  try{
    assert.equal(await h.controller.pin(input),true);
    assert.equal(h.$('comparison-context').textContent,expected);assert.equal(h.$('comparison-context').hidden,false);
    input.entry.fields.SeriesDescription='Different exam';input.entry.fields.StudyDate='20260101';
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.equal(h.$('comparison-context').textContent,expected);assert.equal(h.$('comparison-context').title,expected);
    h.controller.close();assert.equal(h.$('comparison-context').textContent,'');assert.equal(h.$('comparison-context').hidden,true);
  }finally{h.controller.destroy();}
});

test('empty or invalid context is hidden when replacing a previously labeled pinned original',async()=>{
  const h=harness(),first=await source();first.entry.fields={SeriesDescription:'Prior source'};
  try{
    assert.equal(await h.controller.pin(first),true);assert.equal(h.$('comparison-context').hidden,false);
    const next=await source(18);next.entry.fields={StudyDate:'invalid',SeriesNumber:'unknown'};
    assert.equal(await h.controller.pin(next),true);
    assert.equal(h.$('comparison-context').textContent,'');assert.equal(h.$('comparison-context').title,'');
    assert.equal(h.$('comparison-context').hidden,true);
  }finally{h.controller.destroy();}
});

function renderedGray(image){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  const target={setTransform(){},fillRect(){},drawImage(){}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:tag=>{
    assert.equal(tag,'canvas');return {getContext:()=>({createImageData:(width,height)=>({data:new Uint8ClampedArray(width*height*4)}),
      putImageData:data=>{renderedRgba.set(image,new Uint8ClampedArray(data.data));}})};
  }}});
  try{
    assert.equal(typeof image.render,'function','The selected nonlinear source function needs a public image render hook.');
    image.render({image,viewport:{invert:false},canvas:{width:640,height:360,getContext:()=>target},transform:{getMatrix:()=>[1,0,0,1,0,0]}});
    const rgba=renderedRgba.get(image);
    assert.ok(rgba,'The public image renderer must produce display pixels.');
    return Array.from(rgba).filter((_value,index)=>index%4===0);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
}

test('pin applies the source preset and manual adjustments once, then resolves that index from the new frame',async()=>{
  const results=new Map(),snapshots=new Map(),h=harness({decode:(bytes,id,recipe,frame)=>{
    const result=imageResult(bytes,id,frame),pixels=new Int16Array([-1,0,1]);
    Object.assign(result.image,{rows:1,columns:3,color:false,minPixelValue:-1,maxPixelValue:1,slope:0.125,intercept:0,
      windowCenter:10+frame,windowWidth:100+frame,voiLUTFunction:'LINEAR',getPixelData:()=>pixels});
    result.sourceWindowPresets={presets:[{index:0,center:1,width:10,function:'LINEAR'},
      frame===1?{index:1,center:80,width:160,function:'LINEAR',label:'First frame source'}
        :{index:1,center:2,width:8,function:'SIGMOID',label:'Next frame source'}]};
    results.set(frame,result);snapshots.set(frame,{pixels:pixels.slice(),center:result.image.windowCenter,width:result.image.windowWidth,
      function:result.image.voiLUTFunction,presets:structuredClone(result.sourceWindowPresets)});return result;
  }}),input=await source(),original=input.bytes.slice();
  try{
    assert.equal(await h.controller.pin({...input,display:{windowPreset:'source:1',brightness:25,contrast:200}}),true);
    const state=h.viewports[0].state;
    assert.equal(h.$('comparison-brightness').value,'25');assert.equal(h.$('comparison-contrast').value,'200');
    // Source C80/W160 with B25/C200 gives C40/W80, rather than applying B/C twice.
    assert.deepEqual(state.properties.voiRange,{lower:0,upper:79});
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    // New frame's source:1 is C2/W8 SIGMOID: the retained controls give C0/W4.
    assert.deepEqual(state.properties.voiRange,{lower:-2,upper:1});
    const active=h.controller.getDecoded(state.stack[0]);assert.equal(active,results.get(2));
    assert.deepEqual(renderedGray(active.image),[120,128,135],'Source SIGMOID must survive comparison/frame selection.');
    for(const [frame,result] of results){
      const snapshot=snapshots.get(frame);assert.deepEqual(result.image.getPixelData(),snapshot.pixels);
      assert.equal(result.image.windowCenter,snapshot.center);assert.equal(result.image.windowWidth,snapshot.width);assert.equal(result.image.voiLUTFunction,snapshot.function);
      assert.deepEqual(result.sourceWindowPresets,snapshot.presets);
    }
    assert.deepEqual(input.bytes,original);h.$('comparison-save').dispatch('click');await until(()=>h.saved.length===1);assert.deepEqual(h.saved[0].bytes,original);
  }finally{h.controller.destroy();}
});

test('fractional source windows remain logical half-width and Reset restores the baseline preset across frames',async()=>{
  const results=new Map(),h=harness({decode:(bytes,id,recipe,frame)=>{
    const result=imageResult(bytes,id,frame),pixels=new Int16Array([-1,0,1]);
    Object.assign(result.image,{rows:1,columns:3,color:false,minPixelValue:-1,maxPixelValue:1,slope:0.125,intercept:0,
      windowCenter:10+frame,windowWidth:100+frame,voiLUTFunction:'LINEAR',getPixelData:()=>pixels});
    result.sourceWindowPresets={presets:[{index:1,center:0,width:0.5,function:'LINEAR_EXACT',label:'Supplied fractional display'}]};
    results.set(frame,result);return result;
  }});
  try{
    assert.equal(await h.controller.pin({...await source(),display:{windowPreset:'source:1',brightness:0,contrast:100}}),true);
    const state=h.viewports[0].state,first=h.controller.getDecoded(state.stack[0]);
    // Cornerstone gets width1's valid surrogate while the public renderer keeps exact width0.5.
    assert.deepEqual(state.properties.voiRange,{lower:-0.5,upper:-0.5});assert.deepEqual(renderedGray(first.image),[64,128,191]);
    assert.equal(first.image.windowCenter,11);assert.equal(first.image.windowWidth,101);assert.equal(first.image.voiLUTFunction,'LINEAR');
    h.$('comparison-brightness').value='25';h.$('comparison-brightness').dispatch('input');h.$('comparison-contrast').value='200';h.$('comparison-contrast').dispatch('input');
    assert.deepEqual(state.properties.voiRange,{lower:-0.625,upper:-0.625});assert.deepEqual(renderedGray(first.image),[128,255,255]);
    h.$('comparison-reset').dispatch('click');assert.equal(h.$('comparison-brightness').value,'0');assert.equal(h.$('comparison-contrast').value,'100');
    assert.deepEqual(state.properties.voiRange,{lower:-39.5,upper:60.5});assert.equal(first.image.render,undefined);
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.deepEqual(state.properties.voiRange,{lower:-39,upper:62});
    const second=h.controller.getDecoded(state.stack[0]);assert.equal(second.image.render,undefined,'Reset must retain initial rather than the fractional preset key.');
    for(const [frame,result] of results){assert.deepEqual([...result.image.getPixelData()],[-1,0,1]);assert.equal(result.image.windowCenter,10+frame);assert.equal(result.image.windowWidth,100+frame);assert.equal(result.image.voiLUTFunction,'LINEAR');}
  }finally{h.controller.destroy();}
});

test('legacy sources without preset metadata keep initial display and ignore a missing source key',async()=>{
  const h=harness(),input=await source(),original=input.bytes.slice();
  try{
    assert.equal(await h.controller.pin({...input,display:{windowPreset:'source:1',brightness:25,contrast:200}}),true);
    const state=h.viewports[0].state;assert.deepEqual(state.properties.voiRange,{lower:0,upper:127});
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.deepEqual(state.properties.voiRange,{lower:0,upper:127});
    const active=h.controller.getDecoded(state.stack[0]);assert.equal(active.sourceWindowPresets,undefined);
    assert.equal(active.image.windowCenter,128);assert.equal(active.image.windowWidth,256);assert.equal(active.image.voiLUTFunction,undefined);
    assert.deepEqual([...active.image.getPixelData()],[input.bytes[0],2]);
    h.$('comparison-reset').dispatch('click');assert.deepEqual(state.properties.voiRange,{lower:0,upper:255});
    assert.deepEqual(input.bytes,original);
  }finally{h.controller.destroy();}
});

test('pin keeps a checksum-verified source snapshot and identity independently of caller changes',async()=>{
  const h=harness(),input=await source(),expected=input.bytes.slice();
  try{
    const pin=h.controller.pin(input);input.bytes.fill(0);input.entry.sourcePath='changed-after-pin';input.entry.sopInstanceUID='2.25.999';
    assert.equal(await pin,true);assert.equal(h.controller.isOpen,true);assert.equal(h.$('comparison-pane').hidden,false);
    assert.equal(h.$('comparison-source').textContent,'SET/synthetic-original.dcm');assert.equal(h.$('comparison-viewport').dataset.sopInstanceUid,'2.25.1');
    assert.equal(h.$('comparison-viewport').dataset.sha256,await sha(expected));assert.deepEqual(h.calls[0][0],expected);
    assert.equal(h.enabled[0].type,'stack');assert.ok(h.$('image-comparison-layout').classList.contains('has-comparison'));
    h.$('comparison-save').dispatch('click');await until(()=>h.saved.length===1);
    assert.deepEqual(h.saved[0].bytes,expected);assert.equal(h.saved[0].name,'synthetic-original.dcm');
    assert.equal(h.$('comparison-viewport').dataset.sourceFrame,'1');assert.match(h.$('comparison-status').textContent,/pinned original unchanged/);
  }finally{h.controller.destroy();}
});

test('display snapshot mirrors the initial main view and Reset restores source polarity/window/camera',async()=>{
  const h=harness({decode:(bytes,id,recipe,frame)=>imageResult(bytes,id,frame,{invert:true})});
  try{
    assert.equal(await h.controller.pin({...await source(),display:{brightness:35,contrast:180,rotation:90,inverted:true,zoom:2,pan:[12,-7]}}),true);
    const state=h.viewports[0].state;
    assert.equal(state.rotation,90);assert.equal(state.invert,false);assert.equal(state.zoom,2);assert.deepEqual(state.pan,[12,-7]);
    assert.equal(h.$('comparison-brightness').value,'35');assert.equal(h.$('comparison-contrast').value,'180');assert.equal(h.$('comparison-invert').getAttribute('aria-pressed'),'true');
    h.$('comparison-reset').dispatch('click');assert.equal(state.rotation,0);assert.equal(state.invert,true);assert.equal(state.zoom,1);assert.deepEqual(state.pan,[0,0]);
    assert.equal(h.$('comparison-brightness').value,'0');assert.equal(h.$('comparison-contrast').value,'100');
    assert.deepEqual(state.properties.voiRange,{lower:0,upper:255});assert.equal(h.$('comparison-invert').getAttribute('aria-pressed'),'false');
  }finally{h.controller.destroy();}
});

test('comparison restores public camera scale before focal point and retains the camera across frames',async()=>{
  const h=harness({camera:true}),camera={focalPoint:[99,-25,2],position:[99,-25,102],scale:2.5,parallelScale:999};
  try{
    await h.controller.pin({...await source(),display:{camera,rotation:90,brightness:15,contrast:140,zoom:7,pan:[9000,9000]}});
    const state=h.viewports[0].state;
    assert.equal(state.zoom,2.5);assert.deepEqual(state.focalPoint,camera.focalPoint);assert.deepEqual(state.position,camera.position);assert.equal(state.rotation,90);
    assert.deepEqual(state.cameraWrites.slice(-2),[{scale:2.5},{focalPoint:camera.focalPoint,position:camera.position}]);
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.equal(state.zoom,2.5);assert.deepEqual(state.focalPoint,camera.focalPoint);assert.deepEqual(state.position,camera.position);assert.equal(state.rotation,90);
    assert.equal(h.$('comparison-brightness').value,'15');assert.equal(h.$('comparison-contrast').value,'140');
    assert.deepEqual(state.cameraWrites.slice(-2),[{scale:2.5},{focalPoint:camera.focalPoint,position:camera.position}]);
    h.$('comparison-reset').dispatch('click');assert.equal(state.zoom,1);assert.deepEqual(state.focalPoint,[100,60,0]);assert.equal(state.rotation,0);
  }finally{h.controller.destroy();}
});

test('comparison supports parallelScale cameras and exposes camera APIs to shared pan controls',async()=>{
  const h=harness({camera:true});try{
    await h.controller.pin({...await source(),display:{camera:{focalPoint:[90,45,0],parallelScale:15},rotation:90,zoom:7,pan:[9999,9999]}});
    const state=h.viewports[0].state;assert.equal(state.zoom,12);assert.deepEqual(state.focalPoint,[90,45,0]);
    assert.deepEqual(state.cameraWrites.slice(-2),[{parallelScale:15},{focalPoint:[90,45,0]}]);
    const before=[...state.focalPoint];h.$('comparison-viewport').dispatch('keydown',{key:'ArrowRight',shiftKey:true});
    assert.ok(Math.abs(state.focalPoint[0]-before[0])<1e-8);assert.ok(Math.abs(state.focalPoint[1]-before[1]-2.5)<1e-8);
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.equal(state.zoom,12);assert.ok(Math.abs(state.focalPoint[1]-before[1]-2.5)<1e-8);
  }finally{h.controller.destroy();}
});

test('buttons and keyboard controls change only the comparison viewport',async()=>{
  const h=harness();try{
    await h.controller.pin(await source());const state=h.viewports[0].state;
    h.$('comparison-rotate-right').dispatch('click');h.$('comparison-invert').dispatch('click');h.$('comparison-zoom-in').dispatch('click');
    assert.equal(state.rotation,90);assert.equal(state.invert,true);assert.equal(state.zoom,1.25);
    h.$('comparison-viewport').dispatch('keydown',{key:'ArrowRight',shiftKey:true});h.$('comparison-viewport').dispatch('keydown',{key:'ArrowDown',shiftKey:true});
    assert.deepEqual(state.pan,[30,30]);
    h.$('comparison-fit').dispatch('click');assert.equal(state.zoom,1);assert.deepEqual(state.pan,[0,0]);assert.equal(state.rotation,90);
    h.$('comparison-brightness').value='20';h.$('comparison-brightness').dispatch('input');assert.notDeepEqual(state.properties.voiRange,{lower:0,upper:255});
    h.$('comparison-viewport').dispatch('keydown',{key:'['});assert.equal(state.rotation,0);
    assert.equal(h.enabled.length,1);assert.equal(h.calls.length,1);
  }finally{h.controller.destroy();}
});

test('multiframe selection keeps source identity, supports raw parsing, and retires previous frame cache entries',async()=>{
  const h=harness(),input=await source(),parsing={mode:'raw-dataset',transferSyntaxUID:'1.2.840.10008.1.2.1'},recipe={sourceFrame:1,status:'rendered'};
  try{
    assert.equal(await h.controller.pin({...input,previewEntry:recipe,sourceParsing:parsing}),true);const first=h.viewports[0].state.stack[0];
    assert.ok(h.controller.getDecoded(first));assert.equal(h.$('comparison-previous').disabled,true);assert.equal(h.$('comparison-next').disabled,false);
    assert.deepEqual(h.calls[0][4].sourceParsing,parsing);assert.deepEqual(h.calls[0][2],recipe);
    h.$('comparison-brightness').value='25';h.$('comparison-brightness').dispatch('input');h.$('comparison-rotate-left').dispatch('click');
    h.$('comparison-next').dispatch('click');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    const second=h.viewports[0].state.stack[0];assert.notEqual(first,second);assert.equal(h.controller.getDecoded(first),undefined);assert.ok(h.controller.getDecoded(second));
    assert.ok(h.released.includes(first));assert.equal(h.calls[1][2],null);assert.equal(h.calls[1][3],2);assert.equal(h.$('comparison-brightness').value,'25');assert.equal(h.viewports[0].state.rotation,270);
    h.$('comparison-frame').value='3';h.$('comparison-frame').dispatch('change');await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='3');
    assert.equal(h.$('comparison-next').disabled,true);assert.equal(h.$('comparison-frame-label').textContent,'Frame 3 of 3');assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,input.entry.attachment);
    h.$('comparison-frame').value='9';h.$('comparison-frame').dispatch('change');assert.equal(h.$('comparison-frame').value,'3');assert.equal(h.calls.length,3);
  }finally{h.controller.destroy();}
});

test('frame decoding retains the committed pixels and labels until the replacement is ready',async()=>{
  const pending=deferred(),h=harness({decode:(bytes,id,recipe,frame)=>frame===2?pending.promise:imageResult(bytes,id,frame)}),input=await source();
  try{
    await h.controller.pin(input);const first=h.viewports[0].state.stack[0];
    h.$('comparison-next').dispatch('click');await until(()=>h.calls.length===2);
    assert.equal(h.$('comparison-viewport').dataset.sourceFrame,'1');
    assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,input.entry.attachment);
    assert.equal(h.$('comparison-frame-label').textContent,'Frame 1 of 3');
    assert.equal(h.$('comparison-viewport').getAttribute('aria-busy'),'true');
    assert.equal(h.$('comparison-viewport').dataset.loadingFrame,'2');
    assert.ok(h.controller.getDecoded(first));assert.equal(h.released.includes(first),false);
    pending.resolve(imageResult(input.bytes,h.calls[1][1],2));
    await until(()=>h.$('comparison-viewport').dataset.sourceFrame==='2');
    assert.equal(h.$('comparison-viewport').getAttribute('aria-busy'),'false');
    assert.equal(h.$('comparison-viewport').dataset.loadingFrame,'');
    assert.equal(h.controller.getDecoded(first),undefined);assert.ok(h.released.includes(first));
  }finally{h.controller.destroy();}
});

test('failed replacement clears old pixels rather than labeling them as the failed frame',async()=>{
  const pending=deferred(),h=harness({decode:(bytes,id,recipe,frame)=>frame===2?pending.promise:imageResult(bytes,id,frame)}),input=await source();
  try{
    await h.controller.pin(input);h.$('comparison-next').dispatch('click');await until(()=>h.calls.length===2);
    pending.resolve({...imageResult(input.bytes,h.calls[1][1],2),sopInstanceUID:'different'});
    await until(()=>h.$('comparison-status').textContent.includes('could not be displayed'));
    assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,'');
    assert.equal(h.$('comparison-viewport').dataset.sourceFrame,'');
    assert.equal(h.$('comparison-viewport').getAttribute('aria-busy'),'false');
    assert.equal(h.$('comparison-save').disabled,false);
    h.$('comparison-save').dispatch('click');await until(()=>h.saved.length===1);assert.deepEqual(h.saved[0].bytes,input.bytes);
  }finally{h.controller.destroy();}
});

test('replacement pins with duplicate instance IDs remain separate and ignore stale decoder completion',async()=>{
  const old=deferred(),h=harness({decode:async(bytes,id,recipe,frame)=>bytes[0]===1?old.promise:imageResult(bytes,id,frame)}),one=await source(1,'one.dcm'),two=await source(2,'two.dcm');
  try{
    const pending=h.controller.pin(one);await until(()=>h.calls.length===1);
    assert.equal(await h.controller.pin(two),true);assert.equal(h.calls[0][4].signal.aborted,true);assert.equal(h.$('comparison-source').textContent,'two.dcm');
    const active=h.viewports[0].state.stack[0];old.resolve(imageResult(one.bytes,h.calls[0][1],1));assert.equal(await pending,false);
    assert.equal(h.viewports[0].state.stack[0],active);assert.equal(h.controller.getDecoded(h.calls[0][1]),undefined);assert.equal(h.controller.getDecoded(active).image.getPixelData()[0],2);
  }finally{old.resolve({});h.controller.destroy();}
});

test('close cancels pending work and releases source, image map, worker cache and viewport',async()=>{
  const pending=deferred(),h=harness({decode:()=>pending.promise}),input=await source();
  try{
    const pin=h.controller.pin(input);await until(()=>h.calls.length===1);h.$('close-comparison').dispatch('click');
    assert.equal(h.controller.isOpen,false);assert.equal(h.$('comparison-pane').hidden,true);assert.equal(h.$('comparison-save').disabled,true);
    assert.equal(h.calls[0][4].signal.aborted,true);assert.equal(h.disabled.length,1);assert.equal(h.$('comparison-source').textContent,'');
    pending.resolve(imageResult(input.bytes,h.calls[0][1],1));assert.equal(await pin,false);assert.equal(h.controller.getDecoded(h.calls[0][1]),undefined);
    assert.ok(!h.$('image-comparison-layout').classList.contains('has-comparison'));assert.equal(h.$('compare-current').focusCalls,1);
  }finally{pending.resolve({});h.controller.destroy();}
});

test('viewport commits are serialized so an older setStack cannot overwrite a replacement pin',async()=>{
  const rendering=deferred();let stacks=0;
  const h=harness({stack:async()=>{if(++stacks===1)await rendering.promise;}}),one=await source(1,'one.dcm'),two=await source(2,'two.dcm');
  try{
    const first=h.controller.pin(one);await until(()=>stacks===1);
    const second=h.controller.pin(two);await until(()=>h.calls.length===2);assert.equal(stacks,1);
    rendering.resolve();assert.equal(await first,false);assert.equal(await second,true);assert.equal(stacks,2);
    assert.equal(h.$('comparison-source').textContent,'two.dcm');assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,two.entry.attachment);
    assert.equal(h.controller.getDecoded(h.calls[0][1]),undefined);assert.ok(h.controller.getDecoded(h.calls[1][1]));
  }finally{rendering.resolve();h.controller.destroy();}
});

test('closing during worker checksum registration prevents display and leaves no source to save',async()=>{
  const h=harness(),pending=h.controller.pin(await source());h.controller.close();
  assert.equal(await pending,false);assert.equal(h.calls.length,1);assert.equal(h.calls[0][4].signal.aborted,true);assert.equal(h.$('comparison-save').disabled,true);h.controller.destroy();
});

test('checksum mismatch fails before enabling save',async()=>{
  const h=harness(),input=await source();try{
    assert.equal(await h.controller.pin({...input,entry:{...input.entry,sha256:'0'.repeat(64)}}),false);
    assert.equal(h.calls.length,1);assert.equal(h.$('comparison-save').disabled,true);assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,'');assert.match(h.$('comparison-status').textContent,/checksum/);
  }finally{h.controller.destroy();}
});

test('real decoder registration refuses a bad checksum before verification, display or saving',async()=>{
  const workers=[];let decodes=0;
  class Worker extends EventTarget{
    terminated=false;
    constructor(){super();this.runtime=createDecoderWorkerRuntime({decode:(bytes,id,recipe,frame)=>{decodes++;return imageResult(bytes,id,frame);},postMessage:(message,transfers)=>{
      const copied=structuredClone(message,{transfer:transfers});queueMicrotask(()=>{if(!this.terminated)this.dispatchEvent(new MessageEvent('message',{data:copied}));});
    }});}
    postMessage(message,transfers=[]){const copied=structuredClone(message,{transfer:transfers});queueMicrotask(()=>{if(!this.terminated)void this.runtime.handleMessage(copied);});}
    terminate(){this.terminated=true;}
  }
  const client=createDecoderClient({workerFactory:()=>{const worker=new Worker();workers.push(worker);return worker;}}),h=harness({decoderClient:client}),input=await source();
  try{
    const pin=h.controller.pin({...input,entry:{...input.entry,sha256:'0'.repeat(64)}});
    assert.equal(h.$('comparison-save').disabled,true);assert.equal(await pin,false);assert.equal(decodes,0);
    assert.equal(workers[0].terminated,true);assert.deepEqual(workers[0].runtime.getCacheState(),{bytes:0,keys:[]});
    assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,'');assert.equal(h.$('comparison-save').disabled,true);assert.match(h.$('comparison-status').textContent,/checksum/);
    assert.equal(await h.controller.pin(input),true);assert.equal(decodes,1);assert.equal(h.$('comparison-save').disabled,false);
  }finally{h.controller.destroy();}
});

test('decoder identity mismatch cannot show pixels; verified source can still be recovered',async()=>{
  const h=harness({decode:(...args)=>({...imageResult(args[0],args[1],args[3]),sopInstanceUID:'2.25.999'})}),input=await source();
  try{
    assert.equal(await h.controller.pin(input),false);assert.equal(h.$('comparison-viewport').dataset.loadedAttachment,'');assert.equal(h.$('comparison-reset').disabled,true);
    assert.equal(h.$('comparison-save').disabled,false);assert.match(h.$('comparison-status').textContent,/could not be displayed/);
    h.$('comparison-save').dispatch('click');await until(()=>h.saved.length===1);assert.deepEqual(h.saved[0].bytes,input.bytes);
  }finally{h.controller.destroy();}
});

test('failure messages do not expose decoder exception text and destroy removes all handlers',async()=>{
  const h=harness({decode:()=>{throw new Error('PRIVATE^SYNTHETIC /private/path/example.dcm');}});
  assert.equal(await h.controller.pin(await source()),false);assert.ok(!h.$('comparison-status').textContent.includes('PRIVATE'));
  h.controller.destroy();h.controller.destroy();assert.equal(h.destroys,1);assert.equal(h.controller.isOpen,false);
  assert.ok([...h.elements.values()].every(element=>[...element.listeners.values()].every(listeners=>listeners.size===0)));
  assert.equal(await h.controller.pin(await source()),false);
});
