import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {buildArchiveVerificationPlan,verifyArchivePlan} from '../archive-verification.mjs';
import {createArchiveVerifier} from '../archive-verification-client.mjs';
const encode=value=>new TextEncoder().encode(value),digest=bytes=>webcrypto.subtle.digest('SHA-256',bytes);
const hash=async bytes=>Array.from(new Uint8Array(await digest(bytes)),n=>n.toString(16).padStart(2,'0')).join('');
async function fixture(){
  const bytes=encode('unchanged synthetic original'),artifact=encode('synthetic profile');
  const manifest={schemaVersion:2,images:[{attachment:'first.dcm',size:bytes.length,sha256:await hash(bytes),sopInstanceUID:'1.2.3',status:'rendered'},{attachment:'duplicate.dcm',size:bytes.length,sha256:await hash(bytes),sopInstanceUID:'1.2.3',status:'unrendered'}],artifactSha256:{'profile.json':await hash(artifact)}};
  const raw=encode(JSON.stringify(manifest));
  const attachments=Object.fromEntries([['first.dcm',bytes],['duplicate.dcm',bytes.slice()],['profile.json',artifact],['manifest.json',raw],['manifest.sha256',encode(await hash(raw)+'  manifest.json\n')]].map(([filename,content])=>[filename,{filename,content}]));
  return {manifest,attachments};
}
async function check(model,options={}){
  return verifyArchivePlan(buildArchiveVerificationPlan(model.manifest,model.attachments),name=>model.attachments[name]?new Blob([model.attachments[name].content]):null,{digest,...options});
}
test('checks every original including unrenderable duplicate IDs without changing bytes',async()=>{
  const model=await fixture(),before=model.attachments['first.dcm'].content.slice(),progress=[];
  const result=await check(model,{onProgress:value=>progress.push(value)});
  assert.equal(result.integrity,'PASS');assert.equal(result.matchedOriginals,2);assert.equal(result.files.length,4);
  assert.equal(result.checks.exporterIdentity.status,'UNKNOWN');assert.equal(result.checks.clinicalCompleteness.status,'UNKNOWN');
  assert.equal(progress.at(-1).checked,4);assert.deepEqual(model.attachments['first.dcm'].content,before);
});
test('missing originals, modified bytes and modified manifest never pass',async()=>{
  let model=await fixture();delete model.attachments['duplicate.dcm'];
  let result=await check(model);assert.equal(result.integrity,'FAIL');assert.equal(result.files.find(file=>file.attachment==='duplicate.dcm').code,'ATTACHMENT_MISSING');
  model=await fixture();model.attachments['first.dcm'].content[0]^=1;result=await check(model);assert.equal(result.integrity,'FAIL');
  model=await fixture();model.attachments['manifest.json'].content[0]^=1;result=await check(model);assert.equal(result.checks.manifestChecksum.status,'FAIL');
});
test('undeclared attachments and duplicate recovery names cannot be hidden',async()=>{
  const model=await fixture();model.attachments.extra={filename:'unlisted.bin',content:encode('x')};
  assert.equal((await check(model)).checks.attachmentInventory.status,'FAIL');
  model.attachments.extra.filename='first.dcm';assert.throws(()=>buildArchiveVerificationPlan(model.manifest,model.attachments));
});
test('C2PA requires its declared attachment and remains unverified in the browser',async()=>{
  const model=await fixture();model.manifest.profileVersion='0.4.0';
  const policy=encode('synthetic policy');model.manifest.artifactSha256['c2pa-policy.json']=await hash(policy);
  model.attachments['c2pa-policy.json']={filename:'c2pa-policy.json',content:policy};
  let result=await check(model);assert.equal(result.checks.attachmentInventory.status,'FAIL');
  model.attachments['content-credentials.c2pa']={filename:'content-credentials.c2pa',content:encode('unverified credentials')};
  result=await check(model);assert.equal(result.checks.attachmentInventory.status,'PASS');assert.equal(result.checks.c2paCredentials.status,'UNKNOWN');assert.equal(result.assurance,'CHECKSUMS_ONLY');
});
test('signature declarations remain unverified and a missing declared signature fails inventory',async()=>{
  const model=await fixture();model.manifest.security={schemaVersion:1,manifestSignature:'manifest.p7s'};
  let result=await check(model);assert.equal(result.integrity,'FAIL');assert.equal(result.checks.exporterIdentity.status,'UNKNOWN');
  model.attachments['manifest.p7s']={filename:'manifest.p7s',content:encode('not a verified signature')};
  result=await check(model);assert.equal(result.checks.exporterIdentity.status,'UNKNOWN');assert.equal(result.assurance,'CHECKSUMS_ONLY');
  assert.equal(result.signingEvidence.manifestSignaturePresent,true);assert.equal(result.signingEvidence.verification,'UNKNOWN');
});
test('legacy gaps remain unknown and invalid source mappings are rejected',async()=>{
  const model=await fixture();delete model.manifest.artifactSha256;
  assert.equal((await check(model)).integrity,'UNKNOWN');
  model.manifest.images[1].attachment='first.dcm';assert.throws(()=>buildArchiveVerificationPlan(model.manifest,model.attachments));
});
test('cancellation stops before hashing a pending file',async()=>{
  const model=await fixture(),controller=new AbortController();let hashed=false;
  await assert.rejects(verifyArchivePlan(buildArchiveVerificationPlan(model.manifest,model.attachments),()=>{controller.abort();return new Blob([encode('x')]);},{signal:controller.signal,digest:()=>{hashed=true;}}),{name:'AbortError'});
  assert.equal(hashed,false);
});
class FakeWorker extends EventTarget {
  messages=[];terminated=false;
  postMessage(data){this.messages.push(data);}
  terminate(){this.terminated=true;}
  send(data){this.dispatchEvent(new MessageEvent('message',{data}));}
}
test('worker jobs cancel on document replacement and late results are ignored',async()=>{
  const workers=[],client=createArchiveVerifier({workerFactory:()=>{const worker=new FakeWorker();workers.push(worker);return worker;}});
  const model=await fixture(),plan=buildArchiveVerificationPlan(model.manifest,model.attachments);
  const first=client.verify(plan,()=>null);const rejected=assert.rejects(first,{name:'AbortError'});
  const second=client.verify(plan,()=>null);await rejected;assert.equal(workers[0].terminated,true);
  workers[0].send({type:'result',id:1,result:{wrong:true}});
  workers[1].send({type:'result',id:2,result:{correct:true}});assert.deepEqual(await second,{correct:true});assert.equal(workers[1].terminated,true);
});
test('worker can request only planned attachments and unavailable workers fail explicitly',async()=>{
  const model=await fixture(),plan=buildArchiveVerificationPlan(model.manifest,model.attachments),worker=new FakeWorker();
  const client=createArchiveVerifier({workerFactory:()=>worker});const pending=client.verify(plan,()=>{throw new Error('must not access unknown source');});
  worker.send({type:'need',id:1,request:1,name:'unexpected.bin'});await assert.rejects(pending);assert.equal(worker.terminated,true);
  const unavailable=createArchiveVerifier({workerFactory:()=>{throw new Error();}});await assert.rejects(unavailable.verify(plan,()=>null));
});
test('background reads yield to foreground image work and resume after it finishes',async()=>{
  const model=await fixture(),plan=buildArchiveVerificationPlan(model.manifest,model.attachments),worker=new FakeWorker();let busy=true,reads=0;
  const client=createArchiveVerifier({workerFactory:()=>worker});
  const pending=client.verify(plan,name=>{reads++;return model.attachments[name];},{canRun:()=>!busy});
  worker.send({type:'need',id:1,request:1,name:'first.dcm'});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(reads,0);busy=false;
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(reads,1);assert.equal(worker.messages.at(-1).type,'file');
  worker.send({type:'result',id:1,result:{integrity:'PASS'}});assert.equal((await pending).integrity,'PASS');client.destroy();
});
