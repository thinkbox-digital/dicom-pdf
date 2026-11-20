import {frameFitsMemory,workingMemoryBytes} from './working-memory.mjs';
import dicomParser from 'dicom-parser';
import { parseDicomCompatible } from './dicom-parser-compat.mjs';
import { readSourceWindowPresets } from './source-window-presets.mjs';
import { validWindow } from './voi-window.mjs';
import { inflateDicomBytes } from './bounded-inflate.mjs';
import { expandSegmentedPalette } from './segmented-palette.mjs';
import { lookupModalityValue, readModalityLut, readVoiLut } from './modality-lut.mjs';
import { isZeroPixelSpacing } from './display-status.mjs';
import { PARAMETRIC_MAP_SOP, floatingPixelType, validFloatingPixelType, isPaddingSample } from './parametric-map.mjs';
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';
import createOpenJPEG from '@cornerstonejs/codec-openjpeg/decode';
import createCharLS from '@cornerstonejs/codec-charls/decode';
import {decodeJpegExtended12} from './jpeg-extended.mjs';
import {JPEG_LS,JPEG2000} from './image-transfer-syntax.mjs';
import {decodeRleSamples} from './rle-pixel-data.mjs';

const NATIVE = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);
const JPEG_EXTENDED = '1.2.840.10008.1.2.4.51';
const JPEG = new Set(['1.2.840.10008.1.2.4.50', JPEG_EXTENDED]);
const JPEG_LOSSLESS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);
const RLE = '1.2.840.10008.1.2.5';
const ZERO_DS = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[Ee][+-]?\d+)?$/;
export const SUPPORTED_SYNTAXES = new Set([...NATIVE, ...JPEG, ...JPEG_LOSSLESS, ...JPEG_LS, ...JPEG2000, RLE]);
const MAX_INFLATED = workingMemoryBytes();
let openJPEG, charLS;

