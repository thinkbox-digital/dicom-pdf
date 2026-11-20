import {readDicomText} from './metadata-export.mjs';
import {rtReferenceUids} from './rt-plan.mjs';
import {decodeRleSamples} from './rle-pixel-data.mjs';
import {frameFitsMemory,workingMemoryBytes} from './working-memory.mjs';

export const RT_DOSE_SOP='1.2.840.10008.5.1.4.1.1.481.2';
export const RT_DOSE_RLE='1.2.840.10008.1.2.5';
const BIG_ENDIAN='1.2.840.10008.1.2.2';
const SYNTAXES=new Set(['1.2.840.10008.1.2','1.2.840.10008.1.2.1',BIG_ENDIAN,'1.2.840.10008.1.2.1.99',RT_DOSE_RLE]);
const DS=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const IS=/^\+?\d+$/;
const requireValue=(test,message)=>{if(!test)throw new Error(message);};

export function isRtDoseTransferSyntax(syntax){return SYNTAXES.has(syntax);}

function decimals(ds,tag,count){
  if(ds.elements[tag]?.vr&&!['DS','UN'].includes(ds.elements[tag].vr))return null;
  const values=readDicomText(ds,tag)?.split('\\').map(value=>value.trim());
  if(values?.length!==count||values.some(value=>!DS.test(value)))return null;
  const numbers=values.map(Number);
  return numbers.every(Number.isFinite)?numbers:null;
}

function readWord(ds,tag,index=0){
  const element=ds.elements[tag];
  return element.vr==='UN'
    ?new DataView(ds.byteArray.buffer,ds.byteArray.byteOffset+element.dataOffset,element.length).getUint16(index*2,true)
    :ds.uint16(tag,index);
}

function framePositions(ds,frames){
  if(frames===1)return null;
  const pointer=ds.elements.x00280009;
  if(pointer?.length!==4||pointer.vr&&!['AT','UN'].includes(pointer.vr)
    ||readWord(ds,'x00280009',0)!==0x3004||readWord(ds,'x00280009',1)!==0x000c)return null;
  const values=decimals(ds,'x3004000c',frames);
  if(!values)return null;
  const increasing=values[1]>values[0];
  if(!values.slice(1).every((value,i)=>increasing?value>values[i]:value<values[i]))return null;
  if(values[0]===0)return {label:'Offset from first slice',values};
  const origin=decimals(ds,'x00200032',3),orientation=decimals(ds,'x00200037',6);
  const axial=[1,0,0,0,1,0];
  return origin?.[2]===values[0]&&orientation?.every((value,index)=>value===axial[index])?{label:'Patient z',values}:null;
}

function doseUnits(ds){
  const units=readDicomText(ds,'x30040002');
  if(units==='GY')return 'Gy';
  if(units==='RELATIVE')return 'relative';
  if(units==='CODED'){
    const items=ds.elements.x30040020?.items,unit=items?.length===1?items[0].dataSet:null;
    if(unit){
      const code=readDicomText(unit,'x00080100')||readDicomText(unit,'x00080119');
      const scheme=readDicomText(unit,'x00080102');
      if(code&&scheme)return scheme==='UCUM'?code:scheme+' '+code;
      const urn=readDicomText(unit,'x00080120');
      if(urn)return urn;
    }
  }
  throw new Error('The RT Dose grid does not declare readable dose units.');
}

function decodeNative(ds,element,data,bits,little){
  const bytes=ds.byteArray;
  const view=new DataView(bytes.buffer,bytes.byteOffset+element.dataOffset,element.length);
  if(bits===16){
    for(let i=0;i<data.length;i++)data[i]=view.getUint16(i*2,little);
  }else if(little){
    for(let i=0;i<data.length;i++)data[i]=view.getUint32(i*4,true);
  }else{
    // PS3.5 §8.2 packs each 32-bit sample across two OW words, low word first.
    for(let i=0;i<data.length;i++)data[i]=view.getUint16(i*4,false)+65536*view.getUint16(i*4+2,false);
  }
}

function decodeRle(ds,element,data,rows,columns,bits){
  for(const [frame,fragment] of element.fragments.entries()){
    const {position,length}=fragment;
    requireValue(position+length<=ds.byteArray.length,'Truncated RT Dose RLE frame.');
    const encoded=ds.byteArray.subarray(position,position+length);
    data.set(decodeRleSamples(encoded,{bits,samples:1,rows,columns}),frame*rows*columns);
  }
}

