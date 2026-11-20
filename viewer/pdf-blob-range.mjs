/** PDF.js range transport over local Blob slices; never copies the entire PDF first. */
export function localPdfRange(Transport,file,onFailure=()=>{}){
  return new class extends Transport {
    stopped=false;
    constructor(){super(file.size,new Uint8Array(),true);}
    async requestDataRange(begin,end){
      try{
        if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<begin||end>file.size)throw new Error('Invalid local PDF byte range');
        if(end-begin>workingMemoryBytes())throw new Error('This PDF operation needs more available browser memory');
        const result=new Uint8Array(end-begin);
        for(let start=begin;start<end&&!this.stopped;start+=1024*1024){
          const bytes=new Uint8Array(await file.slice(start,Math.min(start+1024*1024,end)).arrayBuffer());
          if(!this.stopped)result.set(bytes,start-begin);
        }
        // PDF.js requires one complete reply for each requested range. Sending
        // partial replies causes its range reader to finish before the data arrives.
        if(!this.stopped)this.onDataRange(begin,result);
      }catch{if(!this.stopped){this.stopped=true;onFailure();}}
    }
    abort(){this.stopped=true;}
  }();
}
import {workingMemoryBytes} from './working-memory.mjs';
