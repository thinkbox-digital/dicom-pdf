import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDecoderClient,DecoderError} from '../decoder-client.mjs';
import {createDecoderWorkerRuntime} from '../dicom-worker.mjs';

const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate){for(let count=0;count<100&&!predicate();count++)await tick();assert.ok(predicate(),'Expected decoder protocol event.');}
function decoded(bytes,imageId,previewEntry,sourceFrame){
  const pixels=new Uint16Array([bytes[0],sourceFrame]);
  return {image:{imageId,rows:1,columns:2,numberOfComponents:1,getPixelData:()=>pixels},range:{min:0,max:65535},frameCount:2,sourceFrame,
    metadata:{transferSyntax:{transferSyntaxUID:'1.2.840.10008.1.2.1'}},sourceOrientation:{iop:sourceFrame===1?[1,0,0,0,1,0]:[0,1,0,0,0,1],anatomicalOrientationType:'BIPED',provenance:'per-frame-functional-groups'},sourceWindowPresets:{presets:[{index:0,center:sourceFrame*10,width:100,label:'Source window',function:'LINEAR'}],provenance:'per-frame-functional-groups',functionExplicit:false,diagnostics:[]},sourceDisplay:{geometry:{ratio:1}}};
}

// Real structured cloning and transfer semantics exercise the boundary without a
// browser. Runtime and client never share their input or output ArrayBuffers.
class ProtocolWorker{
  constructor({decode=decoded,cacheBytes,allocationBytes}={}){
    this.listeners=new Map();this.sent=[];this.replies=[];this.terminated=false;
    this.runtime=createDecoderWorkerRuntime({decode,cacheBytes,allocationBytes,postMessage:(message,transfers)=>{
      const copy=structuredClone(message,{transfer:transfers});this.replies.push(copy);
      queueMicrotask(()=>this.emit('message',{data:copy}));
    }});
  }
  postMessage(message,transfers=[]){
    if(this.terminated)throw new Error('Worker terminated.');
    const copy=structuredClone(message,{transfer:transfers});
    this.sent.push({type:copy.type,id:copy.id,key:copy.key,imageId:copy.imageId,sourceFrame:copy.sourceFrame,previewEntry:copy.previewEntry,byteLength:copy.bytes?.byteLength});
    queueMicrotask(()=>{if(!this.terminated)void this.runtime.handleMessage(copy);});
  }
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  emit(type,event){if(!this.terminated)for(const listener of this.listeners.get(type)||[])listener(event);}
  terminate(){this.terminated=true;}
}
function harness(options={}){
  const workers=[];let disposals=0;
  const client=createDecoderClient({workerFactory:()=>{const worker=new ProtocolWorker(options);workers.push(worker);return {worker,dispose:()=>{disposals++;}};}});
  return {client,workers,get disposals(){return disposals;}};
}
const hasCode=code=>error=>error instanceof DecoderError&&error.code===code;

test('source metadata and unsupported document reads cross the same worker cache without detaching originals',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('../../fixtures/expanded/ct-explicit-le-16.dcm',import.meta.url))),before=bytes.slice(),key=await sha(bytes),h=harness();
  try{
    const elements=await h.client.readMetadata(bytes,{key});
    assert.ok(elements.some(element=>element.keyword==='SOPInstanceUID'&&element.value));
    assert.ok(elements.some(element=>element.encoding==='omitted-pixel-data'));
    const document=await h.client.readDocument(bytes,{key});assert.equal(document.kind,'unsupported');
    await h.client.decode(bytes,'after-document',null,1,{key});
    assert.equal(h.workers[0].sent.filter(message=>message.type==='register').length,1);
    assert.deepEqual(h.workers[0].sent.filter(message=>['metadata','document','decode'].includes(message.type)).map(message=>message.type),['metadata','document','decode']);
    assert.deepEqual(bytes,before);assert.ok(bytes.byteLength>0);
  }finally{h.client.destroy();}
});

