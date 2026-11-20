import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {NATIVE_DIGEST_BYTES,readNativeFlate} from '../pdf-attachment-stream.mjs';
import {sha256File} from '../streaming-sha256.mjs';
import {localPdfRange} from '../pdf-blob-range.mjs';

test('bounded native hashing covers the threshold and switches under tighter memory budgets',async t=>{
  const native=t.mock.method(crypto.subtle,'digest');
  for(const [length,limit,usesNative] of [[512*1024,8*1024*1024,true],[NATIVE_DIGEST_BYTES,8*1024*1024,true],
      [NATIVE_DIGEST_BYTES+1,8*1024*1024,false],[512*1024,512*1024,false]]){
    const bytes=new Uint8Array(length).fill(63),before=native.mock.callCount();
    assert.deepEqual(await readNativeFlate(deflateSync(bytes),limit,true),
      {size:length,digest:createHash('sha256').update(bytes).digest('hex')});
    assert.equal(native.mock.callCount()-before,Number(usesNative));
  }
});

test('native Flate hashes complete decoded chunks, enforces limits and discards partial results on failure',async()=>{
  const bytes=new Uint8Array(1024*1024+1).fill(33),encoded=deflateSync(bytes);
  assert.deepEqual(await readNativeFlate(encoded,bytes.length,true),
    {size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')});
  assert.deepEqual(await readNativeFlate(encoded,bytes.length,false),bytes);
  await assert.rejects(readNativeFlate(encoded,bytes.length-1,true),/available browser memory/);
  assert.equal(await readNativeFlate(encoded.subarray(0,encoded.length-3),bytes.length,true),null);
  assert.deepEqual(await readNativeFlate(deflateSync(new Uint8Array()),64,true),
    {size:0,digest:createHash('sha256').digest('hex')});
});

test('SHA-256 uses bounded slices and never asks for the whole source',async()=>{
  const bytes=new Uint8Array(3*1024*1024+17).fill(123);let largest=0;
  const file={size:bytes.length,arrayBuffer(){assert.fail('Whole-file allocation');},slice(start,end){largest=Math.max(largest,end-start);return new Blob([bytes.subarray(start,end)]);}};
  assert.equal(await sha256File(file),createHash('sha256').update(bytes).digest('hex'));assert.ok(largest<=1024*1024);
});
test('large PDF ranges are split into bounded local reads and abort stops delivery',async()=>{
  const deliveries=[],reads=[];class Transport{constructor(length,initial){this.length=length;assert.equal(initial.length,0);}onDataRange(start,bytes){deliveries.push([start,bytes.length]);}}
  const file={size:5*1024**3,slice(start,end){reads.push([start,end]);return {arrayBuffer:async()=>new ArrayBuffer(end-start)};}};
  const range=localPdfRange(Transport,file,()=>assert.fail());await range.requestDataRange(0,3*1024**2+7);
  assert.deepEqual(deliveries,[[0,3*1024**2+7]]);assert.ok(reads.every(([start,end])=>end-start<=1024**2));
  range.abort();await range.requestDataRange(0,1024);assert.equal(deliveries.length,1);
});
