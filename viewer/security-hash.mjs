import {sha256 as incrementalSha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export async function sha256(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** Reuse the hash of the unchanged prefix across incremental signatures. */
export function createPdfRangeHasher(blob,check=()=>{}) {
  const mib=1024*1024,chunkSize=8*mib,checkpointInterval=16*mib;
  const prefixes=new Map([[0,incrementalSha256.create()]]);
  async function append(hash,start,end,onRead,savePrefixes=false) {
    for(let offset=start;offset<end;){
      check();
      const next=Math.min(offset+chunkSize,end,(Math.floor(offset/checkpointInterval)+1)*checkpointInterval);
      const bytes=new Uint8Array(await blob.slice(offset,next).arrayBuffer());
      hash.update(bytes);
      if(savePrefixes&&(next===end||next%checkpointInterval===0)&&prefixes.size<200)
        prefixes.set(next,hash.clone());
      onRead(next-offset);
      offset=next;
    }
    check();
  }
  return async function hashCovered(end,gaps,onProgress){
    let last=0;
    if(!Number.isSafeInteger(end)||end<0||end>blob.size||gaps.some(([start,stop])=>{
      const invalid=!Number.isSafeInteger(start)||!Number.isSafeInteger(stop)||start<last||stop<=start||stop>end;
      last=stop;
      return invalid;
    }))throw Error('Invalid covered PDF byte ranges.');
    const boundary=gaps[0]?.[0]??end;
    let prefix=0;
    for(const position of prefixes.keys())if(position<=boundary&&position>prefix)prefix=position;
    const hash=prefixes.get(prefix).clone();
    const total=gaps.reduce((length,[start,stop])=>length-(stop-start),end);
    let processed=prefix;
    const onRead=length=>{processed+=length;onProgress?.(processed,total);};
    onProgress?.(processed,total);
    await append(hash,prefix,boundary,onRead,true);
    let position=boundary;
    for(const [start,stop]of gaps){
      await append(hash,position,start,onRead);
      position=stop;
    }
    await append(hash,position,end,onRead);
    return bytesToHex(hash.digest());
  };
}
