import {workingMemoryBytes} from './working-memory.mjs';
import {Inflate} from 'fflate';

/** Check each small compressed chunk before retaining the next output allocation. */
export function inflateDicomBytes(input,offset,{maxBytes=workingMemoryBytes(),maxRatio=2000}={}){
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(offset)||offset<0||offset>=input.length)throw new Error('Invalid deflated DICOM dataset.');
  let size=0,finished=false;const chunks=[];
  const inflater=new Inflate((chunk,last)=>{
    size+=chunk.length;
    if(size>maxBytes||size>Math.max(1,input.length-offset)*maxRatio)throw new Error('Deflated DICOM dataset exceeds the decoding limit.');
    chunks.push(chunk);finished=last;
  });
  for(let position=offset;position<input.length;position+=1024)inflater.push(input.subarray(position,Math.min(position+1024,input.length)),position+1024>=input.length);
  if(!finished)throw new Error('Incomplete deflated DICOM dataset.');
  const result=new Uint8Array(offset+size);result.set(input.subarray(0,offset));let position=offset;
  for(const chunk of chunks){result.set(chunk,position);position+=chunk.length;}
  return result;
}
