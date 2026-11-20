import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeDicom,decodeDicomAsync} from '../native-dicom.mjs';
const root=new URL('../../fixtures/expanded/',import.meta.url);
const read=name=>new Uint8Array(fs.readFileSync(new URL(name,root)));
const sync=name=>decodeDicom(read(name),'test:'+name);
const asyncDecode=name=>decodeDicomAsync(read(name),'test:'+name);
for(const name of ['ct-explicit-le-16.dcm','ct-explicit-be-16.dcm','mr-implicit-le-16.dcm','ct-deflated-16.dcm']){
 test(`CT/MR native/deflated16 samples ${name}`,()=>{
  const {image}=sync(name);assert.equal(image.rows,48);assert.equal(image.columns,64);
  const pixels=image.getPixelData();for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.equal(pixels[y*64+x],x*32+y*16);
 });
}
test('MR signed16 keeps negative stored samples',()=>{
 const {image}=sync('mr-explicit-le-signed16.dcm');assert.equal(image.getPixelData()[0],-1024);assert.equal(image.getPixelData()[63+47*64],1744);
});
test('single-bit unpacking follows DICOM least-significant-bit order',()=>{
 const {image}=sync('sc-single-bit.dcm');for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.equal(image.getPixelData()[y*64+x],x<32?0:1);
});
for(const name of ['sc-native-gray8.dcm','sc-rle-gray8.dcm']){
 test(`native/RLE8 exact independent pixels ${name}`,()=>{
  const {image}=sync(name);for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.equal(image.getPixelData()[y*64+x],(x*3+y*5)&255);
 });
}
test('signed8 samples retain negative values',()=>{
 const {image}=sync('sc-signed8.dcm');assert.equal(image.getPixelData()[0],-128);assert.equal(image.getPixelData()[1],-125);
});
for(const name of ['sc-rgb-interleaved.dcm','sc-rgb-planar.dcm','sc-ybr-full.dcm','sc-ybr-full-422.dcm','sc-palette-color.dcm']){
 test(`color conversion produces correct channel dominance ${name}`,()=>{
  const {image}=sync(name);assert.equal(image.color,true);const p=image.getPixelData();
  const red=(10*64+10)*4,green=(10*64+32)*4,blue=(10*64+54)*4;
  assert.ok(p[red]>150&&p[red+1]<90&&p[red+2]<90);
  assert.ok(p[green+1]>150&&p[green]<90&&p[green+2]<90);
  assert.ok(p[blue+2]>150&&p[blue]<90&&p[blue+1]<90);
  assert.equal(p[red+3],255);
 });
}
test('multiframe selection reads distinct source pixels and rejects missing frame',()=>{
 const bytes=read('sc-multiframe-gray8.dcm'),first=decodeDicom(bytes,'test:frame1',null,1),second=decodeDicom(bytes,'test:frame2',null,2);
 assert.equal(first.frameCount,2);assert.equal(second.sourceFrame,2);assert.equal(first.image.getPixelData()[0],0);assert.equal(second.image.getPixelData()[0],255);
 assert.throws(()=>decodeDicom(bytes,'test:bad-frame',null,3));
});
for(const [name,value] of [['sc-jpeg-lossless-sv1-gray8.dcm',100],['sc-jpeg-lossless14-gray8.dcm',100],['sc-jpeg-lossless-sv1-gray12.dcm',1000]]){
 test(`JPEG lossless precision and sample values ${name}`,()=>{
  const {image}=sync(name);assert.ok(image.getPixelData().every(pixel=>pixel===value));
 });
}
for(const name of ['ct-jpeg2000-lossless16.dcm','sc-jpegls-lossless-gray16.dcm']){
 test(`bundled16bit codec preserves every stored bit ${name}`,async()=>{
  const {image}=await asyncDecode(name);for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.equal(image.getPixelData()[y*64+x],x*32+y*16);
 });
}
test('bundled JPEG-LS8 exact pixels',async()=>{
 const {image}=await asyncDecode('sc-jpegls-lossless-gray8.dcm');for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.equal(image.getPixelData()[y*64+x],(x*3+y*5)&255);
});
test('JPEG-LS near-lossless respects encoded error bound2',async()=>{
 const {image}=await asyncDecode('sc-jpegls-near-lossless-gray8.dcm');for(let y=0;y<48;y++)for(let x=0;x<64;x++)assert.ok(Math.abs(image.getPixelData()[y*64+x]-((x*3+y*5)&255))<=2);
});

test('enhanced MR resolves per-frame VOI and shared/per-frame rescale',()=>{
 const bytes=read('mr-enhanced-functional-groups.dcm');
 const first=decodeDicom(bytes,'test:fg1',null,1),second=decodeDicom(bytes,'test:fg2',null,2);
 assert.equal(first.image.windowCenter,1024);assert.equal(first.image.windowWidth,2048);assert.equal(first.image.slope,1);assert.equal(first.image.intercept,0);
 assert.equal(second.image.windowCenter,1000);assert.equal(second.image.windowWidth,2000);assert.equal(second.image.slope,2);assert.equal(second.image.intercept,-1000);
 assert.deepEqual(first.image.getPixelData(),second.image.getPixelData());
});
