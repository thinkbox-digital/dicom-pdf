import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {zipSync,deflateSync,strToU8,Zip,ZipPassThrough} from 'fflate';
import {ingestInputs,INPUT_LIMITS,InputIngestionError} from '../input-ingestion.mjs';

const fixture=async path=>new Uint8Array(await readFile(new URL('../../fixtures/'+path,import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=(name,bytes,extra={})=>({name,bytes,...extra});
const concat=(...parts)=>{const bytes=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;};
function element(hex,vr,value){
  let data=typeof value==='string'?strToU8(value):value;
  if(data.length%2)data=concat(data,new Uint8Array([vr==='UI'?0:32]));
  const long=['OB','OW','SQ','UN','UT'].includes(vr),header=new Uint8Array(long?12:8),view=new DataView(header.buffer);
  view.setUint16(0,parseInt(hex.slice(0,4),16),true);view.setUint16(2,parseInt(hex.slice(4),16),true);
  header[4]=vr.charCodeAt(0);header[5]=vr.charCodeAt(1);if(long)view.setUint32(8,data.length,true);else view.setUint16(6,data.length,true);
  return concat(header,data);
}
const us=(hex,value)=>element(hex,'US',new Uint8Array([value&255,value>>>8]));
function dicom({syntax='1.2.840.10008.1.2.1',sop='1.2.840.10008.5.1.4.1.1.7',uid='2.25.123',study='2.25.1',series='2.25.2',pixels=true,extra=[],meta=true}={}){
  const dataset=concat(element('00080016','UI',sop),element('00080018','UI',uid),element('00080060','CS','OT'),
    ...(study?[element('0020000d','UI',study)]:[]),...(series?[element('0020000e','UI',series)]:[]),
    ...(pixels?[us('00280002',1),element('00280004','CS','MONOCHROME2'),us('00280010',1),us('00280011',2),us('00280100',8),us('00280101',8),us('00280102',7),us('00280103',0)]:[]),
    ...extra,...(pixels?[element('7fe00010','OB',new Uint8Array([10,240]))]:[]));
  if(!meta)return dataset;
  const prefix=new Uint8Array(132);prefix.set(strToU8('DICM'),128);
  return concat(prefix,element('00020002','UI',sop),element('00020010','UI',syntax),syntax==='1.2.840.10008.1.2.1.99'?deflateSync(dataset):dataset);
}
function directory(fileId,{target='2.25.123',active=0xffff}={}){
  const record=concat(us('00041410',active),element('00041430','CS','IMAGE'),element('00041500','CS',fileId),element('00041511','UI',target));
  const item=new Uint8Array(8),view=new DataView(item.buffer);view.setUint16(0,0xfffe,true);view.setUint16(2,0xe000,true);view.setUint32(4,record.length,true);
  return dicom({sop:'1.2.840.10008.1.3.10',pixels:false,study:null,series:null,extra:[element('00041220','SQ',concat(item,record))]});
}
const code=expected=>error=>error instanceof InputIngestionError&&error.code===expected;
function centralOffset(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);return view.getUint32(bytes.length-6,true);}
function streamedZip(records){
  const chunks=[];let failure;
  const zip=new Zip((error,bytes)=>{if(error)failure=error;else chunks.push(bytes);});
  for(const [name,bytes] of records){const file=new ZipPassThrough(name);zip.add(file);file.push(bytes,true);}zip.end();if(failure)throw failure;
  return concat(...chunks);
}

test('direct source inventory distinguishes preservation PDFs and keeps exact source bytes and metadata',async()=>{
  const bytes=await fixture('expanded/ct-explicit-le-16.dcm'),result=await ingestInputs([input('image',bytes,{sourcePath:'MEDIA/IMAGE0001'})]);
  assert.equal(result.inputKind,'direct-dicom');assert.equal(result.preservationStatus,'not-a-preservation-pdf');assert.equal(result.entries.length,1);
  const entry=result.entries[0];assert.equal(entry.sourcePath,'MEDIA/IMAGE0001');assert.equal(entry.kind,'dicom-image');assert.equal(entry.status,'unrendered');
  assert.equal(entry.displayEligibility.status,'candidate');assert.equal(entry.parsing.pixelPayloadDecoded,false);assert.equal(entry.fields.Modality,'CT');
  assert.equal(entry.fields.TransferSyntaxUID,'1.2.840.10008.1.2.1');assert.equal(entry.sha256,sha(bytes));assert.equal(entry.size,bytes.length);
  assert.deepEqual(result.attachments[entry.attachment].content,bytes);assert.equal(result.totals.originalBytes,bytes.length);assert.equal(result.totals.expandedBytes,bytes.length);
});

test('File/Blob-like and worker-safe inputs normalize identically without depending on filename extensions',async()=>{
  const bytes=dicom(),file={name:'IMAGE0001',webkitRelativePath:'CD/IMAGES/IMAGE0001',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer};
  const fromFile=await ingestInputs([file]),fromWorker=await ingestInputs([input('ignored',bytes,{sourcePath:file.webkitRelativePath})]);
  assert.deepEqual(fromFile.entries,fromWorker.entries);assert.deepEqual(fromFile.attachments,fromWorker.attachments);
});

test('caller buffers are snapshotted before asynchronous hashing and remain independently recoverable',async()=>{
  const buffer=Buffer.from(dicom()),before=Uint8Array.from(buffer),promise=ingestInputs([input('image.dcm',buffer)]);buffer.fill(0);
  const result=await promise,entry=result.entries[0];assert.equal(entry.sha256,sha(before));assert.deepEqual(result.attachments[entry.attachment].content,before);
});

test('loose folder and ZIP of the same DICOMDIR media retain identical image fields and reference trees',async()=>{
  const files={'MEDIA/DICOMDIR':await fixture('spec-directory/DICOMDIR'),'MEDIA/IMAGES/IMG00001':await fixture('spec-directory/IMAGES/IMG00001')};
  const loose=await ingestInputs(Object.entries(files).map(([name,bytes])=>input(name,bytes)));
  const packed=zipSync(files),zipped=await ingestInputs([input('download.zip',packed)]);
  assert.deepEqual(zipped.entries.map(entry=>({sourcePath:entry.sourcePath,fields:entry.fields,sha256:entry.sha256})),loose.entries.map(entry=>({sourcePath:entry.sourcePath,fields:entry.fields,sha256:entry.sha256})));
  for(const result of [loose,zipped]){
    assert.equal(result.references.length,1);assert.equal(result.references[0].status,'resolved');assert.deepEqual(result.references[0].fileId,['IMAGES','IMG00001']);
    assert.equal(result.references[0].targetSourcePath,'MEDIA/IMAGES/IMG00001');assert.match(result.entries[0].directoryInventoryScope,/offset graph not validated/);
  }
  assert.equal(zipped.containers.length,1);assert.equal(zipped.containers[0].status,'expanded');
  assert.deepEqual(zipped.attachments[zipped.containers[0].attachment].content,packed);assert.equal(zipped.containers[0].sha256,sha(packed));
});

test('nested ZIP containers and every leaf stay separately recoverable with actual member paths and ancestry',async()=>{
  const image=dicom(),inner=zipSync({'DICOMDIR':directory('IMAGES\\IMG00001'),'IMAGES/IMG00001':image});
  const outer=zipSync({'nested/study.zip':inner,'NOTES.txt':strToU8('Synthetic supplied notes')});
  const model=await ingestInputs([input('outer.zip',outer)]);assert.equal(model.containers.length,2);assert.equal(model.entries.length,3);
  assert.equal(model.containers[1].origin.container,model.containers[0].attachment);assert.equal(model.containers[1].sourcePath,'nested/study.zip');
  assert.equal(model.references[0].status,'resolved');assert.equal(model.entries[0].origin.container,model.containers[1].attachment);
  assert.deepEqual(model.attachments[model.containers[0].attachment].content,outer);assert.deepEqual(model.attachments[model.containers[1].attachment].content,inner);
  assert.equal(model.totals.containerBytes,outer.length+inner.length);assert.equal(model.totals.compressedBytes,outer.length+inner.length);
  assert.equal(model.totals.expandedBytes,inner.length+strToU8('Synthetic supplied notes').length+directory('IMAGES\\IMG00001').length+image.length);
});

test('streaming data-descriptor ZIPs preserve duplicate member names instead of overwriting either original',async()=>{
  const one=dicom({uid:'2.25.11'}),two=dicom({uid:'2.25.12'}),archive=streamedZip([['IMAGE',one],['IMAGE',two]]);
  const result=await ingestInputs([input('media.zip',archive)]);assert.equal(result.entries.length,2);
  assert.notEqual(result.entries[0].attachment,result.entries[1].attachment);
  assert.deepEqual(result.attachments[result.entries[0].attachment].content,one);assert.deepEqual(result.attachments[result.entries[1].attachment].content,two);
  assert.equal(result.diagnostics.filter(issue=>issue.code==='DUPLICATE_PORTABLE_PATH').length,1);
  assert.ok(result.entries.every(entry=>entry.diagnostics.some(issue=>issue.code==='DUPLICATE_PORTABLE_PATH')));
});

test('case and Unicode portability collisions and duplicate instance UIDs remain distinct source records',async()=>{
  const image=dicom(),result=await ingestInputs([input('IMAGE',image),input('image',image),input('Caf\u00e9',image),input('Cafe\u0301',image)]);
  assert.equal(result.entries.length,4);assert.equal(Object.keys(result.attachments).length,4);
  assert.equal(result.diagnostics.filter(issue=>issue.code==='DUPLICATE_PORTABLE_PATH').length,2);
  assert.equal(result.diagnostics.filter(issue=>issue.code==='DUPLICATE_SOP_INSTANCE_UID').length,1);
  assert.deepEqual(result.entries.map(entry=>entry.sourcePath),['IMAGE','image','Caf\u00e9','Cafe\u0301']);
});

test('raw explicit/implicit little and explicit big endian datasets record only a parsing assumption',async()=>{
  for(const file of ['expanded/ct-explicit-le-16.dcm','expanded/mr-implicit-le-16.dcm','expanded/ct-explicit-be-16.dcm']){
    const bytes=await fixture(file),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),end=144+view.getUint32(140,true),raw=bytes.slice(end);
    const source=await ingestInputs([input('extensionless',raw)]),entry=source.entries[0];
    assert.equal(entry.kind,'dicom-image',file);assert.equal(entry.parsing.mode,'raw-dataset');assert.equal(entry.parsing.transferSyntaxSource,'assumption');
    assert.equal(entry.fields.TransferSyntaxUID,undefined);assert.equal(entry.sopInstanceUID,entry.fields.SOPInstanceUID);
    assert.ok(entry.diagnostics.some(issue=>issue.code==='ASSUMED_RAW_TRANSFER_SYNTAX'));
    assert.deepEqual(source.attachments[entry.attachment].content,raw);
  }
});

test('file meta without the preamble retains its actual transfer syntax independently of raw assumptions',async()=>{
  const bytes=(await fixture('expanded/ct-explicit-le-16.dcm')).slice(132),result=await ingestInputs([input('no-prefix',bytes)]),entry=result.entries[0];
  assert.equal(entry.kind,'dicom-image');assert.equal(entry.parsing.mode,'file-meta-without-preamble');assert.equal(entry.parsing.transferSyntaxSource,'file-meta');
  assert.equal(entry.fields.TransferSyntaxUID,'1.2.840.10008.1.2.1');assert.deepEqual(result.attachments[entry.attachment].content,bytes);
});

test('deflated Part10 input is parsed locally without changing its compressed archival bytes',async()=>{
  const bytes=await fixture('expanded/ct-deflated-16.dcm'),model=await ingestInputs([input('image.dcm',bytes)]),entry=model.entries[0];
  assert.equal(entry.kind,'dicom-image');assert.equal(entry.displayEligibility.status,'candidate');assert.equal(entry.fields.TransferSyntaxUID,'1.2.840.10008.1.2.1.99');
  assert.deepEqual(model.attachments[entry.attachment].content,bytes);
});

test('unsupported image encoding, non-image SR, segmentation and unreadable sources are labeled and retained',async()=>{
  const inputs=[input('syntax',dicom({syntax:'1.2.3.4'})),input('report',dicom({sop:'1.2.840.10008.5.1.4.1.1.88.11',pixels:false})),
    input('seg',dicom({sop:'1.2.840.10008.5.1.4.1.1.66.4'})),input('corrupt.dcm',dicom().slice(0,-1)),input('empty',new Uint8Array())];
  const result=await ingestInputs(inputs);
  assert.equal(result.entries[0].displayEligibility.status,'unsupported');assert.ok(result.entries[0].displayEligibility.codes.includes('UNSUPPORTED_TRANSFER_SYNTAX'));
  assert.equal(result.entries[1].kind,'dicom-object');assert.equal(result.entries[1].displayEligibility.status,'not-image');
  assert.ok(result.entries[2].displayEligibility.codes.includes('UNSUPPORTED_OBJECT_TYPE'));assert.equal(result.entries[3].kind,'unreadable');assert.equal(result.entries[4].kind,'other');
  for(const [index,entry] of result.entries.entries())assert.deepEqual(result.attachments[entry.attachment].content,inputs[index].bytes);
});

test('untrusted HTML, arbitrary binary and filenames never execute or invent DICOM metadata',async()=>{
  const html=strToU8('<script>globalThis.__ingestionExecuted=true</script>'),result=await ingestInputs([input('BRAIN_MRI_20261115_HOSPITAL.html',html),input('binary',new Uint8Array(512).fill(255))]);
  assert.equal(globalThis.__ingestionExecuted,undefined);
  for(const entry of result.entries){assert.equal(entry.kind,'other');assert.deepEqual(entry.fields,{});assert.equal(entry.sopInstanceUID,undefined);}
});

test('selected UTF-8 fields keep their actual values and unsupported character sets are explicitly omitted',async()=>{
  const image=dicom({extra:[element('00080005','CS','ISO_IR 192'),element('00100010','PN','Synthetic^\u00e9\u6f22')]});
  let entry=(await ingestInputs([input('image',image)])).entries[0];assert.equal(entry.fields.PatientName,'Synthetic^\u00e9\u6f22');assert.equal(entry.fieldEncodings.PatientName,'UTF-8');
  entry=(await ingestInputs([input('image',dicom({extra:[element('00080005','CS','UNSUPPORTED'),element('00100010','PN','Name')]}))])).entries[0];
  assert.equal(entry.fields.PatientName,undefined);assert.ok(entry.diagnostics.some(issue=>issue.code==='UNSUPPORTED_CHARACTER_SET'&&issue.field==='PatientName'));
});

test('DICOMDIR resolves only actual same-container File IDs and reports missing, duplicate and mismatched identities separately',async()=>{
  let result=await ingestInputs([input('DICOMDIR',directory('IMAGES\\IMG00002')),input('IMAGES/IMG00001',dicom())]);
  assert.equal(result.references[0].status,'missing');
  result=await ingestInputs([input('DICOMDIR',directory('IMAGES\\IMG00001')),input('IMAGES/IMG00001',dicom()),input('IMAGES/IMG00001',dicom())]);
  assert.equal(result.references[0].status,'ambiguous');assert.equal(result.references[0].targetAttachments.length,2);
  result=await ingestInputs([input('DICOMDIR',directory('IMAGES\\IMG00001')),input('IMAGES/IMG00001',dicom({uid:'2.25.999'}))]);
  assert.equal(result.references[0].status,'identity-mismatch');
  result=await ingestInputs([input('DICOMDIR',directory('IMAGES\\..')),input('IMAGES/IMG00001',dicom())]);assert.equal(result.references[0].status,'invalid-file-id');
  result=await ingestInputs([input('DICOMDIR',directory('IMAGES\\MISSING',{active:0}))]);assert.equal(result.references[0].status,'inactive');
});

test('DICOMDIR never resolves to a coincidentally named file in a different archive namespace',async()=>{
  const result=await ingestInputs([input('one.zip',zipSync({'DICOMDIR':directory('IMAGE')})),input('two.zip',zipSync({'IMAGE':dicom()}))]);
  assert.equal(result.references[0].status,'missing');assert.equal(result.entries.length,2);
});

test('unsafe loose and ZIP recovery paths reject atomically without sanitizing or renaming them',async()=>{
  for(const name of ['../escape','/absolute','C:/absolute','folder\\file','AUX.txt','folder/name.','folder/name ','folder//name']){
    await assert.rejects(ingestInputs([input(name,new Uint8Array([1]))]),code('UNSAFE_PATH'),name);
    await assert.rejects(ingestInputs([input('unsafe.zip',zipSync({[name]:strToU8('source')}))]),code('UNSAFE_PATH'),name);
  }
});

test('encrypted, symlink and unsupported-method ZIPs retain their archive bytes with explicit unsupported diagnostics',async()=>{
  for(const feature of ['encrypted','symlink','method']){
    const bytes=zipSync({'FILE':strToU8('original')},{level:0}),central=centralOffset(bytes),view=new DataView(bytes.buffer);
    if(feature==='encrypted'){view.setUint16(central+8,view.getUint16(central+8,true)|1,true);view.setUint16(6,view.getUint16(6,true)|1,true);}
    if(feature==='symlink')view.setUint32(central+38,0xa1ff0000,true);
    if(feature==='method'){view.setUint16(central+10,99,true);view.setUint16(8,99,true);}
    const result=await ingestInputs([input('archive.zip',bytes)]);assert.equal(result.entries.length,0);assert.equal(result.containers[0].status,'unsupported');
    assert.ok(result.containers[0].diagnostics.some(issue=>issue.code==='ZIP_UNSUPPORTED'));assert.deepEqual(result.attachments[result.containers[0].attachment].content,bytes);
  }
});

test('corrupt CRC, truncated ZIP and false expanded sizes never emit misleading derived originals',async()=>{
  const stored=zipSync({'FILE':strToU8('original')},{level:0}),crc=stored.slice();crc[30+4]^=1;
  const size=zipSync({'FILE':new Uint8Array(4096).fill(1)}),central=centralOffset(size),view=new DataView(size.buffer);
  view.setUint32(central+24,1,true);view.setUint32(22,1,true);
  for(const bytes of [crc,stored.slice(0,-4),size]){
    const result=await ingestInputs([input('archive.zip',bytes)]);assert.equal(result.entries.length,0);assert.equal(result.containers[0].status,'unreadable');
    assert.deepEqual(result.attachments[result.containers[0].attachment].content,bytes);
  }
});

test('limits are pinned, may only tighten, and reject oversized declarations before reading input bytes',async()=>{
  let read=false;const file={name:'huge',size:INPUT_LIMITS.maxFileBytes+1,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}};
  await assert.rejects(ingestInputs([file]),code('LIMIT_EXCEEDED'));assert.equal(read,false);
  await assert.rejects(ingestInputs([input('file',new Uint8Array(4))],{limits:{maxFileBytes:3}}),code('LIMIT_EXCEEDED'));
  await assert.rejects(ingestInputs([input('file',new Uint8Array(4))],{limits:{maxFiles:Number.MAX_SAFE_INTEGER+1}}),code('INVALID_INPUT'));
  await assert.rejects(ingestInputs([input('file',new Uint8Array(4))],{limits:{invented:3}}),code('INVALID_INPUT'));
  await assert.rejects(ingestInputs([]),code('INVALID_INPUT'));
});

