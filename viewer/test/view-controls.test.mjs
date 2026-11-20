import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewControls,thumbnailPixels} from '../view-controls.mjs';

/** A small event target keeps these tests independent of a browser renderer. */
class ControlTarget {
  listeners=new Map();captures=[];focusCalls=[];
  addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(handler);}
  removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);}
  matches(){return false;}
  focus(options){this.focusCalls.push(options);}
  setPointerCapture(id){this.captures.push(id);}
  dispatch(type,values={}){
    const event={target:this,button:0,pointerType:'mouse',pointerId:1,clientX:0,clientY:0,
      ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,defaultPrevented:false,
      preventDefault(){this.defaultPrevented=true;},...values};
    for(const handler of this.listeners.get(type)??[])handler(event);
    return event;
  }
}

function harness({baselineInvert=false,initialInvert=baselineInvert,isReady=true}={}){
  const element=new ControlTarget(),changes=[],steps=[],resetSnapshots=[];
  const state={rotation:0,invert:initialInvert,zoom:1,pan:[0,0],renders:0,cameraResets:0};
  let ready=isReady,sourceInverted=baselineInvert;
  const viewport={
    getRotation:()=>state.rotation,setRotation:value=>{state.rotation=value;},
    getProperties:()=>({invert:state.invert}),setProperties:value=>{if('invert' in value)state.invert=value.invert;},
    getZoom:()=>state.zoom,setZoom:value=>{state.zoom=value;},
    getPan:()=>[...state.pan],setPan:value=>{state.pan=[...value];},
    resetCamera:()=>{state.zoom=1;state.pan=[0,0];state.cameraResets++;},
    render:()=>{state.renders++;}
  };
  const controls=createViewControls({viewport,element,ready:()=>ready,sourceInvert:()=>sourceInverted,
    onStep:step=>steps.push(step),onReset:()=>resetSnapshots.push({...state,pan:[...state.pan]}),
    onChange:change=>changes.push(change)});
  return {controls,element,state,changes,steps,resetSnapshots,setReady:value=>{ready=value;},setSourceInvert:value=>{sourceInverted=value;}};
}

test('rotation wraps in both directions and inversion is reported relative to the source baseline',()=>{
  const h=harness({baselineInvert:true});
  h.controls.rotate(-90);assert.equal(h.state.rotation,270);
  h.controls.rotate(450);assert.equal(h.state.rotation,0);
  assert.deepEqual(h.changes.at(-1),{rotation:0,inverted:false,zoom:1});
  h.controls.invert();assert.equal(h.state.invert,false);assert.equal(h.changes.at(-1).inverted,true);
  h.controls.invert();assert.equal(h.state.invert,true);assert.equal(h.changes.at(-1).inverted,false);
  assert.equal(h.state.renders,4);
});

test('reset restores source polarity and camera and invokes the external display-reset callback',()=>{
  const h=harness();h.controls.rotate(90);h.controls.invert();h.controls.zoom(3);h.controls.pan(40,-20);
  h.setSourceInvert(true);h.controls.reset();
  assert.equal(h.resetSnapshots.length,1);
  assert.deepEqual({rotation:h.state.rotation,invert:h.state.invert,zoom:h.state.zoom,pan:h.state.pan},
    {rotation:0,invert:true,zoom:1,pan:[0,0]});
  assert.equal(h.resetSnapshots[0].rotation,0);assert.equal(h.resetSnapshots[0].invert,true);
  assert.equal(h.resetSnapshots[0].zoom,1);assert.deepEqual(h.resetSnapshots[0].pan,[0,0]);
  assert.deepEqual(h.changes.at(-1),{rotation:0,inverted:false,zoom:1});
});

test('fit retains display choices while zoom clamps extremes and ignores invalid factors',()=>{
  const h=harness();h.controls.rotate(90);h.controls.invert();h.controls.zoom(4);h.controls.pan(10,20);
  h.controls.fit();assert.equal(h.state.rotation,90);assert.equal(h.state.invert,true);
  assert.equal(h.state.zoom,1);assert.deepEqual(h.state.pan,[0,0]);assert.equal(h.resetSnapshots.length,0);
  h.controls.zoom(1e20);assert.equal(h.state.zoom,10000);
  h.controls.zoom(1e-20);assert.equal(h.state.zoom,0.0001);
  const renders=h.state.renders;
  for(const value of [0,-1,NaN,Infinity,-Infinity])h.controls.zoom(value);
  assert.equal(h.state.renders,renders);assert.equal(h.state.zoom,0.0001);
});

