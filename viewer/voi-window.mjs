// DICOM PS3.3 C.11.2.1.2 and C.11.2.1.3. Output is unitless 8-bit display intensity.
// https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.11.2.html
import getCornerstoneVoiLut from './node_modules/@cornerstonejs/core/dist/esm/RenderingEngine/helpers/cpuFallback/rendering/getVOILut.js';
import {lookupModalityValue} from './modality-lut.mjs';
import {isPaddingSample} from './parametric-map.mjs';

const FUNCTIONS=new Set(['LINEAR','LINEAR_EXACT','SIGMOID']);
const cornerstoneLookups=new WeakMap();

export function validWindow(window){
  return !!window&&typeof window.center==='number'&&Number.isFinite(window.center)
    &&typeof window.width==='number'&&Number.isFinite(window.width)
    &&FUNCTIONS.has(window.function??'LINEAR')&&((window.function??'LINEAR')==='LINEAR'?window.width>=1:window.width>0);
}
export function normalizeWindow(window){
  if(!validWindow(window))throw new Error('The display window is invalid or unsupported.');
  return Object.freeze({center:window.center,width:window.width,function:window.function??'LINEAR'});
}
function evaluate(value,window){
  const {center,width,function:kind}=window;
  if(kind==='SIGMOID')return 255/(1+Math.exp(-4*((value-center)/width)));
  if(kind==='LINEAR_EXACT')return Math.min(255,Math.max(0,((value-center)/width+0.5)*255));
  const lower=center-0.5-(width-1)/2,upper=center-0.5+(width-1)/2;
  if(value<=lower)return 0;
  if(value>upper)return 255;
  return ((value-(center-0.5))/(width-1)+0.5)*255;
}
/** Apply a source VOI function after the modality transformation, before polarity. */
export function voiValue(value,window){
  if(!validWindow(window))throw new Error('The display window is invalid or unsupported.');
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error('The display sample is invalid.');
  return evaluate(value,window);
}
export function modalityValue(image,stored){
  return image.modalityLut ? lookupModalityValue(image.modalityLut,stored)
    : stored*(image.slope??1)+(image.intercept??0);
}
function sampledVoiValue(lut,value){
  const maximum=2**lut.bits-1;
  if(!cornerstoneLookups.has(lut)){
    // Cornerstone infers the bit depth and shifts to 8 bits. Require exact
    // intermediate values so later windowing and inversion stay equivalent.
    let lookup=null;
    try{
      const native=getCornerstoneVoiLut(undefined,undefined,{firstValueMapped:lut.first,lut:lut.values});
      if(lut.values.every((entry,index)=>native(lut.first+index)===entry*255/maximum))lookup=native;
    }catch(error){
      // The pinned helper spreads every entry into Math.max. A browser's
      // argument limit must not make an otherwise valid 65,536-entry table fail.
      if(!(error instanceof RangeError))throw error;
    }
    cornerstoneLookups.set(lut,lookup);
  }
  const lookup=cornerstoneLookups.get(lut);
  return lookup&&Number.isInteger(value)?lookup(value):lookupModalityValue(lut,value)*255/maximum;
}
export function windowInputValue(image,stored){
  const value=modalityValue(image,stored),lut=image.sampledVoiLut;
  return lut?sampledVoiValue(lut,value):value;
}

/** Floating-point samples can be windowed directly without an integer LUT. */
export function floatingVoi(image,window,{invert=false}={}){
  const normalized=normalizeWindow(window);
  return stored=>{
    if(!Number.isFinite(stored)||isPaddingSample(stored,image.pixelPadding))return 0;
    const value=modalityValue(image,stored),gray=evaluate(value,normalized);
    return invert?255-gray:gray;
  };
}
/** Lookup by unchanged stored integer samples; fractional/negative rescale is evaluated exactly. */
export function buildStoredVoiLut(image,window,{invert=false}={}){
  const normalized=normalizeWindow(window),minimum=image?.minPixelValue,maximum=image?.maxPixelValue;
  const slope=image?.slope??1,intercept=image?.intercept??0;
  if(!Number.isInteger(minimum)||!Number.isInteger(maximum)||minimum>maximum||minimum< -32768||maximum>65535
      ||maximum-minimum+1>65536||!Number.isFinite(slope)||slope===0||!Number.isFinite(intercept))
    throw new Error('The stored display sample range is invalid or excessive.');
  const values=new Uint8ClampedArray(maximum-minimum+1);
  for(let stored=minimum;stored<=maximum;stored++){
    const modality=windowInputValue(image,stored);
    if(!Number.isFinite(modality))throw new Error('The modality transformation exceeds the display range.');
    const value=evaluate(modality,normalized);values[stored-minimum]=invert?255-value:value;
  }
  return {values,offset:-minimum,minimum,maximum};
}