test('expanded totals, compression ratios, materialized file counts and nested archive depth are bounded before inflation',async()=>{
  const archive=zipSync({'ONE':strToU8('12345'),'TWO':strToU8('67890')},{level:0});
  await assert.rejects(ingestInputs([input('archive.zip',archive)],{limits:{maxExpandedBytes:9}}),code('LIMIT_EXCEEDED'));
  await assert.rejects(ingestInputs([input('archive.zip',archive)],{limits:{maxFiles:2}}),code('LIMIT_EXCEEDED'));
  await assert.rejects(ingestInputs([input('archive.zip',archive)],{limits:{maxCompressedBytes:archive.length-1}}),code('LIMIT_EXCEEDED'));
  await assert.rejects(ingestInputs([input('bomb.zip',zipSync({'ZERO':new Uint8Array(20000)}))]),code('LIMIT_EXCEEDED'));
  const inner=zipSync({'FILE':strToU8('source')}),outer=zipSync({'inner.zip':inner});
  await assert.rejects(ingestInputs([input('outer.zip',outer)],{limits:{maxArchiveDepth:1}}),code('LIMIT_EXCEEDED'));
});

test('CVE-2026-122146-shaped ZIP size declarations are rejected before a large allocation',async()=>{
  const Native=globalThis.Uint8Array,requests=[];
  const archives=[1024*1024*1024,0xfffffffe].map(size=>{
    const bytes=zipSync({'FILE':strToU8('small actual payload')}),view=new DataView(bytes.buffer),central=centralOffset(bytes);
    view.setUint32(22,size,true);view.setUint32(central+24,size,true);return bytes;
  });
  globalThis.Uint8Array=new Proxy(Native,{construct(target,args){
    if(typeof args[0]==='number'&&args[0]>=64*1024*1024){requests.push(args[0]);throw new Error('Unexpected large ZIP allocation');}
    return Reflect.construct(target,args);
  }});
  try{
    for(const archive of archives)await assert.rejects(ingestInputs([input('declared-size.zip',archive)]),code('LIMIT_EXCEEDED'));
    assert.deepEqual(requests,[]);
  }finally{globalThis.Uint8Array=Native;}
});

