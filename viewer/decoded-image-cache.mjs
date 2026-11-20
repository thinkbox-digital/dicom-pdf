/** Byte-bounded decoded images. The last accessed frame is the last evicted. */
export function createDecodedImageCache({maxBytes=64*1024*1024,onEvict}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new RangeError('The decoded image cache budget is invalid.');
  if(onEvict!==undefined&&typeof onEvict!=='function')throw new TypeError('The decoded image eviction callback is invalid.');
  const records=new Map(),notifications=[];let total=0,notifying=false;
  function byteSize(decoded){
    let bytes;
    try{
      const {image}=decoded;
      bytes=image.getPixelData().byteLength+(image.modalityLut?.values.byteLength??0)
        +(image.sampledVoiLut?.values.byteLength??0)+(image.presentationLut?.values.byteLength??0);
    }catch{throw new TypeError('Decoded image pixels are unavailable.');}
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>maxBytes)throw new RangeError('The decoded image exceeds the cache byte budget.');
    return bytes;
  }
  function remove(id){
    const record=records.get(id);if(!record)return false;
    records.delete(id);total-=record.bytes;notifications.push([id,record.decoded]);return true;
  }
  function notify(){
    if(notifying)return;notifying=true;
    try{while(notifications.length){const [id,decoded]=notifications.shift();try{onEvict?.(id,decoded);}catch{ /* Cache accounting must survive an external cache failure. */ }}}
    finally{notifying=false;}
  }
  const cache={
    get(id){const record=records.get(id);if(!record)return undefined;records.delete(id);records.set(id,record);return record.decoded;},
    peek:id=>records.get(id)?.decoded,
    set(id,decoded){
      const bytes=byteSize(decoded); // Validate before changing an existing frame or recency.
      remove(id);records.set(id,{decoded,bytes});total+=bytes;
      while(total>maxBytes)remove(records.keys().next().value);
      notify();return cache;
    },
    delete(id){const removed=remove(id);notify();return removed;},
    clear(){for(const id of records.keys())remove(id);notify();},
    has:id=>records.has(id),
    *entries(){for(const [id,record] of records)yield [id,record.decoded];},
    keys:()=>records.keys(),
    get size(){return records.size;},
    get byteLength(){return total;},
    [Symbol.iterator](){return cache.entries();},
  };
  return cache;
}
