import test from 'node:test';
import assert from 'node:assert/strict';
import {createIngestionClient} from '../ingestion-client.mjs';

class FakeWorker {
  listeners=new Map();sent=[];terminated=0;
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  postMessage(message,...transfer){this.sent.push({original:message,copy:structuredClone(message),transfer});}
  emit(type,event){for(const listener of this.listeners.get(type)||[])listener(event);}
  reply(type,extra={},id=this.sent.at(-1).original.id){this.emit('message',{data:{type,id,...extra}});}
  terminate(){this.terminated++;}
}
function harness(){
  const workers=[];let disposals=0;
  const client=createIngestionClient({workerFactory:()=>{const worker=new FakeWorker();workers.push(worker);return {worker,dispose:()=>disposals++};}});
  return {client,workers,get disposals(){return disposals;}};
}
function input(name='IMAGE',size=3){
  const blob=new Blob([new Uint8Array([1,2,3])]);Object.defineProperties(blob,{name:{value:name},size:{value:size}});return blob;
}
const code=expected=>error=>error.name==='InputIngestionError'&&error.code===expected;

test('immutable Blob handles retain folder paths and reach the worker without UI reads',async()=>{
  const h=harness(),file=new Blob([new Uint8Array([0,255,3])]);let reads=0;
  Object.defineProperties(file,{name:{value:'IMAGE001'},webkitRelativePath:{value:'MEDIA/IMAGES/IMAGE001'},
    arrayBuffer:{value:()=>{reads++;throw new Error('UI file read');}}});
  const pending=h.client.ingest([file]),worker=h.workers[0],sent=worker.sent[0];
  assert.equal(reads,0);assert.equal(sent.original.inputs[0].blob,file);assert.equal(sent.original.inputs[0].sourcePath,'MEDIA/IMAGES/IMAGE001');
  assert.equal(sent.original.inputs[0].name,'IMAGE001');assert.equal(sent.transfer.length,0);
  assert.deepEqual(new Uint8Array(await sent.copy.inputs[0].blob.arrayBuffer()),new Uint8Array([0,255,3]));
  worker.reply('result',{result:{entries:[]}});await pending;assert.equal(reads,0);assert.equal(worker.terminated,1);assert.equal(h.disposals,1);
});

test('worker-safe byte inputs are cloned by messaging without detaching caller buffers',async()=>{
  const h=harness(),bytes=new Uint8Array([7,8,9]),pending=h.client.ingest([{name:'source',sourcePath:'IMAGES/IMAGE001',bytes}]);
  const worker=h.workers[0],sent=worker.sent[0];assert.equal(bytes.byteLength,3);assert.equal(sent.original.inputs[0].sourcePath,'IMAGES/IMAGE001');
  bytes[0]=99;assert.deepEqual(sent.copy.inputs[0].bytes,new Uint8Array([7,8,9]));assert.equal(sent.transfer.length,0);
  worker.reply('result',{result:{entries:[]}});await pending;
});

test('progress and result lifecycle ignores mismatched IDs and disposes once',async()=>{
  const h=harness(),progress=[],pending=h.client.ingest([input()],{onProgress:value=>progress.push(value)}),worker=h.workers[0];
  worker.reply('progress',{progress:{phase:'checking',completed:999}},999);
  worker.reply('progress',{progress:{phase:'checking',completed:1,bytes:3}});
  worker.reply('result',{result:{wrong:true}},999);
  const result={schemaVersion:1,inputKind:'direct-dicom',entries:[]};worker.reply('result',{result});
  assert.equal(await pending,result);assert.deepEqual(progress,[{phase:'checking',completed:1,bytes:3}]);assert.equal(worker.terminated,1);assert.equal(h.disposals,1);
  worker.reply('progress',{progress:{phase:'late'}});worker.reply('error',{code:'RESOURCE_LIMIT'});
  assert.equal(progress.length,1);assert.equal(worker.terminated,1);h.client.clear();h.client.destroy();assert.equal(h.disposals,1);
});

test('progress callback exceptions cannot prevent successful worker completion',async()=>{
  const h=harness(),pending=h.client.ingest([input()],{onProgress:()=>{throw new Error('Synthetic UI callback');}}),worker=h.workers[0];
  worker.reply('progress',{progress:{phase:'checking'}});worker.reply('result',{result:{done:true}});assert.deepEqual(await pending,{done:true});
});

