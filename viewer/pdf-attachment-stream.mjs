import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

// A typical single 512×512 16-bit CT slice fits this bounded native digest.
// Larger decoded streams feed their accumulated prefix and remaining chunks to SHA-256.
export const NATIVE_DIGEST_BYTES=1024*1024;

function joinChunks(chunks,size){
  if(chunks.length===1)return chunks[0];
  const decoded=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){decoded.set(chunk,offset);offset+=chunk.byteLength;}
  return decoded;
}

// Null asks the PDF.js caller to retry the original stream with its decoder.
// Never return a digest computed from a partial native decode.
export async function readNativeFlate(encoded,limit,digestOnly){
  if(encoded.byteLength>limit)throw new Error('Embedded file exceeds available browser memory.');
  const reader=new Blob([encoded]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks=[];
  // WebCrypto may copy its input. Allow space for the prefix, a joined buffer
  // and that copy within the caller's working-memory budget.
  const nativeLimit=Math.min(NATIVE_DIGEST_BYTES,Math.floor(limit/3));
  let size=0,hash=null;
  try{
    for(;;){
      let result;
      try{result=await reader.read();}catch{return null;}
      if(result.done)break;
      size+=result.value.byteLength;
      if(size>limit){
        await reader.cancel();
        throw new Error('Embedded file exceeds available browser memory.');
      }
      if(digestOnly&&!hash&&size>nativeLimit){
        hash=sha256.create();
        for(const chunk of chunks)hash.update(chunk);
        chunks.length=0;
      }
      if(hash)hash.update(result.value);
      else chunks.push(result.value);
    }
    if(hash)return {size,digest:bytesToHex(hash.digest())};
    const decoded=joinChunks(chunks,size);
    if(!digestOnly)return decoded;
    return {size,digest:bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',decoded)))};
  }finally{hash?.destroy();reader.releaseLock();}
}
