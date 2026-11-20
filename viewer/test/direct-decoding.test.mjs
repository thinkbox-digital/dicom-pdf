import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'fflate';
import {decodeDicom} from '../native-dicom.mjs';
import {readDicomMetadata} from '../metadata-export.mjs';
import {inflateDicomBytes} from '../bounded-inflate.mjs';

for(const [name,syntax] of [['ct-explicit-le-16.dcm','1.2.840.10008.1.2.1'],['ct-explicit-be-16.dcm','1.2.840.10008.1.2.2'],['mr-implicit-le-16.dcm','1.2.840.10008.1.2']]){
  test(`unchanged raw dataset renders and exports actual metadata: ${name}`,async()=>{
    const original=new Uint8Array(await readFile(new URL(`../../fixtures/expanded/${name}`,import.meta.url)));
    const expected=decodeDicom(original,'part10');
    const offset=144+new DataView(original.buffer,original.byteOffset,original.byteLength).getUint32(140,true),raw=original.slice(offset),snapshot=raw.slice();
    assert.throws(()=>decodeDicom(raw,'strict'));
    const sourceParsing={mode:'raw-dataset',transferSyntaxUID:syntax};
    const actual=decodeDicom(raw,'raw',null,1,{sourceParsing});
    assert.deepEqual(actual.image.getPixelData(),expected.image.getPixelData());assert.equal(actual.sopInstanceUID,expected.sopInstanceUID);
    assert.equal(actual.image.invert,expected.image.invert);assert.equal(actual.image.windowCenter,expected.image.windowCenter);
    const metadata=readDicomMetadata(raw,{sourceParsing});
    assert.ok(metadata.some(element=>element.keyword==='SOPInstanceUID'&&element.value===expected.sopInstanceUID));
    assert.ok(!metadata.some(element=>element.path.startsWith('fileMeta/')),'Raw datasets must not acquire invented file metadata');
    assert.deepEqual(raw,snapshot);
  });
}
test('file-meta without preamble remains unchanged and conflicting parsing records are refused',async()=>{
  const original=new Uint8Array(await readFile(new URL('../../fixtures/expanded/ct-explicit-le-16.dcm',import.meta.url))),bare=original.slice(132),snapshot=bare.slice();
  const expected=decodeDicom(original,'part10'),sourceParsing={mode:'file-meta-without-preamble',transferSyntaxUID:'1.2.840.10008.1.2.1'};
  assert.deepEqual(decodeDicom(bare,'bare',null,1,{sourceParsing}).image.getPixelData(),expected.image.getPixelData());
  assert.throws(()=>decodeDicom(bare,'wrong',null,1,{sourceParsing:{...sourceParsing,transferSyntaxUID:'1.2.840.10008.1.2.2'}}));
  assert.deepEqual(bare,snapshot);
});
test('bounded inflation retains the exact preserved prefix and decoded body',()=>{
  const body=new Uint8Array(300000).map((_,index)=>index%251),compressed=deflateSync(body),prefix=new Uint8Array([1,2,3,4]);
  const input=new Uint8Array(prefix.length+compressed.length);input.set(prefix);input.set(compressed,prefix.length);const snapshot=input.slice();
  const result=inflateDicomBytes(input,prefix.length);assert.deepEqual(result.subarray(0,4),prefix);assert.deepEqual(result.subarray(4),body);assert.deepEqual(input,snapshot);
});
test('decompression size/ratio and malformed offsets fail instead of retaining unbounded output',()=>{
  const compressed=deflateSync(new Uint8Array(1024*1024));
  assert.throws(()=>inflateDicomBytes(compressed,0,{maxBytes:65536}),/limit/);
  assert.throws(()=>inflateDicomBytes(compressed,0,{maxRatio:10}),/limit/);
  for(const offset of [-1,0.5,compressed.length])assert.throws(()=>inflateDicomBytes(compressed,offset));
});
