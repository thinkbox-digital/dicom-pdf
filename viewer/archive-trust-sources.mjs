export const digicertTimestampFingerprint='33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';
const timestampSources=[
  {
    name:'DigiCert public timestamp CA',
    url:'https://knowledge.digicert.com/content/dam/kb/attachments/time-stamp/DigiCertTrustedRootG4.cer',
    sha256:digicertTimestampFingerprint
  },
  {
    name:'C2PA timestamp trust list',
    url:'https://raw.githubusercontent.com/c2pa-org/conformance-public/refs/heads/main/trust-list/C2PA-TSA-TRUST-LIST.pem',
    bundle:true
  }
];
export const timestampSourceOrigins=timestampSources.map(source=>new URL(source.url).origin);
export const defaultSigningCaOrigins=['https://cacerts.digicert.com','https://knowledge.digicert.com'];

export function signingCertificateUrl(value,origins=typeof DICOM_SIGNING_CA_ORIGINS==='undefined'?defaultSigningCaOrigins:DICOM_SIGNING_CA_ORIGINS){
  let url;
  try{url=new URL(value.trim());}catch{throw Error('Enter an HTTPS URL for the public signing CA certificate.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)
    throw Error('Enter an HTTPS certificate URL without a username, password or fragment.');
  if(!origins.includes(url.origin))throw Error('This certificate site is outside the viewer’s approved sites. Use a certificate file or ask your organization to approve the site.');
  return url;
}

/** Only public certificates are requested. Bound both the response and download time. */
export async function fetchCaBytes(url,{fetcher=fetch}={}){
  const limit=1024*1024;
  const response=await fetcher(url,{method:'GET',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
    signal:AbortSignal.timeout(8000)});
  if(!response.ok||!response.body){
    await response.body?.cancel();
    throw Error('The certificate site did not return a certificate file.');
  }
  const reader=response.body.getReader();
  const chunks=[];
  let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();throw Error('The certificate download exceeds 1 MiB.');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  if(!size)throw Error('The certificate site returned an empty file.');
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

export function createTimestampSourceLoader({read=fetchCaBytes,online=()=>navigator.onLine,clock=Date.now,
  fallback=typeof DICOM_DIGICERT_TIMESTAMP_FALLBACK==='string'?Uint8Array.from(atob(DICOM_DIGICERT_TIMESTAMP_FALLBACK),value=>value.charCodeAt(0)):undefined}={}){
  let pending,refreshAt=0;
  return async function load(){
    if(pending&&clock()<refreshAt)return pending;
    if(!online())return fallback?[{...timestampSources[0],name:'DigiCert public timestamp CA (bundled)',bytes:fallback,bundled:true}]:[];
    refreshAt=Infinity;
    pending=Promise.all(timestampSources.map(async source=>{
      const backup=source.sha256===digicertTimestampFingerprint?fallback:undefined;
      try{return {...source,bytes:await read(source.url),backup};}
      catch{return {...source,backup,error:'The online certificate download was unavailable.'};}
    })).then(sources=>{
      refreshAt=clock()+(sources.some(source=>source.error)?60_000:3_600_000);
      return sources;
    });
    return pending;
  };
}

export function supportsCertificateSitePermission(api=globalThis.chrome){
  return !!(api?.runtime?.id&&api.permissions?.request);
}

// Called directly from the explicit site-access button while its user gesture is active.
export async function withCertificateSitePermission(url,read,api=globalThis.chrome){
  const permissions={origins:[`https://${url.hostname}/*`]};
  const alreadyGranted=api.permissions.contains(permissions).catch(()=>true);
  const granted=api.permissions.request(permissions);
  if(!await granted)throw Error('Certificate site access was declined.');
  try{return await read();}
  finally{if(!await alreadyGranted)await api.permissions.remove(permissions).catch(()=>{});}
}
