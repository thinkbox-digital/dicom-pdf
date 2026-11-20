import {workingMemoryBytes} from './working-memory.mjs';

/** One local PDF's attachment index and bounded cache of decoded bytes. */
export async function openPdfAttachments(pdf) {
  const messages=pdf._transport.messageHandler;
  const index=await messages.sendWithPromise('DicomAttachmentIndex',null);
  const files=Object.create(null), cache=new Map(), pending=new Map();
  let cachedBytes=0;
  const budget=Math.min(32*1024*1024,workingMemoryBytes());

  for(const {key,filename,description,embedded} of index) {
    const file={key,filename,description,embedded};
    file.peek=()=>cache.get(key);
    let digest;
    // Rechecking trust on the same open PDF can reuse unchanged attachment hashes.
    file.readDigest=()=>digest??=messages.sendWithPromise('DicomReadAttachment',{key,limit:workingMemoryBytes(),digestOnly:true})
      .then(result=>{
        if(result===null)return null;
        if(!Number.isSafeInteger(result?.size)||result.size<0||!(/^[a-f0-9]{64}$/.test(result.digest)))
          throw new Error('The embedded file digest could not be read.');
        file.byteLength=result.size;
        return result;
      }).catch(error=>{digest=undefined;throw error;});
    file.read=async()=>{
      const cached=cache.get(key);
      if(cached){cache.delete(key);cache.set(key,cached);return cached;}
      if(pending.has(key))return pending.get(key);
      const request=messages.sendWithPromise('DicomReadAttachment',{key,limit:workingMemoryBytes()})
        .then(bytes=>{
          if(!(bytes instanceof Uint8Array))throw new Error('The embedded file has no readable content.');
          file.byteLength=bytes.byteLength;
          if(bytes.byteLength<=budget){
            while(cache.size&&(cachedBytes+bytes.byteLength>budget||cache.size>=128)){
              const oldest=cache.keys().next().value;
              cachedBytes-=cache.get(oldest).byteLength;cache.delete(oldest);
            }
            cache.set(key,bytes);cachedBytes+=bytes.byteLength;
          }
          return bytes;
        }).finally(()=>pending.delete(key));
      pending.set(key,request);
      return request;
    };
    files[key]=file;
  }
  return files;
}

export async function attachmentBytes(file) {
  if(file.read)return file.read();
  if(file.content instanceof Uint8Array)return file.content;
  if(file.content instanceof ArrayBuffer)return new Uint8Array(file.content);
  if(ArrayBuffer.isView(file.content))return new Uint8Array(file.content.buffer,file.content.byteOffset,file.content.byteLength);
  throw new Error('The embedded file has no readable content.');
}
