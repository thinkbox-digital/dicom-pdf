import test from 'node:test';
import assert from 'node:assert/strict';
import {imageFitBounds,fitImageToViewport} from '../image-fit.mjs';

function image({rows=8,columns=10,left=0,top=0,right=columns,bottom=rows,...overrides}={}){
  const pixels=new Uint16Array(rows*columns);
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)pixels[y*columns+x]=100+x+y;
  return {rows,columns,color:false,windowCenter:128,windowWidth:256,slope:1,intercept:0,
    getPixelData:()=>pixels,...overrides};
}

test('asymmetric zero-filled borders are excluded without modifying samples or dimensions',()=>{
  const source=image({left:1,top:2,right:9,bottom:5}),before=source.getPixelData().slice();
  assert.deepEqual(imageFitBounds(source),{left:1,top:2,right:9,bottom:5});
  assert.deepEqual(source.getPixelData(),before);
  assert.equal(source.rows,8);assert.equal(source.columns,10);
  assert.equal(imageFitBounds(source),imageFitBounds(source));
});

test('multiframe fit stays anchored when visible content changes position between frames',()=>{
  const sparseStart=image({left:3,top:7,right:7,numberOfFrames:243});
  const laterFrame=image({left:1,top:1,bottom:6,numberOfFrames:243});
  for(const frame of [sparseStart,laterFrame]){
    assert.deepEqual(imageFitBounds(frame),{left:0,top:0,right:10,bottom:8});
  }
});

test('all-zero images, color images and zero samples that are not initially black retain the full matrix',()=>{
  const full={left:0,top:0,right:10,bottom:8};
  for(const options of [{bottom:0},{bottom:5,color:true},{bottom:5,windowCenter:0,windowWidth:256},
    {bottom:5,invert:true},{bottom:5,voiLUTFunction:'SIGMOID'}]){
    assert.deepEqual(imageFitBounds(image(options)),full);
  }
});

test('source rescale determines whether stored zero is black',()=>{
  assert.deepEqual(imageFitBounds(image({bottom:5,windowCenter:50,windowWidth:350,intercept:-1024})),
    {left:0,top:0,right:10,bottom:5});
});

test('dark nonzero edges and interior zero gaps are retained',()=>{
  const source=image({bottom:5}),pixels=source.getPixelData();
  pixels[7*10+5]=1; // A dark sample at the far edge must remain in the fit.
  pixels.fill(0,20,30); // An internal blank row is not an outer border.
  assert.deepEqual(imageFitBounds(source),{left:0,top:0,right:10,bottom:8});
});

test('fit respects rotation and non-square pixels and centers through public camera APIs',()=>{
  const source=image({bottom:5}),element={clientWidth:600,clientHeight:400};
  for(const rotation of [0,90,180,270]){
    let scale=1,focalPoint=[5,4,0],resets=0;
    const angle=rotation*Math.PI/180;
    const viewport={element,getImageData:()=>({imageData:{indexToWorld:p=>p}}),
      resetCamera(){scale=1;focalPoint=[5,4,0];resets++;},getZoom:()=>scale,setZoom:value=>{scale=value;},
      setCamera:camera=>{focalPoint=camera.focalPoint;},
      worldToCanvas:([x,y])=>[300+scale*((x-focalPoint[0])*Math.cos(angle)-(y-focalPoint[1])*2*Math.sin(angle)),
        200+scale*((x-focalPoint[0])*Math.sin(angle)+(y-focalPoint[1])*2*Math.cos(angle))]};
    fitImageToViewport(viewport,source);
    assert.equal(resets,1);assert.deepEqual(focalPoint,[5,2.5,0]);assert.ok(Math.abs(scale-40)<1e-10);
    assert.deepEqual(viewport.worldToCanvas(focalPoint),[300,200]);
    for(const point of [[0,0],[10,0],[10,5],[0,5]]){
      const [x,y]=viewport.worldToCanvas(point);assert.ok(x>=-1e-8&&x<=600+1e-8&&y>=-1e-8&&y<=400+1e-8);
    }
  }
});
