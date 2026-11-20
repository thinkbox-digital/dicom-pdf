import test from 'node:test';
import assert from 'node:assert/strict';
import {createStackOrder,orderSourceIndices} from '../stack-order.mjs';

const IOP='1\\0\\0\\0\\1\\0',REVERSED='1\\0\\0\\0\\-1\\0';
const entry=(fields={},extra={})=>({fields:{StudyInstanceUID:'study',SeriesInstanceUID:'series',...fields},...extra});
const at=(z,fields={})=>entry({ImageOrientationPatient:IOP,ImagePositionPatient:'0\\0\\'+z,...fields});

test('sidebar groups slices in physical order without changing filenames or source identity',()=>{
  const entries=[at(2),at(0),at(1)];
  entries.forEach((entry,index)=>{entry.sourcePath=`instance-${index}.dcm`;entry.sopInstanceUID='duplicate';});
  const before=structuredClone(entries),indices=[0,1,2];
  const ordered=orderSourceIndices(indices,createStackOrder(entries));
  assert.deepEqual(ordered,[1,2,0]);assert.deepEqual(indices,[0,1,2]);assert.deepEqual(entries,before);
  assert.deepEqual(ordered.map(index=>entries[index].sourcePath),['instance-1.dcm','instance-2.dcm','instance-0.dcm']);
});

test('sidebar keeps interleaved series contiguous and retains reports and unavailable originals once',()=>{
  const entries=[at(3),at(4,{SeriesInstanceUID:'other'}),entry({Modality:'SR'}),at(1),at(2,{SeriesInstanceUID:'other'}),at(0),at(8,{StudyInstanceUID:'other-study'})];
  for(const index of [2,5])entries[index].supported=false;
  const stack=createStackOrder(entries,{canDisplay:entry=>entry.supported!==false});
  const indices=[0,1,2,3,4,5,6],ordered=orderSourceIndices(indices,stack);
  assert.deepEqual(ordered,[3,0,4,1,2,5,6]);assert.equal(new Set(ordered).size,indices.length);
  assert.deepEqual(orderSourceIndices([0,2,3,5],stack),[3,0,2,5]);
});

test('sidebar honors the selected slice orientation and the same metadata fallbacks as navigation',()=>{
  const entries=[at(1),at(3,{ImageOrientationPatient:REVERSED}),at(2)],stack=createStackOrder(entries);
  assert.deepEqual(orderSourceIndices([0,1,2],stack),[0,2,1]);
  assert.deepEqual(orderSourceIndices([0,1,2],stack,1),[1,2,0]);
  assert.deepEqual(orderSourceIndices([0,1,2],createStackOrder([entry({InstanceNumber:'3'}),entry({InstanceNumber:'1'}),entry({InstanceNumber:'2'})])),[1,2,0]);
  assert.deepEqual(orderSourceIndices([0,1,2],createStackOrder([entry(),entry(),entry()])),[0,1,2]);
});

test('projection sorts physical position rather than source order or instance number',()=>{
  const entries=[at(10,{InstanceNumber:'1'}),at(-4,{InstanceNumber:'3'}),at(2,{InstanceNumber:'2'})],before=[...entries];
  const stack=createStackOrder(entries);assert.deepEqual(stack.indices(0),[1,2,0]);assert.deepEqual(entries,before);
});

test('the current image normal controls reversed and oblique geometry without regrouping originals',()=>{
  const entries=[at(1),at(3,{ImageOrientationPatient:REVERSED}),at(2)];
  const stack=createStackOrder(entries);assert.deepEqual(stack.indices(0),[0,2,1]);assert.deepEqual(stack.indices(1),[1,2,0]);
  assert.notEqual(stack.indices(0),stack.indices(1));
  const oblique=[entry({ImageOrientationPatient:'0\\1\\0\\0\\0\\1',ImagePositionPatient:'3\\100\\-30'}),
    entry({ImageOrientationPatient:'0\\1\\0\\0\\0\\1',ImagePositionPatient:'-2\\-100\\30'})];
  assert.deepEqual(createStackOrder(oblique).indices(0),[1,0]);
});

test('duplicate physical positions and duplicate instance IDs preserve stable original indices',()=>{
  const entries=[at(2,{SOPInstanceUID:'duplicate'}),at(1,{SOPInstanceUID:'duplicate'}),at(2,{SOPInstanceUID:'duplicate'})];
  assert.deepEqual(createStackOrder(entries).indices(0),[1,0,2]);
});

test('one missing or nonfinite position falls back for the entire group to numeric instance order',()=>{
  for(const invalid of [undefined,'0\\0','0\\NaN\\1','0\\Infinity\\1','0\\0\\','0\\ \\1','0\\0\\0x2']){
    const entries=[at(30,{InstanceNumber:'3'}),at(10,{InstanceNumber:'1'}),at(20,{InstanceNumber:'2',ImagePositionPatient:invalid})];
    assert.deepEqual(createStackOrder(entries).indices(0),[1,2,0]);
  }
});

test('missing, zero and malformed orientation use instance numbers with stable ties',()=>{
  for(const orientation of [undefined,'0\\0\\0\\0\\0\\0','1\\0','NaN\\0\\0\\0\\1\\0','Infinity\\0\\0\\0\\1\\0']){
    const entries=[entry({InstanceNumber:'2',ImageOrientationPatient:orientation}),entry({InstanceNumber:'1'}),entry({InstanceNumber:'1'})];
    assert.deepEqual(createStackOrder(entries).indices(0),[1,2,0]);
  }
});

