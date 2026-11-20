import { inflateDicomBytes } from './bounded-inflate.mjs';
import dictionary from './dicom-dictionary.json' with { type: 'json' };
import { parseDicomCompatible } from './dicom-parser-compat.mjs';

const TAGS = dictionary.tags || dictionary;
const MAX_BINARY = 4096, MAX_TEXT = 65536, MAX_ELEMENTS = 100000, MAX_DEPTH = 64;
const TEXT_VRS = new Set(['AE','AS','CS','DA','DS','DT','IS','LO','LT','PN','SH','ST','TM','UC','UI','UR','UT']);
const CHARACTER_VRS = new Set(['LO','LT','PN','SH','ST','UC','UT']);
const BINARY_VRS = new Set(['OB','OD','OF','OL','OV','OW','UN']);
const PIXELS = new Set(['7FE00010','7FE00008','7FE00009']);
const BULK = new Set(['00420011','54001010','56000020']);
const AMBIGUOUS_US_SS = new Set(['00189810','00280104','00280105','00280106','00280107','00280108','00280109','00280110','00280111','00280120','00280121','00281100','00281101','00281102','00281103','00281104','00283002','00409211','00409216','00603004','00603006']);
const DESCRIPTORS = new Set(['00281100','00281101','00281102','00281103','00281104','00283002']);
const HEADERS = ['Source file','Attachment','SOP Instance UID','SHA-256','Path','Tag','Keyword','VR','Value','Encoding'];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function tagInfo(tag) {
  const hex = tag.replace(/^x/i,'').toUpperCase();
  let info = TAGS[hex];
  // Repeating Curve/Overlay groups use the dictionary's canonical 5000/6000 group.
  const group = parseInt(hex.slice(0,4),16);
  if (!info && group % 2 === 0 && (group & 0xff00) === 0x5000) info = TAGS['5000' + hex.slice(4)];
  if (!info && group % 2 === 0 && (group & 0xff00) === 0x6000) info = TAGS['6000' + hex.slice(4)];
  return {hex, tag:'(' + hex.slice(0,4) + ',' + hex.slice(4) + ')', info:info || {}};
}
function guessVr(tag) {
  const {info} = tagInfo(tag);
  const vr = String(info.vr || 'UN').toUpperCase();
  if (vr.includes('SQ')) return 'SQ';
  if (vr.includes('US') && vr.includes('SS')) return 'US';
  if (vr.includes('OW')) return 'OW';
  return /^[A-Z]{2}$/.test(vr) ? vr : 'UN';
}
function rawBytes(ds, element) {
  const offset = element.dataOffset, length = element.length;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || offset + length > ds.byteArray.length)
    throw new Error('Element byte range is unavailable.');
  return ds.byteArray.subarray(offset, offset + length);
}
function base64(bytes) {
  let result='';
  for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2],v=(a<<16)|((b??0)<<8)|(c??0);result+=BASE64[(v>>>18)&63]+BASE64[(v>>>12)&63]+(b===undefined?'=':BASE64[(v>>>6)&63])+(c===undefined?'=':BASE64[v&63]);}
  return result;
}
function ascii(bytes) { let value=''; for(const byte of bytes) { if(byte>127)throw new Error('Non-ASCII bytes without an applicable character set.'); value+=String.fromCharCode(byte); } return value; }
function charset(ds, inherited='') {
  const element=ds.elements.x00080005;
  if(!element)return inherited;
  try{return ascii(rawBytes(ds,element)).replace(/[\0 ]+$/g,'');}catch{return '[unreadable SpecificCharacterSet]';}
}
function decodeText(bytes, vr, characterSet) {
  const applicable=CHARACTER_VRS.has(vr)?characterSet:'';
  const normalized=applicable.replace(/_/g,' ').trim().replace(/\s+/g,' ').toUpperCase();
  if (bytes.length > MAX_TEXT) return {value:null,encoding:'omitted-large-text:' + bytes.length + '-bytes'};
  let value, encoding;
  try {
    if(!normalized || normalized==='ISO IR 6' || normalized==='ISO 2022 IR 6') { value=ascii(bytes);encoding='ASCII'; }
    else if(normalized==='ISO IR 100' || normalized==='ISO 2022 IR 100' && !bytes.includes(0x1b)) {
      value='';for(const byte of bytes)value+=String.fromCharCode(byte);encoding='ISO_IR 100';
    } else if(normalized==='ISO IR 192' || normalized==='UTF 8' || normalized==='UTF-8') {value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);encoding='UTF-8';}
    else {
      const labels={'ISO IR 101':'iso-8859-2','ISO IR 109':'iso-8859-3','ISO IR 110':'iso-8859-4','ISO IR 144':'iso-8859-5','ISO IR 127':'iso-8859-6','ISO IR 126':'iso-8859-7','ISO IR 138':'iso-8859-8','ISO IR 148':'iso-8859-9','ISO IR 166':'windows-874','GB18030':'gb18030','GBK':'gbk','ISO IR 13':'shift_jis'};
      const label=labels[normalized];
      if(!label || normalized.includes('\\') || bytes.includes(0x1b)) return {value:base64(bytes.subarray(0,MAX_BINARY)),encoding:'unsupported-character-set:' + (applicable || 'default') + ';base64' + (bytes.length>MAX_BINARY?';truncated;total-bytes='+bytes.length:'')};
      value=new TextDecoder(label,{fatal:true}).decode(bytes);encoding=applicable;
    }
    return {value:value.replace(/[\0 ]+$/g,''),encoding};
  } catch {
    return {value:base64(bytes.subarray(0,MAX_BINARY)),encoding:'undecodable-text:'+(applicable||'ASCII')+';base64'+(bytes.length>MAX_BINARY?';truncated;total-bytes='+bytes.length:'')};
  }
}
/** Read one textual attribute using the data set's inherited DICOM character set. */
export function readDicomText(ds,tag,inheritedCharacterSet='') {
  const element=ds.elements[tag],vr=element?.vr==='UN'?guessVr(tag):element?.vr||guessVr(tag);
  if(!element?.length||!TEXT_VRS.has(vr))return null;
  const {value,encoding}=decodeText(rawBytes(ds,element),vr,charset(ds,inheritedCharacterSet));
  return encoding.includes(';base64')?null:value?.trim()||null;
}

