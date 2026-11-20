import {workingMemoryBytes} from './working-memory.mjs';
import {attachmentBytes} from './pdf-attachments.mjs';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';

const MAX_ORIGINAL = Number.MAX_SAFE_INTEGER;
const MAX_SUPPLEMENT = Number.MAX_SAFE_INTEGER;
const MAX_ORIGINALS = Number.MAX_SAFE_INTEGER;
const MAX_PACKAGE = Number.MAX_SAFE_INTEGER;
const MAX_ARCHIVE = Math.min(0xffffffff,workingMemoryBytes()); // Runtime allocation and ZIP32 offsets.
const MAX_FILES = 65535; // ZIP32 directory field.
const CHUNK = 256 * 1024;

export class OriginalExportError extends Error {
  constructor(code,message) { super(message);this.name='OriginalExportError';this.code=code; }
}
const refuse=(code,message)=>{throw new OriginalExportError(code,message);};
function aborted(signal) {
  if(signal?.aborted)throw new DOMException('Original-file export cancelled.','AbortError');
}
function bytesOf(value) {
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  refuse('INVALID_ATTACHMENT','An embedded file has no readable byte content.');
}
function safePath(value) {
  if(typeof value!=='string'||!value||value.startsWith('/')||/[\\:\x00-\x1f\x7f]/.test(value))
    refuse('INVALID_PATH','An embedded file has an unsafe recovery path.');
  const parts=value.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..')||strToU8(value).length>65535)
    refuse('INVALID_PATH','An embedded file has an unsafe recovery path.');
  return value;
}
function hashShape(value) { return typeof value==='string'&&/^[a-fA-F0-9]{64}$/.test(value); }
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
}
function sameBytes(a,b) {
  if(a.byteLength!==b.byteLength)return false;
  for(let i=0;i<a.byteLength;i++)if(a[i]!==b[i])return false;
  return true;
}
function sourceAttachments(attachments) {
  const result=new Map();
  for(const file of Object.values(attachments||{})) {
    if(!file||typeof file.filename!=='string')refuse('INVALID_ATTACHMENT','The embedded file inventory is invalid.');
    if(result.has(file.filename))refuse('DUPLICATE_ATTACHMENT','More than one embedded file uses the same attachment name.');
    result.set(file.filename,file);
  }
  return result;
}
function selectEntries(entries,scope,selectedIndex) {
  if(!Array.isArray(entries)||!entries.length)refuse('INVALID_INVENTORY','No original files are available to export.');
  if(!['selected','series','study','all'].includes(scope))refuse('INVALID_SCOPE','Choose an original-file export scope.');
  if(scope==='all')return entries;
  if(!Number.isInteger(selectedIndex)||selectedIndex<0||selectedIndex>=entries.length)
    refuse('INVALID_SELECTION','Choose an original file before exporting.');
  const selected=entries[selectedIndex];
  if(scope==='selected')return [selected];
  const series=selected.fields?.SeriesInstanceUID,study=selected.fields?.StudyInstanceUID;
  if(scope==='study'){
    if(typeof study!=='string'||!study.trim())refuse('INVALID_SELECTION','This file has no supplied exam ID. Choose Selected file or All supplied files.');
    return entries.filter(entry=>entry.fields?.StudyInstanceUID===study);
  }
  // A missing Series Instance UID is not evidence that unrelated files form a series.
  if(typeof series!=='string'||!series.trim())return [selected];
  return entries.filter(entry=>entry.fields?.SeriesInstanceUID===series
    && (entry.fields?.StudyInstanceUID||'')===(study||''));
}
function jsonBytes(value) { return strToU8(JSON.stringify(value,null,2)+'\n'); }
const yieldUi=()=>new Promise(resolve=>setTimeout(resolve,0));

/**
 * Recover unchanged files from a PDF package into a portable ZIP.
 * This module has no DOM, filesystem, network, logging or worker creation side effects.
 * It can run in a caller-owned worker under the extension's local-only CSP.
 */
