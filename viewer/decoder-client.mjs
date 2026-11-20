import {MAX_FRAME_PIXELS} from './working-memory.mjs';

const MAX_QUEUE=64;
const MESSAGES={
  DECODER_UNAVAILABLE:'This browser could not start the local image decoder.',
  DECODER_FAILED:'The local image decoder stopped unexpectedly. Reopen the file to retry.',
  DECODER_CLOSED:'The local image decoder has been closed.',
  UNSUPPORTED_ENCODING:'This image encoding is not supported by the local viewer. The original remains available to save.',
  UNSUPPORTED_LUT:'This image uses a VOI or Presentation LUT. The original remains available to save.',
  INVALID_FRAME:'The requested image frame is not available.',
  PREVIEW_MISMATCH:'The PDF display mapping does not match this original image.',
  MISSING_PIXEL_DATA:'This DICOM object has no supported image pixel data. The original remains available to save.',
  INVALID_DICOM:'This original could not be decoded as a supported DICOM image.',
  RESOURCE_LIMIT:'This image or the pending decode queue exceeds the supported resource limit.',
  CHECKSUM_MISMATCH:'The original does not match its recorded checksum; display was refused.',
  INVALID_REQUEST:'The image decode request is invalid.',
  SOURCE_NOT_CACHED:'The original image is no longer in the local decoder cache.',
  STALE_DOCUMENT:'The image belongs to a document that is no longer open.',
};
export class DecoderError extends Error{
  constructor(code){const safe=Object.hasOwn(MESSAGES,code)?code:'DECODER_FAILED';super(MESSAGES[safe]);this.name='DecoderError';this.code=safe;}
}
const abortError=()=>new DOMException('Image decoding cancelled.','AbortError');
async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
function encodedBytes(value){
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  throw new DecoderError('INVALID_REQUEST');
}
function defaultWorkerFactory(){
  if(typeof Worker!=='function')throw new DecoderError('DECODER_UNAVAILABLE');
  if(typeof DICOM_WORKER_URL==='string'&&DICOM_WORKER_URL){
    const base=typeof document!=='undefined'?document.baseURI:globalThis.location?.href;
    return {worker:new Worker(new URL(DICOM_WORKER_URL,base).href,{type:'module'})};
  }
  if(typeof DICOM_WORKER_SOURCE==='string'&&DICOM_WORKER_SOURCE){
    const url=URL.createObjectURL(new Blob([DICOM_WORKER_SOURCE],{type:'text/javascript'}));
    // The bundled source is an IIFE with no imports. Chromium145 rejects module
    // Blob Workers from file: documents; a classic Worker works directly on disk.
    try{return {worker:new Worker(url,{type:'classic'}),dispose:()=>URL.revokeObjectURL(url)};}
    catch(error){URL.revokeObjectURL(url);throw error;}
  }
  throw new DecoderError('DECODER_UNAVAILABLE');
}
function previewRecipe(entry){
  if(!entry)return null;
  return {status:entry.status,displayRejected:entry.displayRejected,sourceFrame:entry.sourceFrame,displayAdjustments:entry.displayAdjustments};
}
function rehydrate(result){
  const image=result?.image,pixels=result?.pixels;
  if(!image||!ArrayBuffer.isView(pixels)||pixels instanceof DataView||!Number.isInteger(image.rows)||!Number.isInteger(image.columns)
      ||image.rows<1||image.columns<1||image.rows*image.columns>MAX_FRAME_PIXELS||pixels.byteLength>64*1024*1024)throw new DecoderError('DECODER_FAILED');
  const components=image.numberOfComponents||1;
  if(pixels.length!==image.rows*image.columns*components)throw new DecoderError('DECODER_FAILED');
  const {pixels:_,...decoded}=result;
  decoded.image={...image,getPixelData:()=>pixels};return decoded;
}

