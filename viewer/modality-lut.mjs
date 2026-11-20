// Import the pinned CPU mapper without the viewport's state and window policy.
import getCornerstoneModalityLut from './node_modules/@cornerstonejs/core/dist/esm/RenderingEngine/helpers/cpuFallback/rendering/getModalityLut.js';

const cornerstoneLookups=new WeakMap();

/** Read the top-level Modality LUT described in DICOM PS3.3 C.11.1. */
export function readModalityLut(dataset, signed, littleEndian) {
  const sequence = dataset.elements.x00283000;
  if (!sequence) return null;
  if((sequence.vr&&sequence.vr!=='SQ')||sequence.items?.length!==1)throw new Error('Invalid Modality LUT.');
  const {first,values}=readSampledLut(sequence.items[0].dataSet,signed,littleEndian,'Modality',[8,16]);
  return {first,values};
}

/** First sampled VOI alternative. Descriptors may encode signed first input. */
export function readVoiLut(sequence,signed,littleEndian) {
  if((sequence.vr&&sequence.vr!=='SQ')||!sequence.items?.length)throw new Error('Invalid VOI LUT.');
  return readSampledLut(sequence.items[0].dataSet,signed,littleEndian,'VOI',
    Array.from({length:9},(_,index)=>8+index));
}

function readSampledLut(item,signed,littleEndian,name,precisions) {
  const descriptor = item?.elements.x00283002, data = item?.elements.x00283006;
  const invalid = () => { throw new Error(`Invalid ${name} LUT.`); };
  if (descriptor?.length !== 6 || (descriptor.vr && !['US','SS'].includes(descriptor.vr))
      || !data || (data.vr && !['US','OW'].includes(data.vr))) invalid();
  const count = item.uint16('x00283002', 0) || 65536;
  const first = (name==='VOI'?(descriptor.vr?descriptor.vr==='SS':signed):signed) ? item.int16('x00283002', 1) : item.uint16('x00283002', 1);
  const bits = item.uint16('x00283002', 2);
  const words = data.length === count * 2;
  const packed = bits === 8 && data.vr !== 'US' && data.length === count + count % 2;
  if (!precisions.includes(bits) || (!words && !packed) || !Number.isInteger(first)
      || data.dataOffset + data.length > item.byteArray.byteLength) invalid();
  const view = new DataView(item.byteArray.buffer, item.byteArray.byteOffset + data.dataOffset, data.length);
  const values = new Uint16Array(count), maximum = 2 ** bits - 1;
  for (let index = 0; index < count; index++) {
    // Packed bytes in OW are ordered by the low and high halves of each word.
    const value = words ? view.getUint16(index * 2, littleEndian)
      : view.getUint8(littleEndian ? index : index ^ 1);
    if (value > maximum) invalid();
    values[index] = value;
  }
  return {first,values,bits};
}

export function lookupModalityValue(lut, sample) {
  let lookup=cornerstoneLookups.get(lut);
  if(!lookup){
    // The pinned CPU mapper indexes the array directly. Translate to its
    // zero-based domain so signed and nonzero DICOM descriptors work too.
    lookup=getCornerstoneModalityLut(1,0,{firstValueMapped:0,lut:lut.values});
    cornerstoneLookups.set(lut,lookup);
  }
  return lookup(Math.min(lut.values.length-1,sample-lut.first));
}
