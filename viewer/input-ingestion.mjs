import dicomParser from 'dicom-parser';
import {Inflate} from 'fflate';
import dictionary from './dicom-dictionary.json' with {type:'json'};
import {parseDicomCompatible} from './dicom-parser-compat.mjs';
import {frameFitsMemory,workingMemoryBytes} from './working-memory.mjs';
import {floatingPixelType,validFloatingPixelType} from './parametric-map.mjs';
import {RT_DOSE_SOP,isRtDoseTransferSyntax} from './rt-dose.mjs';

import {JPEG_LS,JPEG2000} from './image-transfer-syntax.mjs';

const MiB=1024*1024;
const workingBytes=workingMemoryBytes();
export const INPUT_LIMITS=Object.freeze({maxFileBytes:Number.MAX_SAFE_INTEGER,maxInputBytes:Number.MAX_SAFE_INTEGER,maxCompressedBytes:Number.MAX_SAFE_INTEGER,
  maxExpandedBytes:workingBytes,maxRetainedBytes:workingBytes,maxFiles:Number.MAX_SAFE_INTEGER,maxArchiveDepth:4,maxCompressionRatio:200,
  maxMetadataBytes:16*MiB,maxMetadataElements:50000,maxMetadataDepth:24,maxInflatedDicomBytes:workingBytes});
const MESSAGES={INVALID_INPUT:'Choose readable local files.',UNSAFE_PATH:'A supplied file has an unsafe portable path.',
  LIMIT_EXCEEDED:'The supplied files exceed the supported resource limits.',ZIP_CORRUPT:'This ZIP could not be read safely; the archive original is retained.',
  ZIP_UNSUPPORTED:'This ZIP uses an unsupported archive feature; the archive original is retained.',
  INVALID_DICOM:'This file could not be read as a supported DICOM dataset.',METADATA_LIMIT:'DICOM metadata exceeds the supported parsing limits.'};
export class InputIngestionError extends Error {
  constructor(code){super(MESSAGES[code]||MESSAGES.INVALID_INPUT);this.name='InputIngestionError';this.code=Object.hasOwn(MESSAGES,code)?code:'INVALID_INPUT';}
}
const refuse=code=>{throw new InputIngestionError(code);};
const aborted=signal=>{if(signal?.aborted)throw new DOMException('Local input ingestion cancelled.','AbortError');};
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
const TAGS=dictionary.tags||dictionary;
const VR=new Set('AE AS AT CS DA DS DT FD FL IS LO LT OB OD OF OL OV OW PN SH SL SQ SS ST SV TM UC UI UL UN UR US UT UV'.split(' '));
const LONG_VR=new Set('OB OD OF OL OV OW SQ UC UR UT UN SV UV'.split(' '));
const NATIVE=new Set(['1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.2','1.2.840.10008.1.2.1.99']);
const IMAGE_SYNTAXES=new Set([...NATIVE,...['50','51','57','70'].map(value=>'1.2.840.10008.1.2.4.'+value),...JPEG_LS,...JPEG2000,'1.2.840.10008.1.2.5']);
const PIXELS=new Set(['x7fe00008','x7fe00009','x7fe00010']);
const DIRECTORY_SOP='1.2.840.10008.1.3.10';
const FIELDS=[
  ['SpecificCharacterSet','00080005'],['SOPClassUID','00080016'],['SOPInstanceUID','00080018'],['StudyDate','00080020'],
  ['StudyTime','00080030'],['AccessionNumber','00080050'],['Modality','00080060'],['Manufacturer','00080070','text'],
  ['InstitutionName','00080080','text'],['StudyDescription','00081030','text'],['SeriesDescription','0008103e','text'],
  ['PatientName','00100010','text'],['PatientID','00100020','text'],['PatientBirthDate','00100030'],['PatientSex','00100040'],
  ['BodyPartExamined','00180015'],['SliceThickness','00180050'],['SpacingBetweenSlices','00180088'],['FrameTime','00181063'],
  ['CineRate','00180040'],['RecommendedDisplayFrameRate','00082144'],['ImagerPixelSpacing','00181164'],
  ['NominalScannedPixelSpacing','00182010'],['ViewPosition','00185101'],['StudyInstanceUID','0020000d'],
  ['SeriesInstanceUID','0020000e'],['StudyID','00200010','text'],['SeriesNumber','00200011'],['InstanceNumber','00200013'],
  ['ImagePositionPatient','00200032'],['ImageOrientationPatient','00200037'],['Laterality','00200060'],['ImageLaterality','00200062'],
  ['ImageType','00080008'],['SamplesPerPixel','00280002','us'],['PhotometricInterpretation','00280004'],
  ['PlanarConfiguration','00280006','us'],['NumberOfFrames','00280008'],['Rows','00280010','us'],['Columns','00280011','us'],
  ['PixelSpacing','00280030'],['PixelAspectRatio','00280034'],['BitsAllocated','00280100','us'],['BitsStored','00280101','us'],
  ['HighBit','00280102','us'],['PixelRepresentation','00280103','us'],['BurnedInAnnotation','00280301'],
  ['WindowCenter','00281050'],['WindowWidth','00281051'],['WindowCenterWidthExplanation','00281055','text'],
  ['RescaleIntercept','00281052'],['RescaleSlope','00281053'],['VOILUTFunction','00281056'],
  ['LossyImageCompression','00282110'],['LossyImageCompressionRatio','00282112'],['LossyImageCompressionMethod','00282114'],
  ['PresentationLUTShape','20500020'],['FileSetID','00041130']
];
function limitsOf(overrides={}) {
  const result={...INPUT_LIMITS};
  for(const [key,value] of Object.entries(overrides)) {
    if(!Object.hasOwn(result,key)||!Number.isSafeInteger(value)||value<1||value>result[key])refuse('INVALID_INPUT');
    result[key]=value;
  }
  return result;
}
function safePath(value,directory=false) {
  if(typeof value!=='string'||!value||value.length>2048||/^[\/]/.test(value)||/[\\<>:"|?*\x00-\x1f\x7f]/.test(value))refuse('UNSAFE_PATH');
  const path=directory&&value.endsWith('/')?value.slice(0,-1):value,parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.length>255||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))refuse('UNSAFE_PATH');
  return path;
}
const pathKey=value=>value.normalize('NFC').toLowerCase();
const byteView=value=>value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}
function ascii(bytes,trim=true){let value='';for(const byte of bytes){if(byte>127)throw new Error('Not ASCII');value+=String.fromCharCode(byte);}return trim?value.replace(/[\0 ]+$/g,''):value;}
const isZip=bytes=>bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&((bytes[2]===3&&bytes[3]===4)||(bytes[2]===5&&bytes[3]===6));
const u16=(bytes,offset,little=true)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(offset,little);
const u32=(bytes,offset,little=true)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,little);
const equalBytes=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;});
function crcUpdate(crc,bytes){for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return crc>>>0;}

