import test from 'node:test';
import assert from 'node:assert/strict';
import {readSourceWindowPresets} from '../source-window-presets.mjs';

function dataset(values={}){
  const chunks=[],elements={};let position=0;
  for(const [tag,provided] of Object.entries(values)){
    const [vr,value]=Array.isArray(provided)?provided:['DS',provided],bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value),'utf8');
    elements[tag]={vr,dataOffset:position,length:bytes.length};chunks.push(bytes);position+=bytes.length;
  }
  return {elements,byteArray:new Uint8Array(Buffer.concat(chunks))};
}
function group(source,charset){const result=dataset(charset===undefined?{}:{x00080005:['CS',charset]});result.elements.x00289132={vr:'SQ',items:[{dataSet:source}]};return result;}
const source=(center='40\\80',width='400\\1200',extra={})=>dataset({x00281050:center,x00281051:width,...extra});
const preset=(index,center,width,label=null,functionValue='LINEAR')=>({index,center,width,label,function:functionValue});

test('only supplied pairs become alternatives; absent metadata does not invent anatomy defaults',()=>{
  assert.equal(readSourceWindowPresets(dataset()),null);
  assert.deepEqual(readSourceWindowPresets(source()),{presets:[preset(0,40,400),preset(1,80,1200)],provenance:'top-level',functionExplicit:false,diagnostics:[]});
});
test('source explanation VM labels pair by their original stable index and decode UTF8',()=>{
  const root=source('40\\80','400\\1200',{x00080005:['CS','ISO_IR 192'],x00281055:['LO','Soft tissue\\Café 漢字'],x00281056:['CS','LINEAR']});
  assert.deepEqual(readSourceWindowPresets(root),{presets:[preset(0,40,400,'Soft tissue'),preset(1,80,1200,'Café 漢字')],provenance:'top-level',functionExplicit:true,diagnostics:[]});
});
test('source labels inherit root character set when provided by functional groups',()=>{
  const root=dataset({x00080005:['CS','ISO_IR 100']});
  const item=source('40','400',{x00281055:['LO',Buffer.from([67,97,102,233])]});
  assert.equal(readSourceWindowPresets(root,{shared:group(item)}).presets[0].label,'Café');
});
test('per-frame and shared functional-group character sets override inherited root labels',()=>{
  const root=dataset({x00080005:['CS','ISO_IR 100']});
  for(const selected of ['perFrame','shared']){
    const item=source('40','400',{x00281055:['LO','Café 山田']});
    const result=readSourceWindowPresets(root,{[selected]:group(item,'ISO_IR 192')});
    assert.equal(result.presets[0].label,'Café 山田');assert.deepEqual(result.diagnostics,[]);
  }
});
test('the selected VOI macro own character set overrides its functional group and root',()=>{
  const root=dataset({x00080005:['CS','ISO_IR 100']});
  const utf8=source('40','400',{x00080005:['CS','ISO_IR 192'],x00281055:['LO','Café 山田']});
  const fromOwn=readSourceWindowPresets(root,{perFrame:group(utf8,'ISO_IR 100')});assert.equal(fromOwn.presets[0].label,'Café 山田');assert.deepEqual(fromOwn.diagnostics,[]);
  const latin=source('40','400',{x00080005:['CS','ISO_IR 100'],x00281055:['LO',Buffer.from([67,97,102,233])]});
  const latinResult=readSourceWindowPresets(dataset({x00080005:['CS','ISO_IR 192']}),{perFrame:group(latin,'ISO_IR 192')});assert.equal(latinResult.presets[0].label,'Café');assert.deepEqual(latinResult.diagnostics,[]);
});
test('charset inheritance never borrows an unselected shared group and present bad overrides do not fall back',()=>{
  const root=dataset({x00080005:['CS','ISO_IR 100']}),latin=source('40','400',{x00281055:['LO',Buffer.from([67,97,102,233])]});
  const result=readSourceWindowPresets(root,{perFrame:group(latin),shared:group(source(),'ISO_IR 192')});assert.equal(result.presets[0].label,'Café');assert.deepEqual(result.diagnostics,[]);
  const invalid=source('40','400',{x00080005:['CS','UNSUPPORTED'],x00281055:['LO','Café']});
  const invalidResult=readSourceWindowPresets(dataset({x00080005:['CS','ISO_IR 192']}),{perFrame:group(invalid,'ISO_IR 192')});assert.equal(invalidResult.presets[0].label,null);assert.deepEqual(invalidResult.diagnostics,['UNREADABLE_WINDOW_LABELS']);
  const reset=source('40','400',{x00080005:['CS',''],x00281055:['LO','Café']});
  const resetResult=readSourceWindowPresets(dataset({x00080005:['CS','ISO_IR 192']}),{shared:group(reset,'ISO_IR 192')});assert.equal(resetResult.presets[0].label,null);assert.deepEqual(resetResult.diagnostics,['UNREADABLE_WINDOW_LABELS']);
});
test('selected frame macro takes precedence over shared and dataset without mixing attributes',()=>{
  const root=source('1','10'),shared=group(source('2','20')),perFrame=group(source('3\\4','30\\40'));
  assert.deepEqual(readSourceWindowPresets(root,{perFrame,shared}),{presets:[preset(0,3,30),preset(1,4,40)],provenance:'per-frame-functional-groups',functionExplicit:false,diagnostics:[]});
  assert.equal(readSourceWindowPresets(root,{shared}).presets[0].center,2);
  assert.equal(readSourceWindowPresets(root,{shared}).provenance,'shared-functional-groups');
  assert.equal(readSourceWindowPresets(root,{perFrame:{elements:{}},shared}).presets[0].center,2);
});
test('present empty or malformed frame macros block lower-priority preset fallback',()=>{
  for(const macro of [{vr:'SQ',items:[]},{vr:'SQ',items:[{}]},{vr:'SQ',items:[{dataSet:source()},{dataSet:source()}]},{vr:'LO',items:[{dataSet:source()}]}]){
    const result=readSourceWindowPresets(source(),{perFrame:{elements:{x00289132:macro}},shared:group(source())});
    assert.deepEqual(result.presets,[]);assert.deepEqual(result.diagnostics,['MALFORMED_FRAME_VOI_MACRO']);assert.equal(result.provenance,'per-frame-functional-groups');
  }
  const missing=readSourceWindowPresets(source(),{perFrame:group(dataset())});
  assert.deepEqual(missing.presets,[]);assert.deepEqual(missing.diagnostics,['WINDOW_VALUES_MISSING']);
});
test('mismatched WC/WW VM refuses pairing; missing values cannot borrow dataset fields',()=>{
  for(const item of [source('1\\2','3'),dataset({x00281050:'1'}),dataset({x00281051:'3'})]){
    const result=readSourceWindowPresets(source(),{shared:group(item)});
    assert.deepEqual(result.presets,[]);assert.deepEqual(result.diagnostics,['WINDOW_VM_MISMATCH']);
  }
});
test('mismatched label VM retains valid pairs without inventing labels',()=>{
  const result=readSourceWindowPresets(source('1\\2','3\\4',{x00281055:['LO','Only one label']}));
  assert.deepEqual(result.presets,[preset(0,1,3),preset(1,2,4)]);assert.deepEqual(result.diagnostics,['WINDOW_LABEL_VM_MISMATCH']);
});
test('invalid pairs are omitted while valid original indices keep matching labels',()=>{
  const result=readSourceWindowPresets(source('1\\NaN\\3\\4\\5','10\\20\\0\\0x10\\50',{x00281055:['LO','First\\Second\\Third\\Fourth\\Fifth']}));
  assert.deepEqual(result.presets,[preset(0,1,10,'First'),preset(4,5,50,'Fifth')]);assert.deepEqual(result.diagnostics,['INVALID_WINDOW_PAIR']);
});
test('source VOI function is explicit when provided and width rules follow each function',()=>{
  for(const functionValue of ['LINEAR_EXACT','SIGMOID']){
    const result=readSourceWindowPresets(source('0\\1','0.5\\0',{x00281056:['CS',functionValue]}));
    assert.deepEqual(result.presets,[preset(0,0,0.5,null,functionValue)]);assert.equal(result.functionExplicit,true);assert.deepEqual(result.diagnostics,['INVALID_WINDOW_PAIR']);
  }
  const linear=readSourceWindowPresets(source('0\\1','0.5\\1',{x00281056:['CS','LINEAR']}));assert.deepEqual(linear.presets,[preset(1,1,1)]);
  for(const value of ['','UNKNOWN','LINEAR\\SIGMOID']){
    const result=readSourceWindowPresets(source('1','2',{x00281056:['CS',value]}));assert.equal(result.functionExplicit,true);assert.deepEqual(result.presets,[]);assert.deepEqual(result.diagnostics,['UNSUPPORTED_VOI_FUNCTION']);
  }
});
test('unreadable source labels never become guessed text or invalidate intact numeric alternatives',()=>{
  for(const extra of [{x00281055:['LO',Buffer.from([255])]},
    {x00080005:['CS','ISO_IR 192'],x00281055:['LO',Buffer.from([0xc3,0x28])]},
    {x00080005:['CS','ISO 2022 IR 87'],x00281055:['LO','Unsupported charset']}]){
    const result=readSourceWindowPresets(source('1','2',extra));assert.deepEqual(result.presets,[preset(0,1,2)]);assert.deepEqual(result.diagnostics,['UNREADABLE_WINDOW_LABELS']);
  }
});
test('input sizes, VRs and excessive VM fail with bounded generic diagnostics',()=>{
  const huge=readSourceWindowPresets(source(Array(257).fill('1').join('\\'),Array(257).fill('2').join('\\')));assert.deepEqual(huge.presets,[]);assert.deepEqual(huge.diagnostics,['WINDOW_PRESET_LIMIT']);
  const wrongVr=readSourceWindowPresets(dataset({x00281050:['LO','1'],x00281051:'2'}));assert.deepEqual(wrongVr.diagnostics,['INVALID_WINDOW_VALUES']);
  const oversized=source('1','2');oversized.elements.x00281050.length=65537;assert.deepEqual(readSourceWindowPresets(oversized).diagnostics,['INVALID_WINDOW_VALUES']);
});
