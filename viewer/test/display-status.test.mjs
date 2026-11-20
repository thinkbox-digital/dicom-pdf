import test from 'node:test';
import assert from 'node:assert/strict';
import {unavailableDisplay,unavailableArchiveDisplay,supportingSourceDisplay,sourceListPresentation} from '../display-status.mjs';

test('dose data has a readable label while the SOP diagnostic stays technical',()=>{
  const reason='Unsupported non-raster SOP class: 1.2.840.10008.5.1.4.1.1.481.2';
  const result=unavailableDisplay({fields:{SOPClassUID:'1.2.840.10008.5.1.4.1.1.481.2'},reason});
  assert.equal(result.label,'Dose data — viewing unsupported');
  assert.match(result.description,/radiotherapy dose data/);assert.doesNotMatch(result.description,/1\.2\.840|non-raster|rejected/i);
  assert.equal(result.technical,reason);
});
test('other unsupported objects have honest labels without guessing from filenames',()=>{
  assert.match(unavailableDisplay({fields:{Modality:'RTPLAN'}}).title,/Radiotherapy data/);
  assert.match(unavailableDisplay({fields:{Modality:'SEG'}}).title,/Segmentation data/);
  assert.match(unavailableDisplay({sourcePath:'RTDOSE.dcm'}).title,/^Image:/);
});
test('technical strings remain literal data',()=>{
  const reason='<img src=x onerror=alert(1)>';
  const result=unavailableDisplay({reason});assert.equal(result.technical,reason);assert.doesNotMatch(result.title+result.description,/<img/);
});
test('invalid spacing is identified as a metadata issue rather than unsupported compression',()=>{
  const result=unavailableDisplay({fields:{TransferSyntaxUID:'1.2.840.10008.1.2.4.70'},reason:'Invalid PixelSpacing spacing'});
  assert.equal(result.label,'Image — display metadata issue');assert.match(result.description,/pixel-spacing/);
  assert.doesNotMatch(result.description,/format is not supported/);
});
test('missing PDF previews do not produce interactive-viewer warnings or promises',()=>{
  const entry={sourcePath:'MR1_J2KI',status:'unrendered',reason:'No bundled pure-Java decoder'};
  const original=structuredClone(entry);
  assert.deepEqual(sourceListPresentation(entry,{canView:true}),{label:'MR1_J2KI',warning:false});
  assert.deepEqual(entry,original);
});
test('actual decoder failure is distinct from absent PDF preview and can recover',()=>{
  const entry={sourcePath:'image.dcm',status:'unrendered'};
  assert.deepEqual(sourceListPresentation(entry,{canView:true,displayState:'failed'}),{label:'image.dcm — could not display',warning:true});
  assert.deepEqual(sourceListPresentation(entry,{canView:true,displayState:'displayed'}),{label:'image.dcm',warning:false});
  const dose={sourcePath:'dose.dcm',fields:{Modality:'RTDOSE'}};
  assert.deepEqual(sourceListPresentation(dose,{canView:false}),{label:'dose.dcm — Dose data — viewing unsupported',warning:true});
});

