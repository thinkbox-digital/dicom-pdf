import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeDicom} from '../native-dicom.mjs';
const fixtureRoot = new URL('../../fixtures/synthetic/', import.meta.url);
const read = file => new Uint8Array(fs.readFileSync(new URL(file, fixtureRoot)));
for (const syntax of ['explicit-le', 'implicit-le', 'explicit-be']) {
  for (const [bits,signed] of [[8,false],[8,true],[16,false],[16,true]]) {
    for (const mono of [1,2]) {
      const name = `${syntax}-${bits}-${signed?'signed':'unsigned'}-mono${mono}.dcm`;
      test(`decode ${name}: independent expected phantom sample and polarity`, ()=> {
        const {image} = decodeDicom(read(name), 'test:fixture');
        assert.equal(image.rows, 128); assert.equal(image.columns,192);
        assert.equal(image.invert, mono === 1);
        const range = bits === 8 ? 256 : 4096;
        const minimum = signed ? -range / 2 : 0;
        assert.equal(image.getPixelData()[0],minimum + Math.round(.04*(range-1)));
        assert.equal(image.windowWidth,range);
        assert.equal(image.windowCenter,minimum+range/2);
      });
    }
  }
}
for (const file of ['unsupported/corrupt.dcm', 'unsupported/empty.dcm']) {
 test(`reject ${file} without rendering misleading pixels`,()=>assert.throws(()=>decodeDicom(read(file),'test:unsupported')));
}

for (const file of ['unsupported/color.dcm','unsupported/multiframe.dcm','unsupported/deflated.dcm','explicit-le-8-signed-mono1.dcm']) {
 test(`generic profile decodes previously excluded ${file}`,()=>{
  const decoded=decodeDicom(read(file),'test:expanded-scope');
  assert.equal(decoded.image.rows,128);assert.equal(decoded.image.columns,192);
 });
}

import {applyPreviewDisplay} from '../native-dicom.mjs';
const preview = () => ({status:'rendered', displayRejected:false, sourceFrame:1, displayAdjustments:{
  windowCenter:'128.0',windowWidth:'200.0',rescaleSlope:'1.0',rescaleIntercept:'0.0',
  invert:'false',rotationDegrees:'0.0',flipHorizontal:'false',flipVertical:'false',
  overlayPolicy:'disabled',windowMethod:'source-window-0',voiLUTFunction:'LINEAR',pixelAspectRatio:'1:1'
}});
const mono2 = () => decodeDicom(read('explicit-le-8-unsigned-mono2.dcm'), 'test:preview');
test('version 2 preview applies recorded window baseline over source defaults', () => {
  const decoded = applyPreviewDisplay(mono2(), preview());
  assert.equal(decoded.image.windowCenter,128);
  assert.equal(decoded.image.windowWidth,200);
});
for (const [key,value] of [['sourceFrame',2],['displayRejected',true]]) {
  test(`version 2 rejects unsupported ${key}`, () => {
    const entry=preview();entry[key]=value;
    assert.throws(()=>applyPreviewDisplay(mono2(),entry));
  });
}
for (const [key,value] of [['windowWidth','0'],['windowCenter','NaN'],['rescaleSlope','2'],['invert','true'],['flipHorizontal','true'],['overlayPolicy','enabled']]) {
  test(`version 2 rejects misleading preview ${key}`, () => {
    const entry=preview();entry.displayAdjustments[key]=value;
    assert.throws(()=>applyPreviewDisplay(mono2(),entry));
  });
}
test('version 2 decoder uses the stored preview baseline from the start', () => {
  const entry=preview();entry.displayAdjustments.windowCenter='42';
  const decoded=decodeDicom(read('explicit-le-8-unsigned-mono2.dcm'),'test:preview',entry);
  assert.equal(decoded.image.windowCenter,42);
  assert.equal(decoded.image.windowWidth,200);
});
test('version 2 accepts source rescale rounded to the recorded dcm4che float', () => {
  const entry=preview();entry.displayAdjustments.rescaleSlope='0.12345679';
  const decoded=mono2();decoded.image.slope=0.123456789;
  applyPreviewDisplay(decoded,entry);
  assert.equal(decoded.image.slope,0.12345679);
});
