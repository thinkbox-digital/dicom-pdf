import test from 'node:test';
import assert from 'node:assert/strict';
import {validWindow,normalizeWindow,voiValue,buildStoredVoiLut,windowInputValue} from '../voi-window.mjs';
const window=(center,width,functionValue='LINEAR')=>({center,width,function:functionValue});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} differs from ${expected}`);

test('window validation honors function-specific widths and refuses unsupported or nonnumeric values',()=>{
  assert.equal(validWindow(window(0,1)),true);assert.equal(validWindow(window(0,0.5)),false);
  for(const kind of ['LINEAR_EXACT','SIGMOID']){assert.equal(validWindow(window(-5.25,0.5,kind)),true);assert.equal(validWindow(window(0,0,kind)),false);}
  for(const invalid of [null,{},window('0',1),window(0,'1'),window(NaN,1),window(0,Infinity),window(0,-1),window(0,1,'UNKNOWN')]){
    assert.equal(validWindow(invalid),false);assert.throws(()=>normalizeWindow(invalid),/invalid|unsupported/);
  }
  assert.deepEqual(normalizeWindow({center:12,width:100}),window(12,100));assert.equal(Object.isFrozen(normalizeWindow(window(0,1))),true);
});
test('normative LINEAR example c2048,w4096 maps every unsigned12-bit sample without integer truncation',()=>{
  const preset=window(2048,4096);
  assert.equal(voiValue(-1,preset),0);assert.equal(voiValue(0,preset),0);assert.equal(voiValue(4095,preset),255);assert.equal(voiValue(4096,preset),255);
  near(voiValue(2047.5,preset),127.5);near(voiValue(1024,preset),1024/4095*255);
});
test('LINEAR width1 threshold defines equality without division by zero',()=>{
  for(const center of [0,0.5,5.5,-9]){
    const preset=window(center,1);assert.equal(voiValue(center-0.5,preset),0);
    assert.equal(voiValue(center-0.50001,preset),0);assert.equal(voiValue(center-0.49999,preset),255);
  }
});
test('LINEAR_EXACT uses its distinct boundaries and supports positive fractional windows',()=>{
  const preset=window(0.5,1,'LINEAR_EXACT');assert.equal(voiValue(0,preset),0);near(voiValue(0.5,preset),127.5);assert.equal(voiValue(1,preset),255);
  near(voiValue(0.25,preset),63.75);assert.equal(voiValue(-1,preset),0);assert.equal(voiValue(2,preset),255);
  const fractional=window(-2,0.5,'LINEAR_EXACT');near(voiValue(-2,fractional),127.5);assert.equal(voiValue(-2.25,fractional),0);assert.equal(voiValue(-1.75,fractional),255);
  assert.notEqual(voiValue(0.5,window(0.5,1)),voiValue(0.5,preset));
});
test('SIGMOID applies the DICOM four-over-width exponent with stable saturation and symmetry',()=>{
  const preset=window(-0.25,0.5,'SIGMOID');near(voiValue(-0.25,preset),127.5);
  near(voiValue(-0.125,preset),255/(1+Math.exp(-1)));near(voiValue(-0.375,preset),255/(1+Math.exp(1)));
  near(voiValue(-0.125,preset)+voiValue(-0.375,preset),255);
  assert.equal(voiValue(-1e6,preset),0);assert.equal(voiValue(1e6,preset),255);
});
test('stored-value LUT applies signed fractional negative rescale before VOI and polarity without mutating source',()=>{
  const pixels=new Int16Array([-2,-1,0,1,2]),before=pixels.slice(),image={minPixelValue:-2,maxPixelValue:2,slope:-0.5,intercept:0.25,getPixelData:()=>pixels};
  const preset=window(0.25,2,'LINEAR_EXACT'),lut=buildStoredVoiLut(image,preset);
  assert.equal(lut.offset,2);assert.equal(lut.minimum,-2);assert.equal(lut.maximum,2);assert.deepEqual([...lut.values],[255,191,128,64,0]);
  assert.deepEqual([...buildStoredVoiLut(image,preset,{invert:true}).values],[0,64,128,191,255]);assert.deepEqual(pixels,before);
});
test('sampled VOI clamps signed descriptors after the Modality LUT and preserves exact adjustable output',()=>{
  const image={minPixelValue:-3,maxPixelValue:1,
    modalityLut:{first:-2,values:new Uint16Array([4,5,6])},
    sampledVoiLut:{first:4,bits:16,values:new Uint16Array([0,96*257,65535])}};
  const samples=[-3,-2,-1,0,1];
  assert.deepEqual(samples.map(sample=>windowInputValue(image,sample)),[0,0,96,255,255]);
  const preset=window(96,96,'LINEAR_EXACT');
  assert.deepEqual([...buildStoredVoiLut(image,preset).values],[0,0,128,255,255]);
  assert.deepEqual([...buildStoredVoiLut(image,preset,{invert:true}).values],[255,255,128,0,0]);
});
test('sampled VOI retains descriptor precision where Cornerstone would shift or truncate entries',()=>{
  const image={minPixelValue:0,maxPixelValue:2,sampledVoiLut:{first:0,bits:16,values:new Uint16Array([0,16,65535])}};
  assert.equal(windowInputValue(image,1),16*255/65535);
  assert.deepEqual([...buildStoredVoiLut(image,window(0.125,0.25,'LINEAR_EXACT')).values],[0,64,255]);
  image.sampledVoiLut={first:0,bits:8,values:new Uint16Array([0,7,63])};
  assert.deepEqual([...buildStoredVoiLut(image,window(127.5,255,'LINEAR_EXACT')).values],[0,7,63]);
});
test('LUT has at most65536entries and refuses noninteger, excessive or overflowing sample transformations',()=>{
  const preset=window(0,1,'SIGMOID');assert.equal(buildStoredVoiLut({minPixelValue:-32768,maxPixelValue:32767,slope:1,intercept:0},preset).values.length,65536);
  for(const invalid of [{minPixelValue:-32768,maxPixelValue:65535},{minPixelValue:0.1,maxPixelValue:1},{minPixelValue:2,maxPixelValue:1},{minPixelValue:0,maxPixelValue:65536},
    {minPixelValue:0,maxPixelValue:1,slope:0},{minPixelValue:0,maxPixelValue:1,intercept:Infinity},{minPixelValue:1,maxPixelValue:2,slope:Number.MAX_VALUE}])
    assert.throws(()=>buildStoredVoiLut(invalid,preset),/invalid|excessive|exceeds/);
  assert.throws(()=>voiValue(Infinity,preset),/invalid/);
});
