/* Adapted from EA-PDF Generator (Copyright 2026 ThinkBox Digital), Apache-2.0. */
import {certificate} from './security-cms.js';
import {sha256} from './security-hash.mjs';
import type {PublicTimestampSource,SecurityCheck,TimestampAnchor} from './security-types.js';

const limit=1024*1024;
const maxCertificates=32;
const size=(items:{byteLength:number}[])=>items.reduce((total,item)=>total+item.byteLength,0);

export function trustAnchor(bytes:Uint8Array){
  let parsed;
  try{parsed=certificate(bytes);}catch{throw Error('A selected file is not a supported PEM or DER certificate.');}
  if(parsed.extensions?.find(extension=>extension.extnID==='2.5.29.19')?.parsedValue?.cA!==true)
    throw Error('Select public CA certificates, such as the roots for the signer and timestamp authority.');
  return parsed;
}

export async function describeTrustAnchor(parsed:ReturnType<typeof trustAnchor>){
  return {
    sha256:await sha256(new Uint8Array(parsed.toSchema().toBER(false))),
    subject:parsed.subject.typesAndValues.map(value=>value.value.valueBlock.value).join(', '),
    issuer:parsed.issuer.typesAndValues.map(value=>value.value.valueBlock.value).join(', '),
    notBefore:parsed.notBefore.value.toISOString(),
    notAfter:parsed.notAfter.value.toISOString()
  };
}

function readCertificates(bytes:Uint8Array,name='',listedBundle=false){
  let contents=new TextDecoder().decode(bytes);
  if(/\.(p12|pfx|key)$/i.test(name)||/-----BEGIN [^-\n]*(?:PRIVATE KEY|PKCS12)/.test(contents))
    throw Error('Select public CA certificates. Private signing credentials are unnecessary.');
  if(listedBundle)contents=contents.replace(/^Subject[\t ]+.*$/gm,'');
  if(!contents.includes('-----BEGIN '))return [bytes];
  const pattern=/-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g;
  const matches=[...contents.matchAll(pattern)];
  if(!matches.length||contents.replace(pattern,'').trim())throw Error('Choose PEM or DER public CA certificates.');
  return matches.map(match=>Uint8Array.from(atob(match[1]!.replace(/\s/g,'')),character=>character.charCodeAt(0)));
}

export async function selectTrustRoots(files:File[],previous:Uint8Array[],single=false){
  if(files.length>maxCertificates||files.reduce((total,file)=>total+file.size,0)>limit)
    throw Error('Select at most 32 files totalling 1 MiB.');
  const inputs=[...previous];
  for(const file of files){
    const certificates=readCertificates(new Uint8Array(await file.arrayBuffer()),file.name);
    if(single&&certificates.length!==1)throw Error('The URL must provide one public signing CA certificate.');
    inputs.push(...certificates);
  }
  if(inputs.length>2*maxCertificates||size(inputs)>2*limit)
    throw Error('Select at most 32 public CA certificates.');
  const selection=new Map();
  for(const bytes of inputs){
    // Validate the entire selection before applying any changes.
    const parsed=trustAnchor(bytes);
    const details=await describeTrustAnchor(parsed);
    selection.set(details.sha256,{bytes,details});
  }
  const roots=[...selection.values()].map(value=>value.bytes);
  if(roots.length>maxCertificates||size(roots)>limit)throw Error('The tab can hold up to 32 CA certificates totalling 1 MiB.');
  return {roots,certificates:[...selection.values()].map(value=>value.details)};
}

export async function publicTimestampAnchors(sources:PublicTimestampSource[]){
  const anchors:TimestampAnchor[]=[],checks:SecurityCheck[]=[];
  async function add(source:PublicTimestampSource):Promise<SecurityCheck>{
    if(!source.bytes)throw Error(source.error||'The certificate source was unavailable.');
    const certificates=readCertificates(source.bytes,'',source.bundle);
    if(source.sha256&&(certificates.length!==1||await sha256(certificates[0]!)!==source.sha256))
      throw Error('The downloaded CA certificate did not match its approved SHA-256 fingerprint.');
    if(!certificates.length||anchors.length+certificates.length>64)throw Error('The timestamp trust list exceeds the certificate limit.');
    for(const bytes of certificates)trustAnchor(bytes);
    for(const bytes of certificates)anchors.push({bytes,source:source.name});
    const detail=source.bundled?'Used the bundled DigiCert CA certificate with the approved fingerprint.'
      :`Loaded ${certificates.length} CA certificate(s) for timestamp verification from ${source.url}.`;
    return {name:source.name,category:'Certificate trust',status:'PASS',detail};
  }
  for(const source of sources){
    try{
      checks.push(await add(source));
    }catch(error){
      let detail=(error as Error).message;
      if(source.backup){
        try{
          const used=await add({...source,name:source.name+' (bundled)',bytes:source.backup,bundled:true});
          checks.push({...used,detail:`${used.detail} ${detail}`});
          continue;
        }catch(fallbackError){
          detail+=` Bundled certificate: ${(fallbackError as Error).message}`;
        }
      }
      checks.push({name:source.name,category:'Certificate trust',status:'UNKNOWN',detail});
    }
  }
  return {anchors,checks};
}
