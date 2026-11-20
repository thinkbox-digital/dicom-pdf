import assert from 'node:assert/strict';
import test from 'node:test';
import {attachmentBytes,openPdfAttachments,recordedAttachmentDigest} from '../pdf-attachments.mjs';

test('modern originals require their own checksum and missing legacy checksums stay unchecked',()=>{
  const file={filename:'image.dcm'},hash='ab'.repeat(32);
  const manifest={schemaVersion:2,artifactSha256:{'image.dcm':hash}};
  assert.throws(()=>recordedAttachmentDigest(manifest,file,{}),/SHA-256/);
  assert.throws(()=>recordedAttachmentDigest(manifest,file,{sha256:'invalid'}),/SHA-256/);
  assert.equal(recordedAttachmentDigest(manifest,file,{sha256:hash}),hash);
  assert.equal(recordedAttachmentDigest({schemaVersion:1},file,{}),undefined);
});

function indexedPdf(index,read) {
  return {_transport:{messageHandler:{async sendWithPromise(method,args){
    if(method==='DicomAttachmentIndex')return index;
    assert.equal(method,'DicomReadAttachment');
    return read(args.key,args.limit,args.digestOnly);
  }}}};
}

test('opening the index requests no file bodies and shares concurrent reads by key',async()=>{
  const calls=[];
  const pdf=indexedPdf([
    {key:'a',filename:'image.dcm',embedded:true},
    {key:'b',filename:'image.dcm',embedded:true},
  ],async(key,limit)=>{
    assert.ok(limit>0);calls.push(key);return Uint8Array.of(key==='a'?1:2);
  });
  const files=await openPdfAttachments(pdf);
  assert.deepEqual(calls,[]);
  assert.deepEqual(Object.keys(files),['a','b']);
  const [first,same]=await Promise.all([attachmentBytes(files.a),attachmentBytes(files.a)]);
  assert.strictEqual(first,same);
  assert.deepEqual(calls,['a']);
  assert.deepEqual(await attachmentBytes(files.b),Uint8Array.of(2));
  assert.strictEqual(await attachmentBytes(files.a),first);
  assert.deepEqual(calls,['a','b']);
});

test('failed reads can retry and older attachment bodies are evicted',async()=>{
  const calls=new Map();
  const index=Array.from({length:129},(_,index)=>({key:String(index),filename:index+'.dcm',embedded:true}));
  const files=await openPdfAttachments(indexedPdf(index,key=>{
    calls.set(key,(calls.get(key)||0)+1);
    if(key==='0'&&calls.get(key)===1)throw new Error('Range read failed');
    return Uint8Array.of(Number(key));
  }));
  await assert.rejects(attachmentBytes(files['0']),/Range read failed/);
  for(const {key} of index)await attachmentBytes(files[key]);
  assert.equal(calls.get('0'),2);
  assert.deepEqual(await attachmentBytes(files['0']),Uint8Array.of(0));
  assert.equal(calls.get('0'),3);
});

test('digest-only reads relay measured size and digest without caching a file body',async()=>{
  const calls=[],digest='12'.repeat(32);
  const files=await openPdfAttachments(indexedPdf([{key:'original',filename:'image.dcm',embedded:true}],
    (key,limit,digestOnly)=>{
      assert.equal(key,'original');assert.ok(limit>0);
      calls.push(digestOnly===true);
      return digestOnly?{size:3,digest}:Uint8Array.of(1,2,3);
    }));
  const file=files.original;
  assert.deepEqual(await file.readDigest(),{size:3,digest});
  assert.equal(file.byteLength,3);
  assert.equal(file.peek(),undefined);
  assert.deepEqual(await attachmentBytes(file),Uint8Array.of(1,2,3));
  assert.deepEqual(calls,[true,false]);
});