export function swapDoseWords(value,signed){
  const swapped=(value<<16)|(value>>>16);
  return signed?swapped:swapped>>>0;
}

/** Decode a bounded dose grid, keeping exact stored integers and its source scaling. */
export function readRtDose(ds,{syntax,residentBytes=ds.byteArray.byteLength,budget=workingMemoryBytes()}){
  requireValue(isRtDoseTransferSyntax(syntax),'This RT Dose transfer syntax is unsupported.');
  const element=ds.elements.x7fe00010;
  requireValue(element&&!ds.elements.x7fe00008&&!ds.elements.x7fe00009,'This RT Dose object has no supported integer dose grid.');
  const us=tag=>{
    const field=ds.elements[tag];
    return field?.length===2&&(!field.vr||['US','UN'].includes(field.vr))?readWord(ds,tag):undefined;
  };
  const rows=us('x00280010'),columns=us('x00280011'),bits=us('x00280100'),representation=us('x00280103');
  const type=readDicomText(ds,'x30040004'),summation=readDicomText(ds,'x3004000a');
  requireValue(type&&us('x00280002')===1&&readDicomText(ds,'x00280004')==='MONOCHROME2'
    &&(bits===16||bits===32)&&us('x00280101')===bits&&us('x00280102')===bits-1&&representation===(type==='ERROR'?1:0),
  'The RT Dose pixel layout does not match the declared dose type.');
  const frameElement=ds.elements.x00280008;
  requireValue(!frameElement?.vr||['IS','UN'].includes(frameElement.vr),'The RT Dose Number of Frames is invalid.');
  const frameText=frameElement?readDicomText(ds,'x00280008'):'1';
  const frames=IS.test(frameText)?Number(frameText):NaN;
  requireValue(Number.isSafeInteger(frames)&&frames>=1,'The RT Dose Number of Frames is invalid.');
  const total=rows*columns*frames,gridBytes=total*bits/8;
  requireValue(Number.isSafeInteger(gridBytes)&&frameFitsMemory(rows,columns,{bits:32,residentBytes:residentBytes+gridBytes,budget}),
    'The RT Dose grid exceeds the viewer’s working memory or canvas limit.');
  if(syntax===RT_DOSE_RLE){
    const {fragments,basicOffsetTable}=element;
    requireValue(element.encapsulatedPixelData&&fragments?.length===frames
      &&(!basicOffsetTable?.length||basicOffsetTable.length===frames
        &&basicOffsetTable.every((offset,i)=>offset===fragments[i].offset)),
    'The RT Dose RLE fragments do not identify one fragment per frame.');
  }else{
    requireValue(!element.encapsulatedPixelData&&!element.hadUndefinedLength&&element.length===gridBytes
      &&element.dataOffset+element.length<=ds.byteArray.length&&(!element.vr||element.vr==='OW'),
    'The native RT Dose Pixel Data length or layout differs from the grid.');
  }
  const units=doseUnits(ds),scaling=decimals(ds,'x3004000e',1)?.[0];
  requireValue(scaling>0&&Number.isFinite(scaling*(2**bits-1)),'The RT Dose Grid Scaling is invalid.');
  const signed=representation===1,little=syntax!==BIG_ENDIAN;
  const Grid=bits===16?(signed?Int16Array:Uint16Array):(signed?Int32Array:Uint32Array);
  const data=new Grid(total);
  if(syntax===RT_DOSE_RLE)decodeRle(ds,element,data,rows,columns,bits);
  else decodeNative(ds,element,data,bits,little);

  let min=Infinity,max=-Infinity,swappedMin=Infinity,swappedMax=-Infinity;
  const ambiguousOrder=!little&&bits===32;
  for(const value of data){
    min=Math.min(min,value);max=Math.max(max,value);
    if(ambiguousOrder){
      const swapped=swapDoseWords(value,signed);
      swappedMin=Math.min(swappedMin,swapped);swappedMax=Math.max(swappedMax,swapped);
    }
  }
  const spacing=decimals(ds,'x00280030',2);
  const aspect=spacing?spacing[0]/spacing[1]:null;
  return {data,rows,columns,frames,units,scaling,type,summation,signed,range:[min,max],
    swappedRange:ambiguousOrder?[swappedMin,swappedMax]:null,
    spacing:spacing?.every(value=>value>0)&&aspect>=1e-6&&aspect<=1e6?spacing:null,
    positions:framePositions(ds,frames),plans:rtReferenceUids(ds,'x300c0002')};
}
