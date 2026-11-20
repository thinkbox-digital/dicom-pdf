import assert from 'node:assert/strict';
import test from 'node:test';
import {createArchiveVerifier} from '../archive-verification-client.mjs';

class FakeWorker extends EventTarget {
  messages=[];
  terminated=false;
  postMessage(message){this.messages.push(message);}
  terminate(){this.terminated=true;}
  send(type,details={}){
    const {id}=this.messages.at(-1);
    this.dispatchEvent(new MessageEvent('message',{data:{id,type,...details}}));
  }
}

test('certificate changes reuse the completed PDF verification worker until the archive closes',async()=>{
  const workers=[],verifier=createArchiveVerifier({workerFactory:()=>{
    const worker=new FakeWorker();workers.push(worker);return worker;
  }});
  const checksums={integrity:'PASS'},pdfSecurity={
    onChecksums:value=>assert.equal(value,checksums),onProgress:()=>{}
  };
  assert.equal(verifier.recheckTrust(pdfSecurity),null);
  try{
    const initial=verifier.verify({tasks:[]},()=>null,{pdfSecurity}),worker=workers[0];
    worker.send('checksums',{result:checksums});
    worker.send('result',{result:{...checksums,pdfSecurity:{trustStatus:'UNKNOWN'}}});
    assert.equal((await initial).pdfSecurity.trustStatus,'UNKNOWN');
    assert.equal(worker.terminated,false);

    const roots=[Uint8Array.of(1,2,3)];
    const recheck=verifier.recheckTrust({...pdfSecurity,sessionRoots:roots});
    assert.equal(workers.length,1);
    assert.equal(worker.messages.at(-1).type,'recheck-trust');
    assert.equal(worker.messages.at(-1).plan,null);
    assert.equal(worker.messages.at(-1).sessionRoots,roots);
    worker.send('result',{result:{...checksums,pdfSecurity:{trustStatus:'PASS'}}});
    assert.equal((await recheck).pdfSecurity.trustStatus,'PASS');

    const clear=verifier.recheckTrust(pdfSecurity);
    assert.equal(worker.messages.at(-1).sessionRoots,undefined);
    worker.send('error');
    const incomplete=await clear;
    assert.equal(incomplete.integrity,'PASS');
    assert.equal(incomplete.pdfSecurity.status,'UNKNOWN');
    assert.equal(worker.terminated,true);
    assert.equal(verifier.recheckTrust(pdfSecurity),null);

    const next=verifier.verify({tasks:[]},()=>null,{pdfSecurity}),another=workers[1];
    another.send('checksums',{result:checksums});
    another.send('result',{result:{...checksums,pdfSecurity:{trustStatus:'UNKNOWN'}}});
    await next;
    verifier.cancel();
    assert.equal(another.terminated,true);
    assert.equal(verifier.recheckTrust(pdfSecurity),null);
  }finally{verifier.destroy();}
});