export async function buildOriginalsZip({entries,attachments,manifestBytes=null,scope='all',selectedIndex=0,signal,onProgress}={}) {
  let zip;
  try {
    aborted(signal);
    const selected=selectEntries(entries,scope,selectedIndex),files=sourceAttachments(attachments);
    const names=new Set(),allOriginalNames=new Set(),recoveryPaths={children:new Map()};
    for(const entry of entries) {
      if(!entry||typeof entry.attachment!=='string'||allOriginalNames.has(entry.attachment))
        refuse('INVALID_INVENTORY','The original-file inventory contains an invalid or repeated attachment mapping.');
      allOriginalNames.add(entry.attachment);
    }
    let manifest=null,originalManifest=null;
    if(manifestBytes!==null) {
      originalManifest=bytesOf(manifestBytes).slice();
      if(originalManifest.length>MAX_SUPPLEMENT)refuse('LIMIT_EXCEEDED','The manifest exceeds the export size limit.');
      try {manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(originalManifest));}
      catch {refuse('INVALID_MANIFEST','The package manifest cannot be read.');}
      if(!Array.isArray(manifest.images)||manifest.images.length!==entries.length)
        refuse('MANIFEST_MISMATCH','The original-file inventory differs from its manifest.');
      const recorded=new Map();
      for(const image of manifest.images) {
        if(!image||recorded.has(image.attachment))refuse('MANIFEST_MISMATCH','The manifest contains repeated original-file mappings.');
        recorded.set(image.attachment,image);
      }
      for(const entry of entries) {
        const image=recorded.get(entry.attachment);
        if(!image||entry.sourcePath!==image.sourcePath||entry.sha256!==image.sha256||entry.size!==image.size)
          refuse('MANIFEST_MISMATCH','The original-file inventory differs from its manifest.');
      }
      const embedded=files.get('manifest.json');
      if(embedded&&!sameBytes(await attachmentBytes(embedded),originalManifest))
        refuse('MANIFEST_MISMATCH','The embedded manifest differs from the loaded manifest.');
    }
    const planned=[];let originalTotal=0,payloadTotal=0;
    function plan(name,bytes,expected=null,original=false) {
      safePath(name);
      // Ordinary unzip tools on common desktop filesystems must not overwrite a
      // distinct original because only letter case or Unicode composition differs.
      const collision=name.normalize('NFC').toLowerCase();
      let node=recoveryPaths;
      for(const part of collision.split('/')){
        if(node.file)refuse('DUPLICATE_PATH','A recovery path is used as both a file and a directory; ZIP export was refused.');
        if(!node.children.has(part))node.children.set(part,{children:new Map()});
        node=node.children.get(part);
      }
      if(node.file)refuse('DUPLICATE_PATH','Distinct files collide at the same portable recovery path.');
      if(node.children.size)refuse('DUPLICATE_PATH','A recovery path is used as both a file and a directory; ZIP export was refused.');
      node.file=true;
      if(bytes.length>(original?MAX_ORIGINAL:MAX_SUPPLEMENT))refuse('LIMIT_EXCEEDED','An embedded file exceeds its export size limit.');
      payloadTotal+=bytes.length;
      if(original)originalTotal+=bytes.length;
      if(originalTotal>MAX_ORIGINALS||payloadTotal>MAX_PACKAGE)refuse('LIMIT_EXCEEDED','The selected files exceed the export size limit.');
      planned.push({name,bytes,expected,original});
      if(planned.length>MAX_FILES)refuse('LIMIT_EXCEEDED','Too many embedded files were selected for one ZIP export.');
    }
    const sourceRows=[];
    for(const entry of selected) {
      if(names.has(entry.attachment))refuse('INVALID_INVENTORY','The selected original-file inventory contains a repeated mapping.');
      names.add(entry.attachment);
      const file=files.get(entry.attachment);
      if(!file)refuse('MISSING_ORIGINAL','An original attachment is missing; export was refused.');
      const bytes=await attachmentBytes(file);
      aborted(signal);
      if(!Number.isSafeInteger(entry.size)||entry.size<0||bytes.length!==entry.size)
        refuse('SIZE_MISMATCH','An original file does not match its recorded byte size; export was refused.');
      if(!hashShape(entry.sha256))refuse('INVALID_CHECKSUM','An original file has no valid recorded checksum; export was refused.');
      const relative=safePath(entry.sourcePath);
      plan('originals/'+relative,bytes,entry.sha256.toLowerCase(),true);
      sourceRows.push({attachment:entry.attachment,sourcePath:relative,zipPath:'originals/'+relative,
        sopInstanceUID:entry.sopInstanceUID??null,sha256:entry.sha256.toLowerCase(),size:entry.size});
    }
    const resources=[];
    if(scope==='all')for(const [name,file] of files) {
      if(allOriginalNames.has(name))continue;
      const expected=manifest?.artifactSha256?.[name];
      if(expected!==undefined&&!hashShape(expected))refuse('INVALID_CHECKSUM','A package supplement has an invalid recorded checksum.');
      plan('package/'+safePath(name),await attachmentBytes(file),expected?.toLowerCase()||null);
      aborted(signal);
      resources.push({attachment:name,zipPath:'package/'+name,checksum:expected?'recorded':'not-recorded'});
    }
    // Legacy file/series subsets retain the full manifest as provenance. An
    // exam export omits it to avoid carrying metadata about other exams; the
    // scoped inventory and source-manifest hash provide recovery/provenance.
    if(originalManifest&&scope!=='study'&&(scope!=='all'||!files.has('manifest.json'))) {
      plan('package/manifest.json',originalManifest);
      resources.push({attachment:'manifest.json',zipPath:'package/manifest.json',checksum:'derived-from-loaded-manifest'});
    }
    if(originalManifest) {
      const sidecar=files.get('manifest.sha256');
      if(sidecar) {
        const sidecarBytes=await attachmentBytes(sidecar);
        const expected=await sha256(originalManifest)+'  manifest.json\n';
        if(new TextDecoder('ascii').decode(sidecarBytes)!==expected)
          refuse('MANIFEST_MISMATCH','The manifest checksum sidecar differs; export was refused.');
        if(scope!=='all'&&scope!=='study') {plan('package/manifest.sha256',sidecarBytes);resources.push({attachment:'manifest.sha256',zipPath:'package/manifest.sha256',checksum:'matches-loaded-manifest'});}
      }
    }
    const inventory={schemaVersion:1,scope,completeOriginalInventory:scope==='all',clinicalCompleteness:'not-assessed',
      sourceRole:manifest?.sourceRole??'not supplied',
      originalManifest:originalManifest&&scope!=='study'?'package/manifest.json':null,
      ...(scope==='study'?{sourceManifestSha256:originalManifest?await sha256(originalManifest):null,
        selection:{studyInstanceUID:selected[0].fields.StudyInstanceUID}}:{}),
      originalManifestDescribes:scope==='study'?(originalManifest?'Full input manifest omitted; only its SHA-256 is retained for provenance':'No source manifest supplied')
        :scope==='all'?'All supplied originals in this ZIP':'The full input package; this ZIP intentionally contains only the selected subset',
      originals:sourceRows,packageFiles:resources};
    const recovery=[
      'DICOM original-file recovery ZIP',
      scope==='all'?'This ZIP contains every supplied original file.':'This ZIP contains a selected subset; consult scope.json for the exact included files.',
      'Original files are under originals/ with their supplied relative paths and unchanged bytes.',
      'DICOMDIR-relative File IDs retain their original hierarchy. A subset can have references to files outside this ZIP.',
      'scope.json maps included originals to attachment names, byte sizes and recorded SHA-256 hashes.',
      scope==='study'?(originalManifest?'This exam ZIP omits the full input manifest and package supplements, which can describe other exams. The source manifest SHA-256 is recorded in scope.json.'
        :'This exam ZIP includes only selected originals and recovery instructions. No input manifest was supplied.')
        :'The full input manifest, when present, is retained under package/ as provenance; it can describe originals outside a subset ZIP.',
      'Compare every recovered original against its scope.json SHA-256 before use. Checksums detect disagreement; they do not establish authenticity or clinical completeness.',
      'No source was de-identified, edited or repaired. Keep archival masters and approved de-identified derivatives separate.',
      '',
    ].join('\n');
    plan('scope.json',jsonBytes(inventory));plan('RECOVERY.txt',strToU8(recovery));
    const capacity=payloadTotal+planned.reduce((total,file)=>total+strToU8(file.name).length*2+512,1024);
    if(capacity>MAX_ARCHIVE)refuse('LIMIT_EXCEEDED','This ZIP needs more available browser memory or ZIP64 support.');
    const output=new Uint8Array(capacity);let written=0,packedBytes=0,completed=0,failure=null;
    zip=new Zip((error,chunk)=>{
      if(error){failure=error;return;}
      if(written+chunk.length>output.length){failure=new Error('ZIP output exceeded its planned bound.');return;}
      output.set(chunk,written);written+=chunk.length;
    });
    function progress(phase) {
      onProgress?.({phase,completed,total:planned.length,bytes:packedBytes,totalBytes:payloadTotal,originals:selected.length});
    }
    for(const file of planned) {
      aborted(signal);progress('checking');
      // Snapshot one source at a time. Neither a caller mutation while hashing nor
      // later modification of the attachment array can change already checked bytes.
      const snapshot=file.bytes.slice();
      if(file.expected && await sha256(snapshot)!==file.expected)
        refuse(file.original?'CHECKSUM_MISMATCH':'ARTIFACT_MISMATCH','A recorded checksum does not match; ZIP export was refused.');
      aborted(signal);
      const stream=new ZipPassThrough(file.name);stream.mtime=new Date('2026-01-01T00:00:00Z');zip.add(stream);
      if(!snapshot.length)stream.push(snapshot,true);
      for(let offset=0;offset<snapshot.length;offset+=CHUNK) {
        aborted(signal);const end=Math.min(snapshot.length,offset+CHUNK);
        stream.push(snapshot.subarray(offset,end),end===snapshot.length);packedBytes+=end-offset;
        if(failure)throw failure;
        progress('packing');await yieldUi();
      }
      completed++;progress('packing');
    }
    aborted(signal);zip.end();if(failure)throw failure;
    const filename=scope==='all'?'dicom-originals.zip':scope==='study'?'dicom-originals-exam.zip':scope==='series'?'dicom-originals-series.zip':'dicom-originals-selected.zip';
    return {bytes:output.subarray(0,written),filename,originals:selected.length,files:planned.length,totalBytes:payloadTotal,scope};
  } catch(error) {
    try {zip?.terminate();}catch{}
    if(error?.name==='AbortError'||error instanceof OriginalExportError)throw error;
    throw new OriginalExportError('EXPORT_FAILED','The original-file ZIP export could not be completed.');
  }
}