function requireValue(test, message) { if (!test) throw new Error(message); }
function parse(bytes, imageId, previewEntry, sourceFrame,sourceParsing=null,requireEmptyColorProfile=false) {
  const ds = parseDicomCompatible(bytes, {sourceParsing,inflater:(original,offset)=>inflateDicomBytes(original,offset,{maxBytes:MAX_INFLATED})});
  const str = (tag, source = ds) => source.string(tag)?.trim();
  const n = tag => ds.uint16(tag);
  const syntax = str('x00020010') || sourceParsing?.transferSyntaxUID;
  requireValue(SUPPORTED_SYNTAXES.has(syntax), `Unsupported transfer syntax: ${syntax || 'missing'}`);
  const rows = n('x00280010'), columns = n('x00280011'), samples = n('x00280002') ?? 1;
  const bits = n('x00280100'), stored = n('x00280101') ?? bits, highBit = n('x00280102') ?? stored - 1, signed = n('x00280103') ?? 0;
  const photo = str('x00280004');
  if(requireEmptyColorProfile){
    const pending=[ds];
    while(pending.length){
      const current=pending.pop();
      requireValue(!current.elements.x00282000?.length,'A non-empty ICC profile is present.');
      for(const element of Object.values(current.elements)){
        for(const item of element.items||[])if(item.dataSet)pending.push(item.dataSet);
      }
    }
  }
  const frameCount = Number(str('x00280008') || 1);
  const frame = sourceFrame ?? previewEntry?.sourceFrame ?? 1;
  requireValue(Number.isSafeInteger(frameCount) && frameCount >= 1 && Number.isSafeInteger(frame) && frame >= 1 && frame <= frameCount, 'Invalid or unavailable DICOM source frame.');
  requireValue(frameFitsMemory(rows,columns,{bits,samples,residentBytes:bytes.byteLength+(ds.byteArray===bytes?0:ds.byteArray.byteLength)}),
    'Image frame exceeds the working memory or canvas limit.');
  const gray = ['MONOCHROME1','MONOCHROME2'].includes(photo);
  requireValue(gray ? samples === 1 : ['RGB','YBR_FULL','YBR_FULL_422','YBR_PARTIAL_422','YBR_RCT','YBR_ICT','PALETTE COLOR','ARGB','CMYK'].includes(photo), `Unsupported photometric interpretation: ${photo || 'missing'}`);
  const planar = n('x00280006') ?? 0;
  const wideRgb = photo === 'RGB' && (bits === 16 || bits === 32) && signed === 0 && samples === 3
    && [0,1].includes(planar) && (NATIVE.has(syntax) || syntax === RLE);
  const sop=str('x00080016')||str('x00020002'),floating=floatingPixelType(ds.elements);
  if(floating){
    requireValue(validFloatingPixelType(floating,{elements:ds.elements,sop,bits,samples,photo,native:NATIVE.has(syntax)}),
      'Unsupported floating-point pixel encoding.');
    requireValue(rows*columns*bits/8<=64*1024*1024,'Floating-point frame exceeds the decoded frame byte limit.');
  } else requireValue(([1,8,16].includes(bits) || bits === 32 && wideRgb) && stored >= 1 && stored <= bits
    && highBit >= stored - 1 && highBit < bits && [0,1].includes(signed), 'Unsupported integer pixel encoding.');
  requireValue(gray || photo === 'PALETTE COLOR' || bits === 8 || wideRgb, 'Unsupported color pixel encoding.');
  // Account for the three uint32 channels, RGBA output, and one RLE byte plane.
  requireValue(!wideRgb || bits !== 32 || rows * columns * (syntax === RLE ? 17 : 16) <= workingMemoryBytes(),
    '32-bit RGB frame exceeds the working memory limit.');
  requireValue(samples >= 1 && samples <= 4, 'Unsupported samples per pixel.');
  const el = floating?.element || ds.elements.x7fe00010;
  requireValue(el, 'No image Pixel Data is present in this DICOM object.');
  const perFrame = ds.elements.x52009230?.items?.[frame - 1]?.dataSet;
  const shared = ds.elements.x52009229?.items?.[0]?.dataSet;
  const group = tag => perFrame?.elements[tag]?.items?.[0]?.dataSet || shared?.elements[tag]?.items?.[0]?.dataSet || ds;
  const modality = group('x00289145'), voi = group('x00289132');
  const number = (tag, source = ds) => { const value = str(tag, source); return value === undefined || value === '' ? undefined : Number(value.split('\\')[0]); };
  requireValue(!ds.elements.x20500010,
    'VOI or Presentation LUT sequences are not supported in the interactive viewer.');
  const modalityLut = readModalityLut(ds,signed,syntax!=='1.2.840.10008.1.2.2');
  requireValue(!modalityLut||sop!==PARAMETRIC_MAP_SOP,'Parametric Maps do not support a Modality LUT.');
  if(modalityLut){
    requireValue(!previewEntry,'The recorded PDF preview does not support a Modality LUT.');
    requireValue(gray && !ds.elements.x00281052 && !ds.elements.x00281053
      && !modality.elements.x00281052 && !modality.elements.x00281053,'Invalid Modality LUT and rescale combination.');
  }
  const slope = number('x00281053', modality) ?? 1, intercept = number('x00281052', modality) ?? 0;
  requireValue(Number.isFinite(slope) && slope !== 0 && Number.isFinite(intercept), 'Unsupported rescale slope or intercept.');
  const sampledVoi=voi.elements.x00283010;
  const alternative={center:number('x00281050',voi),width:number('x00281051',voi),function:str('x00281056',voi)||'LINEAR'};
  // Some grayscale exports store a single 0/0 pair in place of a usable window.
  // Treat it as absent for interactive display and use the existing pixel range.
  const zeroWindowFallback=gray&&!floating&&!previewEntry&&!sampledVoi&&voi===ds&&alternative.function==='LINEAR'
    &&['x00281050','x00281051'].every(tag=>{
      const element=voi.elements[tag];
      return element&&(!element.vr||element.vr==='DS')&&ZERO_DS.test(str(tag,voi)??'');
    });
  const sourceWindowPresent=!zeroWindowFallback&&voi.elements.x00281050?.length&&voi.elements.x00281051?.length;
  const sourceWindow=!zeroWindowFallback&&alternative.center!==undefined&&alternative.width!==undefined?alternative:null;
  let sampledVoiLut=null;
  if(sampledVoi&&!validWindow(alternative)){
    requireValue(gray&&!floating&&!previewEntry&&(modalityLut||Number.isInteger(slope)&&Number.isInteger(intercept)),
      'VOI or Presentation LUT sequences are not supported in the interactive viewer.');
    sampledVoiLut=readVoiLut(sampledVoi,signed||intercept<0,syntax!=='1.2.840.10008.1.2.2');
  }
  const voiFunction = sampledVoiLut||floating&&!sourceWindowPresent ? 'LINEAR_EXACT' : alternative.function;
  requireValue(!gray || ['LINEAR','LINEAR_EXACT','SIGMOID'].includes(voiFunction), `Unsupported VOI LUT function: ${voiFunction}`);
  const shape = str('x20500020');
  const invert = shape ? shape === 'INVERSE' : photo === 'MONOCHROME1';
  const legacyWindow = previewEntry?.displayAdjustments?.windowMethod === 'auto-min-max-v1';
  const padding = floating ? floatingPadding(ds,floating)
    : gray && !sourceWindowPresent && !legacyWindow ? pixelPadding(ds,signed,stored) : null;
  const measures = group('x00289110');
  const geometry = previewEntry && previewEntry.displayAdjustments?.geometryMethod === undefined
    ? {ratio:1,source:'legacy'} : imageAspect(ds,measures,rows,columns,!previewEntry);
  return {ds, str, imageId, previewEntry, syntax, rows, columns, samples, bits, stored, highBit, signed, photo, gray, wideRgb, floating, frame, frameCount, el, slope, intercept, modalityLut, sampledVoiLut, sourceWindow, zeroWindowFallback, voiFunction, invert, padding, geometry, sourceOrientation:readSourceOrientation(ds,perFrame,shared), sourceWindowPresets:readSourceWindowPresets(ds,{perFrame,shared}), planar};
}

