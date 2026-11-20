import test from 'node:test';
import assert from 'node:assert/strict';
import {spectroscopyTrace} from '../mr-spectroscopy.mjs';
import {presentationFrame} from '../presentation-state.mjs';
import {frameFitsMemory} from '../working-memory.mjs';

test('spectroscopy uses the acquired voxel and places a positive quadrature tone at a positive frequency',()=>{
  const points=8,width=800,data=new Float32Array(points*2*2);
  for(let i=0;i<points;i++){
    data[(points+i)*2]=Math.cos(Math.PI*i/2);
    data[(points+i)*2+1]=Math.sin(Math.PI*i/2);
  }
  const source={rows:1,columns:2,frames:1,points,width,domain:'TIME',representation:'COMPLEX',components:2,data};
  const spectrum=spectroscopyTrace(source,{column:2,frequency:true}),peak=spectrum.traces[0].values.indexOf(1);
  assert.equal(spectrum.first+spectrum.step*peak,200);
  assert.equal(spectrum.label,'Frequency offset (Hz)');
  const time=spectroscopyTrace(source,{column:2});
  assert.equal(time.step,1.25);
  assert.equal(time.traces[1].values[1],1);
  assert.throws(()=>spectroscopyTrace(source,{column:3}),/acquired grid/);
});

test('saved presentation applies frame-specific contrast and transforms the saved pixel bounds',()=>{
  const ref={instance:'1.2.3',frames:[2]},other={...ref,frames:[1]};
  const annotation={refs:[ref],graphics:[],texts:[]};
  const recipe={
    refs:[ref],areas:[{refs:[],start:[1,3],end:[4,1],aspect:2}],
    windows:[{refs:[other],window:{center:10,width:5,function:'LINEAR'}},
      {refs:[ref],window:{center:5,width:10,function:'LINEAR_EXACT'}}],
    annotations:[annotation,{refs:[other]}],rotation:90,flip:false,slope:2,intercept:0,invert:false,
  };
  const decoded={
    sopInstanceUID:ref.instance,sourceFrame:2,
    metadata:{imagePixelModule:{bitsStored:8,pixelRepresentation:0}},
    image:{rows:3,columns:4,minPixelValue:0,maxPixelValue:5,color:false,slope:50,intercept:-4},
  };
  const result=presentationFrame(recipe,decoded);
  assert.deepEqual([result.left,result.top,result.right,result.bottom,result.aspect],[0,0,3,4,0.5]);
  assert.deepEqual(result.annotations,[annotation]);
  assert.equal(result.lut.values[2],102);
  assert.equal(result.lut.values[5],255);
  assert.throws(()=>presentationFrame(recipe,{...decoded,sourceFrame:1}),/does not reference/);
});

test('the large JPEG-LS sample fits when the browser has enough headroom',()=>{
  assert.equal(frameFitsMemory(5131,3271,{bits:16,residentBytes:8*1024*1024,budget:256*1024*1024}),true);
  assert.equal(frameFitsMemory(5131,3271,{bits:16,residentBytes:8*1024*1024,budget:128*1024*1024}),false);
  assert.equal(frameFitsMemory(2,20000,{budget:256*1024*1024}),false);
});

