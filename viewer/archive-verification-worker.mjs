import {verifyArchivePlan} from './archive-verification.mjs';
import {prepareSecurity} from './security-validation.ts';
import {sha256} from './security-hash.mjs';
import {selectTrustRoots} from './security-trust-selection.ts';
const pending=new Map();let request=0,checksums=null,assessTrust=null;
self.addEventListener('message',event=>{
  const message=event.data;
  if(message?.type==='choose-trust'){
    selectTrustRoots(message.files,message.roots,message.single===true)
      .then(selection=>self.postMessage({selection}))
      .catch(error=>self.postMessage({error:error.message}));
    return;
  }
  if(message?.type==='response'){
    pending.get(message.request)?.(message.value);pending.delete(message.request);return;
  }
  if(message?.type==='file'||message?.type==='chunk'){pending.get(message.request)?.(message.type==='file'?message.file:message.bytes);pending.delete(message.request);return;}
  if(message?.type!=='verify'&&message?.type!=='recheck-trust')return;
  const id=message.id;
  const ask=(type,extra)=>new Promise(resolve=>{const token=++request;pending.set(token,resolve);self.postMessage({type,id,request:token,...extra});});
  const progress=detail=>self.postMessage({type:'security-progress',id,detail});
  let sources;
  const loadTimestampSources=()=>sources??=ask('timestamp-sources',{});
  async function run(){
    let started=performance.now();
    if(message.type==='verify'){
      let manifestSigner;
      checksums=await verifyArchivePlan(message.plan,async (name,options)=>{
        const file=await ask('need',{name,forDigest:options?.forDigest===true});if(!file)return null;
        return {size:file.size,verifiedDigest:file.verifiedDigest,slice(start,end){return {async arrayBuffer(){return (await ask('chunk',{name,start,end})).buffer;}};}};
      },{onDigest:(name,digest)=>self.postMessage({type:'digest',id,name,digest}),
        onManifestSigner:signer=>{manifestSigner=signer;},
        onProgress:progress=>self.postMessage({type:'progress',id,progress})});
      if(message.pdfSecurity){
        self.postMessage({type:'checksums',id,result:checksums});
        const input=await ask('security-input',{});
        if(input){
          input.manifestDigest=await sha256(input.manifestBytes);
          started=performance.now();
          assessTrust=await prepareSecurity({...input,manifestSigner},progress,
            (ends,hasCredentials)=>ask('security-revisions',{ends,hasCredentials}),
            loadTimestampSources);
        }
      }
    }
    const result=structuredClone(checksums);
    if(assessTrust){
      const source=message.sessionRoots?.length?'SESSION':DICOM_TRUST_ROOTS.length?'BUILD':'NONE';
      const roots=source==='SESSION'?message.sessionRoots
        :DICOM_TRUST_ROOTS.map(value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0)));
      result.pdfSecurity=await assessTrust({roots,source,signerCertificateOrigin:message.signerCertificateOrigin},progress,loadTimestampSources,started);
      recordSecurityChecks(result);
    }
    self.postMessage({type:'result',id,result});
  }
  run().catch(()=>self.postMessage({type:'error',id,code:'ARCHIVE_CHECK_FAILED'}));
});

function recordSecurityChecks(result){
  const {pdfSecurity,checks}=result;
  const get=name=>pdfSecurity.checks.find(row=>row.name===name);
  const checked=(row,code)=>({status:row.status,code});
  const c2pa=get('C2PA file binding')??get('C2PA validation')??get('C2PA credential discovery')??get('Declared C2PA credentials');
  if(c2pa)checks.c2paCredentials=checked(c2pa,'OFFLINE_C2PA_VALIDATION');
  const trust=get('Manifest signer trust'),revocation=get('Manifest signer revocation');
  if(trust)checks.certificateTrust=checked(trust,'OFFLINE_MANIFEST_SIGNER_PATH');
  if(revocation)checks.revocation=checked(revocation,'OFFLINE_MANIFEST_SIGNER_REVOCATION');
  const time=pdfSecurity.checks.find(row=>row.status==='PASS'&&row.name.endsWith('trusted signing time'));
  if(time)checks.trustedTime=checked(time,'VERIFIED_SIGNATURE_TIMESTAMP');
  if(trust?.status==='PASS'&&revocation?.status==='PASS'&&pdfSecurity.status==='PASS'&&result.integrity==='PASS'){
    checks.exporterIdentity=checked(trust,'OFFLINE_MANIFEST_SIGNER_PATH_AND_REVOCATION');
    result.assurance='OFFLINE_MANIFEST_SIGNER_VERIFIED';
  }
}
