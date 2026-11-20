/* Adapted from EA-PDF Generator (Copyright 2026 ThinkBox Digital), Apache-2.0. */
import {Sequence,OctetString,ObjectIdentifier,Null} from 'asn1js';
import {sha256} from './security-hash.mjs';
import {verifyCms,requireSecurity,UnsupportedSecurity,SHA256,hex} from './security-cms.js';
import {verifyC2pa} from './security-c2pa.js';
import {OfflineTrust} from './security-trust.js';
import type {CreatorArchiveFacts,CreatorArchiveRevision,PdfRangeHasher,PdfSignatureFacts,SecurityInput,SecurityReport,SecurityEvidence,TimestampAnchor} from './security-types.js';

export type VerifiedPdfSignature={facts:PdfSignatureFacts;end:number;gap:[number,number];cms:Awaited<ReturnType<typeof verifyCms>>;stamp?:Awaited<ReturnType<typeof verifyCms>>};
const unsupported=(condition:unknown,message:string)=>{if(!condition)throw new UnsupportedSecurity(message);};
const sameBytes=(a?:Uint8Array,b?:Uint8Array)=>a===b||!!a&&!!b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
const sameSignature=(a:PdfSignatureFacts,b:PdfSignatureFacts)=>a.type===b.type&&a.subFilter===b.subFilter&&a.byteRange.length===b.byteRange.length&&a.byteRange.every((v,i)=>v===b.byteRange[i])&&sameBytes(a.contents,b.contents);
const freshReport=(report:SecurityReport):SecurityReport=>({...report,checks:[],certificates:[]});

/** DICOM export signatures and supported TSAs use SHA-256 ESSCertIDv2. */
export async function checkSignerBinding(cms:Awaited<ReturnType<typeof verifyCms>>){
  unsupported(!cms.timestampInfo||cms.timestampInfo.version===1&&!cms.timestampInfo.extensions?.some(extension=>extension.critical),'Unsupported critical timestamp extension or timestamp version.');
  const attributes=cms.signed.signerInfos[0]!.signedAttrs!.attributes.filter(a=>a.type==='1.2.840.113549.1.9.16.2.47');
  requireSecurity(attributes.length===1&&attributes[0]!.values.length===1,'Missing or ambiguous SigningCertificateV2 signed attribute.');
  const value=attributes[0]!.values[0];
  unsupported(value instanceof Sequence&&value.valueBlock.value.length===1,'Unsupported SigningCertificateV2 structure.');
  const certs=(value as Sequence).valueBlock.value[0];
  unsupported(certs instanceof Sequence&&certs.valueBlock.value.length===1,'Unsupported ESS certificate list.');
  const identifier=(certs as Sequence).valueBlock.value[0];
  unsupported(identifier instanceof Sequence,'Unsupported ESS certificate identifier.');
  const parts=[...(identifier as Sequence).valueBlock.value];
  if(parts[0] instanceof Sequence){
    const algorithm=parts.shift() as Sequence,oid=algorithm.valueBlock.value[0];
    unsupported(oid instanceof ObjectIdentifier&&oid.valueBlock.toString()===SHA256&&algorithm.valueBlock.value.length<=2&&(algorithm.valueBlock.value.length===1||algorithm.valueBlock.value[1] instanceof Null),'Unsupported ESS certificate hash.');
  }
  unsupported(parts.length===1&&parts[0] instanceof OctetString,'Unsupported ESS issuer/serial or certificate hash.');
  requireSecurity(hex((parts[0] as OctetString).valueBlock.valueHexView)===await sha256(new Uint8Array(cms.signer.toSchema().toBER(false))),'Signed ESS certificate hash does not identify this signer.');
}

