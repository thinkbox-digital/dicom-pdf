import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWindowPresets} from '../window-presets.mjs';

const preset=(index,center,width,label=null,functionValue='LINEAR')=>({index,center,width,label,function:functionValue});
const decoded=(presets=[],image={})=>({image:{color:false,windowCenter:40,windowWidth:400,voiLUTFunction:'LINEAR',...image},
  sourceWindowPresets:{presets,provenance:'top-level',diagnostics:[]}});

test('initial display is the exact decoder/PDF recipe baseline and a differing source preset remains available',()=>{
  const source=decoded([preset(0,50,500,'Supplied choice')],{windowCenter:45.125,windowWidth:425.25});
  const result=buildWindowPresets(source);
  assert.equal(result.options[0].value,'initial');assert.equal(result.options[0].label,'Initial display');
  assert.deepEqual(result.window,{center:45.125,width:425.25,function:'LINEAR'});assert.equal(result.selected,'initial');assert.equal(result.hidden,false);
  assert.deepEqual(result.options[1],{value:'source:0',label:'Supplied choice · WL 50 / WW 500',window:{center:50,width:500,function:'LINEAR'}});
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.options));assert.ok(Object.isFrozen(result.window));
});

test('absent alternatives or only exact baseline values hide the menu without dropping source labels',()=>{
  assert.equal(buildWindowPresets(decoded()).hidden,true);
  const same=buildWindowPresets(decoded([preset(0,40,400,'First source label'),preset(1,40,400,'Second source label')]),{selected:'source:1'});
  assert.equal(same.hidden,true);assert.equal(same.options.length,3);assert.equal(same.selected,'source:1');
  assert.match(same.options[1].label,/First source label/);assert.match(same.options[2].label,/Second source label/);
  const exactDifference=buildWindowPresets(decoded([preset(0,40+Number.EPSILON*64,400)]));assert.equal(exactDifference.hidden,false);
});

test('different VOI functions count as actual alternatives even with equal WC/WW',()=>{
  const result=buildWindowPresets(decoded([preset(0,40,400,'Supplied sigmoid','SIGMOID')]),{selected:'source:0'});
  assert.equal(result.hidden,false);assert.equal(result.window.function,'SIGMOID');assert.match(result.options[1].label,/SIGMOID$/);
});

test('stable source index selection resolves each frame values instead of retaining the previous frame window',()=>{
  const first=buildWindowPresets(decoded([preset(0,1,10),preset(1,2,20)]),{selected:'source:1'});
  const next=buildWindowPresets(decoded([preset(0,3,30),preset(1,4,40)]),{selected:first.selected});
  assert.equal(next.selected,'source:1');assert.deepEqual(next.window,{center:4,width:40,function:'LINEAR'});
  const missing=buildWindowPresets(decoded([preset(0,5,50)],{windowCenter:6,windowWidth:60}),{selected:next.selected});
  assert.equal(missing.selected,'initial');assert.deepEqual(missing.window,{center:6,width:60,function:'LINEAR'});
});

test('gaps keep original keys and missing labels use source ordinal without inventing anatomy names',()=>{
  const source=decoded([preset(4,4,40),preset(0,0,10,'Actual source label'),preset(2,2,20,'')]);
  source.sourceWindowPresets.diagnostics=['INVALID_WINDOW_PAIR'];
  const result=buildWindowPresets(source,{selected:'source:4'});
  assert.deepEqual(result.options.map(option=>option.value),['initial','source:0','source:2','source:4']);
  assert.match(result.options[2].label,/^Source preset 3/);assert.match(result.options[3].label,/^Source preset 5/);
  assert.equal(result.selected,'source:4');assert.deepEqual(source.sourceWindowPresets.diagnostics,['INVALID_WINDOW_PAIR']);
});

