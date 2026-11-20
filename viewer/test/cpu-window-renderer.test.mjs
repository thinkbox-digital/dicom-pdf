import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowRenderer} from '../cpu-window-renderer.mjs';

function fixture({values=[0,1,2,3],rows=2,columns=2,center=1.5,width=3,functionValue='SIGMOID',slope=1,intercept=0,invert=false,originalRender}={}){
  const pixels=new Int16Array(values),before=pixels.slice();
  const image={imageId:'synthetic',rows,columns,width:columns,height:rows,color:false,windowCenter:center,windowWidth:width,voiLUTFunction:functionValue,slope,intercept,invert,
    minPixelValue:Math.min(...values),maxPixelValue:Math.max(...values),getPixelData:()=>pixels};
  if(originalRender)image.render=originalRender;
  const canvases=[],targetCalls=[],targetContext={setTransform:(...args)=>targetCalls.push(['transform',...args]),fillRect:(...args)=>targetCalls.push(['fill',...args]),drawImage:(...args)=>targetCalls.push(['draw',...args])};
  const canvasFactory=()=>{
    const calls=[],context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),putImageData:(data,...args)=>calls.push({data:data.data.slice(),args})};
    const canvas={width:0,height:0,getContext:kind=>kind==='2d'?context:null};canvases.push({canvas,context,calls});return canvas;
  };
  const controller=createWindowRenderer(image,{canvasFactory}),viewport={invert,voi:{windowCenter:center,windowWidth:width},displayedArea:{tlhc:{x:1,y:1},brhc:{x:columns,y:rows}},pixelReplication:false};
  const enabled={image,viewport,canvas:{width:800,height:600,getContext:()=>targetContext},transform:{getMatrix:()=>[0,2,-3,0,42,-7]},renderingTools:{sentinel:true}};
  return {image,pixels,before,controller,enabled,canvases,targetCalls,targetContext};
}
const gray=record=>Array.from(record.data).filter((_,index)=>index%4===0);

