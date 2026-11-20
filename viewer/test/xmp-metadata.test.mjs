import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readXmpInventory,XMP_LIMITS,XmpMetadataError} from '../xmp-metadata.mjs';

const encode=value=>new TextEncoder().encode(value);
const sha256=async bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHash='a'.repeat(64);

async function fixture({schemaVersion=1,ending='',mutateRecord,duplicateIds=false}={}){
  const entries=[
    {attachment:'source-001.dcm',sourcePath:'study/image-1',sha256:sourceHash,sopInstanceUID:'2.25.1001'},
    {attachment:'source-002.dcm',sourcePath:'study/image-2',sha256:'b'.repeat(64),sopInstanceUID:duplicateIds?'2.25.1001':null}
  ];
  const inventory={schemaVersion,images:entries.map(entry=>({...entry,status:'readable',reason:null,elements:[
    {path:'dataset/(0010,0010)',tag:'(0010,0010)',keyword:'PatientName',vr:'PN',value:'Synthetic^Zoë^王 <script>window.bad=true</script>',encoding:'dicom-value-string'},
    {path:'dataset/(7FE0,0010)',tag:'(7FE0,0010)',keyword:'PixelData',vr:'OW',value:null,encoding:'omitted-pixel-data'}
  ]}))};
  mutateRecord?.(inventory.images,inventory);
  const metadataText=JSON.stringify(inventory)+ending;
  const expectedHash=await sha256(encode(metadataText));
  const manifest={schemaVersion:2,profile:'dicom-images',images:entries.map(entry=>({...entry})),artifactSha256:{'dicom-metadata.json':expectedHash}};
  const manifestText=JSON.stringify(manifest,null,2)+'\n';
  const properties=new Map([
    ['dicom:inventoryjson',manifestText.trim()],['dicom:metadatajson',metadataText.trim()],
    ['dicom:metadatasha256',expectedHash],['dicom:metadataversion',String(schemaVersion)]
  ]);
  let raw='<x:xmpmeta><rdf:RDF><rdf:Description><dicom:metadataJson>synthetic</dicom:metadataJson></rdf:Description></rdf:RDF></x:xmpmeta>';
  const metadata={getRaw:()=>raw,get:name=>properties.get(name)??null};
  const options={entries,manifest,manifestBytes:encode(manifestText),sha256};
  return {entries,inventory,metadataText,properties,metadata,options,setRaw:value=>{raw=value;}};
}

const rejectsCode=(action,code)=>assert.rejects(action,error=>error instanceof XmpMetadataError&&error.code===code&&!error.message.includes('Synthetic'));
function setMarker(f,value){
  f.options.manifest.metadataXmpVersion=value;
  const text=JSON.stringify(f.options.manifest);
  f.options.manifestBytes=encode(text);f.properties.set('dicom:inventoryjson',text);
}

test('reads a full inventory with literal Unicode/inert text and exact source mapping',async()=>{
  const f=await fixture(),result=await readXmpInventory(f.metadata,f.options);
  assert.equal(result.source,'xmp');assert.equal(result.raw,f.metadata.getRaw());assert.deepEqual(result.inventory,f.inventory);
  assert.match(result.inventory.images[0].elements[0].value,/Zoë\^王 <script>/);
  assert.equal(result.inventory.images[0].elements[1].value,null);
});

test('accepts schema 2 and duplicate SOP IDs as independent attachment records',async()=>{
  const f=await fixture({schemaVersion:2,duplicateIds:true});
  assert.deepEqual((await readXmpInventory(f.metadata,f.options)).inventory,f.inventory);
});

test('PDF.js edge trim preserves exact manifest comparison and one final sidecar LF',async()=>{
  const f=await fixture({ending:'\n'});
  assert.equal((await readXmpInventory(f.metadata,f.options)).source,'xmp');
});

test('genuine legacy absence returns null and retains the packet for export',async()=>{
  const f=await fixture();for(const name of ['dicom:metadatajson','dicom:metadatasha256','dicom:metadataversion'])f.properties.delete(name);
  f.setRaw('<x:xmpmeta>legacy</x:xmpmeta>');
  assert.deepEqual(await readXmpInventory(f.metadata,f.options),{raw:f.metadata.getRaw(),inventory:null,source:'legacy'});
  assert.deepEqual(await readXmpInventory(null),{raw:'',inventory:null,source:'legacy'});
});

test('full metadata cannot silently fall back when property extraction fails',async()=>{
  const f=await fixture();for(const name of ['dicom:metadatajson','dicom:metadatasha256','dicom:metadataversion'])f.properties.delete(name);
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
});

test('rejects empty or malformed full metadata without exposing source text',async()=>{
  const f=await fixture();
  for(const value of ['', '{"Synthetic":']){
    f.properties.set('dicom:metadatajson',value);
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
  }
});

test('requires the exact manifest text, including its internal formatting',async()=>{
  const f=await fixture();f.properties.set('dicom:inventoryjson',JSON.stringify(f.options.manifest));
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_MANIFEST_MISMATCH');
});

test('checks the supplied manifest object as well as the attachment text',async()=>{
  const f=await fixture();f.options.manifest={...f.options.manifest,profile:'different'};
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_MANIFEST_MISMATCH');
});

test('compares manifest objects independently of object-key order',async()=>{
  const f=await fixture();const {artifactSha256,images,profile,schemaVersion}=f.options.manifest;
  f.options.manifest={artifactSha256,images,profile,schemaVersion};
  assert.equal((await readXmpInventory(f.metadata,f.options)).source,'xmp');
});

