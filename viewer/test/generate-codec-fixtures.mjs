// Generates only mathematical test pixels using the pinned permissively licensed codec packages.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import openjpegFactory from '@cornerstonejs/codec-openjpeg';
import charlsFactory from '@cornerstonejs/codec-charls';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.join(root,'target/codec-fixtures');fs.mkdirSync(output,{recursive:true});
const width=64,height=48;
const charls=await charlsFactory();
for(const [name,bits,near] of [['gray8.jls',8,0],['gray16.jls',12,0],['gray8-near.jls',8,2]]){
 const encoder=new charls.JpegLSEncoder();
 try{
  const data=encoder.getDecodedBuffer({width,height,bitsPerSample:bits,componentCount:1});
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const value=bits===8?(x*3+y*5)&255:x*32+y*16;
   if(bits===8)view.setUint8(y*width+x,value);else view.setUint16((y*width+x)*2,value,true);
  }
  encoder.setNearLossless(near);encoder.encode();fs.writeFileSync(path.join(output,name),encoder.getEncodedBuffer());
 }finally{encoder.delete();}
}
const openjpeg=await openjpegFactory();const encoder=new openjpeg.J2KEncoder();
try{
 const data=encoder.getDecodedBuffer({width,height,bitsPerSample:12,componentCount:1,isSigned:false});
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)view.setUint16((y*width+x)*2,x*32+y*16,true);
 encoder.setDecompositions(2);encoder.setCompressionRatio(0);encoder.encode();
 fs.writeFileSync(path.join(output,'gray16.j2k'),encoder.getEncodedBuffer());
}finally{encoder.delete();}
console.log(`Synthetic CharLS/OpenJPEG codestreams written to ${output}`);