test('public renderer hook draws exact source-size RGBA using the current camera matrix without changing image fields',()=>{
  const h=fixture({values:[-2,-1,0,1],center:0,width:2,functionValue:'LINEAR_EXACT',slope:0.5,intercept:0});
  const original={center:h.image.windowCenter,width:h.image.windowWidth,function:h.image.voiLUTFunction,slope:h.image.slope,intercept:h.image.intercept};
  h.image.render(h.enabled);
  assert.equal(h.canvases.length,1);assert.equal(h.canvases[0].canvas.width,2);assert.equal(h.canvases[0].canvas.height,2);
  assert.deepEqual(gray(h.canvases[0].calls[0]),[0,64,128,191]);
  assert.deepEqual(h.targetCalls[0],['transform',1,0,0,1,0,0]);assert.deepEqual(h.targetCalls[2],['transform',0,2,-3,0,42,-7]);
  assert.deepEqual(h.targetCalls[3],['draw',h.canvases[0].canvas,0,0,2,2,0,0,2,2]);assert.deepEqual(h.enabled.renderingTools,{sentinel:true});
  assert.deepEqual({center:h.image.windowCenter,width:h.image.windowWidth,function:h.image.voiLUTFunction,slope:h.image.slope,intercept:h.image.intercept},original);assert.deepEqual(h.pixels,h.before);
  for(let index=0;index<16;index+=4){assert.equal(h.canvases[0].calls[0].data[index+3],255);assert.equal(h.canvases[0].calls[0].data[index],h.canvases[0].calls[0].data[index+1]);}
  h.controller.destroy();
});
test('camera-only changes reuse one cached pixel canvas while inversion and logical window rebuild its pixels',()=>{
  const h=fixture();h.image.render(h.enabled);h.enabled.transform.getMatrix=()=>[4,0,0,4,-90,150];h.image.render(h.enabled);
  assert.equal(h.canvases.length,1);assert.equal(h.canvases[0].calls.length,1);assert.deepEqual(h.targetCalls.at(-2),['transform',4,0,0,4,-90,150]);
  h.enabled.viewport.invert=true;h.image.render(h.enabled);assert.equal(h.canvases[0].calls.length,2);
  const first=gray(h.canvases[0].calls[0]),inverted=gray(h.canvases[0].calls[1]);
  assert.deepEqual(inverted,first.map(value=>255-value));
  h.controller.setWindow({center:0,width:0.5,function:'SIGMOID'});h.image.render(h.enabled);assert.equal(h.canvases.length,1);assert.equal(h.canvases[0].calls.length,3);assert.deepEqual(h.pixels,h.before);
  h.controller.destroy();
});
test('logical fractional windows remain distinct from the valid LINEAR surrogate used by Cornerstone',()=>{
  const h=fixture(),properties=[];
  const current=h.controller.setWindow({center:-2.25,width:0.5,function:'LINEAR_EXACT'},{setProperties:value=>{
    assert.equal(Object.hasOwn(value,'VOILUTFunction'),false,'CPU viewports throw for the VOI function setter');properties.push(value);
  }});
  assert.deepEqual(current,{center:-2.25,width:0.5,function:'LINEAR_EXACT'});assert.equal(Object.isFrozen(current),true);assert.equal(h.controller.getWindow(),current);
  assert.deepEqual(properties,[{voiRange:{lower:-2.75,upper:-2.75}}]);
  assert.equal(h.image.windowWidth,3);assert.equal(h.image.voiLUTFunction,'SIGMOID');h.controller.destroy();
});
test('stock LINEARwidth>1 has no custom hook; function switches and destroy restore an earlier image renderer',()=>{
  const originalRender=()=>{},h=fixture({functionValue:'LINEAR',originalRender});assert.equal(h.image.render,originalRender);assert.equal(h.canvases.length,0);
  h.controller.setWindow({center:1,width:2,function:'LINEAR_EXACT'});assert.notEqual(h.image.render,originalRender);h.image.render(h.enabled);const canvas=h.canvases[0].canvas;
  h.controller.setWindow({center:1,width:2,function:'LINEAR'});assert.equal(h.image.render,originalRender);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  h.controller.setWindow({center:1,width:1,function:'LINEAR'});h.image.render(h.enabled);assert.deepEqual(gray(h.canvases[1].calls[0]),[0,255,255,255]);
  h.controller.destroy();assert.equal(h.image.render,originalRender);assert.equal(h.canvases[1].canvas.width,0);h.controller.destroy();
  assert.throws(()=>h.controller.setWindow({center:0,width:1}),/released/);
});
test('displayed-area cropping follows the stock source rectangle and interpolation choice',()=>{
  const h=fixture({values:[0,1,2,3,4,5],rows:2,columns:3});h.enabled.viewport.displayedArea={tlhc:{x:2,y:1},brhc:{x:3,y:2}};h.enabled.viewport.pixelReplication=true;
  h.image.render(h.enabled);assert.deepEqual(h.targetCalls.at(-1),['draw',h.canvases[0].canvas,1,0,2,2,0,0,2,2]);assert.equal(h.targetContext.imageSmoothingEnabled,false);h.controller.destroy();
});
test('invalid matrices, dimensions, sample bounds and windows fail explicitly without replacing valid source pixels',()=>{
  const h=fixture(),validState=h.controller.getWindow();assert.throws(()=>h.controller.setWindow({center:0,width:0,function:'SIGMOID'}),/invalid/);assert.equal(h.controller.getWindow(),validState);
  h.enabled.transform.getMatrix=()=>[1,0,0,NaN,0,0];assert.throws(()=>h.image.render(h.enabled),/transform/);assert.equal(h.canvases.length,0);
  h.enabled.transform.getMatrix=()=>[1,0,0,1,0,0];h.image.maxPixelValue=1;assert.throws(()=>h.image.render(h.enabled),/sample.*range/);assert.deepEqual(h.pixels,h.before);h.controller.destroy();
  assert.throws(()=>fixture({rows:16777217,columns:1}),/excessive/);
});
test('color retains the stock renderer and a LINEAR logical window regardless of source VOI function',()=>{
  const pixels=new Uint8Array([255,0,0,255]),image={color:true,rows:1,columns:1,windowCenter:128,windowWidth:256,voiLUTFunction:'SIGMOID',getPixelData:()=>pixels};
  const controller=createWindowRenderer(image);assert.equal(image.render,undefined);assert.deepEqual(controller.getWindow(),{center:128,width:256,function:'LINEAR'});
  assert.deepEqual(controller.setWindow({center:100,width:200,function:'SIGMOID'}),{center:100,width:200,function:'LINEAR'});assert.equal(image.render,undefined);assert.deepEqual([...pixels],[255,0,0,255]);controller.destroy();
});