/** Source-only orientation provenance. Rendering geometry deliberately stays unitless. */
function readSourceOrientation(ds,perFrame,shared) {
  try {
    let source=ds,provenance='top-level';
    for (const [group,name] of [[perFrame,'per-frame-functional-groups'],[shared,'shared-functional-groups']]) {
      const plane=group?.elements.x00209116;
      if (!plane) continue;
      // A present but malformed higher-priority macro must never borrow another frame's orientation.
      if ((plane.vr && plane.vr!=='SQ') || plane.items?.length!==1 || !plane.items[0].dataSet) return null;
      source=plane.items[0].dataSet;provenance=name;break;
    }
    const element=source.elements.x00200037;
    if (!element || (element.vr && element.vr!=='DS')) return null;
    const values=source.string('x00200037')?.trim().split('\\');
    if (values?.length!==6 || values.some(value=>!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?$/.test(value.trim()))) return null;
    const iop=values.map(Number);
    if (!iop.every(Number.isFinite)) return null;
    const row=iop.slice(0,3),column=iop.slice(3),norm=values=>Math.hypot(...values);
    if (Math.abs(norm(row)-1)>1e-3 || Math.abs(norm(column)-1)>1e-3
        || Math.abs(row.reduce((sum,value,index)=>sum+value*column[index],0))>1e-3) return null;
    return {iop,anatomicalOrientationType:ds.string('x00102210')?.trim() || null,provenance};
  } catch { return null; }
}

function pixelPadding(ds,signed,stored) {
  if (!ds.elements.x00280120 || ds.elements.x00280120.length === 0) return null;
  const read = tag => signed ? ds.int16(tag) : ds.uint16(tag);
  const first = read('x00280120'), last = ds.elements.x00280121?.length ? read('x00280121') : first;
  const minimum = signed ? -(2 ** (stored-1)) : 0, maximum = signed ? 2 ** (stored-1)-1 : 2 ** stored-1;
  requireValue(Number.isInteger(first) && Number.isInteger(last) && first>=minimum && first<=maximum && last>=minimum && last<=maximum,
    'Pixel padding is outside the stored sample range.');
  return {minimum:Math.min(first,last),maximum:Math.max(first,last)};
}
function floatingPadding(ds,{paddingTags,paddingVR,bits}){
  if(!ds.elements[paddingTags[0]])return null;
  const values=paddingTags.filter(tag=>ds.elements[tag]).map(tag=>{
    const element=ds.elements[tag];
    requireValue(element.length===bits/8 && (!element.vr||element.vr===paddingVR),
      'Invalid floating-point pixel padding.');
    return bits===32 ? ds.float(tag) : ds.double(tag);
  });
  const [first,last=first]=values;
  // NaNs and infinities are masked as non-finite samples during display.
  if(Number.isNaN(first)||Number.isNaN(last))return null;
  return {minimum:Math.min(first,last),maximum:Math.max(first,last)};
}
function imageAspect(ds,measures,rows,columns,allowDisplayFallback) {
  const pairs = [
    [measures,'x00280030',measures === ds ? 'PixelSpacing' : 'functional-groups.PixelSpacing',false],
    ...(measures === ds ? [] : [[ds,'x00280030','PixelSpacing',false]]),
    [ds,'x00181164','ImagerPixelSpacing',false],
    [ds,'x00182010','NominalScannedPixelSpacing',false],
    [ds,'x00280034','PixelAspectRatio',true],
  ];
  for (const [source,tag,name,integers] of pairs) {
    if (!source.elements[tag]) continue;
    const text = source.string(tag)?.trim();
    const parts = text ? text.split('\\') : [];
    const values = parts.map(value=>value.trim() === '' ? NaN : Number(value.trim()));
    const valid = values.length===2 && values.every((value,index)=>Number.isFinite(value) && (integers ? Number.isInteger(value) && value>0
      : value>0 || value===0 && (index===0 ? rows===1 : columns===1)));
    if (!valid && allowDisplayFallback) {
      if(tag==='x00280030' && isZeroPixelSpacing(text))
        return {ratio:1,source:'zero-pixel-spacing',warning:'Zero pixel spacing. Image aspect ratio is unverified.'};
      if(tag==='x00280034')
        return {ratio:1,source:'invalid-pixel-aspect-ratio',warning:'Invalid pixel aspect ratio. Displayed aspect ratio is unverified.'};
    }
    requireValue(valid,`Invalid ${name}; image aspect needs two valid spacing values.`);
    const ratio = values.includes(0) ? 1 : values[0]/values[1];
    requireValue(Number.isFinite(ratio) && ratio>=1e-6 && ratio<=1e6,`Unsupported ${name} image aspect ratio.`);
    return {ratio,source:name};
  }
  return {ratio:1,source:'default'};
}

