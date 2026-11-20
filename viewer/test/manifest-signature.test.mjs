import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {Attribute,Certificate,ContentInfo,CryptoEngine,EncapsulatedContentInfo,IssuerAndSerialNumber,RelativeDistinguishedNames,SignedAndUnsignedAttributes,SignedData,SignerInfo,Time,AttributeTypeAndValue} from 'pkijs';
import {fromBER,Integer,OctetString,ObjectIdentifier,Sequence,Utf8String} from 'asn1js';
import {CMS_LIMIT,MANIFEST_SIGNATURE_LIMIT,verifyManifestSignature} from '../manifest-signature.mjs';
import {buildArchiveVerificationPlan,verifyArchivePlan} from '../archive-verification.mjs';

const encode=text=>new TextEncoder().encode(text),now=new Date('2030-06-01T00:00:00Z');
const crypto=new CryptoEngine({name:'synthetic-test',crypto:webcrypto,subtle:webcrypto.subtle});
const digest=bytes=>webcrypto.subtle.digest('SHA-256',bytes);
const hash=async bytes=>Buffer.from(await digest(bytes)).toString('hex');
const attribute=(type,value)=>new Attribute({type,values:[value]});
const credentials=new Map();
async function credential(kind='RSA'){
  if(!credentials.has(kind))credentials.set(kind,(async()=>{
    const keys=await webcrypto.subtle.generateKey(kind!=='EC'?{name:kind==='PSS'?'RSA-PSS':'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}:{name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const name=new RelativeDistinguishedNames({typesAndValues:[new AttributeTypeAndValue({type:'2.5.4.3',value:new Utf8String({value:'SYNTHETIC TEST SIGNER — NOT A TRUSTED INSTITUTION'})})]});
    const certificate=new Certificate({version:2,serialNumber:new Integer({value:kind==='RSA'?1:2}),issuer:name,subject:name,
      notBefore:new Time({type:0,value:new Date('2020-01-01T00:00:00Z')}),notAfter:new Time({type:0,value:new Date('2040-01-01T00:00:00Z')})});
    await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
    await certificate.sign(keys.privateKey,'SHA-256',crypto);
    return {keys,certificate,fingerprint:await hash(certificate.toSchema().toBER(false))};
  })());
  return credentials.get(kind);
}
async function fixture({kind='RSA',content=encode('SYNTHETIC MANIFEST CONTENT'),binding=true,duplicateDigest=false,wrongContentType=false,badBinding=false}={}){
  const {keys,certificate,fingerprint}=await credential(kind);
  const digestAttribute=attribute('1.2.840.113549.1.9.4',new OctetString({valueHex:await digest(content)}));
  const attributes=[attribute('1.2.840.113549.1.9.3',new ObjectIdentifier({value:wrongContentType?'1.2.3.4':'1.2.840.113549.1.7.1'})),digestAttribute];
  if(duplicateDigest)attributes.push(digestAttribute);
  if(binding)attributes.push(attribute('1.2.840.113549.1.9.16.2.47',new Sequence({value:[new Sequence({value:[new Sequence({value:[new OctetString({valueHex:badBinding?new Uint8Array(32).buffer:await digest(certificate.toSchema().toBER(false))})]})]})]})));
  const signed=new SignedData({version:1,encapContentInfo:new EncapsulatedContentInfo({eContentType:'1.2.840.113549.1.7.1'}),certificates:[certificate],signerInfos:[new SignerInfo({version:1,sid:new IssuerAndSerialNumber({issuer:certificate.issuer,serialNumber:certificate.serialNumber}),signedAttrs:new SignedAndUnsignedAttributes({type:0,attributes})})]});
  await signed.sign(keys.privateKey,0,'SHA-256',content.buffer,crypto);
  const cms=new Uint8Array(new ContentInfo({contentType:ContentInfo.SIGNED_DATA,content:signed.toSchema(true)}).toSchema().toBER(false));
  return {content,cms,fingerprint};
}
const verify=(value,options={})=>verifyManifestSignature(value.content,value.cms,value.fingerprint,{crypto:webcrypto,now,...options});

for(const kind of ['RSA','EC','PSS'])test(`verifies detached ${kind} CMS, exact certificate binding and current dates without establishing trust`,async()=>{
  const result=await verify(await fixture({kind}));
  for(const name of ['manifestSignature','signerCertificateBinding','signerCertificateValidity'])assert.equal(result.checks[name].status,'PASS',JSON.stringify(result));
  assert.equal(result.checks.certificateTrust.status,'UNKNOWN');assert.equal(result.checks.revocation.status,'UNKNOWN');
  assert.equal(result.timeBasis,'BROWSER_CLOCK_NOT_TRUSTED_TIME');
});
test('altered manifest content and signature bytes are rejected',async()=>{
  const value=await fixture();value.content[0]^=1;
  assert.equal((await verify(value)).checks.manifestSignature.status,'FAIL');
  value.content[0]^=1;
  const info=new ContentInfo({schema:fromBER(value.cms).result}),signed=new SignedData({schema:info.content});
  signed.signerInfos[0].signature.valueBlock.valueHexView[0]^=1;
  value.cms=new Uint8Array(new ContentInfo({contentType:ContentInfo.SIGNED_DATA,content:signed.toSchema(true)}).toSchema().toBER(false));
  assert.equal((await verify(value)).checks.manifestSignature.status,'FAIL');
});
test('fingerprint mismatch and absent or incorrect signed certificate references fail separately',async()=>{
  const mismatch=await fixture();mismatch.fingerprint='00'.repeat(32);
  for(const value of [mismatch,await fixture({binding:false}),await fixture({badBinding:true})]){
    const result=await verify(value);
    assert.equal(result.checks.manifestSignature.status,'PASS');assert.equal(result.checks.signerCertificateBinding.status,'FAIL');
  }
});
test('duplicate digest attributes and wrong content types cannot pass',async()=>{
  for(const options of [{duplicateDigest:true},{wrongContentType:true}])assert.equal((await verify(await fixture(options))).checks.manifestSignature.status,'FAIL');
});
test('attached content, multiple signers and ambiguous included certificates are rejected',async()=>{
  const value=await fixture();
  for(const mutate of [signed=>{signed.encapContentInfo.eContent=new OctetString({valueHex:value.content.buffer});},signed=>{signed.signerInfos.push(signed.signerInfos[0]);},signed=>{signed.certificates.push(signed.certificates[0]);}]){
    const info=new ContentInfo({schema:fromBER(value.cms).result}),signed=new SignedData({schema:info.content});mutate(signed);
    const cms=new Uint8Array(new ContentInfo({contentType:ContentInfo.SIGNED_DATA,content:signed.toSchema(true)}).toSchema().toBER(false));
    assert.equal((await verify({...value,cms})).checks.manifestSignature.status,'FAIL');
  }
});
test('expired or not-yet-valid certificates keep historical validity unknown while cryptography still verifies',async()=>{
  const value=await fixture();
  for(const date of ['2010-01-01T00:00:00Z','2050-01-01T00:00:00Z']){
    const result=await verify(value,{now:new Date(date)});
    assert.equal(result.checks.manifestSignature.status,'PASS');assert.equal(result.checks.signerCertificateValidity.status,'UNKNOWN');
    assert.equal(result.certificate.withinValidityAtBrowserTime,false);
  }
});
test('unsupported signing identifiers remain unverified',async()=>{
  const value=await fixture(),info=new ContentInfo({schema:fromBER(value.cms).result}),signed=new SignedData({schema:info.content});
  signed.signerInfos[0].signatureAlgorithm.algorithmId='1.2.3.4';
  const cms=new Uint8Array(new ContentInfo({contentType:ContentInfo.SIGNED_DATA,content:signed.toSchema(true)}).toSchema().toBER(false));
  assert.equal((await verify({...value,cms})).checks.manifestSignature.status,'UNKNOWN');
});
test('missing browser crypto and input bounds remain unknown; malformed or trailing CMS bytes fail',async()=>{
  const value=await fixture();
  assert.equal((await verify(value,{crypto:null})).checks.manifestSignature.code,'WEBCRYPTO_UNAVAILABLE');
  assert.equal((await verify({...value,cms:new Uint8Array(CMS_LIMIT+1)})).checks.manifestSignature.status,'UNKNOWN');
  assert.equal((await verify({...value,content:new Uint8Array(MANIFEST_SIGNATURE_LIMIT+1)})).checks.manifestSignature.status,'UNKNOWN');
  for(const cms of [new Uint8Array(),encode('not CMS'),new Uint8Array([...value.cms,0])])assert.equal((await verify({...value,cms})).checks.manifestSignature.status,'FAIL');
});
test('hash-consistent tampering of a manifest is caught by its detached signature in the complete viewer plan',async()=>{
  const original=encode('SYNTHETIC ORIGINAL'),artifact=encode('SYNTHETIC ARTIFACT');
  const {fingerprint}=await credential();
  const manifest={schemaVersion:2,images:[{attachment:'original.dcm',sha256:await hash(original),size:original.length}],artifactSha256:{'profile.json':await hash(artifact)},security:{schemaVersion:1,manifestSignature:'manifest.p7s',issuerCertificateSha256:fingerprint}};
  const content=encode(JSON.stringify(manifest)),signed=await fixture({content});
  const files={'original.dcm':original,'profile.json':artifact,'manifest.json':content,'manifest.sha256':encode(await hash(content)+'  manifest.json\n'),'manifest.p7s':signed.cms};
  const attachments=()=>Object.fromEntries(Object.entries(files).map(([filename,content])=>[filename,{filename,content}]));
  const run=()=>verifyArchivePlan(buildArchiveVerificationPlan(manifest,attachments()),async name=>files[name]?new Blob([files[name]]):null,{crypto:webcrypto,now});
  let result=await run();assert.equal(result.integrity,'PASS');assert.equal(result.checks.manifestSignature.status,'PASS');assert.equal(result.assurance,'MANIFEST_SIGNATURE_VALID_IDENTITY_UNVERIFIED');
  const altered=encode(JSON.stringify({...manifest,untrustedExtraClaim:'altered'}));files['manifest.json']=altered;files['manifest.sha256']=encode(await hash(altered)+'  manifest.json\n');
  result=await run();assert.equal(result.checks.manifestChecksum.status,'PASS');assert.equal(result.checks.manifestSignature.status,'FAIL');assert.equal(result.integrity,'FAIL');
});
