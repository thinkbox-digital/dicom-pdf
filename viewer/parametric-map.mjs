export const PARAMETRIC_MAP_SOP='1.2.840.10008.5.1.4.1.1.30';

export function floatingPixelType(elements){
  if(elements.x7fe00008) return {element:elements.x7fe00008,bits:32,vr:'OF',
    paddingTags:['x00280122','x00280124'],paddingVR:'FL'};
  if(elements.x7fe00009) return {element:elements.x7fe00009,bits:64,vr:'OD',
    paddingTags:['x00280123','x00280125'],paddingVR:'FD'};
  return null;
}

export function validFloatingPixelType(type,{elements,sop,bits,samples,photo,native}){
  return sop===PARAMETRIC_MAP_SOP && native && bits===type.bits && samples===1 && photo==='MONOCHROME2'
    && (!type.element.vr||type.element.vr===type.vr) && !elements.x7fe00010 && !elements.x00287fe0
    && !(elements.x7fe00008&&elements.x7fe00009);
}

export function isFloatingPixels(pixels){
  return pixels instanceof Float32Array || pixels instanceof Float64Array;
}

export function isPaddingSample(value,padding){
  return !!padding && value>=padding.minimum && value<=padding.maximum;
}