function normalize(value, c) {
  const shift = c.highBit - c.stored + 1, modulus = 2 ** c.stored;
  let result = (Math.floor(value / 2 ** shift) & (modulus - 1)) >>> 0;
  if (c.signed && result >= modulus / 2) result -= modulus;
  return result;
}
function nativeSamples(c) {
  const {ds,el,rows,columns,samples,bits,frame,photo} = c;
  const count = rows * columns;
  const bytes = ds.byteArray;
  if(c.floating){
    const size=bits/8,frameBytes=count*size,offset=el.dataOffset+(frame-1)*frameBytes;
    requireValue(!el.hadUndefinedLength && el.length===frameBytes*c.frameCount
      && el.dataOffset+el.length<=bytes.length,'Missing or invalid floating-point Pixel Data length.');
    const view=new DataView(bytes.buffer,bytes.byteOffset+offset,frameBytes);
    const little=c.syntax!=='1.2.840.10008.1.2.2';
    const data=bits===32 ? new Float32Array(count) : new Float64Array(count);
    for(let i=0;i<count;i++)data[i]=bits===32?view.getFloat32(i*size,little):view.getFloat64(i*size,little);
    return {samples:data};
  }
  const packed422 = ['YBR_FULL_422','YBR_PARTIAL_422'].includes(photo);
  const sampleCount = count * samples;
  const frameBytes = packed422 ? count * 2 : Math.ceil(sampleCount * bits / 8);
  const offset = el.dataOffset + (bits === 1 ? Math.floor((frame - 1) * sampleCount / 8) : (frame - 1) * frameBytes);
  requireValue(!el.encapsulatedPixelData && el.length >= Math.ceil(frame * sampleCount * bits / 8) * (packed422 ? 2/3 : 1) && offset + frameBytes <= bytes.length, 'Missing or truncated native Pixel Data.');
  if (packed422) {
    requireValue(columns % 2 === 0 && bits === 8 && samples === 3, 'YBR 4:2:2 requires paired 8-bit color pixels.');
    const data = new Uint16Array(sampleCount);
    for(let i=0,j=offset;i<count;i+=2,j+=4){data[i*3]=bytes[j];data[(i+1)*3]=bytes[j+1];data[i*3+1]=data[(i+1)*3+1]=bytes[j+2];data[i*3+2]=data[(i+1)*3+2]=bytes[j+3];}
    return {samples:data, planar:0};
  }
  const data = bits === 32 ? new Uint32Array(sampleCount) : new Uint16Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = c.syntax !== '1.2.840.10008.1.2.2';
  for(let i=0;i<sampleCount;i++) {
    if(bits===1){const bit=(frame-1)*sampleCount+i;data[i]=(bytes[el.dataOffset+(bit>>3)]>>(bit&7))&1;}
    else if (bits === 32) {
      const at = offset + i * 4;
      // Big-endian OW encodes the low word first, with big-endian bytes in each word.
      data[i] = !little && el.vr === 'OW'
        ? view.getUint16(at, false) + 65536 * view.getUint16(at + 2, false)
        : view.getUint32(at, little);
    } else data[i]=bits===8?bytes[offset+i]:view.getUint16(offset+i*2,little);
  }
  return {samples:data, planar:c.planar};
}
function compressedFrame(c) {
  const {ds,el,frameCount,frame} = c;
  requireValue(el.encapsulatedPixelData && el.fragments?.length, 'Missing encapsulated image fragments.');
  if(el.basicOffsetTable?.length) return dicomParser.readEncapsulatedImageFrame(ds,el,frame-1);
  if(frameCount===1) return dicomParser.readEncapsulatedPixelDataFromFragments(ds,el,0,el.fragments.length);
  if(el.fragments.length===frameCount) return dicomParser.readEncapsulatedPixelDataFromFragments(ds,el,frame-1,1);
  if(JPEG.has(c.syntax)||JPEG_LOSSLESS.has(c.syntax)) {
    const offsets=dicomParser.createJPEGBasicOffsetTable(ds,el);
    requireValue(offsets.length===frameCount,'JPEG fragments do not identify every source frame.');
    return dicomParser.readEncapsulatedImageFrame(ds,el,frame-1,offsets);
  }
  throw new Error('Cannot establish frame boundaries without an encapsulated offset table.');
}
function rleSamples(c) {
  return {samples:decodeRleSamples(compressedFrame(c),c),planar:0};
}
function palette(c) {
  const tables=[];
  const channels=['1','2','3'];
  const littleEndian=c.syntax!=='1.2.840.10008.1.2.2';
  const segmented=channels.every(suffix=>!c.ds.elements['x0028120'+suffix] && c.ds.elements['x0028122'+suffix]);
  for(const suffix of channels){
    const descriptor='x0028110'+suffix,element=c.ds.elements['x0028120'+suffix];
    requireValue((element||segmented)&&c.ds.elements[descriptor],'Palette Color LUT data is incomplete.');
    let count=c.ds.uint16(descriptor,0);if(count===0)count=65536;
    const first=c.signed?c.ds.int16(descriptor,1):c.ds.uint16(descriptor,1),bits=c.ds.uint16(descriptor,2);
    requireValue([8,16].includes(bits),'Unsupported palette LUT entry precision.');
    if(segmented){
      const segmentData=c.ds.elements['x0028122'+suffix];
      const bytes=c.ds.byteArray;
      requireValue(c.samples===1 && bits===16 && c.ds.elements[descriptor].length===6
        && (!tables.length || tables[0].first===first && tables[0].data.length===count)
        && segmentData.dataOffset+segmentData.length<=bytes.byteLength,'Invalid segmented palette LUT.');
      const view=new DataView(bytes.buffer,bytes.byteOffset+segmentData.dataOffset,segmentData.length);
      tables.push({data:expandSegmentedPalette(view,count,littleEndian),first});
      continue;
    }
    const data=new Uint8Array(count),view=new DataView(c.ds.byteArray.buffer,c.ds.byteArray.byteOffset,c.ds.byteArray.byteLength),word=element.length>=count*2;
    requireValue(element.length>=count,'Truncated palette LUT.');
    for(let i=0;i<count;i++)data[i]=word?(view.getUint16(element.dataOffset+i*2,littleEndian)>>(bits===16?8:0))&255:c.ds.byteArray[element.dataOffset+i];
    tables.push({data,first});
  }
  return tables;
}
function colorPixels(c, decoded) {
  if(decoded.rgba) return decoded.samples;
  const values=decoded.samples,count=c.rows*c.columns,pixels=new Uint8ClampedArray(count*4),planar=decoded.planar??0;
  const luts=c.photo==='PALETTE COLOR'?palette(c):null;
  const scale=255/(2**c.stored-1);
  const component=(i,k)=>{
    const value=values[planar?k*count+i:i*c.samples+k];
    return c.wideRgb?normalize(value,c)*scale:value;
  };
  for(let i=0;i<count;i++){
    let r,g,b;
    if(luts){const value=normalize(values[i],c);[r,g,b]=luts.map(l=>l.data[Math.max(0,Math.min(l.data.length-1,value-l.first))]);}
    else if(c.photo==='ARGB'){r=component(i,1);g=component(i,2);b=component(i,3);}
    else if(c.photo==='CMYK'){const k=component(i,3)/255;r=(255-component(i,0))*(1-k);g=(255-component(i,1))*(1-k);b=(255-component(i,2))*(1-k);}
    else if(!decoded.rgb&&c.photo.startsWith('YBR')){
      let y=component(i,0),cb=component(i,1)-128,cr=component(i,2)-128;
      if(c.photo==='YBR_PARTIAL_422'){y=(y-16)*1.164383;r=y+1.596027*cr;g=y-.391762*cb-.812968*cr;b=y+2.017232*cb;}
      else {r=y+1.402*cr;g=y-.344136*cb-.714136*cr;b=y+1.772*cb;}
    } else {r=component(i,0);g=component(i,1);b=component(i,2);}
    pixels[i*4]=r;pixels[i*4+1]=g;pixels[i*4+2]=b;pixels[i*4+3]=255;
  }
  return pixels;
}
function finish(c, decoded) {
  const count=c.rows*c.columns;
  let pixels,min=Infinity,max=-Infinity,validMin=Infinity,validMax=-Infinity;
  let lutMin=Infinity,lutMax=-Infinity,validLutMin=Infinity,validLutMax=-Infinity;
  if(c.floating){
    pixels=decoded.samples;
    for(const value of pixels){
      if(!Number.isFinite(value))continue;
      min=Math.min(min,value);max=Math.max(max,value);
      if(!isPaddingSample(value,c.padding)){validMin=Math.min(validMin,value);validMax=Math.max(validMax,value);}
    }
    if(min===Infinity){min=0;max=0;}
  }else if(c.gray){
    pixels=c.signed?new Int16Array(count):new Uint16Array(count);
    for(let i=0;i<count;i++){
      const value=normalize(decoded.samples[i],c);pixels[i]=value;min=Math.min(min,value);max=Math.max(max,value);
      const useForWindow=!c.padding || value<c.padding.minimum || value>c.padding.maximum;
      if(useForWindow){validMin=Math.min(validMin,value);validMax=Math.max(validMax,value);}
      if(c.modalityLut){
        const mapped=lookupModalityValue(c.modalityLut,value);
        lutMin=Math.min(lutMin,mapped);lutMax=Math.max(lutMax,mapped);
        if(useForWindow){validLutMin=Math.min(validLutMin,mapped);validLutMax=Math.max(validLutMax,mapped);}
      }
    }
  }else{pixels=colorPixels(c,decoded);min=0;max=255;}
  const slope=c.gray?c.slope:1,intercept=c.gray?c.intercept:0;
  const range=c.modalityLut?[lutMin,lutMax]:[min*slope+intercept,max*slope+intercept].sort((a,b)=>a-b);
  const hasSourceWindow=!!c.sourceWindow;
  const legacyWindow=c.previewEntry?.displayAdjustments?.windowMethod === 'auto-min-max-v1';
  if (c.gray && !c.sampledVoiLut && !hasSourceWindow && !legacyWindow) requireValue(Number.isFinite(validMin) && Number.isFinite(validMax),'No non-padding pixels are available for automatic windowing.');
  const windowRange=c.modalityLut?[validLutMin,validLutMax]:[validMin*slope+intercept,validMax*slope+intercept].sort((a,b)=>a-b);
  const span=windowRange[1]-windowRange[0];
  const automaticWidth=c.floating ? span||1 : Math.max(1,span+1);
  const automaticCenter=c.floating ? windowRange[0]+span/2 : (windowRange[0]+windowRange[1]+1)/2;
  // Color pixels are already normalized to 8-bit RGB. A DICOM LINEAR
  // window of 128/256 maps every channel value back to itself.
  const width=c.sampledVoiLut?255:c.previewEntry?Number(c.previewEntry.displayAdjustments?.windowWidth):c.gray?(c.sourceWindow?.width??automaticWidth):256;
  const center=c.sampledVoiLut?127.5:c.previewEntry?Number(c.previewEntry.displayAdjustments?.windowCenter):c.gray?(c.sourceWindow?.center??automaticCenter):128;
  requireValue(validWindow({center,width,function:c.gray?c.voiFunction:'LINEAR'}),'Invalid window center/width.');
  const image={imageFrame:{},imageId:c.imageId,rows:c.rows,columns:c.columns,width:c.columns,height:c.rows,
    minPixelValue:min,maxPixelValue:max,slope,intercept,windowCenter:center,windowWidth:width,voiLUTFunction:c.voiFunction,
    color:!c.gray,rgba:!c.gray,numberOfComponents:c.gray?1:4,invert:c.gray&&c.invert,rowPixelSpacing:c.geometry.ratio,columnPixelSpacing:1,
    numberOfFrames:c.frameCount,sizeInBytes:pixels.byteLength+(c.modalityLut?.values.byteLength??0)+(c.sampledVoiLut?.values.byteLength??0),getPixelData:()=>pixels,
    ...(c.modalityLut?{modalityLut:c.modalityLut}:{}),...(c.sampledVoiLut?{sampledVoiLut:c.sampledVoiLut}:{}),...(c.floating&&c.padding?{pixelPadding:c.padding}:{})};
  // The custom CPU renderer applies the source rescale and window to stored samples.
  // Declare the loader's identity pre-scale so Cornerstone keeps the float buffer.
  if(c.floating)image.preScale={scaled:false,scalingParameters:{rescaleSlope:1,rescaleIntercept:0}};
  const result={image,range,frameCount:c.frameCount,sourceFrame:c.frame,sourceOrientation:c.sourceOrientation,sourceWindowPresets:c.sourceWindowPresets,sopInstanceUID:c.str('x00080018'),sopClassUID:c.str('x00080016')||c.str('x00020002'),
    frameTiming:{frameCount:c.frameCount,frameTime:c.str('x00181063'),frameTimeVector:c.str('x00181065'),
      recommendedDisplayFrameRate:c.str('x00082144'),cineRate:c.str('x00180040')},metadata:{
    imagePixelModule:{bitsAllocated:c.bits,bitsStored:c.stored,highBit:c.highBit,pixelRepresentation:c.signed,photometricInterpretation:c.photo,samplesPerPixel:c.samples},
    imagePlaneModule:{rows:c.rows,columns:c.columns,rowPixelSpacing:c.geometry.ratio,columnPixelSpacing:1,usingDefaultValues:true},generalSeriesModule:{modality:c.str('x00080060')},transferSyntax:{transferSyntaxUID:c.syntax}},
    sourceDisplay:{padding:c.padding,geometry:c.geometry,validMin,validMax,hasSourceWindow,zeroWindowFallback:c.zeroWindowFallback}};
  return c.previewEntry?applyPreviewDisplay(result,c.previewEntry):result;
}