test('replacement terminates the old reader and stale replies cannot resolve the new request',async()=>{
  const h=harness(),old=h.client.ingest([input('old')]),rejected=assert.rejects(old,{name:'AbortError'}),worker=h.workers[0];
  const stale=[...worker.listeners.get('message')],next=h.client.ingest([input('new')]),newWorker=h.workers[1];
  await rejected;assert.equal(worker.terminated,1);assert.equal(h.disposals,1);
  for(const listener of stale)listener({data:{id:worker.sent[0].original.id,type:'result',result:{stale:true}}});
  newWorker.reply('result',{result:{current:true}});assert.deepEqual(await next,{current:true});assert.equal(h.disposals,2);
});

test('abort, clear and destroy terminate readers and reject their pending operations',async()=>{
  for(const action of ['abort','clear','destroy']){
    const h=harness(),controller=new AbortController(),pending=h.client.ingest([input()],{signal:controller.signal});
    const rejected=assert.rejects(pending,{name:'AbortError'}),worker=h.workers[0];
    if(action==='abort')controller.abort();else h.client[action]();
    await rejected;assert.equal(worker.terminated,1);assert.equal(h.disposals,1);h.client.destroy();assert.equal(h.disposals,1);
    await assert.rejects(h.client.ingest([input()]),code('INPUT_WORKER_UNAVAILABLE'));assert.equal(h.workers.length,1);
  }
});

test('an already aborted request creates no worker and does not cancel an existing read',async()=>{
  const h=harness(),active=h.client.ingest([input()]),controller=new AbortController();controller.abort();
  await assert.rejects(h.client.ingest([input()],{signal:controller.signal}),{name:'AbortError'});assert.equal(h.workers.length,1);assert.equal(h.workers[0].terminated,0);
  h.workers[0].reply('result',{result:{done:true}});await active;
});

test('invalid sizes fail before worker creation; larger files and collections reach the worker',async()=>{
  const h=harness(),MiB=1024*1024;
  for(const files of [[],[input('negative',-1)],[input('fraction',1.5)],[input('infinite',Infinity)],[{name:'unknown'}]]){
    await assert.rejects(h.client.ingest(files),code('RESOURCE_LIMIT'));assert.equal(h.workers.length,0);
  }
  const many=h.client.ingest(Array.from({length:10001},()=>input()));
  assert.equal(h.workers.length,1);h.workers[0].reply('result',{result:{done:true}});await many;
  // Boundary values use Blob-like handles and allocate no large byte arrays.
  const pending=h.client.ingest(Array.from({length:3},()=>input('boundary',385*MiB)));
  assert.equal(h.workers.length,2);h.workers[1].reply('result',{result:{done:true}});await pending;
});

test('worker startup, protocol and browser failures expose generic errors without source details',async()=>{
  const secret='SYNTHETIC^PRIVATE /private/example.dcm 2.25.123';
  const unavailable=createIngestionClient({workerFactory:()=>{throw new Error(secret);}});
  await assert.rejects(unavailable.ingest([input()]),error=>{assert.equal(error.code,'INPUT_WORKER_UNAVAILABLE');assert.ok(!error.message.includes(secret));return true;});
  for(const type of ['error','messageerror']){
    const h=harness(),pending=h.client.ingest([input()]);let prevented=false;
    h.workers[0].emit(type,{message:secret,preventDefault(){prevented=true;}});
    await assert.rejects(pending,error=>{assert.equal(error.code,'INPUT_WORKER_FAILED');assert.ok(!error.message.includes(secret));return true;});
    assert.equal(prevented,true);assert.equal(h.workers[0].terminated,1);
  }
  const h=harness(),pending=h.client.ingest([input()]);h.workers[0].reply('error',{code:'RESOURCE_LIMIT',message:secret});
  await assert.rejects(pending,error=>{assert.equal(error.code,'RESOURCE_LIMIT');assert.ok(!error.message.includes(secret));return true;});
});

test('unrecognized worker error codes cannot expose arbitrary source text',async()=>{
  const h=harness(),pending=h.client.ingest([input()]),secret='SYNTHETIC^PRIVATE';h.workers[0].reply('error',{code:secret});
  await assert.rejects(pending,error=>{assert.ok(!error.message.includes(secret));assert.ok(!String(error.code).includes(secret));return true;});
});

test('a postMessage failure also terminates and disposes the reader',async()=>{
  const worker=new FakeWorker();let disposed=0;worker.postMessage=()=>{throw new Error('Synthetic clone failure');};
  const client=createIngestionClient({workerFactory:()=>({worker,dispose:()=>disposed++})});
  await assert.rejects(client.ingest([input()]),code('INPUT_WORKER_FAILED'));assert.equal(worker.terminated,1);assert.equal(disposed,1);
});