function littleEndian(ds, element) {
  const parser=element.parser || ds.byteArrayParser;
  return parser.readUint16(new Uint8Array([1,0]),0)===1;
}
function numericValue(ds, tag, element, vr) {
  const length=element.length;
  const widths={US:2,SS:2,UL:4,SL:4,FL:4,FD:8,AT:4,SV:8,UV:8};
  const width=widths[vr];
  if(!width || length%width!==0 || length/width>16384) return null;
  const values=[];
  const source=rawBytes(ds,element), view=new DataView(source.buffer,source.byteOffset,source.byteLength),little=littleEndian(ds,element);
  for(let i=0;i<length/width;i++){
    if(vr==='AT') {const group=ds.uint16(tag,i*2),number=ds.uint16(tag,i*2+1);values.push('('+group.toString(16).padStart(4,'0').toUpperCase()+','+number.toString(16).padStart(4,'0').toUpperCase()+')');}
    else if(vr==='SV')values.push(view.getBigInt64(i*8,little).toString());
    else if(vr==='UV')values.push(view.getBigUint64(i*8,little).toString());
    else {let method={US:'uint16',SS:'int16',UL:'uint32',SL:'int32',FL:'float',FD:'double'}[vr];if(vr==='SS'&&DESCRIPTORS.has(tagInfo(tag).hex)&&i!==1)method='uint16';values.push(String(ds[method](tag,i)));}
  }
  return {value:values.join('\\'),encoding:'numeric'};
}
function resolvedVr(ds, element, info, hex, implicit, representation) {
  const original=String(element.vr || info.vr || 'UN').toUpperCase();
  if(implicit&&AMBIGUOUS_US_SS.has(hex)||original.includes('US')&&original.includes('SS'))return representation===1?'SS':representation===0?'US':'US/SS';
  if(original.includes('OW'))return 'OW';
  return /^[A-Z]{2}$/.test(original)?original:'UN';
}

