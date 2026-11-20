import {sha256} from '@noble/hashes/sha2.js';

/** Bounded working memory: never request an entire original for background hashing. */
export async function sha256File(file,{signal}={}){
  const check=()=>{if(signal?.aborted)throw new DOMException('File check cancelled.','AbortError');};
  const state=sha256.create();
  for(let position=0;position<file.size;position+=1024*1024){
    check();state.update(new Uint8Array(await file.slice(position,position+1024*1024).arrayBuffer()));
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  check();return Array.from(state.digest(),b=>b.toString(16).padStart(2,'0')).join('');
}
