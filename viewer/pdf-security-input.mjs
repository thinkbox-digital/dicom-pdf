const instanceNamespace='http://ns.adobe.com/xap/1.0/mm/';

async function instanceId(pdf){
  const raw=(await pdf.getMetadata()).metadata?.getRaw();
  if(!raw||raw.length>16*1024*1024||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw))return undefined;
  const xmp=new DOMParser().parseFromString(raw,'application/xml');
  const ids=xmp.getElementsByTagNameNS(instanceNamespace,'InstanceID');
  if(ids.length!==1||ids[0].childElementCount)return undefined;
  return ids[0].textContent;
}

export async function readPdfSecurity({pdf,blob,manifest,manifestBytes}){
  const messages=pdf._transport.messageHandler;
  const protection=manifest.security?.protection;
  const input={blob,manifestBytes,
    expectedCredentials:manifest.profileVersion==='0.4.0'&&!!manifest.artifactSha256?.['c2pa-policy.json'],
    expectedPades:protection==='PADES_B_LTA',
    expectedSignature:['CMS_AND_PDF','CMS_AND_PDF_TIMESTAMPED','PADES_B_LTA'].includes(protection),
    expectedTimestamp:protection==='CMS_AND_PDF_TIMESTAMPED'};
  try{
    const {files:credentials,credentialError,...facts}=await messages.sendWithPromise('DicomSecurityFacts',null);
    input.facts=facts;
    input.files=credentials;
    input.credentialError=credentialError;
  }catch(error){
    input.facts={signatures:[],encrypted:false};
    input.discoveryError=error?.message||'PDF signature and evidence discovery could not finish.';
  }
  if(input.files?.credentials)input.instanceId=await instanceId(pdf).catch(()=>undefined);
  return input;
}

export function readArchivalRevisions(pdf,ends,hasCredentials){
  return pdf._transport.messageHandler.sendWithPromise('DicomArchivalRevisions',{ends,hasCredentials});
}