test('one source registration serves different frames without detaching original bytes',async()=>{
  const h=harness(),bytes=new Uint8Array([23,42,1,255]),key=await sha(bytes),before=bytes.slice();
  try{
    const recipe={status:'displayed',sourceFrame:1,displayAdjustments:{windowCenter:27},patientName:'DO NOT SEND'};
    const first=await h.client.decode(bytes,'preview-one',recipe,1,{key});
    const second=await h.client.decode(bytes,'preview-two',null,2,{key});
    assert.deepEqual(bytes,before);assert.equal(bytes.byteLength,4);
    assert.deepEqual(first.image.getPixelData(),new Uint16Array([23,1]));assert.deepEqual(second.image.getPixelData(),new Uint16Array([23,2]));
    assert.deepEqual(first.sourceOrientation,{iop:[1,0,0,0,1,0],anatomicalOrientationType:'BIPED',provenance:'per-frame-functional-groups'});
    assert.deepEqual(second.sourceOrientation,{iop:[0,1,0,0,0,1],anatomicalOrientationType:'BIPED',provenance:'per-frame-functional-groups'});
    assert.deepEqual(first.sourceWindowPresets,{presets:[{index:0,center:10,width:100,label:'Source window',function:'LINEAR'}],provenance:'per-frame-functional-groups',functionExplicit:false,diagnostics:[]});
    assert.equal(second.sourceWindowPresets.presets[0].center,20);
    assert.equal(second.image.imageId,'preview-two');assert.equal(second.sourceFrame,2);assert.equal(second.metadata.transferSyntax.transferSyntaxUID,'1.2.840.10008.1.2.1');
    assert.equal('pixels' in first,false);assert.equal(h.workers[0].sent.filter(item=>item.type==='register').length,1);
    assert.equal(h.workers[0].sent.filter(item=>item.type==='decode').length,2);
    assert.equal(h.workers[0].sent.find(item=>item.type==='decode').previewEntry.patientName,undefined);
    assert.deepEqual(h.workers[0].runtime.getCacheState(),{bytes:4,keys:[key]});
  }finally{h.client.destroy();}
});

test('bounded source cache evicts old originals and re-registers a returning source',async()=>{
  const h=harness({cacheBytes:5}),a=new Uint8Array([1,2,3]),b=new Uint8Array([4,5,6]),ak=await sha(a),bk=await sha(b);
  try{
    await h.client.decode(a,'a',null,1,{key:ak});await h.client.decode(b,'b',null,1,{key:bk});
    assert.deepEqual(h.workers[0].runtime.getCacheState(),{bytes:3,keys:[bk]});
    await h.client.decode(a,'a-return',null,2,{key:ak});
    assert.deepEqual(h.workers[0].runtime.getCacheState(),{bytes:3,keys:[ak]});
    assert.deepEqual(h.workers[0].sent.filter(item=>item.type==='register').map(item=>item.key),[ak,bk,ak]);
  }finally{h.client.destroy();}
});
test('a file above the cache budget uses one temporary working source within its allocation budget',async()=>{
  const h=harness({cacheBytes:4,allocationBytes:32}),large=new Uint8Array(16).fill(7),small=new Uint8Array([1,2,3]);
  try{
    await h.client.decode(large,'large',null,1,{key:await sha(large)});
    assert.equal(h.workers[0].runtime.getWorkingBytes(),16);assert.deepEqual(h.workers[0].runtime.getCacheState(),{bytes:0,keys:[]});
    await h.client.decode(small,'small',null,1,{key:await sha(small)});
    assert.equal(h.workers[0].runtime.getWorkingBytes(),0);assert.equal(h.workers[0].runtime.getCacheState().bytes,3);
  }finally{h.client.destroy();}
});

