import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {defaultSigningCaOrigins,timestampSourceOrigins,digicertTimestampFingerprint} from './archive-trust-sources.mjs';

export function certificateNetwork(value=process.env.DICOM_SIGNING_CA_ORIGINS??''){
  const configured=value.trim()?value.trim().split(/[\s,]+/):[];
  if(configured.length>16)throw Error('Configure at most 16 signing CA sites.');
  const signingCaOrigins=new Set(defaultSigningCaOrigins);
  for(const site of configured){
    const origin=new URL(site);
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||
      origin.search||origin.hash||!/^[a-z0-9.-]+$/i.test(origin.hostname))
      throw Error('Signing CA sites must be exact HTTPS origins.');
    signingCaOrigins.add(origin.origin);
  }
  return {
    signingCaOrigins:[...signingCaOrigins],
    connectOrigins:[...new Set([...timestampSourceOrigins,...signingCaOrigins])].join(' '),
    optionalHosts:[...new Set([...signingCaOrigins].map(origin=>`https://${new URL(origin).hostname}/*`))]
  };
}

export function digicertTimestampFallback(){
  const bytes=readFileSync(new URL('./certificates/digicert-g4-timestamp.der',import.meta.url));
  if(createHash('sha256').update(bytes).digest('hex')!==digicertTimestampFingerprint)
    throw Error('The bundled DigiCert timestamp CA does not match the approved fingerprint.');
  return bytes.toString('base64');
}
