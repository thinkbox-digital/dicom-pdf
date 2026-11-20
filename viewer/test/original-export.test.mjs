import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8,strToU8} from 'fflate';
import {buildOriginalsZip,OriginalExportError} from '../original-export.mjs';

const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
async function packageOf(definitions=[
  {path:'SET/DICOMDIR',bytes:strToU8('synthetic directory refers to IMAGES\\IMG00001'),uid:null,series:null},
  {path:'SET/IMAGES/IMG00001',bytes:new Uint8Array([0,1,2,255]),uid:'2.25.1',series:'2.25.10'},
  {path:'SET/IMAGES/IMG00002',bytes:new Uint8Array([7,6,5,4]),uid:'2.25.1',series:'2.25.10'},
  {path:'OTHER/IMAGE001',bytes:new Uint8Array([9,8,7,6]),uid:'2.25.2',series:'2.25.20'},
  {path:'reports/approved report.txt',bytes:strToU8('Synthetic supplied report, unchanged.'),uid:null,series:null},
]) {
  const entries=[],attachments={};
  for(const [index,input] of definitions.entries()){
    const name=`original-${String(index+1).padStart(4,'0')}.dcm`;
    entries.push({attachment:name,sourcePath:input.path,sopInstanceUID:input.uid,sha256:await sha(input.bytes),size:input.bytes.length,
      fields:{...(input.study?{StudyInstanceUID:input.study}:{}),...(input.series?{StudyInstanceUID:input.study||'2.25.100',SeriesInstanceUID:input.series}:{})}});
    attachments['pdfjs-key-'+index]={filename:name,content:input.bytes};
  }
  const recovery=strToU8('Unchanged package recovery instructions.\n');
  const metadata=strToU8('{"synthetic":true}\n');
  const manifest={schemaVersion:2,sourceRole:'archival-master',images:entries,artifactSha256:{'RECOVERY.txt':await sha(recovery),'dicom-metadata.json':await sha(metadata)}};
  const manifestBytes=strToU8(JSON.stringify(manifest));
  attachments.manifest={filename:'manifest.json',content:manifestBytes};
  attachments.sidecar={filename:'manifest.sha256',content:strToU8(await sha(manifestBytes)+'  manifest.json\n')};
  attachments.recovery={filename:'RECOVERY.txt',content:recovery};
  attachments.metadata={filename:'dicom-metadata.json',content:metadata};
  return {entries,attachments,manifestBytes};
}
const failCode=code=>error=>error instanceof OriginalExportError&&error.code===code;
function payload(pack,name){return Object.values(pack.attachments).find(file=>file.filename===name).content;}
function readStoredZip(bytes){
  let total=0;
  return unzipSync(bytes,{filter:({compression,size,originalSize})=>{
    assert.equal(compression,0,'Recovery ZIP entries must be stored');
    assert.equal(size,originalSize,'Stored entry sizes must match');
    total+=size;
    assert.ok(total<=bytes.length,'Stored entries must fit inside the ZIP');
    return true;
  }});
}

test('all-original ZIP keeps every unchanged byte, supplied paths, manifest and supplements',async()=>{
  const pack=await packageOf(),before=new Map(Object.values(pack.attachments).map(file=>[file.filename,file.content.slice()]));
  const progress=[];const result=await buildOriginalsZip({...pack,onProgress:event=>progress.push(event)});
  assert.equal(result.filename,'dicom-originals.zip');assert.equal(result.originals,5);assert.equal(result.scope,'all');
  const recovered=readStoredZip(result.bytes);assert.equal(Object.keys(recovered).length,result.files);
  for(const entry of pack.entries){
    const bytes=recovered['originals/'+entry.sourcePath];assert.deepEqual(bytes,before.get(entry.attachment));assert.equal(await sha(bytes),entry.sha256);
  }
  assert.deepEqual(recovered['package/manifest.json'],pack.manifestBytes);
  assert.deepEqual(recovered['package/RECOVERY.txt'],payload(pack,'RECOVERY.txt'));
  assert.deepEqual(recovered['package/dicom-metadata.json'],payload(pack,'dicom-metadata.json'));
  const inventory=JSON.parse(strFromU8(recovered['scope.json']));assert.equal(inventory.schemaVersion,1);assert.equal(inventory.completeOriginalInventory,true);assert.equal(inventory.clinicalCompleteness,'not-assessed');
  assert.equal(inventory.originals.length,5);assert.match(strFromU8(recovered['RECOVERY.txt']),/unchanged bytes/);
  assert.ok(progress.some(event=>event.phase==='checking'));assert.ok(progress.some(event=>event.phase==='packing'));assert.equal(progress.at(-1).completed,result.files);
  for(const file of Object.values(pack.attachments))assert.deepEqual(file.content,before.get(file.filename),'Export must not mutate attachments');
});