test('rejects absent inventory JSON, invalid UTF-8, or missing manifest bytes',async()=>{
  const f=await fixture();f.properties.delete('dicom:inventoryjson');
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_MANIFEST_MISMATCH');
  f.properties.set('dicom:inventoryjson','{}');f.options.manifestBytes=Uint8Array.from([0xff]);
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_MANIFEST_MISMATCH');
  delete f.options.manifestBytes;
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_MANIFEST_MISMATCH');
});

test('rejects metadata hash mismatch and missing manifest artifact hash',async()=>{
  const f=await fixture();f.properties.set('dicom:metadatajson',f.metadataText.replace('Zoë','Zoe'));
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_HASH_MISMATCH');
  const missing=await fixture();delete missing.options.manifest.artifactSha256['dicom-metadata.json'];
  missing.options.manifestBytes=encode(JSON.stringify(missing.options.manifest));missing.properties.set('dicom:inventoryjson',new TextDecoder().decode(missing.options.manifestBytes));
  await rejectsCode(()=>readXmpInventory(missing.metadata,missing.options),'XMP_METADATA_HASH_MISMATCH');
});

test('cross-checks the XMP digest and inventory version properties',async()=>{
  const f=await fixture();f.properties.set('dicom:metadatasha256','0'.repeat(64));
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_HASH_MISMATCH');
  const version=await fixture();version.properties.set('dicom:metadataversion','2');
  await rejectsCode(()=>readXmpInventory(version.metadata,version.options),'XMP_METADATA_INVALID');
});

test('hash identity does not excuse changed attachment/path/SOP/source-hash mappings',async()=>{
  for(const key of ['attachment','sourcePath','sopInstanceUID','sha256']){
    const f=await fixture({mutateRecord:images=>{images[0][key]='changed';}});
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_MAPPING_MISMATCH');
  }
});

test('rejects duplicate attachment mappings or a missing element list',async()=>{
  for(const mutateRecord of [images=>{images[1]={...images[0]};},images=>{delete images[0].elements;}]){
    const f=await fixture({mutateRecord});
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_MAPPING_MISMATCH');
  }
});

test('source count, schema and selected-entry mappings are checked independently',async()=>{
  for(const mutateRecord of [images=>{images.pop();},(images,inventory)=>{inventory.schemaVersion=3;}]){
    const f=await fixture({mutateRecord});
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
  }
  const f=await fixture();f.options.entries=f.entries.map(entry=>({...entry}));f.options.entries[0].attachment='changed';
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_MAPPING_MISMATCH');
});

test('bounded UTF-8 counts catch multibyte packet and metadata text before hashing',async()=>{
  const f=await fixture();f.setRaw('王王');
  await rejectsCode(()=>readXmpInventory(f.metadata,{...f.options,limits:{maxRawBytes:5}}),'XMP_LIMIT_EXCEEDED');
  f.setRaw('😀');
  assert.equal((await readXmpInventory(f.metadata,{...f.options,limits:{maxRawBytes:4}})).source,'xmp');
  let hashes=0;
  await rejectsCode(()=>readXmpInventory(f.metadata,{...f.options,sha256:async()=>{hashes++;return sourceHash;},limits:{maxMetadataBytes:4}}),'XMP_LIMIT_EXCEEDED');
  assert.equal(hashes,0);assert.ok(Object.isFrozen(XMP_LIMITS));
});

test('bounds manifest bytes and source counts before accepting the inventory',async()=>{
  const f=await fixture();
  await rejectsCode(()=>readXmpInventory(f.metadata,{...f.options,limits:{maxManifestBytes:1}}),'XMP_LIMIT_EXCEEDED');
  await rejectsCode(()=>readXmpInventory(f.metadata,{...f.options,limits:{maxSources:1}}),'XMP_METADATA_INVALID');
});

test('does not reconstruct arbitrary trimmed metadata whitespace',async()=>{
  for(const ending of ['\n\n','\r\n',' ']){
    const f=await fixture({ending});
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_HASH_MISMATCH');
  }
});

test('unreadable PDF.js metadata and hash failures produce bounded generic errors',async()=>{
  await rejectsCode(()=>readXmpInventory({getRaw(){throw new Error('Synthetic secret');}}),'XMP_UNREADABLE');
  const f=await fixture();
  await rejectsCode(()=>readXmpInventory(f.metadata,{...f.options,sha256:async()=>{throw new Error('Synthetic secret');}}),'XMP_METADATA_HASH_MISMATCH');
});

test('new manifest marker requires full XMP even when every full-metadata property is absent',async()=>{
  const f=await fixture();setMarker(f,1);
  assert.equal((await readXmpInventory(f.metadata,f.options)).source,'xmp');
  for(const name of ['dicom:metadatajson','dicom:metadatasha256','dicom:metadataversion'])f.properties.delete(name);
  f.setRaw('<x:xmpmeta>metadata removed</x:xmpmeta>');
  await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
  await rejectsCode(()=>readXmpInventory(null,f.options),'XMP_METADATA_INVALID');
});

test('new manifest marker requires each payload, SHA-256 and version property independently',async()=>{
  for(const missing of ['dicom:metadatajson','dicom:metadatasha256','dicom:metadataversion']){
    const f=await fixture();setMarker(f,1);f.properties.delete(missing);
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
  }
});

test('unsupported full-XMP marker versions are refused instead of using legacy fallback',async()=>{
  for(const marker of [null,0,2,'1',false]){
    const f=await fixture();setMarker(f,marker);
    await rejectsCode(()=>readXmpInventory(f.metadata,f.options),'XMP_METADATA_INVALID');
  }
});
