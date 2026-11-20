import dictionary from './dicom-dictionary.json' with {type:'json'};
import dicomParser from 'dicom-parser';
import {parseDicomCompatible} from './dicom-parser-compat.mjs';
import {readDicomMetadata} from './metadata-export.mjs';
import {inflateDicomBytes} from './bounded-inflate.mjs';
import {workingMemoryBytes} from './working-memory.mjs';

import {GSPS_SOP,readPresentationState} from './presentation-state.mjs';
import {MR_SPECTROSCOPY_SOP,readMrSpectroscopy} from './mr-spectroscopy.mjs';
import {RT_DOSE_SOP,RT_DOSE_RLE,readRtDose} from './rt-dose.mjs';
import {RT_PLAN_SOP,readRtPlan} from './rt-plan.mjs';
import {SURFACE_SEGMENTATION_SOP,surfaceSegmentationSource} from './surface-segmentation.mjs';

const MiB=1024*1024,TAGS=dictionary.tags||dictionary;
// The Dose Units Code Sequence postdates the bundled dictionary.
const standardVr=hex=>hex==='30040020'?'SQ':TAGS[hex]?.vr?.split(' or ')[0];
const vrCallback=tag=>standardVr(tag.slice(1).toUpperCase());
export const DOCUMENT_LIMITS=Object.freeze({maxSourceBytes:Number.MAX_SAFE_INTEGER,maxPdfBytes:Number.MAX_SAFE_INTEGER,maxMetadataBytes:16*MiB,
  maxElements:50000,maxDepth:24,maxContentItems:5000,maxTextBytes:MiB,maxInflatedBytes:workingMemoryBytes(),maxCompressionRatio:200});
const PDF_SOP='1.2.840.10008.5.1.4.1.1.104.1';
const SPECIALIZED=new Map([
  [GSPS_SOP,'presentation-state'],[MR_SPECTROSCOPY_SOP,'spectroscopy'],[RT_DOSE_SOP,'rt-dose'],[RT_PLAN_SOP,'rt-plan'],
  [SURFACE_SEGMENTATION_SOP,'surface-segmentation'],
]);
const LONG=new Set('OB OD OF OL OV OW SQ UC UR UT UN SV UV'.split(' '));
const VRS=new Set('AE AS AT CS DA DS DT FD FL IS LO LT OB OD OF OL OV OW PN SH SL SQ SS ST SV TM UC UI UL UN UR US UT UV'.split(' '));
const BULK=new Set(['00420011','7FE00008','7FE00009','7FE00010','54001010','56000020']);
const SURFACE_BULK=new Set(['00660016','00660021','00660022','00660023','00660024','00660025','00660029',
  '00660040','00660041','00660042','00660043']);
