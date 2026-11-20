import {sha256File} from './streaming-sha256.mjs';
import {archiveSigningDetails} from './archive-signing-details.mjs';
import {CMS_LIMIT,MANIFEST_SIGNATURE_LIMIT,verifyManifestSignature} from './manifest-signature.mjs';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const abort=()=>new DOMException('File check cancelled.','AbortError');
function invalid(){const error=new Error('The archive inventory could not be checked safely.');error.code='INVALID_ARCHIVE_INVENTORY';return error;}
export function buildArchiveVerificationPlan(manifest,attachments,manifestSidecar){
  if(!manifest||!Array.isArray(manifest.images))throw invalid();
  const byName=new Map(),tasks=[],declared=new Set(['manifest.json','manifest.sha256']);
  for(const file of Object.values(attachments||{})){
    if(typeof file?.filename!=='string'||byName.has(file.filename))throw invalid();
    byName.set(file.filename,file);
  }
  const originals=new Set();
  for(const source of manifest.images){
    if(typeof source?.attachment!=='string'||!source.attachment||originals.has(source.attachment)||declared.has(source.attachment)||!hash(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0)throw invalid();
    originals.add(source.attachment);declared.add(source.attachment);
    tasks.push({attachment:source.attachment,kind:'original',sha256:source.sha256.toLowerCase(),size:source.size});
  }
  let artifactInventory='UNKNOWN';
  if(manifest.artifactSha256&&typeof manifest.artifactSha256==='object'&&!Array.isArray(manifest.artifactSha256)){
    artifactInventory='PASS';
    for(const [name,sha256] of Object.entries(manifest.artifactSha256)){
      if(!name||declared.has(name)||!hash(sha256))throw invalid();
      declared.add(name);tasks.push({attachment:name,kind:'artifact',sha256:sha256.toLowerCase()});
    }
  }
  const security=manifest.security;
  const c2paDeclared=manifest.profileVersion==='0.4.0'&&hash(manifest.artifactSha256?.['c2pa-policy.json']);
  if(c2paDeclared)declared.add('content-credentials.c2pa');
  if(security?.schemaVersion===1&&security.manifestSignature==='manifest.p7s')declared.add('manifest.p7s');
  const unexpected=[...byName.keys()].filter(name=>!declared.has(name));
  const missing=[...declared].filter(name=>!byName.has(name));
  const sidecar=byName.get('manifest.sha256');let manifestHash=null;
  if(sidecar){
    const data=manifestSidecar??sidecar.content;
    if(!(data instanceof Uint8Array)||data.byteLength>256)throw invalid();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(data);
    const match=/^([a-f0-9]{64})\x20{2}manifest\.json\n$/.exec(text);
    if(!match)throw invalid();manifestHash=match[1];
  }
  if(manifestHash)tasks.push({attachment:'manifest.json',kind:'manifest',sha256:manifestHash});
  const checks={
    c2paCredentials:{status:c2paDeclared?'UNKNOWN':'NOT_APPLICABLE',code:c2paDeclared?'C2PA_SECURITY_CHECK_PENDING':'NO_C2PA_DECLARATION'},
    attachmentInventory:{status:artifactInventory==='PASS'?(unexpected.length||missing.length?'FAIL':'PASS'):'UNKNOWN',code:'DECLARED_ATTACHMENT_SET',missing:missing.length,unexpected:unexpected.length},
    manifestChecksum:{status:manifestHash?'PASS':manifest.schemaVersion===2?'FAIL':'UNKNOWN',code:manifestHash?'SIDECAR_PRESENT_CONTENT_CHECK_PENDING':'MANIFEST_SIDECAR_UNAVAILABLE'},
    exporterIdentity:{status:'UNKNOWN',code:security?'SIGNATURE_DECLARED_NOT_VERIFIED_IN_BROWSER':'NO_VERIFIED_EXPORT_SIGNATURE'},
    trustedTime:{status:'UNKNOWN',code:'TIMESTAMP_TRUST_NOT_VERIFIED_IN_BROWSER'},
    acquisitionProvenance:{status:'UNKNOWN',code:'ACQUISITION_NOT_AUTHENTICATED'},
    clinicalCompleteness:{status:'UNKNOWN',code:'CLINICAL_COMPLETENESS_NOT_ASSESSED'}
  };
  const manifestSignature=security?.schemaVersion===1&&security.manifestSignature==='manifest.p7s'?{attachment:'manifest.p7s',manifest:'manifest.json',expectedFingerprint:security.issuerCertificateSha256}:null;
  return {schemaVersion:1,tasks,checks,manifestSignature,signatureDeclared:!!security,signingEvidence:archiveSigningDetails(manifest,attachments)};
}

/** Runs in a disposable worker; one attachment is read/hashed at a time. */
export async function verifyArchivePlan(plan,getFile,{digest=null,onDigest=()=>{},onProgress=()=>{},onManifestSigner,signal,crypto=globalThis.crypto,now=new Date()}={}){
  if(!Array.isArray(plan?.tasks))throw invalid();
  const checks=structuredClone(plan.checks),files=[];let total=0;
  for(const task of plan.tasks){
    if(signal?.aborted)throw abort();
    const file=await getFile(task.attachment,{forDigest:true});if(signal?.aborted)throw abort();
    let status='FAIL',code='ATTACHMENT_MISSING',size=null;
    if(file){
      size=file.size;
      if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(total+=size))throw invalid();
      if(task.size!=null&&size!==task.size)code='BYTE_LENGTH_MISMATCH';
      else{
        let actual;
        if(hash(file.verifiedDigest))actual=file.verifiedDigest;
        else {
          if(digest){const bytes=await file.arrayBuffer();if(signal?.aborted)throw abort();actual=Array.from(new Uint8Array(await digest(bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
          else actual=await sha256File(file,{signal});
          onDigest(task.attachment,actual);
        }
        status=actual===task.sha256?'PASS':'FAIL';code=status==='PASS'?'RECORDED_SHA256_MATCH':'SHA256_MISMATCH';
      }
    }
    files.push({attachment:task.attachment,kind:task.kind,status,code,size});
    if(task.kind==='manifest')checks.manifestChecksum={status,code};
    onProgress({checked:files.length,total:plan.tasks.length});
  }
  const originals=files.filter(file=>file.kind==='original'),artifacts=files.filter(file=>file.kind==='artifact');
  const group=rows=>({status:rows.every(row=>row.status==='PASS')?'PASS':'FAIL',checked:rows.length,matched:rows.filter(row=>row.status==='PASS').length});
  checks.originalBytes={...group(originals),code:'AGREEMENT_WITH_RECORDED_MANIFEST_ONLY'};
  checks.generatedArtifacts=artifacts.length?{...group(artifacts),code:'HASHED_PACKAGE_ARTIFACTS'}:{status:'UNKNOWN',code:'NO_ARTIFACT_HASH_INVENTORY'};
  let manifestSigning=null;
  if(plan.manifestSignature){
    const read=async(name,limit)=>{
      if(signal?.aborted)throw abort();
      const file=await getFile(name);
      if(!file||!Number.isSafeInteger(file.size)||file.size<0)return null;
      if(file.size>limit)return new Uint8Array(limit+1);
      const bytes=new Uint8Array(file.size);
      for(let offset=0;offset<file.size;offset+=1024*1024){
        if(signal?.aborted)throw abort();
        const chunk=new Uint8Array(await file.slice(offset,Math.min(offset+1024*1024,file.size)).arrayBuffer());
        if(chunk.length!==Math.min(1024*1024,file.size-offset))throw invalid();
        bytes.set(chunk,offset);
      }
      if(signal?.aborted)throw abort();
      return bytes;
    };
    const manifest=await read(plan.manifestSignature.manifest,MANIFEST_SIGNATURE_LIMIT),cms=await read(plan.manifestSignature.attachment,CMS_LIMIT);
    manifestSigning=await verifyManifestSignature(manifest,cms,plan.manifestSignature.expectedFingerprint,{crypto,now,onSigner:onManifestSigner});
    if(signal?.aborted)throw abort();
    Object.assign(checks,manifestSigning.checks);
  }
  const failed=Object.values(checks).some(check=>check.status==='FAIL');
  const incomplete=['attachmentInventory','manifestChecksum','generatedArtifacts'].some(name=>checks[name].status==='UNKNOWN');
  return {schemaVersion:1,implementation:'offline-viewer-checks-2',assurance:!failed&&checks.manifestSignature?.status==='PASS'&&checks.signerCertificateBinding?.status==='PASS'?'MANIFEST_SIGNATURE_VALID_IDENTITY_UNVERIFIED':'CHECKSUMS_ONLY',checks,files,
    signingEvidence:plan.signingEvidence,manifestSigning,
    integrity:failed?'FAIL':incomplete?'UNKNOWN':'PASS',originals:originals.length,matchedOriginals:checks.originalBytes.matched};
}