test('retained archive and leaf bytes share the recovery budget even when separate compressed and expanded limits pass',async()=>{
  const leaf=strToU8('retained original'),archive=zipSync({'FILE':leaf},{level:0});
  const cap=archive.length+leaf.length-1;
  assert.ok(archive.length<cap&&leaf.length<cap);
  await assert.rejects(ingestInputs([input('media.zip',archive)],{limits:{maxRetainedBytes:cap}}),code('LIMIT_EXCEEDED'));
  const accepted=await ingestInputs([input('media.zip',archive)],{limits:{maxRetainedBytes:cap+1}});
  assert.equal(accepted.totals.retainedBytes,archive.length+leaf.length);
  let read=false;
  await assert.rejects(ingestInputs([input('first',new Uint8Array(32)),{name:'second',size:2,arrayBuffer:async()=>{read=true;return new ArrayBuffer(2);}}],{limits:{maxRetainedBytes:33}}),code('LIMIT_EXCEEDED'));
  assert.equal(read,false,'retained-byte breach must be detected before reading or copying the next input');
});

test('deep, excessive and invalid-length DICOM metadata stays a recoverable unreadable source',async()=>{
  let nested=element('00080016','UI','2.25.1');
  for(let depth=0;depth<6;depth++){
    const item=new Uint8Array(8),view=new DataView(item.buffer);view.setUint16(0,0xfffe,true);view.setUint16(2,0xe000,true);view.setUint32(4,nested.length,true);
    nested=element('00081115','SQ',concat(item,nested));
  }
  const deep=dicom({extra:[nested]}),result=await ingestInputs([input('deep',deep)],{limits:{maxMetadataDepth:2}});
  assert.equal(result.entries[0].kind,'unreadable');assert.ok(result.entries[0].diagnostics.some(issue=>issue.code==='METADATA_LIMIT'));
  const excessive=await ingestInputs([input('many',dicom())],{limits:{maxMetadataElements:2}});assert.equal(excessive.entries[0].displayEligibility.codes[0],'METADATA_LIMIT');
  assert.deepEqual(result.attachments[result.entries[0].attachment].content,deep);
});