/** Read actual original-file attributes, including unknown/private tags and nested sequences. */
export function readDicomMetadata(bytes,{sourceParsing=null}={}) {
  if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
  const elements=[];let dataset,parseProblem;
  try {
    dataset=parseDicomCompatible(bytes,{sourceParsing,vrCallback:guessVr,inflater:inflateDicomBytes});
  } catch(error) { dataset=error?.dataSet;parseProblem=error?.exception?.message||error?.exception||error?.message||String(error); }
  const implicit=(dataset?.string('x00020010')?.trim()||sourceParsing?.transferSyntaxUID)==='1.2.840.10008.1.2';
  function walk(ds,prefix,inherited,depth,inheritedRepresentation){
    if(depth>MAX_DEPTH) {elements.push({path:prefix+'/[omitted-deep-sequence]',tag:'',keyword:'',vr:'SQ',value:null,encoding:'omitted-depth-limit'});return;}
    const characterSet=charset(ds,inherited),representation=ds.uint16('x00280103')??inheritedRepresentation;
    for(const tag of Object.keys(ds.elements).sort()){
      if(elements.length>=MAX_ELEMENTS)throw new Error('Metadata element count exceeds the supported size.');
      const element=ds.elements[tag],{hex,tag:formatted,info}=tagInfo(tag),vr=resolvedVr(ds,element,info,hex,implicit,representation);
      const base=prefix || (hex.startsWith('0002')?'fileMeta':'dataset');
      const path=base+'/'+formatted;
      const record={path,tag:formatted,keyword:info.keyword||'',vr,value:'',encoding:''};
      if(PIXELS.has(hex)){record.value=null;record.encoding='omitted-pixel-data';elements.push(record);continue;}
      if(BULK.has(hex)||(hex.startsWith('50')&&hex.slice(4)==='3000')){record.value=null;record.encoding='omitted-bulk-data';elements.push(record);continue;}
      if(element.items || vr==='SQ'){
        const items=element.items||[];record.vr='SQ';record.value=String(items.length);record.encoding='sequence-item-count';elements.push(record);
        for(let i=0;i<items.length;i++)if(items[i].dataSet)walk(items[i].dataSet,path+'['+(i+1)+']',characterSet,depth+1,representation);
        continue;
      }
      try {
        const raw=rawBytes(ds,element);
        if(TEXT_VRS.has(vr))Object.assign(record,decodeText(raw,vr,hex.startsWith('0002')?'':characterSet));
        else if(!BINARY_VRS.has(vr)){
          const value=numericValue(ds,tag,element,vr);
          if(value)Object.assign(record,value);else if(raw.length<=MAX_BINARY){record.value=base64(raw);record.encoding=vr==='US/SS'?'ambiguous-vr;base64':'base64';}else{record.value=null;record.encoding='omitted-binary-data';}
        }else if(raw.length<=MAX_BINARY){record.value=base64(raw);record.encoding='base64';}
        else{record.value=null;record.encoding='omitted-binary-data';}
      }catch(error){record.value=null;record.encoding='unreadable-value:'+String(error.message||error);}
      elements.push(record);
    }
  }
  if(dataset)walk(dataset,'','',0);
  if(parseProblem)elements.push({path:'[parse-error]',tag:'',keyword:'',vr:'',value:String(parseProblem),encoding:'incomplete-dataset'});
  return elements;
}