/** Validate the complete directory before allocating any expanded member. */
function zipDirectory(bytes,limits) {
  const bad=()=>refuse('ZIP_CORRUPT');let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--) {
    if(u32(bytes,offset)===0x06054b50&&offset+22+u16(bytes,offset+20)===bytes.length){end=offset;break;}
  }
  if(end<0)bad();
  const count=u16(bytes,end+10),directorySize=u32(bytes,end+12),directoryOffset=u32(bytes,end+16);
  if(u16(bytes,end+4)||u16(bytes,end+6)||u16(bytes,end+8)!==count)refuse('ZIP_UNSUPPORTED');
  if(count===65535||directorySize===0xffffffff||directoryOffset===0xffffffff)refuse('ZIP_UNSUPPORTED');
  if(count>limits.maxFiles)refuse('LIMIT_EXCEEDED');
  if(directoryOffset+directorySize!==end)bad();
  const members=[];let position=directoryOffset,total=0;
  for(let index=0;index<count;index++) {
    if(position+46>end||u32(bytes,position)!==0x02014b50)bad();
    const flags=u16(bytes,position+8),method=u16(bytes,position+10),crc=u32(bytes,position+16),compressed=u32(bytes,position+20),size=u32(bytes,position+24);
    const nameLength=u16(bytes,position+28),extraLength=u16(bytes,position+30),commentLength=u16(bytes,position+32),local=u32(bytes,position+42),attributes=u32(bytes,position+38);
    const next=position+46+nameLength+extraLength+commentLength;
    if(next>end||!nameLength||u16(bytes,position+34))bad();
    if(flags&~0x080e||![0,8].includes(method)||[compressed,size,local].includes(0xffffffff))refuse('ZIP_UNSUPPORTED');
    const type=(attributes>>>16)&0xf000;
    if(type&&![0x8000,0x4000].includes(type))refuse('ZIP_UNSUPPORTED');
    const nameBytes=bytes.subarray(position+46,position+46+nameLength);let name;
    try{name=flags&0x800?new TextDecoder('utf-8',{fatal:true}).decode(nameBytes):ascii(nameBytes,false);}catch{refuse('ZIP_UNSUPPORTED');}
    const directory=name.endsWith('/');safePath(name,directory);
    if(directory&&(size||compressed&&method===0))bad();
    if(size>limits.maxFileBytes||size>Math.max(1,compressed)*limits.maxCompressionRatio)refuse('LIMIT_EXCEEDED');
    total+=size;if(total>limits.maxExpandedBytes)refuse('LIMIT_EXCEEDED');
    if(local+30>directoryOffset||u32(bytes,local)!==0x04034b50||u16(bytes,local+6)!==flags||u16(bytes,local+8)!==method)bad();
    const localNames=u16(bytes,local+26),localExtra=u16(bytes,local+28),start=local+30+localNames+localExtra,stop=start+compressed;
    if(start>directoryOffset||stop>directoryOffset||!equalBytes(bytes.subarray(local+30,local+30+localNames),nameBytes))bad();
    if(!(flags&8)&&(u32(bytes,local+14)!==crc||u32(bytes,local+18)!==compressed||u32(bytes,local+22)!==size))bad();
    let memberEnd=stop;
    if(flags&8){
      if(memberEnd+12>directoryOffset)bad();
      if(u32(bytes,memberEnd)===0x08074b50)memberEnd+=4;
      if(memberEnd+12>directoryOffset||u32(bytes,memberEnd)!==crc||u32(bytes,memberEnd+4)!==compressed||u32(bytes,memberEnd+8)!==size)bad();
      memberEnd+=12;
    }
    if(method===0&&compressed!==size)bad();
    members.push({name,directory,method,crc,compressed,size,start,local,end:memberEnd});position=next;
  }
  if(position!==end)bad();
  const ordered=[...members].sort((a,b)=>a.local-b.local);let previous=0;
  for(const member of ordered){if(member.local!==previous)bad();previous=member.end;}
  if(previous!==directoryOffset)bad();
  return {members,total};
}
async function expandMember(archive,member,signal) {
  const result=new Uint8Array(member.size);let written=0,crc=0xffffffff,final=false,problem;
  const accept=(chunk,last)=>{
    if(written+chunk.length>result.length)refuse('ZIP_CORRUPT');
    result.set(chunk,written);written+=chunk.length;crc=crcUpdate(crc,chunk);final=last;
  };
  const inflater=member.method===8?new Inflate((chunk,last)=>accept(chunk,last)):null;
  for(let offset=0;offset<member.compressed;offset+=1024){
    aborted(signal);const stop=Math.min(member.compressed,offset+1024),last=stop===member.compressed;
    try{if(inflater)inflater.push(archive.subarray(member.start+offset,member.start+stop),last);else accept(archive.subarray(member.start+offset,member.start+stop),last);}catch(error){problem=error;break;}
    if(offset%32768===0){await yieldTask();aborted(signal);}
  }
  if(!member.compressed){try{if(inflater)inflater.push(new Uint8Array(),true);else accept(new Uint8Array(),true);}catch(error){problem=error;}}
  if(problem||!final||written!==member.size||((crc^0xffffffff)>>>0)!==member.crc)refuse('ZIP_CORRUPT');
  return result;
}