/** Single worker, foreground-first queue and content-addressed original registration. */
export function createDecoderClient({workerFactory=defaultWorkerFactory,sourceCacheBytes}={}){
  let workerRecord=null,epoch=0,nextId=1,active=null,queued=[],scheduled=false,closed=false;
  const registered=new Set();
  function settle(job,error,value){
    if(job.settled)return;job.settled=true;job.signal?.removeEventListener('abort',job.abort);
    if(error)job.reject(error);else job.resolve(value);
  }
  function schedule(){if(scheduled||closed)return;scheduled=true;setTimeout(()=>{scheduled=false;pump();},0);}
  function disposeWorker(){
    if(!workerRecord)return;
    try{workerRecord.worker.removeEventListener('message',workerRecord.message);workerRecord.worker.removeEventListener('error',workerRecord.error);workerRecord.worker.removeEventListener('messageerror',workerRecord.error);}catch{}
    try{workerRecord.worker.terminate();}catch{}
    try{workerRecord.dispose?.();}catch{}
    workerRecord=null;registered.clear();
  }
  function failed(){
    const error=new DecoderError('DECODER_FAILED');if(active)settle(active,error);
    for(const job of queued)settle(job,error);active=null;queued=[];disposeWorker();
  }
  function sendDecode(job){
    job.phase='decode';
    workerRecord.worker.postMessage({type:job.operation==='image'?'decode':job.operation,id:job.id,epoch:job.epoch,key:job.key,imageId:job.imageId,
      previewEntry:job.previewEntry,sourceFrame:job.sourceFrame,sourceParsing:job.sourceParsing,requireEmptyColorProfile:job.requireEmptyColorProfile,priority:job.priority});
  }
  function register(job){
    job.phase='register';const copy=new Uint8Array(job.bytes.byteLength);copy.set(job.bytes);
    workerRecord.worker.postMessage({type:'register',id:job.id,epoch:job.epoch,key:job.key,bytes:copy},[copy.buffer]);
  }
  function received(message){
    if(!message||message.epoch!==epoch)return;
    if(message.type==='registered')for(const key of message.evicted||[])registered.delete(key);
    const job=active;if(!job||message.id!==job.id)return;
    try{
      if(message.type==='registered'){
        registered.add(job.key);
        if(job.cancelled){active=null;schedule();return;}
        sendDecode(job);return;
      }
      if(message.type==='error'&&message.code==='SOURCE_NOT_CACHED'&&!job.cancelled&&!job.retried){
        registered.delete(job.key);job.retried=true;register(job);return;
      }
      if(message.type==='decoded'){
        if(!job.cancelled)settle(job,null,rehydrate(message.result));
      }else if(['document','metadata','inspect-raw-ct'].includes(message.type)){
        if(!job.cancelled)settle(job,null,message.result);
      }else if(message.type==='cancelled')settle(job,abortError());
      else if(message.type==='error')settle(job,new DecoderError(message.code));
      else return;
      active=null;schedule();
    }catch{failed();}
  }
  function ensureWorker(){
    if(workerRecord)return;
    let value;try{value=workerFactory();}catch{throw new DecoderError('DECODER_UNAVAILABLE');}
    const record=value?.worker?value:{worker:value};
    if(!record.worker?.postMessage||!record.worker?.addEventListener)throw new DecoderError('DECODER_UNAVAILABLE');
    const currentEpoch=epoch;
    record.message=event=>{if(currentEpoch===epoch)received(event.data);};
    record.error=event=>{event.preventDefault?.();if(currentEpoch===epoch)failed();};
    workerRecord=record;
    record.worker.addEventListener('message',record.message);record.worker.addEventListener('error',record.error);record.worker.addEventListener('messageerror',record.error);
    // A fresh worker starts at epoch zero; clear establishes this client's epoch.
    record.worker.postMessage({type:'clear',epoch,sourceCacheBytes});
  }
  function pump(){
    if(active||closed)return;
    queued.sort((a,b)=>(b.priority==='thumbnail'?0:1)-(a.priority==='thumbnail'?0:1)||a.id-b.id);
    let job;
    while((job=queued.shift())){
      if(job.cancelled||job.epoch!==epoch){settle(job,abortError());continue;}
      active=job;
      try{ensureWorker();if(registered.has(job.key))sendDecode(job);else register(job);}
      catch(error){settle(job,error instanceof DecoderError?error:new DecoderError('DECODER_FAILED'));active=null;disposeWorker();schedule();}
      return;
    }
  }
  async function decode(bytes,imageId,previewEntry=null,sourceFrame=1,{key,signal,priority='foreground',sourceParsing=null,operation='image',requireEmptyColorProfile=false}={}){
    if(closed)throw new DecoderError('DECODER_CLOSED');if(signal?.aborted)throw abortError();
    const currentEpoch=epoch,data=encodedBytes(bytes);
    if(data.byteLength>workingMemoryBytes()||queued.length>=MAX_QUEUE)throw new DecoderError('RESOURCE_LIMIT');
    const cacheKey=key===undefined?await sha256(data):key;
    if(signal?.aborted||currentEpoch!==epoch)throw abortError();
    if(typeof cacheKey!=='string'||!/^[a-f0-9]{64}$/i.test(cacheKey)||typeof imageId!=='string'||!Number.isInteger(sourceFrame)||sourceFrame<1)throw new DecoderError('INVALID_REQUEST');
    return new Promise((resolve,reject)=>{
      const parsing=sourceParsing?{mode:sourceParsing.mode,transferSyntaxUID:sourceParsing.transferSyntaxUID}:null;
      const job={id:nextId++,epoch:currentEpoch,bytes:data,key:cacheKey.toLowerCase(),imageId,previewEntry:previewRecipe(previewEntry),sourceFrame,sourceParsing:parsing,operation,priority,requireEmptyColorProfile:requireEmptyColorProfile===true,signal,resolve,reject,settled:false,cancelled:false,retried:false};
      job.abort=()=>{job.cancelled=true;settle(job,abortError());if(active===job&&job.phase==='decode')try{workerRecord?.worker.postMessage({type:'cancel',id:job.id,epoch:job.epoch});}catch{}schedule();};
      signal?.addEventListener('abort',job.abort,{once:true});queued.push(job);schedule();
    });
  }
  function clear(){
    epoch++;if(active)settle(active,abortError());for(const job of queued)settle(job,abortError());active=null;queued=[];disposeWorker();
  }
  function destroy(){clear();closed=true;}
  return {decode,readDocument:(bytes,options={})=>decode(bytes,'dicom-document',null,1,{...options,operation:'document'}),
    inspectRawCt:(bytes,options={})=>decode(bytes,'dicom-raw-ct',null,1,{...options,operation:'inspect-raw-ct'}),
    readMetadata:(bytes,options={})=>decode(bytes,'dicom-metadata',null,1,{...options,operation:'metadata'}),clear,destroy};
}
import {workingMemoryBytes} from './working-memory.mjs';