function safeCell(value) {
  let text=value===null||value===undefined?'':String(value);
  // RFC4180 quoting alone does not stop spreadsheet programs from executing formulas.
  if(/^[\s]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
const SOURCE_COLUMNS = ['Source file','Attachment','SOP Instance UID','SHA-256','Metadata status','Metadata diagnostics'];
const SOURCE_CONTEXT = new Map([['Source file','sourcePath'],['Attachment','attachment'],['SHA-256','sha256']]);
function detailedCsv(records,selected) {
  const lines=[HEADERS.map(safeCell).join(',')];
  for(const record of records){
    for(const element of record.elements||[]){
      if(selected&&!selected.has(element.path)&&element.encoding!=='incomplete-dataset')continue;
      const row=[record.sourcePath,record.attachment,record.sopInstanceUID,record.sha256,element.path,element.tag,element.keyword,element.vr,element.value,element.encoding];
      lines.push(row.map(safeCell).join(','));
    }
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
function columnValue(element) {
  const encoding=element.encoding || '';
  if(element.value===null || element.value===undefined)return encoding?'['+encoding+']':'';
  const value=String(element.value);
  if(/base64|^omitted-|^unreadable-|^undecodable-|^unsupported-|^ambiguous-|^sequence-item-count$/.test(encoding))return '['+encoding+']'+(value?' '+value:'');
  return value;
}
function columnsCsv(records,selected) {
  const fields=new Map();
  for(const record of records)for(const element of record.elements || []){
    if(element.encoding==='incomplete-dataset' || selected&&!selected.has(element.path))continue;
    if(!fields.has(element.path))fields.set(element.path,element);
  }
  // Package context is the same information shown under Selected original;
  // keep it adjacent to source identity, followed by the original DICOM tags.
  const ordered=[...fields].filter(([,element])=>element.encoding==='package-context')
    .concat([...fields].filter(([,element])=>element.encoding!=='package-context'));
  const used=new Set(SOURCE_COLUMNS),columns=[];
  for(const [path,element] of ordered){
    const context=element.encoding==='package-context',keyword=element.keyword || element.tag || path;
    const sourceKey=context?SOURCE_CONTEXT.get(keyword):null;
    if(sourceKey && records.every(record=>{
      const actual=(record.elements || []).find(item=>item.path===path);
      return !actual || String(actual.value ?? '')===String(record[sourceKey] ?? '');
    }))continue;
    const base=context?keyword:`${keyword} [${path}]`;
    let label=base;
    if(used.has(label))label=`${base} [${path}]`;
    let suffix=2;while(used.has(label))label=`${base} [${path}] (${suffix++})`;
    used.add(label);columns.push({path,label});
  }
  if((SOURCE_COLUMNS.length+columns.length)*(records.length+1)>5_000_000)throw new Error('This selection is too wide for a spreadsheet export. Choose fewer fields or Detailed tag rows.');
  const lines=[[...SOURCE_COLUMNS,...columns.map(column=>column.label)].map(safeCell).join(',')];
  for(const record of records){
    const byPath=new Map(),diagnostics=[];
    if(record.reason)diagnostics.push(String(record.reason));
    for(const element of record.elements || []){
      if(element.encoding==='incomplete-dataset'){
        if(element.value)diagnostics.push(String(element.value));
        continue;
      }
      if(byPath.has(element.path))throw new Error(`Duplicate metadata path ${element.path} in ${record.attachment || record.sourcePath}; export refused.`);
      byPath.set(element.path,element);
    }
    const status=record.status || (diagnostics.length?'partial':'readable');
    const values=[record.sourcePath,record.attachment,record.sopInstanceUID,record.sha256,status,[...new Set(diagnostics)].join('\n')];
    for(const column of columns)values.push(byPath.has(column.path)?columnValue(byPath.get(column.path)):'');
    lines.push(values.map(safeCell).join(','));
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
/** One row per original by default; detailed rows retain exact tag/VR/encoding records. */
export function metadataCsv(records,selectedKeys=null,{layout='columns'}={}) {
  const selected=selectedKeys===null?null:selectedKeys instanceof Set?selectedKeys:new Set(selectedKeys);
  if(layout==='rows')return detailedCsv(records,selected);
  if(layout==='columns')return columnsCsv(records,selected);
  throw new TypeError(`Unknown metadata CSV layout: ${layout}`);
}