function header(bytes,position,end,little,explicit) {
  if(position+8>end)refuse('INVALID_DICOM');
  const group=u16(bytes,position,little),element=u16(bytes,position+2,little),tag='x'+group.toString(16).padStart(4,'0')+element.toString(16).padStart(4,'0');
  let vr,offset=position+8,length;
  if(explicit&&group!==0xfffe){
    vr=String.fromCharCode(bytes[position+4],bytes[position+5]);if(!VR.has(vr))refuse('INVALID_DICOM');
    if(LONG_VR.has(vr)){if(position+12>end||bytes[position+6]||bytes[position+7])refuse('INVALID_DICOM');offset=position+12;length=u32(bytes,position+8,little);}
    else length=u16(bytes,position+6,little);
  }else{length=u32(bytes,position+4,little);vr=TAGS[tag.slice(1).toUpperCase()]?.vr;}
  if(length!==0xffffffff&&offset+length>end)refuse('INVALID_DICOM');
  return {tag,group,element,vr,length,offset};
}
function metaHeader(bytes,start,limits) {
  let position=start,declaredEnd=null,count=0;const fields={};
  while(position+8<=bytes.length&&u16(bytes,position)===2){
    if(++count>limits.maxMetadataElements||position-start>limits.maxMetadataBytes)refuse('METADATA_LIMIT');
    const item=header(bytes,position,bytes.length,true,true);
    if(item.length===0xffffffff)refuse('INVALID_DICOM');
    if(item.tag==='x00020000'){
      if(item.vr!=='UL'||item.length!==4)refuse('INVALID_DICOM');declaredEnd=item.offset+4+u32(bytes,item.offset);
      if(declaredEnd>bytes.length)refuse('INVALID_DICOM');
    }
    const keyword={x00020010:'TransferSyntaxUID',x00020002:'MediaStorageSOPClassUID',x00020003:'MediaStorageSOPInstanceUID'}[item.tag];
    if(keyword){if(item.length>128)refuse('INVALID_DICOM');try{fields[keyword]=ascii(bytes.subarray(item.offset,item.offset+item.length));}catch{refuse('INVALID_DICOM');}}
    position=item.offset+item.length;if(declaredEnd!==null&&position>declaredEnd)refuse('INVALID_DICOM');
    if(position===declaredEnd)break;
  }
  if(declaredEnd!==null&&position!==declaredEnd)refuse('INVALID_DICOM');
  return {position,fields};
}
function rawAssumption(bytes) {
  for(const [syntax,little,explicit] of [['1.2.840.10008.1.2.1',true,true],['1.2.840.10008.1.2.2',false,true],['1.2.840.10008.1.2',true,false]]){
    try{
      let position=0,known=0;
      for(let index=0;index<2;index++){
        const item=header(bytes,position,bytes.length,little,explicit),info=TAGS[item.tag.slice(1).toUpperCase()];
        if(!info||![0x0004,0x0008,0x0010,0x0018,0x0020,0x0028,0x0040].includes(item.group)||item.length===0xffffffff||item.length>65536)break;
        if(explicit&&!String(info.vr).includes(item.vr))break;
        known++;position=item.offset+item.length;
      }
      if(known>=2)return syntax;
    }catch{}
  }
  return null;
}
/** Bound structure before the recursive dependency sees any untrusted sequence. */
function metadataPreflight(bytes,start,syntax,limits,{orderedRoot=false}={}) {
  const little=syntax!=='1.2.840.10008.1.2.2',explicit=syntax!=='1.2.840.10008.1.2';let count=0,metadataBytes=0,pixelTag=null;
  const step=()=>{if(++count>limits.maxMetadataElements)refuse('METADATA_LIMIT');};
  function data(position,end,depth,undefinedItem=false,root=false,littleEndian=little,explicitVr=explicit){
    if(depth>limits.maxMetadataDepth)refuse('METADATA_LIMIT');
    let previous='';
    while(position<end){
      step();const item=header(bytes,position,end,littleEndian,explicitVr);metadataBytes+=item.offset-position;
      if(orderedRoot&&root){
        if(item.tag<=previous||item.group<8||item.length!==0xffffffff&&item.length%2)refuse('INVALID_DICOM');
        previous=item.tag;
      }
      if(metadataBytes>limits.maxMetadataBytes)refuse('METADATA_LIMIT');
      if(item.group===0xfffe){if(undefinedItem&&item.element===0xe00d&&item.length===0)return item.offset;refuse('INVALID_DICOM');}
      if(root&&PIXELS.has(item.tag)){
        pixelTag??=item.tag;
        if(item.length!==0xffffffff){position=item.offset+item.length;continue;}
        if(item.tag!=='x7fe00010')refuse('INVALID_DICOM');
        let cursor=item.offset,closed=false,fragments=0;
        while(cursor<end){
          step();const fragment=header(bytes,cursor,end,littleEndian,false);metadataBytes+=8;
          if(metadataBytes>limits.maxMetadataBytes)refuse('METADATA_LIMIT');
          if(fragment.group!==0xfffe||fragment.length===0xffffffff)refuse('INVALID_DICOM');
          if(fragment.element===0xe0dd&&fragment.length===0){cursor=fragment.offset;closed=true;break;}
          if(fragment.element!==0xe000||fragment.length%2!==0||fragments===0&&fragment.length%4!==0)refuse('INVALID_DICOM');
          fragments++;cursor=fragment.offset+fragment.length;
        }
        if(!closed||!fragments)refuse('INVALID_DICOM');position=cursor;continue;
      }
      const unknown=item.vr==='UN',childLittle=unknown||littleEndian,childExplicit=!unknown&&explicitVr;
      const sequence=item.vr==='SQ'||unknown&&TAGS[item.tag.slice(1).toUpperCase()]?.vr==='SQ'||item.length===0xffffffff
        ||item.length>=8&&u16(bytes,item.offset,childLittle)===0xfffe&&u16(bytes,item.offset+2,childLittle)===0xe000;
      if(sequence){
        let cursor=item.offset,sequenceEnd=item.length===0xffffffff?end:item.offset+item.length,closed=item.length!==0xffffffff;
        while(cursor<sequenceEnd){
          step();const child=header(bytes,cursor,sequenceEnd,childLittle,false);metadataBytes+=8;
          if(metadataBytes>limits.maxMetadataBytes)refuse('METADATA_LIMIT');
          if(child.group!==0xfffe)refuse('INVALID_DICOM');
          if(child.element===0xe0dd&&item.length===0xffffffff&&child.length===0){cursor=child.offset;closed=true;break;}
          if(child.element!==0xe000)refuse('INVALID_DICOM');
          cursor=data(child.offset,child.length===0xffffffff?sequenceEnd:child.offset+child.length,depth+1,child.length===0xffffffff,false,childLittle,childExplicit);
        }
        if(!closed||item.length!==0xffffffff&&cursor!==sequenceEnd)refuse('INVALID_DICOM');position=cursor;
      }else {
        if(!['x00420011','x54001010','x7fe00008','x7fe00009'].includes(item.tag))metadataBytes+=item.length;
        if(metadataBytes>limits.maxMetadataBytes)refuse('METADATA_LIMIT');position=item.offset+item.length;
      }
    }
    if(undefinedItem)refuse('INVALID_DICOM');return position;
  }
  data(start,bytes.length,0,false,true);return {pixelTag,count};
}
async function inflateDicom(bytes,offset,limits,signal) {
  const chunks=[];let total=0,final=false;
  const inflater=new Inflate((chunk,last)=>{
    total+=chunk.length;if(total>limits.maxInflatedDicomBytes||total>Math.max(1,bytes.length-offset)*limits.maxCompressionRatio)refuse('METADATA_LIMIT');
    chunks.push(chunk);final=last;
  });
  for(let position=offset;position<bytes.length;position+=1024){
    aborted(signal);try{inflater.push(bytes.subarray(position,Math.min(position+1024,bytes.length)),position+1024>=bytes.length);}catch(error){if(error instanceof InputIngestionError)throw error;refuse('INVALID_DICOM');}
    if((position-offset)%32768===0){await yieldTask();aborted(signal);}
  }
  if(!final)refuse('INVALID_DICOM');
  const result=new Uint8Array(offset+total);result.set(bytes.subarray(0,offset));let position=offset;
  for(const chunk of chunks){result.set(chunk,position);position+=chunk.length;}
  return result;
}
function selectedFields(ds,meta,diagnostics) {
  const fields={...meta},encodings={};let characterSet='';
  try{const element=ds.elements.x00080005;if(element)characterSet=ascii(ds.byteArray.subarray(element.dataOffset,element.dataOffset+element.length));}catch{}
  for(const [keyword,hex,kind] of FIELDS){
    const tag='x'+hex,item=ds.elements[tag];if(!item||item.length===0)continue;
    try{
      if(item.length>4096||item.dataOffset<0||item.dataOffset+item.length>ds.byteArray.length)throw new Error();
      let value,encoding='ASCII';
      if(kind==='us'){if(item.length!==2)throw new Error();value=String(ds.uint16(tag));encoding='numeric';}
      else{
        const bytes=ds.byteArray.subarray(item.dataOffset,item.dataOffset+item.length),charset=kind==='text'?characterSet.trim().replaceAll('_',' '):'';
        if(!charset||['ISO IR 6','ISO 2022 IR 6'].includes(charset))value=ascii(bytes);
        else if(charset==='ISO IR 192'){value=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/[\0 ]+$/g,'');encoding='UTF-8';}
        else if(['ISO IR 100','ISO 2022 IR 100'].includes(charset)&&!bytes.includes(27)){value=Array.from(bytes,value=>String.fromCharCode(value)).join('').replace(/[\0 ]+$/g,'');encoding='ISO_IR 100';}
        else {diagnostics.push({code:'UNSUPPORTED_CHARACTER_SET',field:keyword});continue;}
      }
      fields[keyword]=value;encodings[keyword]=encoding;
    }catch{diagnostics.push({code:'UNREADABLE_METADATA_VALUE',field:keyword});}
  }
  return {fields,fieldEncodings:encodings};
}
function eligibility(ds,fields,syntax) {
  const sop=fields.SOPClassUID||fields.MediaStorageSOPClassUID||'';
  if(sop===DIRECTORY_SOP||ds.elements.x00041220)return {kind:'dicom-directory',displayEligibility:{status:'not-image',codes:['DIRECTORY_OBJECT']}};
  const hasPixels=[...PIXELS].some(tag=>ds.elements[tag]);
  if(!hasPixels)return {kind:'dicom-object',displayEligibility:{status:'not-image',codes:['NO_IMAGE_PIXEL_DATA']}};
  const codes=[],dose=sop===RT_DOSE_SOP;
  if(!(dose?isRtDoseTransferSyntax(syntax):IMAGE_SYNTAXES.has(syntax)))codes.push('UNSUPPORTED_TRANSFER_SYNTAX');
  if(!dose&&(sop.startsWith('1.2.840.10008.5.1.4.1.1.481.')||['1.2.840.10008.5.1.4.1.1.66.4','1.2.840.10008.5.1.4.1.1.77.1.6'].includes(sop)))codes.push('UNSUPPORTED_OBJECT_TYPE');
  const rows=Number(fields.Rows),columns=Number(fields.Columns),bits=Number(fields.BitsAllocated),samples=Number(fields.SamplesPerPixel||1),frames=Number(fields.NumberOfFrames||1);
  if(!frameFitsMemory(rows,columns,{bits,samples,residentBytes:ds.byteArray.byteLength}))codes.push('UNSUPPORTED_IMAGE_DIMENSIONS');
  const rgb32=bits===32 && fields.PhotometricInterpretation==='RGB' && samples===3
    && Number(fields.PixelRepresentation??0)===0 && [0,1].includes(Number(fields.PlanarConfiguration??0))
    && (NATIVE.has(syntax)||syntax==='1.2.840.10008.1.2.5');
  const floating=floatingPixelType(ds.elements);
  const validPixels=dose?!!ds.elements.x7fe00010&&!floating&&[16,32].includes(bits)&&samples===1
    &&Number(fields.BitsStored)===bits&&Number(fields.HighBit)===bits-1&&fields.PhotometricInterpretation==='MONOCHROME2'
    :floating ? validFloatingPixelType(floating,{elements:ds.elements,sop,bits,samples,
    photo:fields.PhotometricInterpretation,native:NATIVE.has(syntax)}) : [1,8,16].includes(bits)||rgb32;
  if(!validPixels||![1,2,3,4].includes(samples)||!Number.isSafeInteger(frames)||frames<1)codes.push('UNSUPPORTED_PIXEL_FORMAT');
  if(!['MONOCHROME1','MONOCHROME2','RGB','YBR_FULL','YBR_FULL_422','YBR_PARTIAL_422','YBR_RCT','YBR_ICT','PALETTE COLOR','ARGB','CMYK'].includes(fields.PhotometricInterpretation))codes.push('UNSUPPORTED_PHOTOMETRIC_INTERPRETATION');
  return {kind:'dicom-image',displayEligibility:{status:codes.length?'unsupported':'candidate',codes}};
}
/** Verify the native CT layout before making an older archive entry viewable. */
export function inspectArchivedCt(bytes){
  const syntax='1.2.840.10008.1.2.1';
  if(bytes[128]===68&&bytes[129]===73&&bytes[130]===67&&bytes[131]===77||rawAssumption(bytes)!==syntax)return null;
  const {pixelTag}=metadataPreflight(bytes,0,syntax,INPUT_LIMITS,{orderedRoot:true});
  if(pixelTag!=='x7fe00010')return null;
  const parsing={mode:'raw-dataset',transferSyntaxUID:syntax,transferSyntaxSource:'verified-native-layout'};
  const ds=parseDicomCompatible(bytes,{sourceParsing:parsing,untilTag:pixelTag});
  const {fields}=selectedFields(ds,{},[]);
  const pixels=ds.elements[pixelTag],uid=/^[0-9]+(?:\.[0-9]+)+$/;
  const {Rows,Columns,BitsAllocated,BitsStored,HighBit,PixelRepresentation}=fields;
  if(ds.warnings?.length||fields.SOPClassUID!=='1.2.840.10008.5.1.4.1.1.2'||fields.Modality!=='CT'
    ||![fields.SOPInstanceUID,fields.StudyInstanceUID,fields.SeriesInstanceUID].every(value=>value?.length<=64&&uid.test(value))
    ||!['MONOCHROME1','MONOCHROME2'].includes(fields.PhotometricInterpretation)||fields.SamplesPerPixel!=='1'
    ||Number(fields.NumberOfFrames??1)!==1||BitsAllocated!=='16'||!(Number(BitsStored)>0&&Number(BitsStored)<=16)
    ||Number(HighBit)!==Number(BitsStored)-1||!['0','1'].includes(PixelRepresentation)
    ||!frameFitsMemory(Number(Rows),Number(Columns),{residentBytes:bytes.length})
    ||pixels?.vr!=='OW'||pixels.hadUndefinedLength||pixels.length!==Number(Rows)*Number(Columns)*2)return null;
  const requiredVrs={x00080016:'UI',x00080018:'UI',x00080060:'CS',x0020000d:'UI',x0020000e:'UI',
    x00280002:'US',x00280004:'CS',x00280010:'US',x00280011:'US',x00280100:'US',x00280101:'US',x00280102:'US',x00280103:'US'};
  if(Object.entries(requiredVrs).some(([tag,vr])=>ds.elements[tag]?.vr!==vr))return null;
  return {fields,parsing,sopInstanceUID:fields.SOPInstanceUID};
}

