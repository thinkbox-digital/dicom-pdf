import test from 'node:test';
import assert from 'node:assert/strict';
import {readStructureInventory,structureDetails} from '../source-structure.mjs';
const entry={attachment:'original.dcm',sourcePath:'synthetic.dcm',sha256:'a'.repeat(64)};
function inventory(){return {schemaVersion:1,rulesVersion:'1',standardEdition:'2026d',fullIodValidation:false,images:[{...entry,status:'FAIL',checks:{pixelStructure:{status:'FAIL',scope:'Native encoded length only'}},suppliedPixelBytes:2,expectedPixelBytes:128,issues:[{severity:'ERROR',code:'NATIVE_PIXEL_LENGTH_MISMATCH',path:'dataset/(7FE0,0010)',message:'Encoded length differs.'}]}]};}
test('exposes stored diagnostics and encoded byte counts without a full-validity claim',()=>{
  const data=readStructureInventory(inventory(),[entry]),values=structureDetails(data,entry);
  assert.equal(values['Stored structural checks'],'FAIL');assert.equal(values['Encoded pixel bytes'],'2');assert.equal(values['Expected native pixel bytes'],'128');
  assert.match(values['Structural check scope'],/full IOD validity not established/);assert.match(values['Structural findings'],/NATIVE_PIXEL_LENGTH_MISMATCH/);
  assert.deepEqual(structureDetails(null,entry),{});
});
test('refuses stale or duplicate mappings and unsupported rule versions',()=>{
  let data=inventory();data.images[0].sha256='b'.repeat(64);assert.throws(()=>readStructureInventory(data,[entry]));
  data=inventory();data.images.push({...data.images[0]});assert.throws(()=>readStructureInventory(data,[entry,{...entry,attachment:'other.dcm'}]));
  data=inventory();data.rulesVersion='999';assert.throws(()=>readStructureInventory(data,[entry]));
});
test('rejects invalid status and byte counts while retaining messages as inert strings',()=>{
  let data=inventory();data.images[0].expectedPixelBytes=-1;assert.throws(()=>readStructureInventory(data,[entry]));
  data=inventory();data.images[0].checks.pixelStructure.status='VALID';assert.throws(()=>readStructureInventory(data,[entry]));
  data=inventory();data.images[0].issues[0].message='<img src=x onerror=alert(1)>';
  assert.match(structureDetails(readStructureInventory(data,[entry]),entry)['Structural findings'],/<img/);
});