test('DICOMDIR-relative layout and duplicate instance IDs remain distinct',async()=>{
  const pack=await packageOf(),result=await buildOriginalsZip(pack),files=readStoredZip(result.bytes);
  assert.ok(files['originals/SET/DICOMDIR']);assert.ok(files['originals/SET/IMAGES/IMG00001']);assert.ok(files['originals/SET/IMAGES/IMG00002']);
  const scope=JSON.parse(strFromU8(files['scope.json']));const repeated=scope.originals.filter(file=>file.sopInstanceUID==='2.25.1');
  assert.equal(repeated.length,2);assert.notEqual(repeated[0].zipPath,repeated[1].zipPath);
  assert.notDeepEqual(files[repeated[0].zipPath],files[repeated[1].zipPath]);
});

test('selected and series ZIPs explicitly describe subsets without pretending the full manifest is included',async()=>{
  const pack=await packageOf();
  for(const [scope,count] of [['selected',1],['series',2]]){
    const result=await buildOriginalsZip({...pack,scope,selectedIndex:1}),files=readStoredZip(result.bytes),inventory=JSON.parse(strFromU8(files['scope.json']));
    assert.equal(result.originals,count);assert.equal(inventory.completeOriginalInventory,false);assert.equal(inventory.originals.length,count);
    assert.match(inventory.originalManifestDescribes,/only the selected subset/);assert.match(strFromU8(files['RECOVERY.txt']),/references to files outside this ZIP/);
    assert.deepEqual(files['package/manifest.json'],pack.manifestBytes);assert.ok(files['package/manifest.sha256']);
    assert.ok(!files['package/dicom-metadata.json'],'A subset must not imply that unrelated package supplements describe only this subset');
    assert.equal(Object.keys(files).filter(name=>name.startsWith('originals/')).length,count);
  }
});

test('series scope never merges unknown series or the same series ID in another study',async()=>{
  const pack=await packageOf([
    {path:'one.dcm',bytes:new Uint8Array([1]),uid:'2.25.1',series:'2.25.10',study:'2.25.100'},
    {path:'two.dcm',bytes:new Uint8Array([2]),uid:'2.25.2',series:'2.25.10',study:'2.25.200'},
    {path:'unknown-one.dcm',bytes:new Uint8Array([3]),uid:null,series:null},
    {path:'unknown-two.dcm',bytes:new Uint8Array([4]),uid:null,series:null},
  ]);
  assert.equal((await buildOriginalsZip({...pack,scope:'series',selectedIndex:0})).originals,1);
  assert.equal((await buildOriginalsZip({...pack,scope:'series',selectedIndex:2})).originals,1);
});

