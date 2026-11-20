import {ingestInputs} from './input-ingestion.mjs';

export async function ingestWorkerInputs(inputs,{onProgress}={}){
  if(!Array.isArray(inputs))throw Object.assign(new Error(),{code:'RESOURCE_LIMIT'});
  const files=[];let total=0;
  for(const input of inputs){
    const length=input.bytes?.byteLength??input.blob?.size;
    if(!Number.isSafeInteger(length)||length<0||!Number.isSafeInteger(total+=length))throw Object.assign(new Error(),{code:'RESOURCE_LIMIT'});
  }
  for(const input of inputs)files.push(input.bytes instanceof Uint8Array?{name:input.name,sourcePath:input.sourcePath,bytes:input.bytes}:
    {name:input.name,sourcePath:input.sourcePath,size:input.blob.size,arrayBuffer:()=>input.blob.arrayBuffer()});
  return ingestInputs(files,{onProgress});
}

if(typeof self!=='undefined'&&typeof document==='undefined')self.addEventListener('message',async event=>{
  const message=event.data;if(message?.type!=='ingest')return;
  try{
    const result=await ingestWorkerInputs(message.inputs,{onProgress:progress=>self.postMessage({type:'progress',id:message.id,progress})});
    const transfers=new Set();
    const visit=value=>{if(value instanceof Uint8Array){transfers.add(value.buffer);return;}if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);};
    visit(result);self.postMessage({type:'result',id:message.id,result},[...transfers]);
  }catch(error){self.postMessage({type:'error',id:message.id,code:typeof error?.code==='string'?error.code:'INVALID_INPUT'});}
});