test('defined pixel bytes are skipped while valid and excessive trailing metadata are still preflighted',async()=>{
  const original=dicom(),valid=concat(original,element('fffcfffc','OB',new Uint8Array([0,0])));
  const accepted=await ingestInputs([input('valid-after-pixel',valid)],{limits:{maxMetadataElements:20}});
  assert.equal(accepted.entries[0].kind,'dicom-image');assert.equal(accepted.entries[0].sha256,sha(valid));
  const excessive=concat(original,...Array.from({length:30},()=>element('fffcfffc','OB',new Uint8Array([0,0]))));
  const rejected=await ingestInputs([input('excessive-after-pixel',excessive)],{limits:{maxMetadataElements:20}});
  assert.equal(rejected.entries[0].kind,'unreadable');assert.equal(rejected.entries[0].displayEligibility.codes[0],'METADATA_LIMIT');
  assert.deepEqual(rejected.attachments[rejected.entries[0].attachment].content,excessive);
});

test('encapsulated pixel fragments are length-bounded and trailing metadata cannot bypass preflight limits',async()=>{
  const prefix=dicom({syntax:'1.2.840.10008.1.2.4.50'}).slice(0,-14);
  const pixel=new Uint8Array([0xe0,0x7f,0x10,0,79,66,0,0,255,255,255,255]);
  const fragment=(length,bytes=new Uint8Array())=>{
    const header=new Uint8Array(8),view=new DataView(header.buffer);view.setUint16(0,0xfffe,true);view.setUint16(2,0xe000,true);view.setUint32(4,length,true);return concat(header,bytes);
  };
  const delimiter=new Uint8Array([0xfe,0xff,0xdd,0xe0,0,0,0,0]);
  const valid=concat(prefix,pixel,fragment(0),fragment(2,new Uint8Array([255,216])),delimiter,element('fffcfffc','OB',new Uint8Array([0,0])));
  assert.equal((await ingestInputs([input('encapsulated',valid)])).entries[0].kind,'dicom-image');
  const excessive=concat(valid,...Array.from({length:30},()=>element('fffcfffc','OB',new Uint8Array([0,0]))));
  assert.equal((await ingestInputs([input('trailing',excessive)],{limits:{maxMetadataElements:20}})).entries[0].displayEligibility.codes[0],'METADATA_LIMIT');
  for(const bad of [concat(prefix,pixel,fragment(0),fragment(0xffffffff),delimiter),concat(prefix,pixel,fragment(0),fragment(1,new Uint8Array([1])),delimiter),concat(prefix,pixel,fragment(0),fragment(2,new Uint8Array([1,2])))]){
    const model=await ingestInputs([input('malformed-fragments',bad)]);assert.equal(model.entries[0].displayEligibility.codes[0],'INVALID_DICOM');
    assert.deepEqual(model.attachments[model.entries[0].attachment].content,bad);
  }
});

