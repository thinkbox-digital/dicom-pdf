import {closeSync,fstatSync,openSync,readSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';

export function viewerTrustRoots(filename=process.env.DICOM_VIEWER_TRUST_PEM) {
  if(!filename)return '[]';
  const limit=2*1024*1024;
  const file=openSync(filename,'r');
  let pem;
  try {
    const info=fstatSync(file);
    if(!info.isFile())throw new Error('Viewer CA bundle must be a regular file.');
    if(info.size>limit)throw new Error('Viewer CA bundle exceeds the size limit.');
    const bytes=Buffer.alloc(limit+1);
    let length=0;
    while(length<bytes.length){
      const read=readSync(file,bytes,length,bytes.length-length,null);
      if(!read)break;
      length+=read;
    }
    if(length>limit)throw new Error('Viewer CA bundle exceeds the size limit.');
    pem=bytes.toString('utf8',0,length);
  } finally {
    closeSync(file);
  }
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