test('exam scope preserves every supplied series and report in that study, including duplicate IDs',async()=>{
  const pack=await packageOf([
    {path:'exam-a/one.dcm',bytes:new Uint8Array([1]),uid:'2.25.1',series:'2.25.10',study:'2.25.100'},
    {path:'exam-a/two.dcm',bytes:new Uint8Array([2]),uid:'2.25.1',series:'2.25.20',study:'2.25.100'},
    {path:'exam-a/report.dcm',bytes:new Uint8Array([3]),uid:'2.25.3',study:'2.25.100'},
    {path:'exam-b/other.dcm',bytes:new Uint8Array([4]),uid:'2.25.4',series:'2.25.10',study:'2.25.9999'},
    {path:'unassigned.txt',bytes:strToU8('Unassigned supplied text'),uid:null},
  ]);
  const result=await buildOriginalsZip({...pack,scope:'study',selectedIndex:1}),files=readStoredZip(result.bytes);
  assert.equal(result.filename,'dicom-originals-exam.zip');assert.equal(result.originals,3);
  for(const [index,entry] of pack.entries.slice(0,3).entries())assert.deepEqual(files['originals/'+entry.sourcePath],new Uint8Array([index+1]));
  const raw=strFromU8(files['scope.json']),inventory=JSON.parse(raw);
  assert.equal(inventory.scope,'study');assert.equal(inventory.completeOriginalInventory,false);
  assert.deepEqual(inventory.selection,{studyInstanceUID:'2.25.100'});
  assert.equal(inventory.sourceManifestSha256,await sha(pack.manifestBytes));
  assert.equal(inventory.originalManifest,null);assert.deepEqual(inventory.packageFiles,[]);
  assert.equal(Object.keys(files).length,5);assert.equal(raw.includes('2.25.9999'),false);
  assert.equal(Object.keys(files).some(name=>name.startsWith('package/')),false);
  assert.match(strFromU8(files['RECOVERY.txt']),/omits the full input manifest/);
});

test('exam scope refuses unknown exam IDs instead of grouping unrelated originals',async()=>{
  for(const invalid of [undefined,null,'',' ',17]){
    const pack=await packageOf();pack.entries[0].fields.StudyInstanceUID=invalid;
    await assert.rejects(buildOriginalsZip({...pack,scope:'study',selectedIndex:0}),failCode('INVALID_SELECTION'));
  }
});

test('exam recovery without a source manifest does not claim one was retained',async()=>{
  const pack=await packageOf();pack.manifestBytes=null;
  const files=readStoredZip((await buildOriginalsZip({...pack,scope:'study',selectedIndex:1})).bytes);
  const inventory=JSON.parse(strFromU8(files['scope.json']));assert.equal(inventory.sourceManifestSha256,null);
  assert.equal(inventory.originalManifestDescribes,'No source manifest supplied');
  assert.match(strFromU8(files['RECOVERY.txt']),/No input manifest was supplied/);
});

test('source byte changes, size mismatches and missing originals refuse export with generic errors',async()=>{
  let pack=await packageOf();payload(pack,pack.entries[1].attachment)[0]^=255;
  await assert.rejects(buildOriginalsZip(pack),failCode('CHECKSUM_MISMATCH'));
  pack=await packageOf();pack.entries[1].size++;pack.manifestBytes=null;
  await assert.rejects(buildOriginalsZip(pack),failCode('SIZE_MISMATCH'));
  pack=await packageOf();delete pack.attachments['pdfjs-key-1'];
  await assert.rejects(buildOriginalsZip(pack),error=>failCode('MISSING_ORIGINAL')(error)&&!error.message.includes('IMG00001'));
});

test('manifest provenance, checksum sidecar and recorded supplement hashes are independently checked',async()=>{
  let pack=await packageOf();pack.attachments.manifest.content=strToU8('{"changed":true}');
  await assert.rejects(buildOriginalsZip(pack),failCode('MANIFEST_MISMATCH'));
  pack=await packageOf();pack.attachments.sidecar.content=strToU8('0'.repeat(64)+'  manifest.json\n');
  await assert.rejects(buildOriginalsZip(pack),failCode('MANIFEST_MISMATCH'));
  pack=await packageOf();pack.attachments.metadata.content=strToU8('Modified resource');
  await assert.rejects(buildOriginalsZip(pack),failCode('ARTIFACT_MISMATCH'));
});

