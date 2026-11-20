import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPaneInventory,classifyPaneEntry} from '../pane-inventory.mjs';

const SOP='1.2.840.10008.5.1.4.1.1.';
const source=(attachment,fields={},extra={})=>({attachment,sourcePath:attachment,fields,...extra});

test('raster originals including unsupported encodings retain their global left-side identities',()=>{
  const entries=[source('metadata.txt'),source('image-a',{Rows:'100',Columns:'200',SOPInstanceUID:'duplicate'}),
    source('image-b',{Rows:'100',Columns:'200',SOPInstanceUID:'duplicate'},{displayRejected:true,displayEligibility:{status:'unsupported',codes:['UNSUPPORTED_TRANSFER_SYNTAX']}})];
  const model=buildPaneInventory(entries);assert.deepEqual(model.dataIndices,[1,2]);assert.deepEqual(model.otherSuppliedIndices,[0]);
  assert.deepEqual([...model.byIndex.keys()],[0,1,2]);assert.equal(model.byIndex.get(2).attachment,'image-b');assert.equal(model.byIndex.get(2).viewKind,'dicom');
});

test('actual PDF/SR storage classes stay data even with missing image dimensions or misleading suffixes',()=>{
  const pdf=classifyPaneEntry(source('report.txt',{SOPClassUID:SOP+'104.1'})),sr=classifyPaneEntry(source('report.xml',{SOPClassUID:SOP+'88.33'}));
  assert.deepEqual(pdf,{pane:'data',kind:'dicom-pdf',viewKind:'dicom-document'});
  assert.deepEqual(sr,{pane:'data',kind:'dicom-sr',viewKind:'dicom-document'});
  assert.equal(classifyPaneEntry(source('document',{MediaStorageSOPClassUID:SOP+'104.1'})).kind,'dicom-pdf');
});

test('known image SOP classes without readable pixels remain data placeholders rather than disappearing',()=>{
  const result=classifyPaneEntry(source('broken.dcm',{SOPClassUID:SOP+'2'},{status:'unrendered'}));
  assert.equal(result.pane,'data');assert.equal(result.kind,'dicom-image');assert.equal(result.viewKind,'dicom');
});

test('generic raster/PDF display categories reuse attachmentKind while text and SVG remain metadata',()=>{
  for(const name of ['photo.png','photo.JPEG','image.webp','document.pdf'])assert.equal(classifyPaneEntry(source(name)).pane,'data',name);
  for(const name of ['README','README.txt','document.xml','report.html','image.svg','inventory.json','opaque.bin'])assert.equal(classifyPaneEntry(source(name)).pane,'metadata',name);
  assert.equal(classifyPaneEntry(source('no-extension'),{contentType:'application/pdf'}).viewKind,'pdf');
  assert.equal(classifyPaneEntry(source('no-extension'),{contentType:'image/png'}).viewKind,'image');
  assert.equal(classifyPaneEntry(source('image.svg'),{contentType:'image/svg+xml'}).viewKind,'text');
});

test('legacy broad DICOM attachment MIME does not hide actual generic raster/PDF format candidates',()=>{
  const broad={contentType:'application/dicom'};
  assert.equal(classifyPaneEntry(source('photo.png'),broad).kind,'image');
  assert.equal(classifyPaneEntry(source('report.pdf'),broad).kind,'pdf');
  assert.equal(classifyPaneEntry(source('README.txt'),broad).viewKind,'text');
  assert.equal(classifyPaneEntry(source('object.pdf',{SOPClassUID:SOP+'9'}),broad).pane,'metadata');
});

test('actual DICOMDIR, archive and unsupported nonimage evidence overrides raster/PDF-looking names',()=>{
  const cases=[source('directory.pdf',{SOPClassUID:'1.2.840.10008.1.3.10',Rows:'2',Columns:'2'}),
    source('archive.png',{}, {kind:'zip-archive'}),source('container.pdf',{}, {archiveStatus:'unreadable'}),
    source('object.jpg',{SOPClassUID:SOP+'9'},{kind:'dicom-object'})];
  for(const item of cases)assert.equal(classifyPaneEntry(item).pane,'metadata');
  assert.equal(classifyPaneEntry(source('archive.pdf'),{contentType:'application/zip'}).pane,'metadata');
});

test('recognized SEG/RT/presentation/WSI objects unsupported as standalone data remain on the metadata side',()=>{
  for(const suffix of ['66.4','481.3','11.2','77.1.6']){
    const item=source('object.png',{SOPClassUID:SOP+suffix,Rows:'100',Columns:'100'},
      {kind:'dicom-image',displayEligibility:{status:'unsupported',codes:['UNSUPPORTED_OBJECT_TYPE']}});
    assert.equal(classifyPaneEntry(item).pane,'metadata',suffix);
  }
});

