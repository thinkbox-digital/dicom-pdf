/** Allocation headroom, separate from input size. Cache/decoder work must fit its runtime. */
export function workingMemoryBytes(){
  const memory=globalThis.performance?.memory;
  const reported=Number(memory?.jsHeapSizeLimit)||Number(globalThis.navigator?.deviceMemory)*1024**3;
  // When the runtime exposes no memory information, retain conservative working
  // headroom. This governs allocations, not source-file eligibility or hashes.
  const heap=Number.isFinite(reported)&&reported>0?reported:2**31;
  const used=Number(memory?.usedJSHeapSize)||0;
  return Math.max(1,Math.floor((heap-used)/4));
}

export const MAX_FRAME_PIXELS=32*1024*1024;
const MAX_CANVAS_EDGE=16384;

export function frameFitsMemory(rows,columns,{bits=16,samples=1,residentBytes=0,budget=workingMemoryBytes()}={}){
  const count=rows*columns;
  if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(columns)||rows<1||columns<1
    ||rows>MAX_CANVAS_EDGE||columns>MAX_CANVAS_EDGE||count>MAX_FRAME_PIXELS)return false;
  // The decoded frame must also fit the 64 MiB image cache and transfer limit.
  if(count*(samples>1?4:Math.max(2,(bits||16)/8))>64*1024*1024)return false;
  // Reserve one decoded buffer, codec work planes, RGBA staging and canvas storage.
  const bytesPerPixel=8+Math.max(4,Math.min(4,samples||1)*Math.max(4,(bits||16)/8));
  return count*bytesPerPixel+residentBytes<=budget;
}