/** Synchronous native, deflated, RLE and JPEG Lossless decoding. Frames are one-based. */
export function decodeDicom(bytes,imageId,previewEntry=null,sourceFrame=previewEntry?.sourceFrame??1,{sourceParsing=null,requireEmptyColorProfile=false}={}){
  return decodeParsed(parse(bytes,imageId,previewEntry,sourceFrame,sourceParsing,requireEmptyColorProfile));
}
function decodeParsed(c){
  if(NATIVE.has(c.syntax))return finish(c,nativeSamples(c));
  if(c.syntax===RLE)return finish(c,rleSamples(c));
  if(JPEG_LOSSLESS.has(c.syntax)){
    const encoded=compressedFrame(c),decoder=new JpegLosslessDecoder();
    const samples=decoder.decode(encoded.buffer,encoded.byteOffset,encoded.byteLength,Math.ceil(c.bits/8));
    requireValue(decoder.frame.dimX===c.columns&&decoder.frame.dimY===c.rows,'JPEG Lossless dimensions differ from DICOM metadata.');
    return finish(c,{samples,planar:0});
  }
  throw new Error('This compressed transfer syntax requires asynchronous decoding.');
}
// Check the frame header before the codec allocates its output buffer.
function validateJpegLsHeader(c,encoded){
  const invalid='JPEG-LS header or dimensions differ from DICOM metadata.';
  requireValue(encoded[0]===0xff&&encoded[1]===0xd8,invalid);
  const view=new DataView(encoded.buffer,encoded.byteOffset,encoded.byteLength);
  for(let position=2;position+4<=encoded.length;){
    requireValue(encoded[position++]===0xff,invalid);
    while(encoded[position]===0xff)position++;
    const marker=encoded[position++];
    requireValue(marker!==0xda&&marker!==0xd9&&position+2<=encoded.length,invalid);
    const length=view.getUint16(position);
    requireValue(length>=2&&position+length<=encoded.length,invalid);
    if(marker===0xf7){
      requireValue(length>=8&&view.getUint16(position+3)===c.rows&&view.getUint16(position+5)===c.columns
        &&encoded[position+7]===c.samples&&length===8+3*c.samples,invalid);
      const precision=encoded[position+2];
      requireValue(precision>=c.stored&&precision<=c.bits&&(precision===c.stored||c.highBit===c.stored-1),invalid);
      return precision;
    }
    position+=length;
  }
  throw new Error(invalid);
}
async function codecSamples(c,factory,kind){
  const module=await factory,decoder=kind==='jpeg2000'?new module.J2KDecoder():new module.JpegLSDecoder();
  try{
    const encoded=compressedFrame(c);
    const precision=kind==='jpegls'?validateJpegLsHeader(c,encoded):c.stored;
    decoder.getEncodedBuffer(encoded.length).set(encoded);decoder.decode();
    const info=decoder.getFrameInfo();
    requireValue(info.width===c.columns&&info.height===c.rows,'Compressed dimensions differ from DICOM metadata.');
    const count=c.rows*c.columns*c.samples, bytes=decoder.getDecodedBuffer();
    requireValue(info.componentCount===c.samples&&info.bitsPerSample===precision&&bytes.length===count*(c.bits/8),
      'Compressed image sample layout differs from DICOM metadata.');
    let samples;
    if(c.bits===8)samples=bytes.slice();
    else {samples=new Uint16Array(count);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<count;i++)samples[i]=view.getUint16(i*2,true);}
    if(kind==='jpegls'&&precision>c.stored){
      const mask=2**c.stored-1,decodedMask=2**precision-1;
      requireValue(samples.every(sample=>sample<=mask||c.signed&&sample>=decodedMask-2**(c.stored-1)+1),
        'JPEG-LS samples exceed the stored bit layout.');
    }
    const interleave=kind==='jpeg2000'?2:decoder.getInterleaveMode();
    if(interleave===1&&c.samples>1){const interleaved=new Uint16Array(count);for(let y=0;y<c.rows;y++)for(let x=0;x<c.columns;x++)for(let k=0;k<c.samples;k++)interleaved[(y*c.columns+x)*c.samples+k]=samples[y*c.columns*c.samples+k*c.columns+x];samples=interleaved;}
    return {samples,planar:interleave===0?1:0,rgb:kind==='jpeg2000'};
  }finally{decoder.delete();}
}
async function browserJpeg(c){
  requireValue(c.bits===8,'Browser JPEG decoding supports only 8-bit JPEG samples.');
  requireValue(typeof createImageBitmap==='function','JPEG Baseline decoding requires the browser image decoder.');
  const bitmap=await createImageBitmap(new Blob([compressedFrame(c)],{type:'image/jpeg'}),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
  try{
    requireValue(bitmap.width===c.columns&&bitmap.height===c.rows,'JPEG dimensions differ from DICOM metadata.');
    const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(c.columns,c.rows):Object.assign(document.createElement('canvas'),{width:c.columns,height:c.rows});
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);
    const rgba=context.getImageData(0,0,c.columns,c.rows).data;
    if(c.gray){const samples=new Uint16Array(c.rows*c.columns);for(let i=0;i<samples.length;i++)samples[i]=rgba[i*4];return {samples};}
    return {samples:rgba,rgba:true,rgb:true};
  }finally{bitmap.close();}
}