test('deflated DICOM expansion is bounded before recursive metadata parsing and originals remain available',async()=>{
  const bytes=dicom({syntax:'1.2.840.10008.1.2.1.99',extra:[element('00111010','OB',new Uint8Array(32768))]});
  const result=await ingestInputs([input('image',bytes)],{limits:{maxInflatedDicomBytes:1024}});
  assert.equal(result.entries[0].kind,'unreadable');assert.ok(result.entries[0].diagnostics.some(issue=>issue.code==='METADATA_LIMIT'));
  assert.deepEqual(result.attachments[result.entries[0].attachment].content,bytes);
});

test('encapsulated document bulk bytes are not mistaken for metadata while large text remains bounded',async()=>{
  const bulk=dicom({sop:'1.2.840.10008.5.1.4.1.1.104.1',pixels:false,extra:[element('00420011','OB',new Uint8Array(4096)),element('00420012','LO','application/pdf')]});
  const source=await ingestInputs([input('document',bulk)],{limits:{maxMetadataBytes:256}});
  assert.equal(source.entries[0].kind,'dicom-object');assert.equal(source.entries[0].displayEligibility.status,'not-image');
  assert.deepEqual(source.attachments[source.entries[0].attachment].content,bulk);
  const text=dicom({pixels:false,extra:[element('0040a160','UT','a'.repeat(4096))]});
  const bounded=await ingestInputs([input('text',text)],{limits:{maxMetadataBytes:256}});assert.equal(bounded.entries[0].displayEligibility.codes[0],'METADATA_LIMIT');
});