test('all controls and keyboard events remain inert until an image is ready',()=>{
  const h=harness({isReady:false});
  h.controls.rotate(90);h.controls.invert();h.controls.zoom(2);h.controls.fit();h.controls.reset();h.controls.pan(5,5);
  assert.equal(h.element.dispatch('keydown',{key:'ArrowRight'}).defaultPrevented,false);
  assert.equal(h.element.dispatch('pointerdown',{clientX:5,clientY:10}).defaultPrevented,false);
  assert.equal(h.state.renders,0);assert.equal(h.state.cameraResets,0);assert.equal(h.resetSnapshots.length,0);
  assert.deepEqual(h.steps,[]);assert.deepEqual(h.element.captures,[]);
});

test('keyboard navigation and display shortcuts perform the corresponding actions',()=>{
  const h=harness(),key=(value,extra={})=>h.element.dispatch('keydown',{key:value,...extra});
  for(const value of ['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'])assert.equal(key(value).defaultPrevented,true);
  assert.deepEqual(h.steps,[-1,-1,1,1]);
  key('+');assert.equal(h.state.zoom,1.25);key('=');assert.equal(h.state.zoom,1.5625);key('-');assert.equal(h.state.zoom,1.25);
  key(']');assert.equal(h.state.rotation,90);key('[');assert.equal(h.state.rotation,0);
  key('i');assert.equal(h.state.invert,true);key('I');assert.equal(h.state.invert,false);
  key('ArrowLeft',{shiftKey:true});key('ArrowDown',{shiftKey:true});assert.deepEqual(h.state.pan,[-30,30]);
  key('ArrowRight',{shiftKey:true});key('ArrowUp',{shiftKey:true});assert.deepEqual(h.state.pan,[0,0]);
  assert.deepEqual(h.steps,[-1,-1,1,1]);
  key('0');assert.equal(h.state.zoom,1);assert.equal(h.resetSnapshots.length,0);
  key('r');key('R');assert.equal(h.resetSnapshots.length,2);
  const renders=h.state.renders;assert.equal(key('Escape').defaultPrevented,false);assert.equal(h.state.renders,renders);
});

test('keyboard shortcuts leave editable fields, buttons and browser modifier combinations alone',()=>{
  const h=harness();
  for(const kind of ['input','select','textarea','button','a[href]','summary','[role="slider"]','[role="spinbutton"]','[role="textbox"]','[role="combobox"]']){
    const target={matches:selector=>selector.split(',').includes(kind)};
    assert.equal(h.element.dispatch('keydown',{key:'r',target}).defaultPrevented,false,kind);
    assert.equal(h.element.dispatch('keydown',{key:'ArrowRight',target}).defaultPrevented,false,kind);
  }
  for(const modifier of ['ctrlKey','metaKey','altKey']){
    assert.equal(h.element.dispatch('keydown',{key:'i',[modifier]:true}).defaultPrevented,false,modifier);
    assert.equal(h.element.dispatch('keydown',{key:'ArrowDown',shiftKey:true,[modifier]:true}).defaultPrevented,false,modifier);
  }
  assert.deepEqual(h.steps,[]);assert.equal(h.state.renders,0);assert.equal(h.resetSnapshots.length,0);
});

test('shortcuts respect nested interactive content, inherited editing, composition and handled events',()=>{
  const h=harness();
  for(const target of [{isContentEditable:true},{closest:()=>({tagName:'BUTTON'})},
    {closest:selector=>selector.includes('[contenteditable]')?{}:null}]){
    for(const key of ['r','ArrowRight','i']){
      assert.equal(h.element.dispatch('keydown',{key,target}).defaultPrevented,false);
    }
  }
  assert.equal(h.element.dispatch('keydown',{key:'r',isComposing:true}).defaultPrevented,false);
  h.element.dispatch('keydown',{key:'ArrowRight',defaultPrevented:true});
  assert.deepEqual(h.steps,[]);assert.equal(h.state.renders,0);
  assert.equal(h.element.dispatch('keydown',{key:'ArrowRight'}).defaultPrevented,true);
  assert.deepEqual(h.steps,[1]);
});