const failure=code=>{const error=new Error('DICOM document is not available.');error.code=code;throw error;};
const abort=signal=>{if(signal?.aborted)throw new DOMException('Document reading cancelled.','AbortError');};
const viewOf=bytes=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const ascii=bytes=>{if(bytes.some(value=>value>127))failure('MALFORMED_DICOM');return String.fromCharCode(...bytes).replace(/[\0 ]+$/g,'');};
function limitsFor(overrides={}){
  const result={...DOCUMENT_LIMITS};
  for(const [key,value] of Object.entries(overrides)){
    if(!Object.hasOwn(result,key)||!Number.isSafeInteger(value)||value<1||value>result[key])failure('INVALID_LIMITS');result[key]=value;
  }
  return result;
}
function header(bytes,position,end,little,explicit){
  if(position+8>end)failure('MALFORMED_DICOM');
  const view=viewOf(bytes),group=view.getUint16(position,little),element=view.getUint16(position+2,little);
  const hex=group.toString(16).padStart(4,'0').toUpperCase()+element.toString(16).padStart(4,'0').toUpperCase();
  let vr=standardVr(hex),offset=position+8,length;
  if(explicit&&group!==0xfffe){
    vr=String.fromCharCode(bytes[position+4],bytes[position+5]);if(!VRS.has(vr))failure('MALFORMED_DICOM');
    if(LONG.has(vr)){if(position+12>end||bytes[position+6]||bytes[position+7])failure('MALFORMED_DICOM');offset=position+12;length=view.getUint32(position+8,little);}
    else length=view.getUint16(position+6,little);
  }else length=view.getUint32(position+4,little);
  if(length!==0xffffffff&&offset+length>end)failure('MALFORMED_DICOM');
  return {hex,group,element,vr,offset,length};
}
function prepare(bytes,sourceParsing,limits,signal){
  const part10=bytes.length>=132&&bytes[128]===68&&bytes[129]===73&&bytes[130]===67&&bytes[131]===77;
  let position=part10?132:0,syntax,metaEnd=null,metaCount=0;
  if(!part10&&!['raw-dataset','file-meta-without-preamble'].includes(sourceParsing?.mode))failure('SOURCE_PARSING_REQUIRED');
  if(part10||sourceParsing?.mode==='file-meta-without-preamble'){
    while(position+8<=bytes.length&&viewOf(bytes).getUint16(position,true)===2){
      if(++metaCount>limits.maxElements||position>(part10?132:0)+limits.maxMetadataBytes)failure('RESOURCE_LIMIT');
      const item=header(bytes,position,bytes.length,true,true);if(item.length===0xffffffff)failure('MALFORMED_DICOM');
      if(item.hex==='00020000'){
        if(item.vr!=='UL'||item.length!==4)failure('MALFORMED_DICOM');metaEnd=item.offset+4+viewOf(bytes).getUint32(item.offset,true);
        if(metaEnd>bytes.length)failure('MALFORMED_DICOM');
      }
      if(item.hex==='00020010'){if(item.length>128)failure('MALFORMED_DICOM');syntax=ascii(bytes.subarray(item.offset,item.offset+item.length));}
      position=item.offset+item.length;if(metaEnd!==null&&position>metaEnd)failure('MALFORMED_DICOM');if(position===metaEnd)break;
    }
    if(!syntax||metaEnd!==null&&metaEnd!==position)failure('MALFORMED_DICOM');
    if(sourceParsing?.transferSyntaxUID&&sourceParsing.transferSyntaxUID!==syntax)failure('SOURCE_PARSING_MISMATCH');
  }else{
    syntax=sourceParsing.transferSyntaxUID;
    if(!['1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.2'].includes(syntax))failure('SOURCE_PARSING_REQUIRED');
  }
  let prepared=bytes;
  if(syntax==='1.2.840.10008.1.2.1.99'){
    abort(signal);try{prepared=inflateDicomBytes(bytes,position,{maxBytes:limits.maxInflatedBytes,maxRatio:limits.maxCompressionRatio});}
    catch{failure('RESOURCE_LIMIT');}
  }
  const little=syntax!=='1.2.840.10008.1.2.2',explicit=syntax!=='1.2.840.10008.1.2';
  let count=metaCount,metadataBytes=0,pixelTag;
  function scan(start,end,depth,undefinedItem=false,root=false,littleEndian=little,explicitVr=explicit){
    if(depth>limits.maxDepth)failure('RESOURCE_LIMIT');let cursor=start;
    while(cursor<end){
      abort(signal);if(++count>limits.maxElements)failure('RESOURCE_LIMIT');
      const item=header(prepared,cursor,end,littleEndian,explicitVr);metadataBytes+=item.offset-cursor;
      if(metadataBytes>limits.maxMetadataBytes)failure('RESOURCE_LIMIT');
      if(item.group===0xfffe){if(undefinedItem&&item.element===0xe00d&&item.length===0)return item.offset;failure('MALFORMED_DICOM');}
      if(root&&['7FE00008','7FE00009','7FE00010'].includes(item.hex)){
        pixelTag??='x'+item.hex.toLowerCase();
        if(item.length!==0xffffffff){cursor=item.offset+item.length;continue;}
        if(item.hex!=='7FE00010')failure('MALFORMED_DICOM');
        let next=item.offset,closed=false,fragments=0;
        while(next<end){
          abort(signal);if(++count>limits.maxElements)failure('RESOURCE_LIMIT');
          const fragment=header(prepared,next,end,littleEndian,false);metadataBytes+=8;
          if(metadataBytes>limits.maxMetadataBytes)failure('RESOURCE_LIMIT');
          if(fragment.group!==0xfffe||fragment.length===0xffffffff)failure('MALFORMED_DICOM');
          if(fragment.element===0xe0dd&&fragment.length===0){next=fragment.offset;closed=true;break;}
          if(fragment.element!==0xe000||fragment.length%2!==0||fragments===0&&fragment.length%4!==0)failure('MALFORMED_DICOM');
          fragments++;next=fragment.offset+fragment.length;
        }
        if(!closed||!fragments)failure('MALFORMED_DICOM');cursor=next;continue;
      }
      if(item.hex==='00420011'&&(item.length===0xffffffff||item.length>limits.maxPdfBytes))failure('PDF_RESOURCE_LIMIT');
      if(SURFACE_BULK.has(item.hex)){
        if(item.length===0xffffffff)failure('MALFORMED_DICOM');
        cursor=item.offset+item.length;continue;
      }
      // PS3.5 §6.2.2 permits interpreting a dictionary-known UN value as implicit little endian.
      const unknown=item.vr==='UN',childLittle=unknown||littleEndian,childExplicit=!unknown&&explicitVr;
      const sequence=item.vr==='SQ'||unknown&&standardVr(item.hex)==='SQ'||item.length===0xffffffff
        ||item.length>=8&&viewOf(prepared).getUint16(item.offset,childLittle)===0xfffe
        &&viewOf(prepared).getUint16(item.offset+2,childLittle)===0xe000;
      if(sequence){
        let next=item.offset,stop=item.length===0xffffffff?end:item.offset+item.length,closed=item.length!==0xffffffff;
        while(next<stop){
          if(++count>limits.maxElements)failure('RESOURCE_LIMIT');
          const child=header(prepared,next,stop,childLittle,false);metadataBytes+=8;if(metadataBytes>limits.maxMetadataBytes)failure('RESOURCE_LIMIT');
          if(child.group!==0xfffe)failure('MALFORMED_DICOM');
          if(child.element===0xe0dd&&item.length===0xffffffff&&child.length===0){next=child.offset;closed=true;break;}
          if(child.element!==0xe000)failure('MALFORMED_DICOM');
          next=scan(child.offset,child.length===0xffffffff?stop:child.offset+child.length,depth+1,child.length===0xffffffff,false,childLittle,childExplicit);
        }
        if(!closed||item.length!==0xffffffff&&next!==stop)failure('MALFORMED_DICOM');cursor=next;
      }else{
        if(!BULK.has(item.hex))metadataBytes+=item.length;
        if(metadataBytes>limits.maxMetadataBytes)failure('RESOURCE_LIMIT');cursor=item.offset+item.length;
      }
    }
    if(undefinedItem)failure('MALFORMED_DICOM');return cursor;
  }
  scan(position,prepared.length,0,false,true);
  return {prepared,pixelTag,syntax};
}