test('unsafe, aliased and colliding recovery paths are rejected without renaming files',async()=>{
  for(const path of ['../outside.dcm','/absolute.dcm','C:/outside.dcm','folder\\image.dcm','folder//image.dcm','./image.dcm','bad\0name.dcm','bad\nname.dcm']){
    const pack=await packageOf([{path,bytes:new Uint8Array([1]),uid:'2.25.1'}]);
    await assert.rejects(buildOriginalsZip(pack),failCode('INVALID_PATH'));
  }
  for(const paths of [['same.dcm','same.dcm'],['CASE.dcm','case.dcm'],['caf\u00e9.dcm','cafe\u0301.dcm']]){
    const pack=await packageOf(paths.map((path,index)=>({path,bytes:new Uint8Array([index]),uid:'2.25.1'})));
    await assert.rejects(buildOriginalsZip(pack),failCode('DUPLICATE_PATH'));
  }
  const pack=await packageOf();pack.attachments.unsafe={filename:'../outside.json',content:strToU8('{}')};
  await assert.rejects(buildOriginalsZip(pack),failCode('INVALID_PATH'));
});

test('file/directory conflicts fail before packing in either order, including portable aliases',async()=>{
  for(const paths of [['scan','scan/image.dcm'],['SCAN','scan/image.dcm'],['caf\u00e9','cafe\u0301/image.dcm']]){
    for(const ordered of [paths,[...paths].reverse()]){
      const pack=await packageOf(ordered.map((path,index)=>({path,bytes:new Uint8Array([index]),uid:'2.25.1'})));
      let progress=0;
      await assert.rejects(buildOriginalsZip({...pack,onProgress:()=>progress++}),error=>
        failCode('DUPLICATE_PATH')(error)&&error.message.includes('both a file and a directory'));
      assert.equal(progress,0,'No attachment may be packed before hierarchy validation');
    }
  }
});

test('shared parent directories and non-component prefixes recover every original unchanged',async()=>{
  const sources=['scan/a.dcm','scan/b.dcm','scan-extra','scan-extra-files/c.dcm'];
  const pack=await packageOf(sources.map((path,index)=>({path,bytes:new Uint8Array([index]),uid:'2.25.1'})));
  const result=await buildOriginalsZip(pack),files=readStoredZip(result.bytes);
  for(let index=0;index<sources.length;index++)assert.deepEqual(files['originals/'+sources[index]],new Uint8Array([index]));
});

test('cancellation works before and during archive packing',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(buildOriginalsZip({...await packageOf(),signal:controller.signal}),{name:'AbortError'});
  const during=new AbortController(),pack=await packageOf([{path:'large.dcm',bytes:new Uint8Array(1024*1024),uid:'2.25.1'}]);
  await assert.rejects(buildOriginalsZip({...pack,signal:during.signal,onProgress:event=>{if(event.phase==='packing'&&event.bytes>0)during.abort();}}),{name:'AbortError'});
});

test('source snapshots prevent caller mutation while hashing from changing recovered bytes',async()=>{
  const pack=await packageOf([{path:'image.dcm',bytes:new Uint8Array([1,2,3,4]),uid:'2.25.1'}]),expected=payload(pack,pack.entries[0].attachment).slice();
  const result=await buildOriginalsZip({...pack,onProgress:event=>{if(event.phase==='packing')payload(pack,pack.entries[0].attachment).fill(99);}});
  assert.deepEqual(readStoredZip(result.bytes)['originals/image.dcm'],expected);
});

test('invalid scopes, selections, missing checksums and oversized sources fail before packing',async()=>{
  const pack=await packageOf();await assert.rejects(buildOriginalsZip({...pack,scope:'patient'}),failCode('INVALID_SCOPE'));
  await assert.rejects(buildOriginalsZip({...pack,scope:'selected',selectedIndex:-1}),failCode('INVALID_SELECTION'));
  const noHash=await packageOf();noHash.entries[0].sha256='invalid';noHash.manifestBytes=null;
  await assert.rejects(buildOriginalsZip(noHash),failCode('INVALID_CHECKSUM'));
  const huge=new Uint8Array(128*1024*1024+1),large={entries:[{attachment:'original.dcm',sourcePath:'large.dcm',size:huge.length,sha256:'0'.repeat(64)}],attachments:{original:{filename:'original.dcm',content:huge}}};
  await assert.rejects(buildOriginalsZip(large),failCode('CHECKSUM_MISMATCH'));
});