test('grayscale presentation states and spectroscopy have dedicated previews',()=>{
  assert.equal(classifyPaneEntry(source('state.dcm',{SOPClassUID:SOP+'11.1'})).viewKind,'presentation-state');
  assert.equal(classifyPaneEntry(source('spectrum.dcm',{SOPClassUID:SOP+'4.2'})).viewKind,'spectroscopy');
});

test('RT Dose and RT Plan open from the source list even with legacy PDF preview rejections',()=>{
  const dose=source('dose',{SOPClassUID:SOP+'481.2'},{status:'unrendered',displayRejected:true});
  const plan=source('plan',{MediaStorageSOPClassUID:SOP+'481.5'},{kind:'dicom-object'});
  const model=buildPaneInventory([dose,plan]);
  assert.deepEqual(model.dataIndices,[0,1]);assert.deepEqual(model.otherSuppliedIndices,[]);
  assert.equal(model.byIndex.get(0).viewKind,'rt-dose');
  assert.equal(model.byIndex.get(1).viewKind,'rt-plan');
});

test('surface segmentation originals open from Data despite legacy non-raster rejections',()=>{
  const surface=source('surface.dcm',{MediaStorageSOPClassUID:SOP+'66.5'},
    {status:'unrendered',kind:'dicom-object',displayEligibility:{status:'unsupported',codes:['UNSUPPORTED_OBJECT_TYPE']}});
  const model=buildPaneInventory([surface]);
  assert.deepEqual(model.dataIndices,[0]);
  assert.deepEqual(model.otherSuppliedIndices,[]);
  assert.equal(model.byIndex.get(0).viewKind,'surface-segmentation');
});

test('metadata-looking names do not invent image, report or clinical meaning',()=>{
  const item=source('MRI_BRAIN_20260101_FINDINGS.txt',{Modality:'MR',StudyDescription:'Actual source description'});
  const before=structuredClone(item);assert.equal(classifyPaneEntry(item).pane,'metadata');assert.deepEqual(item,before);
  assert.equal(classifyPaneEntry(source('DICOMDIR'),{contentType:'image/png'}).pane,'data','a reserved-looking name alone does not invent a DICOM directory');
});

test('generated files and other supplied originals are separate and original data is not duplicated on the right',()=>{
  const image=source('original-1',{Rows:'10',Columns:'20'}),readme=source('original-2',{}, {sourcePath:'README.txt'});
  const attachments={a:{filename:'original-1',content:new Uint8Array([1])},b:{filename:'original-2',content:new Uint8Array([2])},
    manifest:{filename:'manifest.json',content:new Uint8Array([3])},schema:{filename:'dicom-xmp.rng',content:new Uint8Array([4])}};
  const model=buildPaneInventory([image,readme],attachments);
  assert.deepEqual(model.dataIndices,[0]);assert.deepEqual(model.otherSuppliedIndices,[1]);
  assert.deepEqual(model.generatedFiles.map(file=>file.filename),['manifest.json','dicom-xmp.rng']);assert.equal(model.generatedFiles[0],attachments.manifest);
  assert.equal(Object.isFrozen(model.dataIndices),true);assert.equal(Object.isFrozen(model.generatedFiles),true);
});

test('source attachment mapping uses exact IDs rather than similar filenames and survives missing attachments',()=>{
  const entries=[source('original-manifest',{}, {sourcePath:'manifest.json'}),source('missing-image',{Rows:'1',Columns:'2'})];
  const model=buildPaneInventory(entries,{generated:{filename:'manifest.json',content:new Uint8Array()}});
  assert.deepEqual(model.dataIndices,[1]);assert.deepEqual(model.otherSuppliedIndices,[0]);assert.equal(model.generatedFiles.length,1);
  assert.equal(model.byIndex.get(1).attachment,'missing-image');assert.equal(model.byIndex.get(1).pane,'data');
});

test('source selected fields outrank enriched fields without changing either source or attachment bytes',()=>{
  const item=source('source',{SOPClassUID:SOP+'104.1'},{navigationFields:{SOPClassUID:'1.2.840.10008.1.3.10'}}),bytes=new Uint8Array([1,2,3]);
  assert.equal(classifyPaneEntry(item,{content:bytes}).pane,'data');assert.deepEqual([...bytes],[1,2,3]);
});