function restoreImplicitSequences(ds){
  const pending=[ds];
  while(pending.length){
    const current=pending.pop();
    for(const element of Object.values(current.elements)){
      if(element.vr==='UN'&&!element.items&&vrCallback(element.tag)==='SQ'){
        const stream=new dicomParser.ByteStream(dicomParser.littleEndianByteArrayParser,current.byteArray,element.dataOffset);
        dicomParser.readSequenceItemsImplicit(stream,element,vrCallback);
      }
      for(const item of element.items||[])if(item.dataSet)pending.push(item.dataSet);
    }
  }
}
const tagPath=(base,hex)=>base+'/('+hex.slice(0,4)+','+hex.slice(4)+')';
const inert=value=>String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
function srText(records,limits,signal){
  if(records.some(record=>record.encoding==='incomplete-dataset'))failure('MALFORMED_DICOM');
  const byPath=new Map(records.map(record=>[record.path,record]));let bytes=0,contentItems=0,unsupportedContentItems=0;const lines=[];
  const value=(base,hex)=>{
    const record=byPath.get(tagPath(base,hex));if(!record)return null;
    if(record.value===null||/base64|^omitted-|^unreadable-|^undecodable-|^unsupported-|^ambiguous-/.test(record.encoding))return '[not rendered: value encoding unavailable]';
    return inert(record.value);
  };
  const itemBases=(base,hex)=>{
    const path=tagPath(base,hex),record=byPath.get(path);if(!record)return [];
    const count=Number(record.value);if(!Number.isSafeInteger(count)||count<0||count>limits.maxContentItems)failure('RESOURCE_LIMIT');
    return Array.from({length:count},(_,index)=>path+'['+(index+1)+']');
  };
  const code=(base,sequence)=>{
    const first=itemBases(base,sequence)[0];if(!first)return '';
    const meaning=value(first,'00080104'),coding=value(first,'00080102'),identifier=value(first,'00080100')||value(first,'00080119')||value(first,'00080120');
    return [meaning,identifier?'['+(coding?coding+':':'')+identifier+']':coding?'['+coding+']':''].filter(Boolean).join(' ');
  };
  const append=(line,depth)=>{
    const formatted=String(line).split(/\r\n|\r|\n/).map((part,index)=>'  '.repeat(depth)+(index?'  ':'')+part).join('\n');
    bytes+=new TextEncoder().encode(formatted).length+1;if(bytes>limits.maxTextBytes)failure('RESOURCE_LIMIT');lines.push(formatted);
  };
  function node(base,depth){
    abort(signal);if(depth>limits.maxDepth||++contentItems>limits.maxContentItems)failure('RESOURCE_LIMIT');
    const type=value(base,'0040A040'),relationship=value(base,'0040A010'),name=code(base,'0040A043');let actual='';
    if(['TEXT','PNAME','DATE','TIME','DATETIME','UIDREF'].includes(type)){
      actual=value(base,{TEXT:'0040A160',PNAME:'0040A123',DATE:'0040A121',TIME:'0040A122',DATETIME:'0040A120',UIDREF:'0040A124'}[type])||'[value not supplied]';
    }else if(type==='CODE')actual=code(base,'0040A168')||'[coded value not supplied]';
    else if(type==='NUM'){
      const measurement=itemBases(base,'0040A300')[0];
      if(measurement){const numeric=value(measurement,'0040A30A')||value(measurement,'0040A161'),numerator=value(measurement,'0040A162'),denominator=value(measurement,'0040A163');
        actual=[numeric||numerator&&denominator?numeric||numerator+'/'+denominator:'[numeric value not supplied]',code(measurement,'004008EA')].filter(Boolean).join(' ');
      }else actual='[measurement not supplied]';
    }else if(type==='IMAGE'){
      actual=itemBases(base,'00081199').map(reference=>[
        value(reference,'00081155')?'SOP Instance UID '+value(reference,'00081155'):'[instance ID not supplied]',
        value(reference,'00081150')?'SOP Class UID '+value(reference,'00081150'):'',
        value(reference,'00081160')?'frames '+value(reference,'00081160'):'',value(reference,'0062000B')?'segments '+value(reference,'0062000B'):''
      ].filter(Boolean).join('; ')).join(' | ')||'[image reference not supplied]';
    }else if(type==='CONTAINER')actual=value(base,'0040A050')||'';
    else {actual='[not rendered: '+(type||'by-reference or unspecified content')+']';const reference=value(base,'0040DB73');if(reference)actual+=' content item '+reference;}
    const label=[relationship?'['+relationship+']':'',type||'CONTENT',name].filter(Boolean).join(' ');
    if(label.includes('[not rendered:')||actual.includes('[not rendered:'))unsupportedContentItems++;
    append(label+(actual?': '+actual:''),depth);
    for(const child of itemBases(base,'0040A730'))node(child,depth+1);
  }
  const rootType=value('dataset','0040A040');
  if(rootType)node('dataset',0);
  else for(const child of itemBases('dataset','0040A730'))node(child,0);
  if(!contentItems)failure('EMPTY_SR');
  return {text:lines.join('\n')+'\n',contentItems,unsupportedContentItems};
}

