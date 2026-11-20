import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sha256File} from '../streaming-sha256.mjs';
import {localPdfRange} from '../pdf-blob-range.mjs';

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
