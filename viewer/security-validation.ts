/* Adapted from EA-PDF Generator (Copyright 2026 ThinkBox Digital), Apache-2.0. */
import {sha256,createPdfRangeHasher} from './security-hash.mjs';
import {verifyCms,hex,requireSecurity,UnsupportedSecurity} from './security-cms.js';
import {verifyC2pa} from './security-c2pa.js';
import {checkSignerBinding,prepareCreatorArchive} from './security-archival.js';
import type {VerifiedPdfSignature} from './security-archival.js';
import {OfflineTrust} from './security-trust.js';
import {publicTimestampAnchors} from './security-trust-selection.js';
import type {SecurityInput,SecurityReport,PdfSignatureFacts,CreatorArchiveReader,SecurityCategory,SecurityState,PublicTimestampSource,TrustSource} from './security-types.js';

const archivalLabel='PAdES B-LTA and permitted revisions';
const timestampAttribute='1.2.840.113549.1.9.16.2.14';

type Progress=(value:string)=>void;
type TrustOptions={roots:Uint8Array[];source:TrustSource;signerCertificateOrigin?:string};

function recordProblem(report:SecurityReport,category:SecurityCategory,name:string,error:unknown){
  const status=error instanceof UnsupportedSecurity?'UNKNOWN':'FAIL';
  report.checks.push({category,name,status,detail:error instanceof Error?error.message:String(error)});
  return status;
}

export async function signatureRange(blob:Blob,signature:PdfSignatureFacts):Promise<{end:number;gap:[number,number]}> {
  const [zero,start,end,size]=signature.byteRange;
  requireSecurity(signature.byteRange.length===4&&signature.byteRange.every(Number.isSafeInteger)&&zero===0&&start!>0&&end!>start!&&size!>=0&&end!<=blob.size&&size!<=blob.size-end!&&end!-start!<=2*1024*1024+2,'Invalid PDF signature byte ranges');
  const encoded=await blob.slice(start,end).text();
  requireSecurity(/^<[a-fA-F0-9]+>$/.test(encoded)&&encoded.length%2===0&&encoded.slice(1,-1).toLowerCase()===hex(signature.contents),'Signature gap does not match this signature Contents');
  return {end:end!+size!,gap:[start!,end!]};
}