test('cancellation works before reading, during archive progress and cooperatively between input files',async()=>{
  let controller=new AbortController();controller.abort();
  await assert.rejects(ingestInputs([input('image',dicom())],{signal:controller.signal}),{name:'AbortError'});
  controller=new AbortController();
  await assert.rejects(ingestInputs([input('archive.zip',zipSync({'IMAGE':dicom()}))],{signal:controller.signal,onProgress:event=>{if(event.phase==='expanding')controller.abort();}}),{name:'AbortError'});
  controller=new AbortController();let callbacks=0;setTimeout(()=>controller.abort(),0);
  await assert.rejects(ingestInputs(Array.from({length:100},(_,index)=>input('IMAGE'+index,dicom())),{signal:controller.signal,onProgress:()=>{callbacks++;}}),{name:'AbortError'});
  assert.ok(callbacks<100);
});

test('progress exposes counts and phases without source names or patient metadata',async()=>{
  const progress=[];await ingestInputs([input('PERSONAL_NAME.dcm',dicom())],{onProgress:event=>progress.push(event)});
  assert.equal(progress.at(-1).phase,'complete');assert.ok(progress.every(event=>Object.keys(event).sort().join(',')==='archives,bytes,completed,phase'));
  assert.ok(!JSON.stringify(progress).includes('PERSONAL_NAME'));
});
