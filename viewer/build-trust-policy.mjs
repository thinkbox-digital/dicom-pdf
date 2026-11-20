import {readFileSync,statSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';

export function viewerTrustRoots(filename=process.env.DICOM_VIEWER_TRUST_PEM) {
  if(!filename)return '[]';
  if(statSync(filename).size>2*1024*1024)throw new Error('Viewer CA bundle exceeds the size limit.');
  const pem=readFileSync(filename,'utf8');
  const pattern=/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks=pem.match(pattern)??[];
  if(!blocks.length||blocks.length>32||pem.replace(pattern,'').trim())
    throw new Error('Viewer CA bundle must contain 1 to 32 PEM certificates.');
  const roots=new Map();
  for(const block of blocks){
    const cert=new X509Certificate(block);
    if(!cert.ca)throw new Error('Viewer trust anchors must be CA certificates.');
    roots.set(cert.fingerprint256,cert.raw.toString('base64'));
  }
  return JSON.stringify([...roots.values()]);
}
