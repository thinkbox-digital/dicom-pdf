import {fromBER,Sequence,OctetString,ObjectIdentifier} from 'asn1js';
import {Certificate,ContentInfo,CryptoEngine,IssuerAndSerialNumber,SignedData} from 'pkijs';

export const CMS_LIMIT=1024*1024,MANIFEST_SIGNATURE_LIMIT=16*1024*1024;
const SHA256='2.16.840.1.101.3.4.2.1',DATA='1.2.840.113549.1.7.1';
const CONTENT_TYPE='1.2.840.113549.1.9.3',MESSAGE_DIGEST='1.2.840.113549.1.9.4',CERTIFICATE_V2='1.2.840.113549.1.9.16.2.47';
const check=(status,code)=>({status,code});
const hex=bytes=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
const invalid=()=>{throw new Error('Invalid manifest signature');};
function attribute(signer,type){
  const found=signer.signedAttrs?.attributes.filter(value=>value.type===type);
  if(found?.length!==1||found[0].values.length!==1)invalid();
  return found[0].values[0];
}
function certificateHash(signer){
  const binding=attribute(signer,CERTIFICATE_V2);
  if(!(binding instanceof Sequence))invalid();
  const certs=binding.valueBlock.value[0];
  if(!(certs instanceof Sequence)||certs.valueBlock.value.length!==1)invalid();
  const certificate=certs.valueBlock.value[0];
  if(!(certificate instanceof Sequence))invalid();
  const fields=certificate.valueBlock.value;let index=0;
  if(fields[0] instanceof Sequence){
    if(fields[0].valueBlock.value[0]?.valueBlock?.toString()!==SHA256)invalid();
    index++;
  }
  if(!(fields[index] instanceof OctetString)||fields[index].valueBlock.isConstructed||fields[index].valueBlock.valueHexView.length!==32)invalid();
  return hex(fields[index].valueBlock.valueHexView);
}

/** Verify the detached manifest and pass a bound signer to the caller for path validation. */
export async function verifyManifestSignature(manifest,cms,expectedFingerprint,{crypto=globalThis.crypto,now=new Date(),onSigner}={}){
  const checks={
    manifestSignature:check('UNKNOWN','MANIFEST_SIGNATURE_NOT_CHECKED'),
    signerCertificateBinding:check('UNKNOWN','SIGNER_CERTIFICATE_NOT_CHECKED'),
    signerCertificateValidity:check('UNKNOWN','SIGNER_CERTIFICATE_NOT_CHECKED'),
    certificateTrust:check('UNKNOWN','EXTERNAL_TRUST_POLICY_REQUIRED'),
    revocation:check('UNKNOWN','REVOCATION_NOT_VERIFIED_IN_BROWSER')
  };
  const result={checks,verificationTime:now.toISOString(),timeBasis:'BROWSER_CLOCK_NOT_TRUSTED_TIME'};
  if(!crypto?.subtle){checks.manifestSignature=check('UNKNOWN','WEBCRYPTO_UNAVAILABLE');return result;}
  if(!(manifest instanceof Uint8Array)||!(cms instanceof Uint8Array)||!cms.length||cms.length>CMS_LIMIT||manifest.length>MANIFEST_SIGNATURE_LIMIT){
    checks.manifestSignature=check(cms?.length>CMS_LIMIT||manifest?.length>MANIFEST_SIGNATURE_LIMIT?'UNKNOWN':'FAIL','MANIFEST_SIGNATURE_INPUT_UNAVAILABLE_OR_TOO_LARGE');return result;
  }
  try{
    const parsed=fromBER(cms);
    if(parsed.offset!==cms.length)invalid();
    const info=new ContentInfo({schema:parsed.result});
    if(info.contentType!==ContentInfo.SIGNED_DATA)invalid();
    const signed=new SignedData({schema:info.content});
    if(signed.encapContentInfo.eContent||signed.encapContentInfo.eContentType!==DATA||signed.signerInfos.length!==1)invalid();
    const signer=signed.signerInfos[0];
    if(signer.digestAlgorithm.algorithmId!==SHA256||!['1.2.840.113549.1.1.1','1.2.840.113549.1.1.11','1.2.840.113549.1.1.10','1.2.840.10045.4.3.2'].includes(signer.signatureAlgorithm.algorithmId)||!(signer.sid instanceof IssuerAndSerialNumber)){
      checks.manifestSignature=check('UNKNOWN','MANIFEST_SIGNING_ALGORITHM_OR_IDENTIFIER_UNSUPPORTED');return result;
    }
    const matches=(signed.certificates||[]).filter(value=>value instanceof Certificate&&value.issuer.isEqual(signer.sid.issuer)&&value.serialNumber.isEqual(signer.sid.serialNumber));
    if(matches.length!==1)invalid();
    const contentType=attribute(signer,CONTENT_TYPE),digest=attribute(signer,MESSAGE_DIGEST);
    if(!(contentType instanceof ObjectIdentifier)||contentType.valueBlock.toString()!==DATA||!(digest instanceof OctetString)||digest.valueBlock.isConstructed||digest.valueBlock.valueHexView.length!==32)invalid();
    const engine=new CryptoEngine({name:'offline-viewer',crypto,subtle:crypto.subtle});
    if(!await signed.verify({signer:0,data:manifest.slice().buffer,checkChain:false},engine))invalid();
    checks.manifestSignature=check('PASS','CMS_CONTENT_DIGEST_AND_SIGNATURE_VERIFIED');
    const certificate=matches[0];
    const fingerprint=hex(await crypto.subtle.digest('SHA-256',certificate.toSchema().toBER(false)));
    result.certificate={sha256:fingerprint,notBefore:certificate.notBefore.value.toISOString(),notAfter:certificate.notAfter.value.toISOString()};
    try{
      const bound=certificateHash(signer)===fingerprint&&/^[a-f\d]{64}$/i.test(expectedFingerprint||'')&&expectedFingerprint.toLowerCase()===fingerprint;
      checks.signerCertificateBinding=check(bound?'PASS':'FAIL',bound?'SIGNED_CERTIFICATE_AND_DECLARED_FINGERPRINT_MATCH':'SIGNER_CERTIFICATE_BINDING_MISMATCH');
    }catch{checks.signerCertificateBinding=check('FAIL','SIGNING_CERTIFICATE_V2_BINDING_INVALID');}
    const current=now>=certificate.notBefore.value&&now<=certificate.notAfter.value;
    result.certificate.withinValidityAtBrowserTime=current;
    checks.signerCertificateValidity=check(current?'PASS':'UNKNOWN',current?'WITHIN_VALIDITY_AT_BROWSER_TIME':'OUTSIDE_CURRENT_VALIDITY_HISTORICAL_VALIDATION_REQUIRED');
    if(checks.signerCertificateBinding.status==='PASS')
      onSigner?.({signer:certificate,certificates:signed.certificates.filter(value=>value instanceof Certificate)});
  }catch{
    checks.manifestSignature=check('FAIL','INVALID_MANIFEST_CMS_SIGNATURE');
  }
  return result;
}
