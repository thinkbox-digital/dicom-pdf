/** Limits apply to UTF-8 text, rather than JavaScript UTF-16 code units. */
import {workingMemoryBytes} from './working-memory.mjs';
const workingBytes=workingMemoryBytes();
export const XMP_LIMITS=Object.freeze({maxRawBytes:workingBytes,maxMetadataBytes:workingBytes,maxManifestBytes:workingBytes,maxSources:10000});

const MESSAGES={
  XMP_UNREADABLE:'The document XMP could not be read.',
  XMP_LIMIT_EXCEEDED:'The document XMP exceeds the supported resource limit.',
  XMP_MANIFEST_MISMATCH:'The XMP inventory does not match the embedded manifest.',
  XMP_METADATA_INVALID:'The full XMP metadata inventory is invalid or unsupported.',
  XMP_METADATA_HASH_MISMATCH:'The full XMP metadata does not match its recorded SHA-256.',
  XMP_METADATA_MAPPING_MISMATCH:'The full XMP metadata source mapping differs from the manifest.'
};

export class XmpMetadataError extends Error {
  constructor(code){super(MESSAGES[code]||MESSAGES.XMP_UNREADABLE);this.name='XmpMetadataError';this.code=code;}
}
const fail=code=>{throw new XmpMetadataError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/i.test(value);

function bounds(overrides){
  const limits={...XMP_LIMITS,...overrides};
  for(const key of Object.keys(XMP_LIMITS))if(!Number.isSafeInteger(limits[key])||limits[key]<0)throw new RangeError('The XMP resource limit is invalid.');
  return limits;
}

function textWithin(value,limit,code){
  if(typeof value!=='string')fail(code);
  // Count without first allocating a second, potentially large UTF-8 buffer.
  if(value.length>limit)fail('XMP_LIMIT_EXCEEDED');
  let size=0;
  for(let i=0;i<value.length;i++){
    const c=value.charCodeAt(i);
    if(c<0x80)size++;
    else if(c<0x800)size+=2;
    else if(c>=0xd800&&c<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){size+=4;i++;}
    else size+=3;
    if(size>limit)fail('XMP_LIMIT_EXCEEDED');
  }
  return value;
}

function json(text,code){try{return JSON.parse(text);}catch{fail(code);}}

function sameJson(left,right){
  const pending=[[left,right]];
  while(pending.length){
    const [a,b]=pending.pop();
    if(a===b)continue;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a),other=Object.keys(b);
    if(keys.length!==other.length)return false;
    for(const key of keys){if(!Object.hasOwn(b,key))return false;pending.push([a[key],b[key]]);}
  }
  return true;
}

function manifestText(bytes,limit){
  if(!(bytes instanceof Uint8Array))fail('XMP_MANIFEST_MISMATCH');
  if(bytes.byteLength>limit)fail('XMP_LIMIT_EXCEEDED');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('XMP_MANIFEST_MISMATCH');}
}

function checkMappings(inventory,entries,manifest,limits){
  if(!object(inventory)||![1,2].includes(inventory.schemaVersion)||!Array.isArray(inventory.images)
    ||!Array.isArray(entries)||!Array.isArray(manifest?.images)||entries.length>limits.maxSources
    ||inventory.images.length!==entries.length||manifest.images.length!==entries.length)fail('XMP_METADATA_INVALID');
  const expected=new Map();
  for(let index=0;index<entries.length;index++){
    const entry=entries[index],record=manifest.images[index];
    if(!object(entry)||typeof entry.attachment!=='string'||!entry.attachment||expected.has(entry.attachment)
      ||!object(record)||record.attachment!==entry.attachment||record.sourcePath!==entry.sourcePath
      ||record.sha256!==entry.sha256||(record.sopInstanceUID??null)!==(entry.sopInstanceUID??null))fail('XMP_METADATA_MAPPING_MISMATCH');
    expected.set(entry.attachment,entry);
  }
  const seen=new Set();
  for(const record of inventory.images){
    const entry=object(record)?expected.get(record.attachment):null;
    if(!entry||seen.has(record.attachment)||record.sourcePath!==entry.sourcePath||record.sha256!==entry.sha256
      ||!hash(record.sha256)||(record.sopInstanceUID??null)!==(entry.sopInstanceUID??null)
      ||!Array.isArray(record.elements))fail('XMP_METADATA_MAPPING_MISMATCH');
    seen.add(record.attachment);
  }
}