export async function prepareSecurity(input:SecurityInput,progress:Progress,readArchive:CreatorArchiveReader,startTimestampSources:()=>void,check:()=>void=()=>{}){
  const {blob,facts,files}=input;
  const hashCovered=createPdfRangeHasher(blob,check);
  const report:SecurityReport={schemaVersion:1,status:'UNKNOWN',trustStatus:'NOT_APPLICABLE',trustSource:'NONE',checks:[],checkedAt:new Date().toISOString(),fileSize:blob.size,scope:'DICOM archive export security',certificates:[]};
  const add=(category:SecurityCategory,name:string,status:SecurityState,detail:string)=>report.checks.push({category,name,status,detail});
  let covered=false,incomplete=false,failed=false;
  const problem=(category:SecurityCategory,name:string,error:unknown)=>{
    const status=recordProblem(report,category,name,error);
    incomplete||=status==='UNKNOWN';failed||=status==='FAIL';
  };
  if(input.discoveryError||facts.encrypted){
    incomplete=true;
    add('Other checks','PDF security discovery','UNKNOWN',input.discoveryError??'Encrypted PDF security structures are outside the supported profile.');
  }
  const signatures=facts.encrypted?[]:facts.signatures.slice().sort((a,b)=>(a.byteRange[2]!+a.byteRange[3]!)-(b.byteRange[2]!+b.byteRange[3]!));
  if(input.expectedSignature&&!input.discoveryError&&!signatures.some(signature=>signature.type==='Sig'))
    problem('CMS','Declared export signature',Error('The DICOM manifest declares an export signature, but the PDF signature is missing.'));
  const verified:VerifiedPdfSignature[]=[];
  let latestGap:[number,number]|undefined,earlierEnd=0;
  for(const [index,signature]of signatures.entries()){
    check();
    const stage=`Checking PDF signature ${index+1} of ${signatures.length}…`;
    progress(stage);
    let lastUpdate=performance.now(),lastPercent=0;
    const timestamp=signature.type==='DocTimeStamp';
    const category=timestamp||signature.subFilter==='ETSI.CAdES.detached'?'PAdES':'CMS';
    const name=`${timestamp?'Document timestamp':'PDF signature'} ${index+1}`;
    try{
      const range=await signatureRange(blob,signature);
      requireSecurity(range.end>earlierEnd,'PDF signatures do not seal distinct saved revisions.');
      earlierEnd=range.end;
      if(index===signatures.length-1){
        requireSecurity(range.end===blob.size,'The final signature does not cover the current file. Later bytes are present.');
        latestGap=range.gap;
      }
      if(!['adbe.pkcs7.detached','ETSI.CAdES.detached','ETSI.RFC3161'].includes(signature.subFilter))
        throw new UnsupportedSecurity('Unsupported PDF signature SubFilter: '+signature.subFilter);
      requireSecurity(timestamp===(signature.subFilter==='ETSI.RFC3161')&&['Sig','DocTimeStamp'].includes(signature.type),'Inconsistent PDF signature type');
      const digest=await hashCovered(range.end,[range.gap],(processed:number,total:number)=>{
        const now=performance.now(),percent=Math.floor(100*processed/total);
        if(now-lastUpdate>=500&&percent>lastPercent){
          progress(`${stage} ${percent}% of signed bytes hashed`);
          lastUpdate=now;lastPercent=percent;
        }
      });
      const cms=await verifyCms(signature.contents,digest,report,timestamp);check();
      const time=timestamp?` Recorded time: ${cms.time!.toISOString()}.`:'';
      add(category,name,'PASS',`Signature and protected bytes match through byte ${range.end.toLocaleString()}.${time} ${range.end===blob.size?'Covers the current file.':'Covers an earlier saved revision.'}`);
      covered||=range.end===blob.size;
      const item:VerifiedPdfSignature={facts:signature,end:range.end,gap:range.gap,cms};
      if(!timestamp){
        const timestamps=cms.signed.signerInfos[0]?.unsignedAttrs?.attributes.filter(a=>a.type===timestampAttribute)??[];
        requireSecurity(timestamps.length<=1,'Ambiguous signature timestamps');
        if(timestamps.length){
          requireSecurity(timestamps[0]!.values.length===1,'Ambiguous signature timestamp token');
          const stamp=await verifyCms(new Uint8Array(timestamps[0]!.values[0]!.toBER(false)),await sha256(cms.signature),report,true);
          item.stamp=stamp;
          add(category,name+' timestamp imprint','PASS',`The token signed the PDF signature value. Recorded time: ${stamp.time!.toISOString()}.`);
        }
      }
      verified.push(item);
    }catch(error){check();problem(category,name,error);}
  }
  if(signatures.length)report.pdfSignaturesChecked=signatures.length;
  if(input.expectedTimestamp&&!input.expectedPades&&!input.discoveryError&&verified.length&&verified.every(item=>!item.stamp))
    problem('CMS','Declared signature timestamp',Error('The export declares a signature timestamp, but no supported token matched the signature.'));

  const hasTimestamps=verified.some(item=>item.stamp||item.facts.type==='DocTimeStamp');
  if(hasTimestamps)startTimestampSources();
  let currentClaim:Awaited<ReturnType<typeof verifyC2pa>>|undefined;
  if(input.credentialError)problem('C2PA','C2PA credential discovery',Error(input.credentialError));
  if(files?.credentials&&!facts.encrypted){
    try{
      if(input.discoveryError||signatures.length&&!latestGap)throw new UnsupportedSecurity('A complete final signature byte range is needed to validate the C2PA exclusions.');
      if(signatures.length>1)requireSecurity(files.credentialOffset!>=signatures.at(-2)!.byteRange[2]!+signatures.at(-2)!.byteRange[3]!,'Current C2PA credentials precede the latest timestamp revision.');
      currentClaim=await verifyC2pa(blob,files,input.manifestDigest,input.instanceId,latestGap,report,hashCovered,check,progress);
      report.c2paSignerIdentity=currentClaim.localIdentity?'LOCAL_EPHEMERAL_UNTRUSTED':'CONFIGURED_CERTIFICATE';
      covered=true;
    }catch(error){check();problem('C2PA','C2PA validation',error);}
  }else if(!input.credentialError&&!input.discoveryError&&(files?.policy||input.expectedCredentials))
    problem('C2PA','Declared C2PA credentials',Error('The archive’s C2PA policy is present without its credentials.'));

  let assessArchivalTrust:Awaited<ReturnType<typeof prepareCreatorArchive>>|undefined;
  if(input.expectedPades||signatures.some(signature=>signature.type==='DocTimeStamp')){
    try{
      if(input.discoveryError||facts.encrypted)throw new UnsupportedSecurity('PDF security discovery is incomplete.');
      requireSecurity(signatures.length>=(files?.credentials?3:2)&&signatures[0]?.subFilter==='ETSI.CAdES.detached'&&signatures.slice(1).every(signature=>signature.type==='DocTimeStamp'),'The required CAdES export signature and archival document timestamps are missing.');
      if(verified.length!==signatures.length||input.expectedCredentials&&!currentClaim)
        throw new UnsupportedSecurity('Every PDF signature and declared C2PA claim must verify before checking archival protection.');
      progress('Inspecting saved PDF revisions…');
      const revisions=await readArchive(verified.map(item=>item.end),!!currentClaim);check();
      assessArchivalTrust=await prepareCreatorArchive(input,revisions,verified,report,hashCovered,check,progress,currentClaim);
    }catch(error){check();problem('PAdES',archivalLabel,error);}
  }

  const integrityReport=report,integrityFailed=failed,integrityIncomplete=incomplete;
  return async function assessTrust({roots,source,signerCertificateOrigin}:TrustOptions,progress:Progress,loadTimestampSources:()=>Promise<PublicTimestampSource[]>,started:number):Promise<SecurityReport>{
    const report:SecurityReport={...integrityReport,checks:[...integrityReport.checks],checkedAt:new Date().toISOString(),trustSource:source};
    const add=(category:SecurityCategory,name:string,status:SecurityState,detail:string)=>report.checks.push({category,name,status,detail});
    let failed=integrityFailed,incomplete=integrityIncomplete,exportSigningTime:Date|undefined;
    const trustStates:SecurityState[]=[];
    const problem=(category:SecurityCategory,name:string,error:unknown)=>{
      const status=recordProblem(report,category,name,error);
      incomplete||=status==='UNKNOWN';failed||=status==='FAIL';
    };
    const signerPolicy=new OfflineTrust(undefined,roots,check);
    report.selectedCertificates=await signerPolicy.selectedCertificates();check();
    if(signerCertificateOrigin)
      add('Certificate trust','Signing CA download','PASS',`Loaded the selected signing CA certificate from ${signerCertificateOrigin}.`);
    let trust:OfflineTrust;
    const assess=async(result:Pick<Awaited<ReturnType<typeof verifyCms>>,'signer'|'certificates'>,label:string,when:Date,timestamp=false)=>{
      const checked=await trust.assess(result.signer,result.certificates,when,timestamp);check();
      for(const [kind,value]of Object.entries(checked)){
        add('Certificate trust',label+' '+kind,value.status,value.detail);
        trustStates.push(value.status);
        failed||=value.status==='FAIL';
      }
      return checked.trust.status==='PASS'&&checked.revocation.status==='PASS';
    };
    const trustedStamp=async(stamp:Awaited<ReturnType<typeof verifyCms>>,name:string)=>{
      try{await checkSignerBinding(stamp);}
      catch(error){
        check();
        const status=error instanceof UnsupportedSecurity?'UNKNOWN':'FAIL';
        trustStates.push(status);failed||=status==='FAIL';
        add('Certificate trust',name+' certificate binding',status,(error as Error).message);
        return false;
      }
      return assess(stamp,name,stamp.time!,true);
    };

    if(facts.signatures.length||input.manifestSigner||input.discoveryError||files?.credentials&&!currentClaim?.localIdentity)
      report.checks.push({...signerPolicy.policy(report.trustSource),category:'Certificate trust'});

    progress('Checking timestamp CA certificates…');
    const {anchors:timestampAnchors,checks:sourceChecks}=await publicTimestampAnchors(hasTimestamps?await loadTimestampSources():[]);check();
    report.checks.push(...sourceChecks);
    let archival:Awaited<ReturnType<NonNullable<typeof assessArchivalTrust>>>|undefined;
    if(assessArchivalTrust){
      try{
        archival=await assessArchivalTrust(roots,timestampAnchors,report,progress);
        add('PAdES',archivalLabel,'PASS','Verified the DICOM export signature, trusted timestamps, retained evidence, credential renewals where present, and permitted changes across saved revisions.');
      }catch(error){check();problem('PAdES',archivalLabel,error);}
    }

    progress('Checking offline certificate trust and revocation…');
    trust=new OfflineTrust(archival?.evidence??facts.evidence,roots,check,timestampAnchors);
    for(const item of verified){
      const index=signatures.indexOf(item.facts);
      if(item.facts.type==='DocTimeStamp'){
        const name=`Document timestamp ${index+1}`,trusted=await trustedStamp(item.cms,name);
        add('PAdES',name+' trusted time',trusted?'PASS':'UNKNOWN',trusted?'Timestamp imprint, TSA path, usage and archived revocation evidence verify at the recorded time.':'The timestamp imprint matches. Trusted time requires a verified TSA certificate and revocation evidence.');
        continue;
      }
      const name=`PDF signature ${index+1}`,category=item.facts.subFilter==='ETSI.CAdES.detached'?'PAdES':'CMS';
      let signingTime:Date|undefined;
      if(item.stamp){
        const trusted=await trustedStamp(item.stamp,name+' timestamp');
        if(trusted)signingTime=item.stamp.time;
        if(index===0)exportSigningTime=signingTime;
        add(category,name+' trusted signing time',trusted?'PASS':'UNKNOWN',trusted?'TSA certificate, usage and archived revocation evidence verify at the recorded time.':'Trusted time requires a verified TSA certificate and revocation evidence.');
      }
      await assess(item.cms,name,signingTime??new Date());
    }

    if(currentClaim){
      if(currentClaim.localIdentity){
        trustStates.push('UNKNOWN');
        add('Certificate trust','C2PA export signer','UNKNOWN','A one-time certificate signed this archive. The C2PA signature verifies the file’s integrity. Verifying who exported it requires a trusted signing certificate.');
      }else{
        const sameSigner=verified[0]&&hex(currentClaim.signer.tbsView)===hex(verified[0].cms.signer.tbsView);
        await assess(currentClaim,'C2PA export signer',archival?.time??(sameSigner?exportSigningTime:undefined)??new Date());
      }
    }
    if(input.manifestSigner){
      try{
        const cms=input.manifestSigner;
        const signerMatches=verified[0]&&hex(cms.signer.tbsView)===hex(verified[0].cms.signer.tbsView);
        if(input.expectedSignature&&verified[0])requireSecurity(signerMatches,'The manifest and PDF export signatures use different certificates.');
        await assess(cms,'Manifest signer',(signerMatches&&(archival?.signingTime??exportSigningTime))||new Date());
      }catch(error){check();problem('CMS','Manifest signer binding',error);}
    }
    if(!signatures.length&&!files?.credentials&&!input.discoveryError)
      add('Other checks','Export protection','NOT_APPLICABLE','No PDF signature or C2PA export credentials were found.');
    add('Other checks','Verification scope','NOT_APPLICABLE','Signature, timestamp, and revocation checks use the PDF and its stored evidence on this device. Online downloads supply public CA certificates. Export signer trust uses the independently selected signing CA policy.');
    report.status=failed?'FAIL':incomplete?'UNKNOWN':covered?'PASS':'NOT_APPLICABLE';
    report.trustStatus=trustStates.includes('FAIL')?'FAIL':trustStates.includes('UNKNOWN')?'UNKNOWN':trustStates.length?'PASS':'NOT_APPLICABLE';
    report.elapsedMilliseconds=performance.now()-started;
    return report;
  };
}