test('missing instance values preserve source order instead of becoming zero',()=>{
  assert.deepEqual(createStackOrder([entry({InstanceNumber:'3'}),entry({InstanceNumber:'1'}),entry()]).indices(0),[0,1,2]);
  for(const invalid of ['', ' ',null,false,true,[],{},'1.2','1e2','0x2','2147483648','-2147483649']){
    assert.deepEqual(createStackOrder([entry({InstanceNumber:'3'}),entry({InstanceNumber:invalid}),entry({InstanceNumber:'-2'})]).indices(0),[0,1,2]);
  }
});

test('explicit zero and signed or padded decimal geometry remain valid supplied positions',()=>{
  const entries=[at(' +2.0E1 '),at('0'),at('-.5')];
  assert.deepEqual(createStackOrder(entries).indices(0),[2,1,0]);
});

test('valid integer instance numbers include zero, signs, padding and signed 32-bit boundaries',()=>{
  const entries=['2147483647',' +2 ','0','-2147483648','-2'].map(InstanceNumber=>entry({InstanceNumber}));
  assert.deepEqual(createStackOrder(entries).indices(0),[3,4,2,1,0]);
});

test('a missing orientation component cannot supply an inferred patient normal',()=>{
  const entries=[at(30,{ImageOrientationPatient:'1\\0\\\\0\\1\\0',InstanceNumber:'1'}),
    at(10,{InstanceNumber:'3'}),at(20,{InstanceNumber:'2'})];
  assert.deepEqual(createStackOrder(entries).indices(0),[0,2,1]);
});

test('only actual matching study and series values share membership, and unsupported sources are excluded',()=>{
  const entries=[at(3),at(1,{StudyInstanceUID:'other'}),at(2,{SeriesInstanceUID:'other'}),at(0)];
  entries[3].supported=false;
  const stack=createStackOrder(entries,{canDisplay:entry=>entry.supported!==false});
  assert.deepEqual(stack.indices(0),[0]);assert.deepEqual(stack.indices(1),[1]);assert.deepEqual(stack.indices(2),[2]);
  const missingStudy=createStackOrder([entry({StudyInstanceUID:undefined}),entry({StudyInstanceUID:null}),entry({StudyInstanceUID:''})]);
  assert.deepEqual(missingStudy.indices(0),[0]);assert.deepEqual(missingStudy.indices(1),[1]);assert.deepEqual(missingStudy.indices(2),[2]);
});

test('missing series identifiers isolate every original even when UID, metadata or object references repeat',()=>{
  const same=entry({SeriesInstanceUID:undefined,SOPInstanceUID:'same'}),entries=[same,same,entry({SeriesInstanceUID:''}),entry({SeriesInstanceUID:null})];
  const stack=createStackOrder(entries);for(let index=0;index<entries.length;index++)assert.deepEqual(stack.indices(index),[index]);
});

test('same-series access returns the same frozen array without refiltering or rereading positions',()=>{
  let eligibilityReads=0,positionReads=0;
  const entries=Array.from({length:5},(_,index)=>{
    const item=at(5-index);Object.defineProperty(item.fields,'ImagePositionPatient',{get(){positionReads++;return '0\\0\\'+(5-index);}});return item;
  });
  const stack=createStackOrder(entries,{canDisplay:()=>{eligibilityReads++;return true;}}),first=stack.indices(0),reads=positionReads;
  assert.equal(eligibilityReads,5);assert.equal(reads,5);assert.equal(stack.indices(4),first);assert.equal(stack.indices(2),first);
  assert.equal(eligibilityReads,5);assert.equal(positionReads,reads);assert.equal(Object.isFrozen(first),true);
  assert.throws(()=>first.push(10),TypeError);assert.throws(()=>{first[0]=10;},TypeError);
});

test('equivalent normals share an order while reversed normals have separate cached arrays',()=>{
  const entries=[at(1),at(2,{ImageOrientationPatient:'0\\1\\0\\-1\\0\\0'}),at(3,{ImageOrientationPatient:REVERSED})],stack=createStackOrder(entries);
  assert.equal(stack.indices(0),stack.indices(1));assert.notEqual(stack.indices(0),stack.indices(2));
});

test('clear refreshes cached arrays and displayable membership without modifying returned snapshots',()=>{
  const entries=[at(2),at(1)],stack=createStackOrder(entries,{canDisplay:item=>item.supported!==false}),first=stack.indices(0);
  entries[1].supported=false;assert.equal(stack.indices(0),first);stack.clear();const refreshed=stack.indices(0);
  assert.notEqual(refreshed,first);assert.deepEqual(refreshed,[0]);assert.deepEqual(first,[1,0]);
});

test('cache is bounded to128 recently used group/orientation orders',()=>{
  const entries=Array.from({length:129},(_,index)=>at(index,{SeriesInstanceUID:'series-'+index})),stack=createStackOrder(entries);
  const first=stack.indices(0),second=stack.indices(1);for(let index=2;index<128;index++)stack.indices(index);
  assert.equal(stack.indices(0),first,'touch first to make it recent');stack.indices(128);
  assert.equal(stack.indices(0),first);assert.notEqual(stack.indices(1),second,'least recently used order must be evicted');
});

test('invalid selections and non-displayable isolated originals return frozen empty arrays',()=>{
  const stack=createStackOrder([entry({SeriesInstanceUID:undefined})],{canDisplay:()=>false});
  for(const index of [-1,1,1.5,'0',undefined])assert.deepEqual(stack.indices(index),[]);
  assert.deepEqual(stack.indices(0),[]);assert.equal(Object.isFrozen(stack.indices(0)),true);
  assert.throws(()=>createStackOrder(null),TypeError);assert.throws(()=>createStackOrder([],{canDisplay:null}),TypeError);
});