/** Browser-safe compressed decoding, bundled locally without uploads or codec fetches. */
export async function decodeDicomAsync(bytes,imageId,previewEntry=null,sourceFrame=previewEntry?.sourceFrame??1,{sourceParsing=null,requireEmptyColorProfile=false}={}){
  const c=parse(bytes,imageId,previewEntry,sourceFrame,sourceParsing,requireEmptyColorProfile);
  if(NATIVE.has(c.syntax)||c.syntax===RLE||JPEG_LOSSLESS.has(c.syntax))return decodeParsed(c);
  if(c.syntax===JPEG_EXTENDED && c.bits===16){
    requireValue(c.gray && !c.signed && c.stored<=12 && c.highBit===c.stored-1,
      '12-bit JPEG Extended encoding supports right-aligned unsigned grayscale pixels.');
    return finish(c,{samples:await decodeJpegExtended12(compressedFrame(c),c.columns,c.rows)});
  }
  if(JPEG.has(c.syntax))return finish(c,await browserJpeg(c));
  if(JPEG2000.has(c.syntax)){openJPEG??=createOpenJPEG({print:()=>{},printErr:()=>{}});return finish(c,await codecSamples(c,openJPEG,'jpeg2000'));}
  if(JPEG_LS.has(c.syntax)){charLS??=createCharLS({print:()=>{},printErr:()=>{}});return finish(c,await codecSamples(c,charLS,'jpegls'));}
  throw new Error(`Unsupported transfer syntax: ${c.syntax}`);
}