function directoryReferences(ds) {
  const items=ds.elements.x00041220?.items||[],references=[];
  for(const [recordIndex,item] of items.entries()){
    const record=item.dataSet,read=tag=>record?.elements[tag]?.length<=1024?record.string(tag)?.trim()||null:null;
    const id=read('x00041500');if(!id&&!record?.elements.x00041500)continue;
    references.push({recordIndex,fileId:id?id.split('\\'):[],recordType:read('x00041430'),
      active:record.elements.x00041410?record.uint16('x00041410')!==0:null,
      sopClassUID:read('x00041510'),sopInstanceUID:read('x00041511'),transferSyntaxUID:read('x00041512')});
  }
  return references;
}
async function inspectDicom(bytes,limits,signal) {
  const diagnostics=[];let part10=bytes.length>=132&&bytes[128]===68&&bytes[129]===73&&bytes[130]===67&&bytes[131]===77,meta={position:0,fields:{}},syntax,mode;
  if(part10){mode='part10';meta=metaHeader(bytes,132,limits);syntax=meta.fields.TransferSyntaxUID;if(!syntax)refuse('INVALID_DICOM');}
  else if(bytes.length>=8&&u16(bytes,0)===2){mode='file-meta-without-preamble';meta=metaHeader(bytes,0,limits);syntax=meta.fields.TransferSyntaxUID;if(!syntax)refuse('INVALID_DICOM');}
  else {syntax=rawAssumption(bytes);if(!syntax)return null;mode='raw-dataset';diagnostics.push({code:'ASSUMED_RAW_TRANSFER_SYNTAX'});}
  const inflated=syntax==='1.2.840.10008.1.2.1.99'?await inflateDicom(bytes,meta.position,limits,signal):bytes;
  const preflight=metadataPreflight(inflated,meta.position,syntax,limits),options={untilTag:preflight.pixelTag||undefined,
    vrCallback:tag=>TAGS[tag.slice(1).toUpperCase()]?.vr?.split(' or ')[0]};
  let ds;
  if(part10)ds=parseDicomCompatible(bytes,{...options,inflater:()=>inflated});
  else {
    // TransferSyntaxUID is a parsing option, not a source metadata value. A raw
    // dataset has no recorded file-meta syntax and its bytes remain untouched.
    ds=dicomParser.parseDicom(inflated.subarray(meta.position),{...options,TransferSyntaxUID:syntax==='1.2.840.10008.1.2.1.99'?'1.2.840.10008.1.2.1':syntax});
  }
  const selected=selectedFields(ds,meta.fields,diagnostics);
  if(mode==='raw-dataset'&&!(selected.fields.SOPClassUID||selected.fields.StudyInstanceUID||selected.fields.Rows&&selected.fields.Columns&&selected.fields.PhotometricInterpretation))return null;
  const result={...selected,...eligibility(ds,selected.fields,syntax),diagnostics,
    parsing:{mode,transferSyntaxUID:syntax,transferSyntaxSource:meta.fields.TransferSyntaxUID?'file-meta':'assumption',pixelPayloadDecoded:false},
    directoryRecords:directoryReferences(ds)};
  if(ds.warnings?.length)diagnostics.push({code:'PARSER_WARNINGS',count:ds.warnings.length});
  return result;
}