test('foreground work precedes queued thumbnails and native decoders never overlap',async()=>{
  const calls=[],firstStarted=deferred(),release=deferred();let concurrent=0,maximum=0;
  const h=harness({decode:async(...args)=>{
    calls.push(args[1]);maximum=Math.max(maximum,++concurrent);
    if(args[1]==='initial'){firstStarted.resolve();await release.promise;}
    const result=decoded(...args);concurrent--;return result;
  }}),bytes=new Uint8Array([7,8]),key=await sha(bytes);
  try{
    const initial=h.client.decode(bytes,'initial',null,1,{key});await firstStarted.promise;
    const thumbnail=h.client.decode(bytes,'thumbnail',null,1,{key,priority:'thumbnail'});
    const foreground=h.client.decode(bytes,'foreground',null,2,{key,priority:'foreground'});
    release.resolve();await Promise.all([initial,thumbnail,foreground]);
    assert.deepEqual(calls,['initial','foreground','thumbnail']);assert.equal(maximum,1);
    // Same-turn work also prioritizes foreground before a thumbnail starts.
    const laterThumbnail=h.client.decode(bytes,'later-thumbnail',null,1,{key,priority:'thumbnail'});
    const laterForeground=h.client.decode(bytes,'later-foreground',null,1,{key});
    await Promise.all([laterThumbnail,laterForeground]);assert.deepEqual(calls.slice(-2),['later-foreground','later-thumbnail']);
  }finally{release.resolve();h.client.destroy();}
});

test('abort rejects queued and in-flight requests and ignores their late output',async()=>{
  const firstStarted=deferred(),release=deferred(),calls=[];
  const h=harness({decode:async(...args)=>{calls.push(args[1]);if(args[1]==='active'){firstStarted.resolve();await release.promise;}return decoded(...args);}});
  const bytes=new Uint8Array([11]),key=await sha(bytes),activeAbort=new AbortController(),queuedAbort=new AbortController();
  try{
    const active=h.client.decode(bytes,'active',null,1,{key,signal:activeAbort.signal});const activeRejected=assert.rejects(active,{name:'AbortError'});
    await firstStarted.promise;
    const queued=h.client.decode(bytes,'queued',null,1,{key,signal:queuedAbort.signal});const queuedRejected=assert.rejects(queued,{name:'AbortError'});
    queuedAbort.abort();activeAbort.abort();await Promise.all([activeRejected,queuedRejected]);
    const next=h.client.decode(bytes,'next',null,2,{key});release.resolve();
    assert.equal((await next).sourceFrame,2);assert.deepEqual(calls,['active','next']);
    assert.ok(h.workers[0].sent.some(item=>item.type==='cancel'));
  }finally{release.resolve();h.client.destroy();}
});

test('clear terminates old document cache and late decodes cannot resolve new requests',async()=>{
  const started=deferred(),release=deferred();
  const h=harness({decode:async(...args)=>{if(args[1]==='old'){started.resolve();await release.promise;}return decoded(...args);}});
  const bytes=new Uint8Array([3,4]),key=await sha(bytes);
  try{
    const old=h.client.decode(bytes,'old',null,1,{key});const rejected=assert.rejects(old,{name:'AbortError'});await started.promise;
    h.client.clear();await rejected;assert.equal(h.workers[0].terminated,true);assert.equal(h.disposals,1);
    const next=await h.client.decode(bytes,'new',null,2,{key});release.resolve();await tick();
    assert.equal(next.image.imageId,'new');assert.equal(h.workers.length,2);assert.equal(h.workers[1].sent.filter(item=>item.type==='register').length,1);
    h.client.destroy();assert.equal(h.disposals,2);await assert.rejects(h.client.decode(bytes,'closed',null,1,{key}),hasCode('DECODER_CLOSED'));
  }finally{release.resolve();h.client.destroy();}
});

test('bad checksums are refused before a decoder sees bytes',async()=>{
  let calls=0;const h=harness({decode:(...args)=>{calls++;return decoded(...args);}});
  try{
    await assert.rejects(h.client.decode(new Uint8Array([1,2]),'bad',null,1,{key:'0'.repeat(64)}),hasCode('CHECKSUM_MISMATCH'));
    assert.equal(calls,0);assert.deepEqual(h.workers[0].runtime.getCacheState(),{bytes:0,keys:[]});
  }finally{h.client.destroy();}
});