/** Apply the immutable PDF preview baseline without changing source pixels or identifiers. */
export function applyPreviewDisplay(decoded,entry){
  requireValue(entry.status==='rendered'&&entry.displayRejected===false,entry.reason||'Source was rejected for preview display.');
  requireValue(!decoded.image.modalityLut,'The recorded PDF preview does not support a Modality LUT.');
  requireValue(Number.isInteger(entry.sourceFrame)&&entry.sourceFrame>=1&&entry.sourceFrame<=(decoded.frameCount??1)&&entry.sourceFrame===(decoded.sourceFrame??1),'Preview source frame is unavailable.');
  const display=entry.displayAdjustments;requireValue(display&&typeof display==='object','Preview display adjustments are missing.');
  const number=key=>{const value=Number(display[key]);requireValue(typeof display[key]==='string'&&display[key].trim()!==''&&Number.isFinite(value),`Invalid preview ${key}.`);return value;};
  const center=number('windowCenter'),width=number('windowWidth');requireValue(validWindow({center,width,function:display.voiLUTFunction}),'Invalid preview window width.');
  const slope=number('rescaleSlope'),intercept=number('rescaleIntercept');
  requireValue(Math.fround(slope)===Math.fround(decoded.image.slope)&&Math.fround(intercept)===Math.fround(decoded.image.intercept),'Preview rescale differs from the DICOM source.');
  requireValue(display.invert===String(decoded.image.invert),'Preview polarity differs from the DICOM source.');
  requireValue(number('rotationDegrees')===0&&display.flipHorizontal==='false'&&display.flipVertical==='false','Rotation and reflection are outside this preview profile.');
  requireValue(display.overlayPolicy==='disabled'&&['LINEAR','LINEAR_EXACT','SIGMOID'].includes(display.voiLUTFunction),'Unsupported preview display policy.');
  requireValue(['source-window-0','auto-min-max-v1','auto-min-max-padding-v2','color-default','color-direct'].includes(display.windowMethod),'Unsupported preview window method.');
  if (display.windowMethod==='auto-min-max-padding-v2') {
    const source=decoded.sourceDisplay, padding=source?.padding;
    requireValue(decoded.image.color===false && padding && !source.hasSourceWindow,'Padding-aware automatic preview differs from source windowing.');
    requireValue(display.paddingPolicy==='exclude-stored-range' && number('pixelPaddingMin')===padding.minimum && number('pixelPaddingMax')===padding.maximum,
      'Preview pixel padding range differs from the DICOM source.');
    requireValue(Number.isFinite(source.validMin) && Number.isFinite(source.validMax),'No non-padding pixels are available for automatic windowing.');
    const range=[source.validMin*Math.fround(slope)+Math.fround(intercept),source.validMax*Math.fround(slope)+Math.fround(intercept)].sort((a,b)=>a-b);
    requireValue(Math.fround(width)===Math.fround(Math.max(1,range[1]-range[0]+1)) && Math.fround(center)===Math.fround((range[0]+range[1]+1)/2),
      'Padding-aware preview window differs from the DICOM source.');
  }
  let ratio=1;
  if (display.geometryMethod!==undefined) {
    requireValue(display.geometryMethod==='source-aspect-v1','Unsupported preview geometry method.');
    const parts=String(display.pixelAspectRatio).split(':').map(Number),source=decoded.sourceDisplay?.geometry;
    requireValue(parts.length===2 && parts.every(value=>Number.isFinite(value) && value>0) && source && !source.warning && display.geometrySource===source.source,
      'Preview image aspect source differs from the DICOM source.');
    ratio=parts[0]/parts[1];
    requireValue(Number.isFinite(ratio) && Math.abs(ratio-source.ratio)<=1e-6*Math.abs(source.ratio),
      'Preview pixel aspect differs from the DICOM source.');
  } else requireValue(display.pixelAspectRatio==='1:1','Unsupported legacy preview pixel aspect.');
  if(display.color!==undefined)requireValue(display.color===String(decoded.image.color),'Preview color interpretation differs from source.');
  decoded.image.rowPixelSpacing=ratio;decoded.image.columnPixelSpacing=1;
  if (decoded.metadata?.imagePlaneModule) {decoded.metadata.imagePlaneModule.rowPixelSpacing=ratio;decoded.metadata.imagePlaneModule.columnPixelSpacing=1;}
  decoded.image.slope=slope;decoded.image.intercept=intercept;decoded.image.windowCenter=center;decoded.image.windowWidth=width;decoded.image.voiLUTFunction=display.voiLUTFunction;
  return decoded;
}