/**
 * Normalize local File/Blob-like inputs or worker-safe {name,sourcePath?,bytes}.
 * The result is a direct source inventory, never a preservation PDF or a claim
 * of successful image display. attachments includes both leaf originals and
 * archive containers with unique IDs and immutable-at-ingestion byte snapshots.
 * ZIP member sourcePath is its exact portable path within its own container;
 * origin.container identifies namespaces, including nested archives. Colliding
 * paths are diagnosed explicitly and are never silently renamed or merged.
 * Resource/unsafe-path failures reject atomically; ordinary unreadable sources
 * and archives remain recoverable. Cancellation rejects with AbortError.
 * maxRetainedBytes bounds the combined unchanged archive containers and leaf
 * originals, independently of compressed-input and expanded-byte budgets. The
 * default 256 MiB matches the original-file recovery ZIP payload budget.
 * Limits can be tightened, never increased. No DOM, persistence, or network is
 * used; invoke in a worker for parsing. Callbacks expose counts/codes only.
 */
export async function ingestInputs(files,{signal,onProgress,limits:overrides}={}) {
  const limits=limitsOf(overrides),entries=[],containers=[],references=[],diagnostics=[],attachments=Object.create(null);
  const totals={suppliedInputs:0,files:0,archives:0,inputBytes:0,containerBytes:0,originalBytes:0,expandedBytes:0,compressedBytes:0};
  let id=0,materialized=0;
  const progress=phase=>{onProgress?.({phase,completed:entries.length,archives:containers.length,bytes:totals.originalBytes});aborted(signal);};
  const attach=async(bytes,path,origin)=>{
    aborted(signal);if(++materialized>limits.maxFiles||bytes.length>limits.maxFileBytes)refuse('LIMIT_EXCEEDED');
    if(totals.originalBytes+totals.containerBytes+bytes.length>limits.maxRetainedBytes)refuse('LIMIT_EXCEEDED');
    const attachment='input-'+String(++id).padStart(6,'0'),sha256=await hash(bytes);aborted(signal);
    attachments[attachment]={filename:attachment,content:bytes};return {attachment,sourcePath:path,size:bytes.length,sha256,origin,diagnostics:[]};
  };
  async function accept(bytes,path,origin,depth=0){
    aborted(signal);safePath(path);
    if(isZip(bytes)||/\.zip$/i.test(path)){
      if(depth>=limits.maxArchiveDepth)refuse('LIMIT_EXCEEDED');
      totals.compressedBytes+=bytes.length;if(totals.compressedBytes>limits.maxCompressedBytes)refuse('LIMIT_EXCEEDED');
      const container=await attach(bytes,path,origin);container.kind='zip-archive';container.status='unreadable';container.children=[];
      containers.push(container);totals.archives++;totals.containerBytes+=bytes.length;
      let directory,expanded;
      try{
        directory=zipDirectory(bytes,limits);
        if(totals.expandedBytes+directory.total>limits.maxExpandedBytes||totals.originalBytes+totals.containerBytes+directory.total>limits.maxRetainedBytes||materialized+directory.members.filter(member=>!member.directory).length>limits.maxFiles)refuse('LIMIT_EXCEEDED');
        totals.expandedBytes+=directory.total;expanded=[];
        for(const member of directory.members){if(member.directory)continue;expanded.push({member,bytes:await expandMember(bytes,member,signal)});progress('expanding');}
      }catch(error){
        if(error?.name==='AbortError'||error?.code==='UNSAFE_PATH'||error?.code==='LIMIT_EXCEEDED')throw error;
        const code=error?.code==='ZIP_UNSUPPORTED'?'ZIP_UNSUPPORTED':'ZIP_CORRUPT';container.status=code==='ZIP_UNSUPPORTED'?'unsupported':'unreadable';container.diagnostics.push({code});progress('checking');return container;
      }
      container.status='expanded';
      for(const expandedFile of expanded){
        const childOrigin={inputIndex:origin.inputIndex,container:container.attachment,memberPath:expandedFile.member.name};
        const child=await accept(expandedFile.bytes,expandedFile.member.name,childOrigin,depth+1);container.children.push(child.attachment);
      }
      return container;
    }
    const entry=await attach(bytes,path,origin);entries.push(entry);totals.files++;totals.originalBytes+=bytes.length;
    entry.status='unrendered';entry.fields={};entry.kind='other';entry.displayEligibility={status:'not-image',codes:['NOT_DICOM']};
    try{
      const parsed=await inspectDicom(bytes,limits,signal);
      if(parsed){const {directoryRecords,...info}=parsed;Object.assign(entry,info);entry.sopInstanceUID=entry.fields.SOPInstanceUID||null;
        for(const reference of directoryRecords)references.push({...reference,sourceAttachment:entry.attachment,sourcePath:entry.sourcePath,container:origin.container??null,status:'unresolved'});
        if(entry.kind==='dicom-directory')entry.directoryInventoryScope='flat DirectoryRecordSequence; offset graph not validated';
      }else entry.diagnostics.push({code:'NOT_DICOM'});
    }catch(error){
      if(error?.name==='AbortError')throw error;
      entry.kind='unreadable';entry.displayEligibility={status:'unreadable',codes:[error?.code==='METADATA_LIMIT'?'METADATA_LIMIT':'INVALID_DICOM']};
      entry.diagnostics.push({code:entry.displayEligibility.codes[0]});
    }
    progress('checking');await yieldTask();aborted(signal);return entry;
  }
  if(!files||typeof files[Symbol.iterator]!=='function')refuse('INVALID_INPUT');
  for(const file of files){
    aborted(signal);if(++totals.suppliedInputs>limits.maxFiles)refuse('LIMIT_EXCEEDED');
    const path=safePath(file?.sourcePath||file?.webkitRelativePath||file?.name);let bytes=byteView(file?.bytes);
    const declared=bytes?.byteLength??file?.size;
    if(!Number.isSafeInteger(declared)||declared<0||declared>limits.maxFileBytes||totals.inputBytes+declared>limits.maxInputBytes)refuse('LIMIT_EXCEEDED');
    if(totals.originalBytes+totals.containerBytes+declared>limits.maxRetainedBytes)refuse('LIMIT_EXCEEDED');
    if(!bytes){if(typeof file.arrayBuffer!=='function')refuse('INVALID_INPUT');try{bytes=new Uint8Array(await file.arrayBuffer());}catch{refuse('INVALID_INPUT');}}
    if(bytes.length!==declared)refuse('INVALID_INPUT');
    bytes=Uint8Array.from(bytes);totals.inputBytes+=bytes.length;
    if(!isZip(bytes)&&!/\.zip$/i.test(path)){totals.expandedBytes+=bytes.length;if(totals.expandedBytes>limits.maxExpandedBytes)refuse('LIMIT_EXCEEDED');}
    await accept(bytes,path,{inputIndex:totals.suppliedInputs-1,container:null});
  }
  if(!totals.suppliedInputs)refuse('INVALID_INPUT');
  const paths=new Map(),instances=new Map();
  for(const source of [...entries,...containers]){
    const key=pathKey(source.sourcePath);if(!paths.has(key))paths.set(key,[]);paths.get(key).push(source);
    if(source.sopInstanceUID){if(!instances.has(source.sopInstanceUID))instances.set(source.sopInstanceUID,[]);instances.get(source.sopInstanceUID).push(source);}
  }
  for(const group of paths.values())if(group.length>1){for(const source of group)source.diagnostics.push({code:'DUPLICATE_PORTABLE_PATH'});diagnostics.push({code:'DUPLICATE_PORTABLE_PATH',attachments:group.map(source=>source.attachment)});}
  for(const group of instances.values())if(group.length>1){diagnostics.push({code:'DUPLICATE_SOP_INSTANCE_UID',attachments:group.map(source=>source.attachment)});}
  for(const reference of references){
    if(reference.active===false){reference.status='inactive';continue;}
    if(!reference.fileId.length||reference.fileId.some(component=>!/^[-A-Za-z0-9_]{1,8}$/.test(component))){reference.status='invalid-file-id';continue;}
    const directory=reference.sourcePath.includes('/')?reference.sourcePath.slice(0,reference.sourcePath.lastIndexOf('/')+1):'';
    reference.targetSourcePath=directory+reference.fileId.join('/');
    const matches=entries.filter(entry=>(entry.origin.container??null)===reference.container&&entry.sourcePath===reference.targetSourcePath);
    reference.targetAttachments=matches.map(entry=>entry.attachment);
    reference.status=matches.length===0?'missing':matches.length>1?'ambiguous':reference.sopInstanceUID&&matches[0].sopInstanceUID&&reference.sopInstanceUID!==matches[0].sopInstanceUID?'identity-mismatch':reference.sopInstanceUID&&!matches[0].sopInstanceUID?'unverified':'resolved';
  }
  totals.retainedBytes=totals.originalBytes+totals.containerBytes;progress('complete');
  return {schemaVersion:1,inputKind:'direct-dicom',preservationStatus:'not-a-preservation-pdf',entries,attachments,containers,references,diagnostics,totals,limits};
}
