import {decodeDicomAsync,parseImageDataset} from './native-dicom.mjs';
import {readDicomDocument} from './dicom-document.mjs';
import {readDicomMetadata} from './metadata-export.mjs';
import {inspectArchivedCt} from './input-ingestion.mjs';
import {workingMemoryBytes} from './working-memory.mjs';

const CACHE_BYTES=128*1024*1024;
const MAX_QUEUE=64;
// Account for the inflated backing store and reserve space for parser objects.
// Native datasets share their original backing buffer with the source cache.
function fitsParsedCache(ds,bytes,budget){
  let size=ds.byteArray.buffer===bytes.buffer?0:ds.byteArray.buffer.byteLength;
  const pending=[ds];
  while(pending.length){
    if(size>budget)return false;
    const item=pending.pop();
    size+=256+(item.warnings?.length||0)*256;
    for(const tag in item.elements){
      const element=item.elements[tag];
      size+=256+(element.fragments?.length||0)*128+(element.basicOffsetTable?.length||0)*8;
      if(size>budget)return false;
      for(const child of element.items||[]){
        size+=128;
        if(size>budget)return false;
        if(child.dataSet)pending.push(child.dataSet);
      }
    }
  }
  return size<=budget;
}
function checkAbort(job){return job.cancelled;}
async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
function safeCode(error){
  const text=String(error?.message||'');
  if(text.startsWith('VOI or Presentation LUT sequences are not supported'))return 'UNSUPPORTED_LUT';
  if(/transfer syntax|encoding.*support|compressed transfer/i.test(text))return 'UNSUPPORTED_ENCODING';
  if(/source frame|frame.*outside|frame.*unavailable/i.test(text))return 'INVALID_FRAME';
  if(/preview|polarity differs|rescale differs|aspect differs/i.test(text))return 'PREVIEW_MISMATCH';
  if(/No image Pixel Data|Missing encapsulated/i.test(text))return 'MISSING_PIXEL_DATA';
  if(/oversized|exceeds|excessive|limit|pixel matrix/i.test(text))return 'RESOURCE_LIMIT';
  return 'INVALID_DICOM';
}