test('duplicate numeric values and duplicate supplied labels remain independently indexed choices',()=>{
  const result=buildWindowPresets(decoded([preset(0,1,10,'Same supplied label'),preset(1,1,10,'Same supplied label'),preset(2,2,20,'Another')]),{selected:'source:1'});
  assert.equal(result.options.length,4);assert.equal(result.selected,'source:1');assert.deepEqual(result.options[1].window,result.options[2].window);
  assert.equal(result.options[1].label,result.options[2].label);assert.notEqual(result.options[1].value,result.options[2].value);
});

test('invalid widths, nonfinite values, unsupported functions and ambiguous duplicate indices never become choices',()=>{
  const choices=[preset(0,1,0),preset(1,NaN,10),preset(2,1,Infinity),preset(3,1,2,null,'UNKNOWN'),
    preset(4,1,0.5),preset(5,1,10),preset(5,2,20),preset(-1,1,10),preset(256,1,10),preset(1.5,1,10),null];
  const result=buildWindowPresets(decoded(choices));assert.deepEqual(result.options.map(option=>option.value),['initial']);assert.equal(result.hidden,true);
});

test('valid LINEAR_EXACT and SIGMOID widths below one are retained exactly',()=>{
  for(const functionValue of ['LINEAR_EXACT','SIGMOID']){
    const result=buildWindowPresets(decoded([preset(0,0,0.000001,null,functionValue)]),{selected:'source:0'});
    assert.equal(result.window.width,0.000001);assert.equal(result.window.function,functionValue);assert.match(result.options[1].label,/WW 1e-6/);
  }
});

test('wide finite values remain usable and label formatting does not round or clamp actual windows',()=>{
  const result=buildWindowPresets(decoded([preset(0,-1e100,1e200,null,'LINEAR_EXACT')]),{selected:'source:0'});
  assert.deepEqual(result.window,{center:-1e100,width:1e200,function:'LINEAR_EXACT'});assert.match(result.options[1].label,/WL -1e\+100 \/ WW 1e\+200/);
  assert.ok([...result.options[1].label].length<=80);
});

test('color hides source windows and normalizes its initial display function to LINEAR',()=>{
  const result=buildWindowPresets(decoded([preset(0,1,10)],{color:true,voiLUTFunction:'SIGMOID'}),{selected:'source:0'});
  assert.equal(result.hidden,true);assert.equal(result.options.length,1);assert.equal(result.selected,'initial');assert.equal(result.window.function,'LINEAR');
});

test('source label text remains inert, single-line and bounded without changing source records',()=>{
  const label='<script>\nwindow.example=1</script>\u202e'+'漢😀'.repeat(100),source=decoded([preset(0,50,500,label,'SIGMOID')]);
  const before=JSON.stringify(source),result=buildWindowPresets(source);
  assert.match(result.options[1].label,/^<script> window.example=1<\/script>/);assert.ok(!/[\r\n\u202e]/.test(result.options[1].label));
  assert.ok([...result.options[1].label].length<=80);assert.match(result.options[1].label,/SIGMOID$/);assert.equal(JSON.stringify(source),before);
});

test('invalid or missing initial display, malformed preset arrays and absent selected keys fail safely',()=>{
  for(const source of [null,{},decoded([],{windowWidth:0}),decoded([],{windowCenter:NaN}),decoded([],{voiLUTFunction:'UNKNOWN'})]){
    const result=buildWindowPresets(source);assert.equal(result.hidden,true);assert.equal(result.window,null);assert.deepEqual(result.options,[]);
  }
  for(const selected of ['source:100','source:01','other',null,{}])assert.equal(buildWindowPresets(decoded([preset(0,2,20)]),{selected}).selected,'initial');
  const huge=decoded(Array.from({length:257},(_,index)=>preset(index,1,10)));assert.equal(buildWindowPresets(huge).options.length,1);
  const malformed=decoded();malformed.sourceWindowPresets.presets={};assert.equal(buildWindowPresets(malformed).options.length,1);
});