/**
 * Read report content without altering its DICOM source. Run in a worker.
 * Raw sources require an explicit recorded sourceParsing option. SR output is
 * literal text, not HTML or an interpretation of clinical findings. Unsupported
 * content stays visibly labeled. A PDF copy strips a single DICOM zero padding
 * byte only when EncapsulatedDocumentLength actually records the shorter size.
 */
export function readDicomDocument(source,{sourceParsing=null,signal,limits:overrides}={}){
  try{
    abort(signal);const limits=limitsFor(overrides),bytes=source instanceof Uint8Array?source:source instanceof ArrayBuffer?new Uint8Array(source):null;
    if(!bytes)failure('INVALID_INPUT');if(bytes.length>limits.maxSourceBytes)failure('RESOURCE_LIMIT');
    const {prepared,pixelTag,syntax}=prepare(bytes,sourceParsing,limits,signal);
    const ds=parseDicomCompatible(bytes,{sourceParsing,untilTag:syntax===RT_DOSE_RLE?undefined:pixelTag,vrCallback,inflater:()=>prepared});
    const sopClassUID=ds.string('x00080016')?.trim()||ds.string('x00020002')?.trim()||null;
    const sopInstanceUID=ds.string('x00080018')?.trim()||null;
    const specialized=SPECIALIZED.get(sopClassUID);
    if(specialized){
      try{
        if(specialized==='rt-plan'||specialized==='rt-dose'||specialized==='surface-segmentation')restoreImplicitSequences(ds);
        let content;
        switch(specialized){
          case 'presentation-state': content=readPresentationState(ds);break;
          case 'spectroscopy': content=readMrSpectroscopy(ds);break;
          case 'rt-plan': content=readRtPlan(ds);break;
          case 'rt-dose': content=readRtDose(ds,{syntax,residentBytes:bytes.length+(prepared===bytes?0:prepared.length)});break;
          case 'surface-segmentation': content=surfaceSegmentationSource(ds,{residentBytes:bytes.length+(prepared===bytes?0:prepared.length)});break;
        }
        return {kind:specialized,content,sopClassUID,sopInstanceUID,sourceUnchanged:true};
      }catch(error){
        const code=specialized==='surface-segmentation'?(error?.code||'UNSUPPORTED_SURFACE_OBJECT')
          :specialized==='rt-dose'||specialized==='rt-plan'?'UNSUPPORTED_RT_OBJECT':'UNSUPPORTED_SPECIALIZED_OBJECT';
        return {kind:'unsupported',detail:error.message,code};
      }
    }
    if(sopClassUID===PDF_SOP){
      const mimeElement=ds.elements.x00420012,document=ds.elements.x00420011,lengthElement=ds.elements.x00420015;
      if(!mimeElement||mimeElement.length>256||!document||document.length===0xffffffff||document.length<8)failure('MALFORMED_PDF_DOCUMENT');
      const mime=ascii(ds.byteArray.subarray(mimeElement.dataOffset,mimeElement.dataOffset+mimeElement.length)).toLowerCase();
      if(mime!=='application/pdf')failure('UNSUPPORTED_DOCUMENT_MIME');
      let length=document.length;
      if(lengthElement){
        if(lengthElement.length!==4)failure('MALFORMED_PDF_DOCUMENT');length=ds.uint32('x00420015');
        if(length<8||length>document.length||document.length-length>1||document.length-length===1&&ds.byteArray[document.dataOffset+length]!==0)failure('MALFORMED_PDF_DOCUMENT');
      }
      if(length>limits.maxPdfBytes)failure('PDF_RESOURCE_LIMIT');
      const payload=ds.byteArray.subarray(document.dataOffset,document.dataOffset+length);
      if(!/^%PDF-[12]\.\d/.test(ascii(payload.subarray(0,8))))failure('MALFORMED_PDF_DOCUMENT');
      const tail=String.fromCharCode(...payload.subarray(Math.max(0,payload.length-4096)));
      if(!/%%EOF[\x00\t\n\f\r ]*$/.test(tail))failure('MALFORMED_PDF_DOCUMENT');
      return {kind:'pdf',bytes:Uint8Array.from(payload),mime:'application/pdf',sopClassUID,sopInstanceUID,sourceUnchanged:true,paddingRemoved:document.length-length};
    }
    if(sopClassUID?.startsWith('1.2.840.10008.5.1.4.1.1.88.')){
      const records=readDicomMetadata(bytes,{sourceParsing});abort(signal);
      return {kind:'sr',...srText(records,limits,signal),mime:'text/plain',sopClassUID,sopInstanceUID,sourceUnchanged:true};
    }
    return {kind:'unsupported',code:'UNSUPPORTED_DOCUMENT_OBJECT'};
  }catch(error){if(error?.name==='AbortError')throw error;return {kind:'unsupported',code:error?.code||'MALFORMED_DICOM'};}
}
