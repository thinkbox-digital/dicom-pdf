const FUNCTIONS=new Set(['LINEAR','LINEAR_EXACT','SIGMOID']);
const DECIMAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;
const MAX_PRESETS=256,MAX_TEXT_BYTES=65536;

function raw(ds,tag){
  const element=ds?.elements?.[tag];
  if(!element)return null;
  const {dataOffset:offset,length}=element;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(length)||length<0||length>MAX_TEXT_BYTES||offset+length>ds.byteArray.length)
    throw new Error('Invalid source display value.');
  return ds.byteArray.subarray(offset,offset+length);
}
function ascii(bytes){
  let value='';for(const byte of bytes){if(byte>127)throw new Error('Invalid source display text.');value+=String.fromCharCode(byte);}
  return value.replace(/[\0 ]+$/,'');
}
function labelsText(ds,ancestors){
  const bytes=raw(ds,'x00281055');if(bytes===null)return null;
  if(ds.elements.x00281055.vr&&ds.elements.x00281055.vr!=='LO')throw new Error('Invalid source display label.');
  const charsetSource=[ds,...ancestors].find(source=>source?.elements?.x00080005);
  const charset=ascii((charsetSource?raw(charsetSource,'x00080005'):null)??new Uint8Array()).replace(/_/g,' ').trim().replace(/\s+/g,' ').toUpperCase();
  let value;
  if(!charset||charset==='ISO IR 6'||charset==='ISO 2022 IR 6')value=ascii(bytes);
  else if(charset==='ISO IR 100'||charset==='ISO 2022 IR 100'&&!bytes.includes(0x1b))value=Array.from(bytes,byte=>String.fromCharCode(byte)).join('');
  else {
    const names={'ISO IR 192':'utf-8','UTF 8':'utf-8','UTF-8':'utf-8','ISO IR 101':'iso-8859-2','ISO IR 109':'iso-8859-3','ISO IR 110':'iso-8859-4',
      'ISO IR 144':'iso-8859-5','ISO IR 127':'iso-8859-6','ISO IR 126':'iso-8859-7','ISO IR 138':'iso-8859-8','ISO IR 148':'iso-8859-9','ISO IR 166':'windows-874','GB18030':'gb18030','GBK':'gbk','ISO IR 13':'shift_jis'};
    if(!names[charset]||bytes.includes(0x1b))throw new Error('Unsupported source display label encoding.');
    value=new TextDecoder(names[charset],{fatal:true}).decode(bytes);
  }
  return value.replace(/[\0 ]+$/,'').split('\\');
}

/** File-provided alternatives only. No anatomy presets or source-pixel changes. */
export function readSourceWindowPresets(root,{perFrame=null,shared=null}={}){
  let source=root,provenance='top-level',macroPresent=false,functionalGroup=null;
  const result={presets:[],provenance,functionExplicit:false,diagnostics:[]};
  const diagnostic=code=>{if(!result.diagnostics.includes(code))result.diagnostics.push(code);};
  for(const [group,name] of [[perFrame,'per-frame-functional-groups'],[shared,'shared-functional-groups']]){
    const macro=group?.elements?.x00289132;
    if(!macro)continue;
    result.provenance=provenance=name;macroPresent=true;
    if((macro.vr&&macro.vr!=='SQ')||macro.items?.length!==1||!macro.items[0].dataSet){diagnostic('MALFORMED_FRAME_VOI_MACRO');return result;}
    source=macro.items[0].dataSet;functionalGroup=group;break;
  }
  const hasCenter=!!source?.elements?.x00281050,hasWidth=!!source?.elements?.x00281051;
  if(!hasCenter&&!hasWidth){if(!macroPresent)return null;diagnostic('WINDOW_VALUES_MISSING');return result;}
  result.functionExplicit=!!source.elements.x00281056;
  let functionValue='LINEAR';
  try{
    if(result.functionExplicit){
      if(source.elements.x00281056.vr&&source.elements.x00281056.vr!=='CS')throw new Error();
      functionValue=ascii(raw(source,'x00281056')).trim();
      if(!FUNCTIONS.has(functionValue)){diagnostic('UNSUPPORTED_VOI_FUNCTION');return result;}
    }
  }catch{diagnostic('INVALID_VOI_FUNCTION');return result;}
  let centers,widths;
  try{
    for(const tag of ['x00281050','x00281051'])if(source.elements[tag]?.vr&&source.elements[tag].vr!=='DS')throw new Error();
    if(!hasCenter||!hasWidth){diagnostic('WINDOW_VM_MISMATCH');return result;}
    centers=ascii(raw(source,'x00281050')).split('\\');widths=ascii(raw(source,'x00281051')).split('\\');
  }catch{diagnostic('INVALID_WINDOW_VALUES');return result;}
  if(centers.length!==widths.length){diagnostic('WINDOW_VM_MISMATCH');return result;}
  if(centers.length>MAX_PRESETS){diagnostic('WINDOW_PRESET_LIMIT');return result;}
  let labels=null;
  try{labels=labelsText(source,[functionalGroup,root]);}catch{diagnostic('UNREADABLE_WINDOW_LABELS');}
  if(labels&&labels.length!==centers.length){labels=null;diagnostic('WINDOW_LABEL_VM_MISMATCH');}
  for(let index=0;index<centers.length;index++){
    const centerText=centers[index].trim(),widthText=widths[index].trim(),center=Number(centerText),width=Number(widthText);
    if(!DECIMAL.test(centerText)||!DECIMAL.test(widthText)||!Number.isFinite(center)||!Number.isFinite(width)
        ||(functionValue==='LINEAR'?width<1:width<=0)){diagnostic('INVALID_WINDOW_PAIR');continue;}
    result.presets.push({index,center,width,label:labels?.[index]?.trim()||null,function:functionValue});
  }
  return result;
}