function cameraHarness({rotation=0,zoom=1}={}){
  const element=new ControlTarget(),state={rotation,zoom,focalPoint:[4,-9,10],position:[4,-9,110],invert:false,renders:0,cameraWrites:0};
  const radians=()=>state.rotation*Math.PI/180;
  const worldToCanvas=world=>{const dx=(world[0]-state.focalPoint[0])*state.zoom,dy=(world[1]-state.focalPoint[1])*state.zoom;
    return [100+Math.cos(radians())*dx-Math.sin(radians())*dy,80+Math.sin(radians())*dx+Math.cos(radians())*dy];};
  const viewport={getRotation:()=>state.rotation,setRotation:value=>{state.rotation=value;},getProperties:()=>({invert:state.invert}),setProperties:value=>{state.invert=value.invert??state.invert;},
    getZoom:()=>state.zoom,setZoom:value=>{state.zoom=value;},render:()=>{state.renders++;},resetCamera(){state.zoom=1;state.focalPoint=[4,-9,10];state.position=[4,-9,110];},
    getPan:()=>assert.fail('Camera-capable viewports must not read translation as a screen pan.'),setPan:()=>assert.fail('Camera-capable viewports must not use setPan.'),
    getCamera:()=>({focalPoint:[...state.focalPoint],position:[...state.position],scale:state.zoom}),
    setCamera:value=>{state.cameraWrites++;if(value.focalPoint)state.focalPoint=[...value.focalPoint];if(value.position)state.position=[...value.position];},
    canvasToWorld:screen=>{const dx=(screen[0]-100)/state.zoom,dy=(screen[1]-80)/state.zoom;
      return [state.focalPoint[0]+Math.cos(radians())*dx+Math.sin(radians())*dy,state.focalPoint[1]-Math.sin(radians())*dx+Math.cos(radians())*dy,state.focalPoint[2]];}};
  const controls=createViewControls({viewport,element,ready:()=>true,sourceInvert:()=>false,onStep:()=>{}});
  return {controls,element,state,viewport,worldToCanvas};
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} differs from ${expected}`);

test('public-camera pan moves an image by exact screen pixels at arbitrary rotations and zooms',()=>{
  for(const rotation of [0,37,90,180,270])for(const zoom of [0.25,2,8]){
    const h=cameraHarness({rotation,zoom}),anchor=[27,19,10],before=h.worldToCanvas(anchor),offset=h.state.position.map((value,index)=>value-h.state.focalPoint[index]);
    h.controls.pan(25,-12);const after=h.worldToCanvas(anchor);
    near(after[0]-before[0],25);near(after[1]-before[1],-12);assert.equal(h.state.cameraWrites,1);
    h.state.position.forEach((value,index)=>near(value-h.state.focalPoint[index],offset[index]));h.controls.destroy();
  }
});


test('keyboard pan remains in screen axes for a rotated and zoomed camera',()=>{
  const h=cameraHarness({rotation:37,zoom:4}),anchor=[27,19,10],before=h.worldToCanvas(anchor);
  h.element.dispatch('keydown',{key:'ArrowLeft',shiftKey:true});h.element.dispatch('keydown',{key:'ArrowDown',shiftKey:true});
  const after=h.worldToCanvas(anchor);near(after[0]-before[0],-30);near(after[1]-before[1],30);
});


test('invalid camera transforms or pan inputs cannot contaminate the camera or fall back to incompatible setPan',()=>{
  const h=cameraHarness(),before=[...h.state.focalPoint];
  h.viewport.canvasToWorld=()=>undefined;h.controls.pan(10,20);assert.deepEqual(h.state.focalPoint,before);assert.equal(h.state.cameraWrites,0);
  h.viewport.canvasToWorld=()=>[NaN,0,0];h.controls.pan(10,20);assert.equal(h.state.cameraWrites,0);
  h.viewport.canvasToWorld=()=>{throw new Error('Synthetic unavailable transform.');};h.controls.pan(10,20);assert.equal(h.state.cameraWrites,0);
  for(const value of [NaN,Infinity,-Infinity])h.controls.pan(value,1);assert.equal(h.state.cameraWrites,0);
});

function decoded(values,overrides={}){
  const pixels=values instanceof Uint8Array||values instanceof Int16Array?values:new Int16Array(values);
  return {image:{rows:1,columns:pixels.length,rowPixelSpacing:1,columnPixelSpacing:1,windowCenter:128,windowWidth:256,
    slope:1,intercept:0,invert:false,color:false,...overrides,getPixelData:()=>pixels}};
}
const grayValues=thumbnail=>Array.from(thumbnail.pixels).filter((_,index)=>index%4===0);

test('grayscale thumbnails apply baseline window clipping and opaque neutral channels without mutating source pixels',()=>{
  const pixels=new Int16Array([-1,0,64,128,255,256]),before=pixels.slice();
  const thumbnail=thumbnailPixels(decoded(pixels));
  assert.equal(thumbnail.width,6);assert.equal(thumbnail.height,1);assert.deepEqual(grayValues(thumbnail),[0,0,64,128,255,255]);
  for(let index=0;index<thumbnail.pixels.length;index+=4){
    assert.equal(thumbnail.pixels[index],thumbnail.pixels[index+1]);assert.equal(thumbnail.pixels[index],thumbnail.pixels[index+2]);
    assert.equal(thumbnail.pixels[index+3],255);
  }
  assert.deepEqual(pixels,before);
});

test('grayscale thumbnail modality rescale precedes the VOI window and MONOCHROME1 inverts the result',()=>{
  const image=decoded([-100,0,100],{slope:2,intercept:100,windowCenter:100.5,windowWidth:201});
  assert.deepEqual(grayValues(thumbnailPixels(image)),[0,128,255]);
  image.image.invert=true;assert.deepEqual(grayValues(thumbnailPixels(image)),[255,128,0]);
  const threshold=thumbnailPixels(decoded([4,5,6],{windowCenter:5.5,windowWidth:1}));
  assert.deepEqual(grayValues(threshold),[0,0,255]);
});

test('color thumbnails preserve decoded RGB rather than applying grayscale windowing or inversion',()=>{
  const pixels=new Uint8Array([255,0,0,0,0,125,255,10]);
  const thumbnail=thumbnailPixels(decoded(pixels,{columns:2,color:true,invert:true,slope:9,intercept:100}));
  assert.deepEqual([...thumbnail.pixels],[255,0,0,255,0,125,255,255]);
  assert.deepEqual([...pixels],[255,0,0,0,0,125,255,10]);
});

test('thumbnail sizing preserves physical non-square pixel aspect, stays bounded and samples the corresponding rows and columns',()=>{
  const source=decoded([0,1,2,3,4,5,6,7],{rows:2,columns:4,rowPixelSpacing:2,columnPixelSpacing:1});
  let thumbnail=thumbnailPixels(source);assert.equal(thumbnail.width,4);assert.equal(thumbnail.height,4);
  thumbnail=thumbnailPixels(source,2);assert.equal(thumbnail.width,2);assert.equal(thumbnail.height,2);
  assert.deepEqual(grayValues(thumbnail),[0,2,4,6]);
  const wide=thumbnailPixels(decoded(Array.from({length:16},(_,index)=>index),{rows:4,columns:4,rowPixelSpacing:0.5}),2);
  assert.equal(wide.width,2);assert.equal(wide.height,1);assert.deepEqual(grayValues(wide),[0,2]);
});


test('thumbnails apply source LINEAR_EXACT and SIGMOID after fractional negative modality rescale',()=>{
  const pixels=new Int16Array([-2,-1,0,1,2]),before=pixels.slice();
  const exact=decoded(pixels,{slope:-0.5,intercept:0.25,windowCenter:0.25,windowWidth:2,voiLUTFunction:'LINEAR_EXACT'});
  assert.deepEqual(grayValues(thumbnailPixels(exact)),[255,191,128,64,0]);
  exact.image.invert=true;assert.deepEqual(grayValues(thumbnailPixels(exact)),[0,64,128,191,255]);
  const sigmoid=decoded(pixels,{windowCenter:0,windowWidth:4,voiLUTFunction:'SIGMOID'});
  assert.deepEqual(grayValues(thumbnailPixels(sigmoid)),[30,69,128,186,225]);
  const fractional=decoded([0,1,2],{slope:0.25,intercept:0,windowCenter:0.25,windowWidth:0.5,voiLUTFunction:'LINEAR_EXACT'});
  assert.deepEqual(grayValues(thumbnailPixels(fractional)),[0,128,255]);assert.deepEqual(pixels,before);
});
