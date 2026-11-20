const MESSAGES={
  INPUT_WORKER_UNAVAILABLE:'This browser could not start the local file reader.',
  INPUT_WORKER_FAILED:'The local file reader stopped. Select the files again to retry.',
  RESOURCE_LIMIT:'The selected files exceed the supported input limits.',
  LIMIT_EXCEEDED:'The selected files exceed the supported input limits.',
  UNSAFE_PATH:'The selected archive contains an unsafe file path and was not opened.',
  INVALID_INPUT:'The selected files could not be opened safely.',
  INVALID_DICOM:'The selected file could not be read as a supported DICOM object.',
  ZIP_CORRUPT:'The selected ZIP could not be read safely.',
  ZIP_UNSUPPORTED:'This ZIP encoding is not supported. The original archive remains available.',
};
const aborted=()=>new DOMException('Opening files cancelled.','AbortError');
function inputError(code){const safe=Object.hasOwn(MESSAGES,code)?code:'INPUT_WORKER_FAILED';const error=new Error(MESSAGES[safe]);error.name='InputIngestionError';error.code=safe;return error;}
function defaultFactory(){
  if(typeof Worker!=='function')throw inputError('INPUT_WORKER_UNAVAILABLE');
  if(typeof DICOM_INPUT_WORKER_URL==='string')return {worker:new Worker(new URL(DICOM_INPUT_WORKER_URL,document.baseURI),{type:'module'})};
  if(typeof DICOM_INPUT_WORKER_SOURCE==='string'){
    const url=URL.createObjectURL(new Blob([DICOM_INPUT_WORKER_SOURCE],{type:'text/javascript'}));
    try{return {worker:new Worker(url,{type:'classic'}),dispose:()=>URL.revokeObjectURL(url)};}
    catch(error){URL.revokeObjectURL(url);throw error;}
  }
  throw inputError('INPUT_WORKER_UNAVAILABLE');
}

/** Immutable File/Blob handles cross to a disposable worker; parsing never falls back to the UI. */
export function createIngestionClient({workerFactory=defaultFactory}={}){
  let current=null,sequence=0,closed=false;
  function clear(){current?.cancel();}
  async function ingest(files,{signal,onProgress=()=>{}}={}){
    if(closed)throw inputError('INPUT_WORKER_UNAVAILABLE');
    if(signal?.aborted)throw aborted();
    clear();const id=++sequence,inputs=Array.from(files||[]);
    if(!inputs.length)throw inputError('RESOURCE_LIMIT');
    const normalized=inputs.map(value=>value?.bytes instanceof ArrayBuffer||ArrayBuffer.isView(value?.bytes)?{name:value.name,sourcePath:value.sourcePath||value.name,bytes:value.bytes instanceof Uint8Array?value.bytes:new Uint8Array(value.bytes.buffer||value.bytes,value.bytes.byteOffset||0,value.bytes.byteLength)}:
      {name:value.name,sourcePath:value.webkitRelativePath||value.sourcePath||value.name,blob:value.blob||value});
    let total=0;
    for(const file of normalized){const size=file.bytes?.byteLength??file.blob?.size;
      if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(total+=size))throw inputError('RESOURCE_LIMIT');}
    let record;
    try{const created=workerFactory();record=created?.worker?created:{worker:created};if(!record.worker?.postMessage)throw new Error();}
    catch{throw inputError('INPUT_WORKER_UNAVAILABLE');}
    return new Promise((resolve,reject)=>{
      let done=false;
      function finish(error,result){
        if(done)return;done=true;signal?.removeEventListener('abort',cancel);
        record.worker.removeEventListener('message',message);record.worker.removeEventListener('error',failure);record.worker.removeEventListener('messageerror',failure);
        record.worker.terminate();record.dispose?.();if(current?.id===id)current=null;
        error?reject(error):resolve(result);
      }
      const cancel=()=>finish(aborted());
      const failure=event=>{event.preventDefault?.();finish(inputError('INPUT_WORKER_FAILED'));};
      const message=event=>{
        if(event.data?.id!==id||done)return;
        if(event.data.type==='progress'){try{onProgress(event.data.progress);}catch{}return;}
        if(event.data.type==='result')finish(null,event.data.result);
        else if(event.data.type==='error')finish(inputError(event.data.code));
      };
      current={id,cancel};signal?.addEventListener('abort',cancel,{once:true});
      record.worker.addEventListener('message',message);record.worker.addEventListener('error',failure);record.worker.addEventListener('messageerror',failure);
      try{record.worker.postMessage({type:'ingest',id,inputs:normalized});}catch{finish(inputError('INPUT_WORKER_FAILED'));}
    });
  }
  return {ingest,clear,destroy(){clear();closed=true;}};
}