test('decoder and worker failures expose safe messages and codes without file-derived details',async()=>{
  const secret='PRIVATE^PATIENT /home/person/secret.dcm 2.25.123';
  const h=harness({decode:()=>{throw new Error(`Unsupported transfer syntax ${secret}`);}}),bytes=new Uint8Array([99]),key=await sha(bytes);
  try{
    await assert.rejects(h.client.decode(bytes,'private',null,1,{key}),error=>{
      assert.equal(error.code,'UNSUPPORTED_ENCODING');assert.ok(!error.message.includes(secret));return true;
    });
    const pending=h.client.decode(bytes,'private2',null,1,{key});const rejected=assert.rejects(pending,error=>{
      assert.equal(error.code,'DECODER_FAILED');assert.ok(!error.message.includes(secret));return true;
    });
    // Wait for the job to be queued, then fail the Worker before it can decode.
    let prevented=false;h.workers[0].emit('error',{message:secret,preventDefault:()=>{prevented=true;}});
    await rejected;assert.equal(prevented,true);assert.equal(h.workers[0].terminated,true);
  }finally{h.client.destroy();}
});

test('unavailable workers fail explicitly and never decode on the UI thread',async()=>{
  const client=createDecoderClient({workerFactory:()=>{throw new Error('Internal browser detail.');}});
  try{await assert.rejects(client.decode(new Uint8Array([1]),'no-worker',null,1,{key:await sha(new Uint8Array([1]))}),hasCode('DECODER_UNAVAILABLE'));}
  finally{client.destroy();}
});

test('the self-contained standalone bundle uses a classic Blob Worker for file compatibility',async()=>{
  const originalWorker=globalThis.Worker,originalSource=globalThis.DICOM_WORKER_SOURCE,created=[];
  globalThis.DICOM_WORKER_SOURCE='/* fixed local bundled IIFE */';
  globalThis.Worker=class extends ProtocolWorker{
    constructor(url,options){super();created.push({url,options});}
  };
  const client=createDecoderClient(),bytes=new Uint8Array([17]);
  try{
    const image=await client.decode(bytes,'disk-viewer',null,1,{key:await sha(bytes)});
    assert.equal(image.image.imageId,'disk-viewer');assert.equal(created.length,1);
    assert.ok(created[0].url.startsWith('blob:'));assert.equal(created[0].options.type,'classic');
  }finally{
    client.destroy();
    if(originalWorker===undefined)delete globalThis.Worker;else globalThis.Worker=originalWorker;
    if(originalSource===undefined)delete globalThis.DICOM_WORKER_SOURCE;else globalThis.DICOM_WORKER_SOURCE=originalSource;
  }
});

test('invalid frames, registration limits and oversized pixel replies fail with explicit codes',async()=>{
  const bytes=new Uint8Array([5,6]),key=await sha(bytes),h=harness({cacheBytes:1,allocationBytes:1});
  try{
    await assert.rejects(h.client.decode(bytes,'bad-frame',null,0,{key}),hasCode('INVALID_REQUEST'));
    await assert.rejects(h.client.decode(bytes,'too-large',null,1,{key}),hasCode('RESOURCE_LIMIT'));
  }finally{h.client.destroy();}
  const broken=harness({decode:()=>({image:{rows:100,columns:100,numberOfComponents:1,getPixelData:()=>new Uint16Array(1)}})});
  try{await assert.rejects(broken.client.decode(bytes,'bad-pixels',null,1,{key}),hasCode('DECODER_FAILED'));}
  finally{broken.client.destroy();}
});

test('the worker protocol decodes a real synthetic DICOM and preserves its encoded source',async()=>{
  const original=new Uint8Array(await readFile(new URL('../../fixtures/expanded/sc-native-gray8.dcm',import.meta.url))),before=original.slice(),messages=[];
  const runtime=createDecoderWorkerRuntime({postMessage:(message,transfers=[])=>messages.push(structuredClone(message,{transfer:transfers}))});
  const key=await sha(original);await runtime.handleMessage({type:'register',id:1,epoch:0,key,bytes:original});
  assert.equal(messages[0].type,'registered');await runtime.handleMessage({type:'decode',id:2,epoch:0,key,imageId:'synthetic',sourceFrame:1});
  await until(()=>messages.some(message=>message.type==='decoded'));
  const result=messages.find(message=>message.type==='decoded').result;
  assert.equal(typeof result.image.getPixelData,'undefined');assert.equal(result.pixels.length,result.image.rows*result.image.columns);
  assert.ok(result.pixels instanceof Uint16Array);assert.deepEqual(original,before);assert.equal(await sha(original),key);
});
