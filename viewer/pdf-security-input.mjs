import sax from 'sax';

const instanceNamespace='http://ns.adobe.com/xap/1.0/mm/';

// PDF.js's property map discards namespaces and repeated names. Scan its raw
// XMP with namespace resolution while retaining only the unique identifier.
export async function xmpInstanceId(raw){
  if(typeof raw!=='string'||!raw||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw))return undefined;
  const parser=sax.parser(true,{xmlns:true,strictEntities:true});
  let value,inside=false,depth=0,roots=0,opening=false;
  const attributes=new Set();
  const invalid=()=>{throw new Error('Unreadable or ambiguous XMP identifier.');};
  parser.onerror=invalid;
  parser.onopentagstart=()=>{opening=true;attributes.clear();};
  parser.onattribute=attribute=>{
    const key=attribute.uri+'\0'+attribute.local;
    if(attributes.has(key)||attributes.size>=1024||attribute.name.split(':').length>2)invalid();
    attributes.add(key);
  };
  parser.onopentag=tag=>{
    opening=false;
    if(inside||tag.name.split(':').length>2||++depth>128||depth===1&&++roots>1)invalid();
    if(tag.uri===instanceNamespace&&tag.local==='InstanceID'){
      if(value!==undefined)invalid();
      value='';inside=true;
    }
  };
  parser.onclosetag=()=>{inside=false;depth--;};
  parser.ontext=parser.oncdata=text=>{
    if(inside){
      if(value.length+text.length>1024)invalid();
      value+=text;
    }
  };
  try{
    let lastYield=performance.now();
    for(let offset=0;offset<raw.length;offset+=16384){
      parser.write(raw.slice(offset,offset+16384));
      if(opening&&parser.position-parser.startTagPosition>65536)invalid();
      if(performance.now()-lastYield>24){
        await new Promise(resolve=>setTimeout(resolve,0));
        lastYield=performance.now();
      }
    }
    parser.close();
    return value||undefined;
  }catch{return undefined;}
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
  if(input.files?.credentials){
    try{input.instanceId=await xmpInstanceId((await pdf.getMetadata()).metadata?.getRaw());}
    catch{input.instanceId=undefined;}
  }
  return input;
}

export function readArchivalRevisions(pdf,ends,hasCredentials){
  return pdf._transport.messageHandler.sendWithPromise('DicomArchivalRevisions',{ends,hasCredentials});
}