async function digest(bytes,sha256){
  try{
    const value=await sha256(bytes);
    if(!hash(value))fail('XMP_METADATA_HASH_MISMATCH');
    return value.toLowerCase();
  }catch{fail('XMP_METADATA_HASH_MISMATCH');}
}

/**
 * Read PDF.js Metadata (lowercase property names), without parsing XML or loading
 * any resources. getRaw() is PDF.js's extracted/repaired packet string; it is
 * useful to export but is not a claim of byte identity with the PDF stream.
 *
 * PDF.js trims property text. The manifest is compared with the exact supplied
 * UTF-8 attachment after this same edge trim. Full metadata must hash to the
 * separately recorded sidecar SHA-256; only one optional final LF is recovered
 * for compatibility. New creator payloads have no edge whitespace.
 *
 * Absence of full metadata returns inventory:null for legacy sidecar/source
 * fallback only when the manifest does not require it. metadataXmpVersion:1
 * requires all three full-metadata properties, including a matching version and
 * digest. A missing or invalid required inventory always throws a generic error
 * without source values. The caller decides whether to permit other recovery.
 */
export async function readXmpInventory(pdfMetadata,{manifest,manifestBytes,entries,sha256,limits:overrides}={}){
  const limits=bounds(overrides);
  const marker=manifest?.metadataXmpVersion,required=manifest!=null&&Object.hasOwn(manifest,'metadataXmpVersion');
  if(required&&marker!==1)fail('XMP_METADATA_INVALID');
  if(pdfMetadata==null){
    if(required)fail('XMP_METADATA_INVALID');
    return {raw:'',inventory:null,source:'legacy'};
  }
  let raw,inventoryText,metadataText,declaredHash,version;
  try{
    raw=pdfMetadata.getRaw();
    inventoryText=pdfMetadata.get('dicom:inventoryjson');
    metadataText=pdfMetadata.get('dicom:metadatajson');
    declaredHash=pdfMetadata.get('dicom:metadatasha256');
    version=pdfMetadata.get('dicom:metadataversion');
  }catch{fail('XMP_UNREADABLE');}
  raw=textWithin(raw,limits.maxRawBytes,'XMP_UNREADABLE');
  if(required&&(metadataText==null||declaredHash==null||version==null))fail('XMP_METADATA_INVALID');
  const full=metadataText!=null||declaredHash!=null||version!=null||/<\s*dicom:metadata(?:json|sha256|version)[\s>/]/i.test(raw);
  if(inventoryText!=null||full){
    const expected=manifestText(manifestBytes,limits.maxManifestBytes);
    textWithin(inventoryText,limits.maxManifestBytes,'XMP_MANIFEST_MISMATCH');
    if(inventoryText!==expected.trim()||!sameJson(json(expected,'XMP_MANIFEST_MISMATCH'),manifest))fail('XMP_MANIFEST_MISMATCH');
  }
  if(!full)return {raw,inventory:null,source:'legacy'};
  metadataText=textWithin(metadataText,limits.maxMetadataBytes,'XMP_METADATA_INVALID');
  const inventory=json(metadataText,'XMP_METADATA_INVALID');
  checkMappings(inventory,entries,manifest,limits);
  if(version!=null&&version!==String(inventory.schemaVersion))fail('XMP_METADATA_INVALID');
  const expectedHash=manifest?.artifactSha256?.['dicom-metadata.json'];
  if(!hash(expectedHash)||declaredHash!=null&&(!hash(declaredHash)||declaredHash.toLowerCase()!==expectedHash.toLowerCase())
    ||typeof sha256!=='function')fail('XMP_METADATA_HASH_MISMATCH');
  const bytes=new TextEncoder().encode(metadataText);
  let actual=await digest(bytes,sha256);
  if(actual!==expectedHash.toLowerCase()&&bytes.byteLength<limits.maxMetadataBytes){
    const withLf=new Uint8Array(bytes.length+1);withLf.set(bytes);withLf[bytes.length]=10;
    actual=await digest(withLf,sha256);
  }
  if(actual!==expectedHash.toLowerCase())fail('XMP_METADATA_HASH_MISMATCH');
  return {raw,inventory,source:'xmp'};
}