/** Local, serialized decode protocol. Exported for protocol/cache tests without a DOM. */
export function createDecoderWorkerRuntime({decode=decodeDicomAsync,parseDataset=parseImageDataset,postMessage,cacheBytes=CACHE_BYTES,allocationBytes=workingMemoryBytes()}={}){
  if(typeof postMessage!=='function')throw new TypeError('A decoder reply channel is required.');
  const sources=new Map(),pendingRegistrations=new Map();let totalBytes=0,workingSource=null,queue=[],active=null,epoch=0,sequence=0;
  let sourceCacheBytes=cacheBytes,parsed=null;
  function readDataset(bytes,sourceParsing){
    const mode=sourceParsing?.mode,syntax=sourceParsing?.transferSyntaxUID;
    if(parsed?.bytes===bytes&&parsed.mode===mode&&parsed.syntax===syntax)return parsed.ds;
    parsed=null;
    const ds=parseDataset(bytes,sourceParsing);
    const available=Math.min(sourceCacheBytes,allocationBytes)-totalBytes-(workingSource?.bytes.byteLength||0);
    if(Number(ds.string('x00280008'))>1&&available>0&&fitsParsedCache(ds,bytes,available))
      parsed={bytes,mode,syntax,ds};
    return ds;
  }
  const send=(message,transfers=[])=>postMessage(message,transfers);
  const error=(job,code)=>send({type:'error',id:job.id,epoch:job.epoch,code});
  function cached(key){if(workingSource?.key===key)return workingSource.bytes;const bytes=sources.get(key);if(bytes){sources.delete(key);sources.set(key,bytes);}return bytes;}
  async function pump(){
    if(active)return;
    queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
    const job=queue.shift();if(!job)return;
    if(job.epoch!==epoch||checkAbort(job)){send({type:'cancelled',id:job.id,epoch:job.epoch});void pump();return;}
    const bytes=cached(job.key);if(!bytes){error(job,'SOURCE_NOT_CACHED');void pump();return;}
    active=job;
    try{
      if(job.type==='metadata'||job.type==='inspect-raw-ct'){
        const result=job.type==='metadata'?readDicomMetadata(bytes,{sourceParsing:job.sourceParsing}):inspectArchivedCt(bytes);
        if(!job.cancelled&&job.epoch===epoch)send({type:job.type,id:job.id,epoch:job.epoch,result});
        else send({type:'cancelled',id:job.id,epoch:job.epoch});
        return;
      }
      if(job.type==='document'){
        const result=readDicomDocument(bytes,{sourceParsing:job.sourceParsing});
        const arrays=result.kind==='surface-segmentation'
          ?result.content.surfaces.flatMap(({points,normals,triangles,lines,vertices})=>[points,normals,triangles,lines,vertices])
          :[result.kind==='pdf'?result.bytes:result.content?.data];
        const transfers=[...new Set(arrays.filter(ArrayBuffer.isView).map(array=>array.buffer))];
        if(!job.cancelled&&job.epoch===epoch)send({type:'document',id:job.id,epoch:job.epoch,result},transfers);
        else send({type:'cancelled',id:job.id,epoch:job.epoch});
        return;
      }
      const result=await decode(bytes,job.imageId,job.previewEntry,job.sourceFrame,{sourceParsing:job.sourceParsing,requireEmptyColorProfile:job.requireEmptyColorProfile===true,readDataset});
      if(job.cancelled||job.epoch!==epoch){send({type:'cancelled',id:job.id,epoch:job.epoch});return;}
      const pixels=result?.image?.getPixelData?.();
      if(!ArrayBuffer.isView(pixels)||pixels instanceof DataView)throw new Error('Invalid pixel matrix.');
      const {getPixelData,...image}=result.image;
      const transfers=[pixels.buffer];
      if(image.modalityLut)transfers.push(image.modalityLut.values.buffer);
      if(image.sampledVoiLut)transfers.push(image.sampledVoiLut.values.buffer);
      if(image.presentationLut)transfers.push(image.presentationLut.values.buffer);
      send({type:'decoded',id:job.id,epoch:job.epoch,result:{...result,image,pixels}},transfers);
    }catch(cause){if(!job.cancelled&&job.epoch===epoch)error(job,safeCode(cause));else send({type:'cancelled',id:job.id,epoch:job.epoch});}
    finally{active=null;void pump();}
  }
  async function handleMessage(message){
    if(!message||typeof message!=='object')return;
    const job={id:message.id,epoch:message.epoch};
    if(message.type==='clear'){
      epoch=message.epoch;sources.clear();totalBytes=0;workingSource=null;parsed=null;queue=[];if(active)active.cancelled=true;
      sourceCacheBytes=Number.isSafeInteger(message.sourceCacheBytes)&&message.sourceCacheBytes>0
        ?Math.min(cacheBytes,message.sourceCacheBytes):cacheBytes;
      for(const registration of pendingRegistrations.values())registration.cancelled=true;
      send({type:'cleared',epoch});return;
    }
    if(message.type==='cancel'){
      if(active?.id===message.id&&active.epoch===message.epoch)active.cancelled=true;
      const index=queue.findIndex(item=>item.id===message.id&&item.epoch===message.epoch);
      if(index>=0){const [cancelled]=queue.splice(index,1);send({type:'cancelled',id:cancelled.id,epoch:cancelled.epoch});}
      return;
    }
    if(message.epoch!==epoch){error(job,'STALE_DOCUMENT');return;}
    if(message.type==='register'){
      if(typeof message.key!=='string'||!/^[a-f0-9]{64}$/i.test(message.key)||!(message.bytes instanceof Uint8Array))return error(job,'INVALID_REQUEST');
      if(message.bytes.byteLength>allocationBytes)return error(job,'RESOURCE_LIMIT');
      const registration={...job,cancelled:false};pendingRegistrations.set(job.id,registration);
      try{
        if(await sha256(message.bytes)!==message.key.toLowerCase())return error(job,'CHECKSUM_MISMATCH');
        if(registration.cancelled||job.epoch!==epoch)return send({type:'cancelled',id:job.id,epoch:job.epoch});
        parsed=null;
        const evicted=[];
        if(workingSource){evicted.push(workingSource.key);workingSource=null;}
        if(sources.has(message.key)){totalBytes-=sources.get(message.key).byteLength;sources.delete(message.key);}
        while(totalBytes+message.bytes.byteLength>sourceCacheBytes&&sources.size){
          const oldest=sources.keys().next().value;totalBytes-=sources.get(oldest).byteLength;sources.delete(oldest);evicted.push(oldest);
        }
        if(message.bytes.byteLength>sourceCacheBytes)workingSource={key:message.key,bytes:message.bytes};
        else {sources.set(message.key,message.bytes);totalBytes+=message.bytes.byteLength;}
        send({type:'registered',id:job.id,epoch:job.epoch,key:message.key,evicted,cacheBytes:totalBytes});
      }catch{error(job,'DECODER_FAILED');}finally{pendingRegistrations.delete(job.id);}
      return;
    }
    if(['decode','document','metadata','inspect-raw-ct'].includes(message.type)){
      if(queue.length>=MAX_QUEUE)return error(job,'RESOURCE_LIMIT');
      if(typeof message.key!=='string'||typeof message.imageId!=='string'||!Number.isInteger(message.sourceFrame)||message.sourceFrame<1)return error(job,'INVALID_REQUEST');
      queue.push({...message,sequence:sequence++,priority:message.priority==='thumbnail'?0:1,cancelled:false});void pump();
    }
  }
  return {handleMessage,getCacheState:()=>({bytes:totalBytes,keys:[...sources.keys()]}),getWorkingBytes:()=>workingSource?.bytes.byteLength||0};
}

if(typeof self!=='undefined'&&typeof document==='undefined'&&typeof self.postMessage==='function'&&typeof self.addEventListener==='function'){
  const runtime=createDecoderWorkerRuntime({postMessage:(message,transfers)=>self.postMessage(message,transfers)});
  self.addEventListener('message',event=>{void runtime.handleMessage(event.data).catch(()=>{
    self.postMessage({type:'error',id:event.data?.id,epoch:event.data?.epoch,code:'DECODER_FAILED'});
  });});
}