const storage='1.2.840.10008.5.1.4.1.1.';
const auditedCases=[
  ['grayscale softcopy',{fields:{SOPClassUID:storage+'11.1'}},/saved settings to a referenced image/],
  ['MR spectroscopy',{fields:{SOPClassUID:storage+'4.2'}},/spectroscopy layout or the plot axes/],
  ['raw acquisition',{fields:{SOPClassUID:storage+'66'}},/scanner’s format/],
  ['surface segmentation',{fields:{SOPClassUID:storage+'66.5'}},/3D surface mesh/],
  ['RT structure set',{fields:{SOPClassUID:storage+'481.3'}},/contour overlay/],
  ['RT plan',{fields:{SOPClassUID:storage+'481.5'}},/treatment planning data/],
  ['enhanced ultrasound',{fields:{SOPClassUID:storage+'6.2'}},/ultrasound volume renderer/],
  ['Philips ultrasound',{fields:{SOPClassUID:'1.2.840.113543.6.6.1.3.10002'}},/time series of 3D ultrasound volumes/],
  ['Philips private CT',{fields:{TransferSyntaxUID:'1.3.46.670589.33.1.4.1'}},/private pixel data layout/],
  ['HTJ2K',{fields:{TransferSyntaxUID:'1.2.840.10008.1.2.4.203'}},/High-Throughput JPEG 2000/],
  ['Part 10',{reason:'DICOM Part 10 file meta information is required'},/verify a supported encoding/],
  ['pixel bit layout',{reason:'Unsupported pixel bit layout',fields:{BitsStored:'16',HighBit:'0'}},/16 stored bits and a High Bit of 0/],
  ['color profile',{reason:'Invalid ICC Profile Data'},/ICC color profile/],
  ['lookup table',{reason:'Modality/VOI/presentation LUT sequences are not implemented'},/grayscale lookup table/],
  ['truncated data',{reason:'EOFException'},/before all of the expected data/],
  ['external data',{reason:'Pixel data is referenced externally; no network retrieval is performed'},/external location/],
  ['unreadable DICOM',{reason:'Not a DICOM Stream'},/could not read this original/],
];
for(const [name,entry,expected] of auditedCases){
  test(`${name} explains the viewing limitation and the recovery control`,()=>{
    for(const [recovery,action] of [['selected',/Save → Original file/],['row',/download button/],['metadata',/Metadata → Other supplied files/]]){
      const {description}=unavailableDisplay(entry,{recovery});
      assert.match(description,expected);
      assert.match(description,/original source file is available/);
      assert.match(description,action);
    }
  });
}
test('a memory-limited image reports its pixel count and recovery',()=>{
  const message=unavailableDisplay({fields:{Rows:'5131',Columns:'3271'}},{failure:{code:'RESOURCE_LIMIT'}});
  assert.match(message.description,/16,783,501 pixels/);
  assert.match(message.description,/working memory/);
  assert.match(message.description,/Save → Original file/);
});
test('a surface renderer error is distinguished from a historical PDF preview rejection',()=>{
  const entry={sourcePath:'surface.dcm',fields:{SOPClassUID:storage+'66.5'},reason:'Historical PDF preview rejection'};
  const failure={code:'SURFACE_RENDER_UNAVAILABLE',message:'WebGL 2 is unavailable.'};
  const message=unavailableDisplay(entry,{failure});
  assert.equal(message.title,'Surface segmentation: viewing unavailable');
  assert.match(message.description,/browser could not start the 3D surface renderer/);
  assert.match(message.description,/Save → Original file/);
  assert.equal(message.technical,failure.message);
  assert.deepEqual(sourceListPresentation(entry,{canView:true,kind:'surface-segmentation',displayState:'displayed'}),
    {label:'surface.dcm — 3D surface',warning:false});
});
test('supporting-only archives show a shared reason or point to source-specific reasons',()=>{
  const header=auditedCases.find(([name])=>name==='Part 10')[1],mesh=auditedCases.find(([name])=>name==='surface segmentation')[1];
  assert.match(unavailableArchiveDisplay([mesh]).description,/3D surface mesh.*Metadata → Other supplied files/);
  assert.match(unavailableArchiveDisplay([header,header]).description,/headerless file.*original source files/);
  assert.match(unavailableArchiveDisplay([header,mesh]).description,/viewing limitations.*Metadata → Other supplied files/);
  assert.doesNotMatch(unavailableArchiveDisplay([]).description,/available to save|download button/);
});

test('ordinary supporting files are classified without a DICOM parsing error',()=>{
  const item={sourcePath:'export-notes.bin',reason:'Not a DICOM Stream'};
  assert.equal(supportingSourceDisplay(item),null);
  assert.doesNotMatch(unavailableArchiveDisplay([item]).title,/Unreadable DICOM/);
  assert.match(supportingSourceDisplay({...item,sourcePath:'damaged.dcm'}).description,/read this original as a DICOM file/);
});