/** Strict support for our signed profile; this is not a general PDF change classifier. */
export async function prepareCreatorArchive(input:SecurityInput,facts:CreatorArchiveFacts,verified:VerifiedPdfSignature[],report:SecurityReport,hashCovered:PdfRangeHasher,check:()=>void,progress:(message:string)=>void,currentClaim?:Awaited<ReturnType<typeof verifyC2pa>>){
  requireSecurity(facts.status!=='INVALID',facts.detail??'Invalid saved creator revision.');
  unsupported(facts.schemaVersion===1&&facts.status==='COMPLETE'&&facts.revisions?.length,'Saved creator revisions are unavailable: '+(facts.detail??'unsupported extraction'));
  const revisions=facts.revisions!,first=revisions[0]!,last=revisions.at(-1)!;
  requireSecurity(revisions.length<=128&&first.signatures.length===1&&last.end===input.blob.size,'Incomplete creator archive history.');
  unsupported(verified.length>=(input.files?.credentials?3:2)&&verified[0]?.facts.type==='Sig'&&verified.slice(1).every(s=>s.facts.type==='DocTimeStamp'),'DICOM archive requires an export signature and archival document timestamps.');
  const finalSignatures=last.signatures;
  requireSecurity(finalSignatures.length===verified.length&&finalSignatures.every((s,i)=>sameSignature(s,verified[i]!.facts)),'Current and historical signature inventories disagree.');
  const signedRevisions=new Map<number,CreatorArchiveRevision>();
  const evidenceKinds=['certificates','crls','ocsps']as const;
  const retained={certificates:new Map<string,Uint8Array>(),crls:new Map<string,Uint8Array>(),ocsps:new Map<string,Uint8Array>()};
  const sealedEvidence=new Map<number,SecurityEvidence>();
  let prior:CreatorArchiveRevision|undefined;
  for(const revision of revisions){
    check();
    requireSecurity(revision.protectedSha256===first.protectedSha256,'Protected pages, attachments, metadata, document information or ordinary annotations changed after export.');
    requireSecurity(revision.signatures.length>0&&revision.signatures.length<=verified.length&&revision.signatureRefs.length===revision.signatures.length&&revision.fieldNames.length===revision.signatures.length,'Invalid historical signature inventory.');
    requireSecurity(revision.signatures.every((s,i)=>sameSignature(s,verified[i]!.facts)),'An earlier signature was removed, changed or replaced.');
    requireSecurity(sameBytes(revision.policy,input.files?.policy),'The creator security policy changed after export.');
    const newest=verified[revision.signatures.length-1]!;
    requireSecurity(newest.end<=revision.end,'A saved revision refers to a signature from a later revision.');
    if(newest.end===revision.end){requireSecurity(!signedRevisions.has(newest.end),'Duplicate signed revision.');signedRevisions.set(newest.end,revision);}
    if(prior){
      requireSecurity(revision.end>prior.end&&revision.previousXRef===prior.startXRef&&revision.startXRef>prior.startXRef,'DICOM saved revisions are not a continuous chain.');
      requireSecurity(revision.signatures.length===prior.signatures.length||revision.signatures.length===prior.signatures.length+1,'Unexpected archival signature additions.');
      requireSecurity(prior.fieldNames.every((name,i)=>name===revision.fieldNames[i]),'An earlier signature field label changed.');
      requireSecurity(prior.signatureRefs.every((ref,i)=>ref===revision.signatureRefs[i]),'Earlier signature objects were replaced.');
      if(revision.signatures.length===prior.signatures.length)requireSecurity(sameBytes(revision.credentials,prior.credentials)&&revision.credentialOffset===prior.credentialOffset,'Credentials changed in an unsigned evidence revision.');
      else requireSecurity(newest.end===revision.end,'New timestamp does not seal its complete saved revision.');
    }else requireSecurity(newest.end===revision.end,'Export signature does not seal the first saved revision.');
    // DSS can replace its current lists during augmentation. Earlier records
    // still exist in the verified prefix, so use them only at a covering seal.
    const evidence=revision.evidence;
    unsupported(!evidence.error,'Archived validation evidence could not be read: '+evidence.error);
    for(const kind of evidenceKinds)for(const bytes of evidence[kind]){
      check();retained[kind].set(await sha256(bytes),bytes);
    }
    if(signedRevisions.has(revision.end))
      sealedEvidence.set(revision.end,{certificates:[...retained.certificates.values()],crls:[...retained.crls.values()],ocsps:[...retained.ocsps.values()]});
    prior=revision;
  }
  requireSecurity(verified.every(s=>signedRevisions.has(s.end)),'An authenticated signature revision is missing from the saved history.');
  report.checks.push({category:'PAdES',name:'DICOM archival revision history',status:'PASS',detail:`Inspected ${revisions.length} saved revisions, including unsigned evidence updates. Pages, embedded files, metadata, document information and ordinary annotations retain their export values. Permitted updates include validation evidence, invisible timestamps and authenticated C2PA credentials.`});

  const exportSignature=verified[0]!,signingStamp=exportSignature.stamp;
  unsupported(!!signingStamp?.time,'The creator export signature has no supported signing timestamp.');
  await checkSignerBinding(exportSignature.cms);await checkSignerBinding(signingStamp!);
  let time=signingStamp!.time!;
  for(const signature of verified.slice(1)){
    await checkSignerBinding(signature.cms);
    requireSecurity(!!signature.cms.time&&signature.cms.time>=time,'Archival timestamps run backwards in time.');time=signature.cms.time!;
  }
  report.checks.push({category:'PAdES',name:'DICOM archival signer binding',status:'PASS',detail:'Export and timestamp signatures bind the exact signing certificates with signed SHA-256 ESSCertIDv2 attributes. Recorded signing and renewal times are ordered.'});

  const firstArchive=signedRevisions.get(verified[1]!.end)!;
  const claims:{claim:Awaited<ReturnType<typeof verifyC2pa>>;at:Date;revision:CreatorArchiveRevision}[]=[];
  if(input.files?.credentials){
    let previous:CreatorArchiveRevision|undefined,credentialsSeen=false;
    const reservation=new TextEncoder().encode('THINKBOX_PDF_C2PA_RESERVED_STREAM!');
    for(const revision of revisions){
      const {credentials,credentialOffset}=revision;
      requireSecurity(!!credentials&&typeof credentialOffset==='number','Missing credentials in signed revision.');
      if(previous&&sameBytes(previous.credentials,credentials)&&previous.credentialOffset===credentialOffset){previous=revision;continue;}
      if(!previous&&reservation.every((byte,index)=>credentials![index]===byte)&&credentials!.subarray(reservation.length).every(byte=>byte===0)){
        previous=revision;continue;
      }
      const index=revision.signatures.length-1,signature=verified[index]!;
      requireSecurity(signature.end===revision.end&&
        (index===0||revision.fieldNames[index]==='C2PA archival document timestamp'&&credentialOffset!>=previous!.end),
        'C2PA credential replacement is not sealed by its designated timestamp.');
      const claim=revision===last&&currentClaim?currentClaim:await verifyC2pa(input.blob.slice(0,revision.end),revision,input.manifestDigest,input.instanceId,signature.gap,freshReport(report),hashCovered,check,progress);
      requireSecurity(!claim.localIdentity,'An ephemeral C2PA signer cannot establish archival trust.');
      if(!credentialsSeen)requireSecurity(sameBytes(new Uint8Array(claim.signer.toSchema().toBER(false)),new Uint8Array(exportSignature.cms.signer.toSchema().toBER(false))),'The original C2PA credential and export signature have different signers.');
      claims.push({claim,at:index===0?signingStamp!.time!:signature.cms.time!,revision:index===0?firstArchive:revision});
      previous=revision;credentialsSeen=true;
    }
    requireSecurity(credentialsSeen&&last.fieldNames.at(-1)==='C2PA archival document timestamp'&&
      sameBytes(last.credentials,input.files.credentials)&&last.credentialOffset===input.files.credentialOffset,
      'Final archival timestamp does not seal the current DICOM credentials.');
    report.checks.push({category:'C2PA + PAdES',name:'DICOM archival credentials',status:'PASS',detail:'Original and renewed C2PA credentials verify against their saved PDF bytes. The final timestamp seals the current credentials and the complete archive.'});
  }

  return async function assessArchivalTrust(roots:Uint8Array[],timestampAnchors:TimestampAnchor[],report:SecurityReport,progress:(message:string)=>void){
    const trusts=new Map<number,OfflineTrust>();
    const assess=async(cms:Pick<VerifiedPdfSignature['cms'],'signer'|'certificates'>,at:Date,revision:CreatorArchiveRevision,label:string,timestamp=false)=>{
      let trust=trusts.get(revision.end);
      if(!trust){trust=new OfflineTrust(sealedEvidence.get(revision.end),roots,check,timestampAnchors);trusts.set(revision.end,trust);}
      const result=await trust.assess(cms.signer,cms.certificates,at,timestamp);check();
      for(const [kind,value]of Object.entries(result)){
        requireSecurity(value.status!=='FAIL',label+' '+kind+': '+value.detail);
        unsupported(value.status==='PASS',label+' '+kind+': '+value.detail);
      }
    };
    for(const {claim,at,revision} of claims)await assess(claim,at,revision,'Archived C2PA signer');
    await assess(signingStamp!,signingStamp!.time!,firstArchive,'Export timestamp',true);
    await assess(exportSignature.cms,signingStamp!.time!,firstArchive,'Export signer');
    for(const [index,signature]of verified.slice(1).entries()){
      progress(`Checking archival timestamp ${index+1} and its stored evidence…`);
      await assess(signature.cms,signature.cms.time!,signedRevisions.get(signature.end)!,`Archival timestamp ${index+1}`,true);
    }
    report.checks.push({category:'PAdES',name:'DICOM archival timestamps and evidence',status:'PASS',detail:`The export signer, signing timestamp and all ${verified.length-1} document timestamps connect to configured CAs with fresh signed revocation evidence at their recorded times. Each archival timestamp seals the evidence used for it and earlier evidence remains stored.`});
    return {time,signingTime:signingStamp!.time!,evidence:sealedEvidence.get(last.end)!};
  };
}
