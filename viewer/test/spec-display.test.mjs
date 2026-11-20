import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDicom,applyPreviewDisplay} from '../native-dicom.mjs';
import {createDecoderWorkerRuntime} from '../dicom-worker.mjs';
import {createWindowRenderer} from '../cpu-window-renderer.mjs';
import {thumbnailPixels} from '../view-controls.mjs';
import {buildStoredVoiLut} from '../voi-window.mjs';
import {PARAMETRIC_MAP_SOP} from '../parametric-map.mjs';

const concat=(...parts)=>Buffer.concat(parts.map(part=>Buffer.from(part)));
const text=value=>Buffer.from(String(value),'ascii');
function integer(value,signed=false,little=true){const data=Buffer.alloc(2);data[signed?(little?'writeInt16LE':'writeInt16BE'):(little?'writeUInt16LE':'writeUInt16BE')](value);return data;}
function length(value,little=true){const data=Buffer.alloc(4);data[little?'writeUInt32LE':'writeUInt32BE'](value);return data;}
function element(tag,vr,value,little=true){
  let data=Buffer.from(value);if(data.length%2)data=concat(data,Buffer.from([['UI','OB','OW'].includes(vr)?0:32]));
  const key=concat(integer(parseInt(tag.slice(0,4),16),false,little),integer(parseInt(tag.slice(4),16),false,little));
  return ['OB','OD','OF','OW','SQ','UN','UT'].includes(vr)?concat(key,text(vr),Buffer.alloc(2),length(data.length,little),data):concat(key,text(vr),integer(data.length,false,little),data);
}
function item(attributes,little=true){const bytes=concat(...attributes.map(([tag,vr,value])=>element(tag,vr,value,little)));return concat(integer(0xfffe,false,little),integer(0xe000,false,little),length(bytes.length,little),bytes);}
function dicom({pixels=[0,0,100,200],signed=false,stored=16,bits=16,high=stored-1,rows=2,columns=2,padding,limit,slope,intercept,center,width,extra=[],little=true,
  photo='MONOCHROME2',samples=1,planar,pixelVR='OW',pixelBytes,pixelTag='7FE00010',sop='1.2.840.10008.5.1.4.1.1.7',
  syntax=little?'1.2.840.10008.1.2.1':'1.2.840.10008.1.2.2'}={}){
  const uid='2.25.900000000000000001';
  const meta=concat(element('00020001','OB',Buffer.from([0,1])),element('00020002','UI',text(sop)),
    element('00020003','UI',text(uid)),element('00020010','UI',text(syntax)),element('00020012','UI',text('2.25.900000000000000002')));
  const attributes=[['00080016','UI',text(sop)],['00080018','UI',text(uid)],
    ['00280002','US',integer(samples,false,little)],['00280004','CS',text(photo)],
    ['00280010','US',integer(rows,false,little)],['00280011','US',integer(columns,false,little)],
    ['00280100','US',integer(bits,false,little)], ...extra];
  if(pixelTag==='7FE00010')attributes.push(['00280101','US',integer(stored,false,little)],
    ['00280102','US',integer(high,false,little)],['00280103','US',integer(signed?1:0,false,little)]);
  if(planar!==undefined)attributes.push(['00280006','US',integer(planar,false,little)]);
  for(const [value,tag] of [[padding,'00280120'],[limit,'00280121']])if(value!==undefined)attributes.push([tag,signed?'SS':'US',integer(value,signed,little)]);
  for(const [value,tag] of [[slope,'00281053'],[intercept,'00281052'],[center,'00281050'],[width,'00281051']])if(value!==undefined)attributes.push([tag,'DS',text(value)]);
  const data=concat(...attributes.sort(([a],[b])=>a.localeCompare(b)).map(([tag,vr,value])=>element(tag,vr,value,little)));
  const samplesBytes=pixelBytes??concat(...pixels.map(value=>integer(value,signed,little)));
  const pixelData=element(pixelTag,pixelVR,samplesBytes,little);
  if(syntax==='1.2.840.10008.1.2.5')pixelData.writeUInt32LE(0xffffffff,8);
  return new Uint8Array(concat(Buffer.alloc(128),text('DICM'),element('00020000','UL',length(meta.length)),meta,data,pixelData));
}
function preview(overrides={}){return {status:'rendered',displayRejected:false,sourceFrame:1,displayAdjustments:{
  windowCenter:'150.5',windowWidth:'101',rescaleSlope:'1',rescaleIntercept:'0',invert:'false',rotationDegrees:'0',
  flipHorizontal:'false',flipVertical:'false',overlayPolicy:'disabled',windowMethod:'auto-min-max-padding-v2',voiLUTFunction:'LINEAR',
  pixelAspectRatio:'1:1',paddingPolicy:'exclude-stored-range',pixelPaddingMin:'0',pixelPaddingMax:'0',...overrides}};}

test('Parametric Maps preserve fractional multi-frame OF and OD samples and apply each frame window',()=>{
  for(const [bits,little,pixelTag,pixelVR,FloatArray] of [
    [32,true,'7FE00008','OF',Float32Array],[64,false,'7FE00009','OD',Float64Array]
  ]){
    const values=[0,NaN,0.125,-Infinity,-2,-1,-0.5,Infinity],pixelBytes=Buffer.alloc(values.length*bits/8);
    const view=new DataView(pixelBytes.buffer,pixelBytes.byteOffset,pixelBytes.length);
    values.forEach((value,index)=>bits===32?view.setFloat32(index*4,value,little):view.setFloat64(index*8,value,little));
    const window=(center,width)=>item([['00289132','SQ',item([
      ['00281050','DS',text(center)],['00281051','DS',text(width)],['00281056','CS',text('LINEAR_EXACT')],
    ],little)]],little);
    const options={sop:PARAMETRIC_MAP_SOP,bits,little,pixelTag,pixelVR,pixelBytes,
      extra:[['00280008','IS',text(2)],['52009230','SQ',concat(window(0.125,0.25),window(-1,2))]]};
    const bytes=dicom(options),snapshot=bytes.slice();
    for(const [frame,center,width,gray] of [[1,0.125,0.25,[0,0,128,0]],[2,-1,2,[0,128,191,0]]]){
      const decoded=decodeDicom(bytes,'map',null,frame),image=decoded.image;
      assert.ok(image.getPixelData() instanceof FloatArray);
      assert.deepEqual([...image.getPixelData()],values.slice((frame-1)*4,frame*4));
      assert.deepEqual([decoded.frameCount,image.windowCenter,image.windowWidth,image.voiLUTFunction],[2,center,width,'LINEAR_EXACT']);
      assert.deepEqual([...thumbnailPixels(decoded).pixels].filter((_,index)=>index%4===0),gray);
    }
    assert.deepEqual(bytes,snapshot);
    assert.throws(()=>decodeDicom(dicom({...options,bits:16}),'bad-map'),/floating-point pixel encoding/);
    assert.throws(()=>decodeDicom(dicom({...options,pixelBytes:pixelBytes.subarray(0,-bits/8)}),'short-map'),/Pixel Data length/);
  }
  const integerMap=decodeDicom(dicom({sop:PARAMETRIC_MAP_SOP,pixels:[0,1,10,120]}),'integer-map');
  assert.deepEqual([...integerMap.image.getPixelData()],[0,1,10,120]);
});

test('floating-point Parametric Map fallback windows exclude padding and non-finite samples',()=>{
  const values=new Float32Array([-999,NaN,-0.25,0.25]),bytes=Buffer.alloc(16);
  values.forEach((value,index)=>bytes.writeFloatLE(value,index*4));
  const padding=Buffer.alloc(4);padding.writeFloatLE(-999);
  const decoded=decodeDicom(dicom({sop:PARAMETRIC_MAP_SOP,bits:32,pixelTag:'7FE00008',pixelVR:'OF',pixelBytes:bytes,
    extra:[['00280122','FL',padding],['00280124','FL',padding]]}),'map-padding');
  assert.deepEqual([decoded.image.windowCenter,decoded.image.windowWidth,decoded.image.voiLUTFunction],[0,0.5,'LINEAR_EXACT']);
  assert.deepEqual([...thumbnailPixels(decoded).pixels].filter((_,index)=>index%4===0),[0,0,0,255]);
});

test('automatic window excludes stored padding but keeps original samples and full min/max',()=>{
  const bytes=dicom({padding:0}),before=bytes.slice(),decoded=decodeDicom(bytes,'test:padding');
  assert.equal(decoded.image.windowWidth,101);assert.equal(decoded.image.windowCenter,150.5);
  assert.equal(decoded.image.minPixelValue,0);assert.equal(decoded.image.maxPixelValue,200);
  assert.deepEqual([...decoded.image.getPixelData()],[0,0,100,200]);assert.deepEqual(bytes,before);
  assert.equal(decoded.sourceDisplay.validMin,100);assert.equal(decoded.sourceDisplay.validMax,200);
});
test('interactive grayscale display windows a single zero center and width from non-padding pixels',()=>{
  const bytes=dicom({center:0,width:0,padding:0,intercept:-1000}),before=bytes.slice();
  const decoded=decodeDicom(bytes,'test:zero-window');
  assert.deepEqual([decoded.image.windowCenter,decoded.image.windowWidth,decoded.image.voiLUTFunction],[-849.5,101,'LINEAR']);
  assert.equal(decoded.sourceDisplay.zeroWindowFallback,true);
  assert.equal(decoded.sourceDisplay.hasSourceWindow,false);
  assert.deepEqual(decoded.sourceWindowPresets.presets,[]);
  assert.deepEqual([...decoded.image.getPixelData()],[0,0,100,200]);
  assert.deepEqual(bytes,before);
  const recorded=preview({windowMethod:'source-window-0',rescaleIntercept:'-1000',windowCenter:'-900',windowWidth:'200'});
  const baseline=decodeDicom(bytes,'test:recorded-window',recorded);
  assert.deepEqual([baseline.image.windowCenter,baseline.image.windowWidth],[-900,200]);
  assert.equal(baseline.sourceDisplay.zeroWindowFallback,false);
});
test('signed padding interval is excluded before a negative-slope rescale, including big-endian data',()=>{
  for(const little of [true,false]){
    const decoded=decodeDicom(dicom({pixels:[-2048,-2040,-100,100],signed:true,stored:12,padding:-2048,limit:-2000,slope:-2,intercept:100,little}),'test:signed-padding');
    assert.equal(decoded.image.windowWidth,401);assert.equal(decoded.image.windowCenter,100.5);
    assert.equal(decoded.image.minPixelValue,-2048);assert.equal(decoded.image.maxPixelValue,100);
    assert.deepEqual(decoded.sourceDisplay.padding,{minimum:-2048,maximum:-2000});
  }
});
test('all-padding images require an explicit window; zero-width and absent windows are not fabricated',()=>{
  const options={pixels:[0,0,0,0],padding:0};
  assert.throws(()=>decodeDicom(dicom(options),'test:all-padding'),/No non-padding pixels/);
  const explicit=decodeDicom(dicom({...options,center:12,width:20}),'test:source-window');
  assert.equal(explicit.image.windowCenter,12);assert.equal(explicit.image.windowWidth,20);
  assert.throws(()=>decodeDicom(dicom({...options,center:12,width:0}),'test:zero-width'),/window/);
  assert.throws(()=>decodeDicom(dicom({...options,center:0,width:0}),'test:zero-window-padding'),/No non-padding pixels/);
  assert.throws(()=>decodeDicom(dicom({center:'0\\1',width:'0\\0'}),'test:invalid-multi-window'),/Invalid window center\/width/);
});
test('explicit source windows remain unchanged and do not interpret unrelated invalid padding',()=>{
  const decoded=decodeDicom(dicom({pixels:[1,2,3,4],stored:8,padding:500,center:128,width:256}),'test:explicit-window');
  assert.equal(decoded.image.windowCenter,128);assert.equal(decoded.image.windowWidth,256);
});
test('new padding recipe verifies source interval, policy and derived window',()=>{
  const bytes=dicom({padding:0});
  assert.equal(decodeDicom(bytes,'test:padding-recipe',preview()).image.windowCenter,150.5);
  for(const overrides of [{pixelPaddingMin:'1'},{pixelPaddingMax:'10'},{paddingPolicy:'include'},{windowWidth:'200'},{windowCenter:'0'}])
    assert.throws(()=>decodeDicom(bytes,'test:wrong-padding-recipe',preview(overrides)),/padding|Padding/);
  assert.throws(()=>decodeDicom(dicom({padding:0,center:128,width:256}),'test:not-auto',preview()),/source windowing/);
});
test('recorded automatic previews accept a single source zero window',()=>{
  const bytes=dicom({padding:0,center:0,width:0});
  const image=decodeDicom(bytes,'test:recorded-padding',preview());
  assert.equal(image.image.windowCenter,150.5);
  assert.equal(image.sourceDisplay.zeroWindowFallback,true);
  const noPadding=dicom({center:0,width:0});
  const automatic=preview({windowMethod:'auto-min-max-v1',windowCenter:'100.5',windowWidth:'201'});
  assert.equal(decodeDicom(noPadding,'test:zero-window',automatic).image.windowWidth,201);
});
test('legacy automatic recipes preserve recorded all-padding windows and historical square geometry',()=>{
  const bytes=dicom({pixels:[0,0,0,0],padding:0,extra:[['00280030','DS',text('2\\1')]]});
  const entry=preview({windowMethod:'auto-min-max-v1',windowCenter:'0.5',windowWidth:'1'});
  const decoded=decodeDicom(bytes,'test:legacy-window',entry);
  assert.equal(decoded.image.windowCenter,0.5);assert.equal(decoded.image.windowWidth,1);
  assert.equal(decoded.image.rowPixelSpacing,1);assert.equal(decoded.metadata.imagePlaneModule.rowPixelSpacing,1);
});
test('PixelSpacing preserves relative image aspect without introducing calibrated millimetres',()=>{
  const decoded=decodeDicom(dicom({extra:[['00280030','DS',text('0.4\\0.2')]]}),'test:pixel-spacing');
  assert.equal(decoded.image.rowPixelSpacing,2);assert.equal(decoded.image.columnPixelSpacing,1);
  assert.equal(decoded.metadata.imagePlaneModule.rowPixelSpacing,2);assert.equal(decoded.metadata.imagePlaneModule.columnPixelSpacing,1);
  assert.equal(decoded.metadata.imagePlaneModule.usingDefaultValues,true);
  assert.deepEqual(decoded.sourceDisplay.geometry,{ratio:2,source:'PixelSpacing'});
});
test('aspect fallbacks select imager, nominal spacing and integer pixel aspect in documented order',()=>{
  for(const [extra,ratio,source] of [
    [[['00181164','DS',text('0.2\\0.4')],['00182010','DS',text('0.3\\0.1')]],0.5,'ImagerPixelSpacing'],
    [[['00182010','DS',text('0.3\\0.1')]],3,'NominalScannedPixelSpacing'],
    [[['00280034','IS',text('3\\2')]],1.5,'PixelAspectRatio'],
    [[],1,'default'],
  ]){
    const decoded=decodeDicom(dicom({extra}),'test:aspect-fallback');assert.ok(Math.abs(decoded.image.rowPixelSpacing-ratio)<1e-12);
    assert.equal(decoded.sourceDisplay.geometry.source,source);
  }
});
test('functional-group PixelMeasures spacing has precedence over root spacing',()=>{
  for(const tag of ['52009229','52009230']){
    const measures=element('00289110','SQ',item([['00280030','DS',text('0.6\\0.2')]]));
    const group=concat(integer(0xfffe),integer(0xe000),length(measures.length),measures);
    const decoded=decodeDicom(dicom({extra:[['00280030','DS',text('0.2\\0.2')],[tag,'SQ',group]]}),'test:functional-aspect');
    assert.ok(Math.abs(decoded.image.rowPixelSpacing-3)<1e-12);assert.equal(decoded.sourceDisplay.geometry.source,'functional-groups.PixelSpacing');
  }
});
test('invalid first-present geometry is rejected; only corresponding singleton spacing may be zero',()=>{
  for(const [tag,vr,value] of [['00280030','DS','2'],['00280030','DS','0\\1'],['00280030','DS','-1\\1'],['00280030','DS','1e20\\1']]){
    const fallback=tag==='00280030'?[['00182010','DS',text('1\\1')]]:[];
    assert.throws(()=>decodeDicom(dicom({extra:[[tag,vr,text(value)],...fallback]}),'test:invalid-aspect'),/aspect|spacing/);
  }
  const singleton=decodeDicom(dicom({rows:1,columns:4,extra:[['00280030','DS',text('0\\1')]]}),'test:singleton');
  assert.equal(singleton.image.rowPixelSpacing,1);assert.equal(singleton.image.columnPixelSpacing,1);
});
test('an invalid PixelAspectRatio uses square pixels only in the interactive view',()=>{
  for(const value of ['01','1.5\\1','0\\1']){
    const bytes=dicom({extra:[['00280034','IS',text(value)]]});
    const decoded=decodeDicom(bytes,'test:aspect-warning');
    assert.equal(decoded.image.rowPixelSpacing,1);
    assert.equal(decoded.image.columnPixelSpacing,1);
    assert.equal(decoded.sourceDisplay.geometry.source,'invalid-pixel-aspect-ratio');
    assert.match(decoded.sourceDisplay.geometry.warning,/aspect ratio is unverified/);
    assert.throws(()=>decodeDicom(bytes,'test:archival-aspect',preview({
      geometryMethod:'source-aspect-v1',geometrySource:'PixelAspectRatio',
    })),/Invalid PixelAspectRatio/);
  }
});
test('two zero PixelSpacing values allow a warned, unitless image without a PDF geometry recipe',()=>{
  const bytes=dicom({padding:0,extra:[['00280030','DS',text('0.000\\0.000')],['00182010','DS',text('2\\1')]]});
  const original=bytes.slice(), decoded=decodeDicom(bytes,'test:zero-spacing');
  assert.equal(decoded.image.rowPixelSpacing,1);
  assert.equal(decoded.image.columnPixelSpacing,1);
  assert.equal(decoded.sourceDisplay.geometry.source,'zero-pixel-spacing');
  assert.match(decoded.sourceDisplay.geometry.warning,/aspect ratio is unverified/);
  assert.deepEqual(bytes,original);
  const recipe=preview({geometryMethod:'source-aspect-v1',geometrySource:'PixelSpacing'});
  assert.throws(()=>decodeDicom(bytes,'test:recorded-spacing',recipe),/Invalid PixelSpacing/);
  assert.throws(()=>applyPreviewDisplay(decoded,preview({...recipe.displayAdjustments,geometrySource:'zero-pixel-spacing'})),/aspect source/);
});

test('16-bit RGB scales the stored channel range in both byte orders and planar layouts',()=>{
  for(const little of [true,false]){
    for(const [planar,pixels] of [[0,[0,2048,4095,4095,1024,0]],[1,[0,4095,2048,1024,4095,0]]]){
      const bytes=dicom({photo:'RGB',samples:3,planar,stored:12,rows:1,columns:2,pixels,little});
      const original=bytes.slice(), {image}=decodeDicom(bytes,'test:rgb16');
      assert.deepEqual([...image.getPixelData()],[0,128,255,255,255,64,0,255]);
      assert.deepEqual(bytes,original);
    }
  }
  assert.throws(()=>decodeDicom(dicom({photo:'YBR_FULL',samples:3}),'test:ybr16'),/color pixel encoding/);
});

const rgb32={photo:'RGB',samples:3,bits:32,stored:32,rows:1,columns:2,planar:0};
const twoRgbPixels=[64,128,191,255,255,0,128,255];
test('32-bit RGB keeps unsigned scale for native interleaved and planar samples in both byte orders',()=>{
  for(const [little,pixelVR,planar,hex] of [
    [true,'OW',0,'00010040 00020080 000300c0 ffffffff 00000000 00040080'],
    [true,'OW',1,'00010040 ffffffff 00020080 00000000 000300c0 00040080'],
    [false,'OW',0,'01004000 02008000 0300c000 ffffffff 00000000 04008000'],
    [false,'OB',0,'40000100 80000200 c0000300 ffffffff 00000000 80000400'],
  ]){
    const bytes=dicom({...rgb32,little,pixelVR,planar,pixelBytes:Buffer.from(hex.replaceAll(' ',''),'hex')});
    const original=bytes.slice(),{image,metadata}=decodeDicom(bytes,'test:rgb32');
    assert.deepEqual([...image.getPixelData()],twoRgbPixels);
    assert.equal(metadata.imagePixelModule.bitsStored,32);
    assert.deepEqual(bytes,original);
  }
});

test('32-bit RGB honors Bits Stored and High Bit and rejects unsupported 32-bit layouts',()=>{
  const pixelBytes=Buffer.from('030000f8050000f4f7ffffff','hex');
  const bytes=dicom({...rgb32,columns:1,stored:24,high:27,pixelBytes});
  assert.deepEqual([...decodeDicom(bytes,'test:shifted-rgb32').image.getPixelData()],[128,64,255,255]);
  for(const unsupported of [{signed:true}, {photo:'YBR_FULL'}, {planar:2}]){
    assert.throws(()=>decodeDicom(dicom({...rgb32,...unsupported,pixelBytes}),'test:invalid-rgb32'),/integer pixel encoding/);
  }
});

test('32-bit RGB RLE combines twelve byte planes in RGB and descending significance order',()=>{
  const frame=Buffer.alloc(64+12*4);
  frame.writeUInt32LE(12);
  const first=Buffer.from('4000010080000200c0000300','hex'),second=Buffer.from('ffffffff0000000080000400','hex');
  for(let i=0;i<12;i++){
    const offset=64+i*4;
    frame.writeUInt32LE(offset,4+i*4);
    frame.set([1,first[i],second[i],0],offset);
  }
  const emptyOffsets=concat(integer(0xfffe),integer(0xe000),length(0));
  const itemHeader=concat(integer(0xfffe),integer(0xe000),length(frame.length));
  const end=concat(integer(0xfffe),integer(0xe0dd),length(0));
  const bytes=dicom({...rgb32,planar:1,syntax:'1.2.840.10008.1.2.5',pixelVR:'OB',
    pixelBytes:concat(emptyOffsets,itemHeader,frame,end)});
  assert.deepEqual([...decodeDicom(bytes,'test:rle-rgb32').image.getPixelData()],twoRgbPixels);
});

test('segmented color palettes expand discrete, linear, and indirect words before mapping indices',()=>{
  for(const little of [true,false]){
    const words=values=>concat(...values.map(value=>integer(value,false,little)));
    const palette=(first,middle,end)=>words([0,2,first,middle,1,2,end,2,1,0,0]);
    const extra=[
      ...['1','2','3'].map(channel=>['0028110'+channel,'US',words([6,10,16])]),
      ['00281221','OW',palette(0,16384,49152)],
      ['00281222','OW',palette(65280,48896,16128)],
      ['00281223','OW',palette(32768,32768,32768)],
    ];
    const pixels=[9,10,11,12,13,14,15,16];
    const {image}=decodeDicom(dicom({photo:'PALETTE COLOR',rows:2,columns:4,pixels,little,extra}),'test:segmented-color');
    assert.deepEqual([...image.getPixelData()],[
      0,255,128,255, 0,255,128,255, 64,191,128,255, 128,127,128,255,
      192,63,128,255, 0,255,128,255, 64,191,128,255, 64,191,128,255,
    ]);
    for(const malformed of [[1,6,255],[0,1,255,2,1,6,0],[0,1,255,2,1,2,0],[0,7,0,0,0,0,0,0,0]]){
      const broken=[...extra.slice(0,-1),['00281223','OW',words(malformed)]];
      assert.throws(()=>decodeDicom(dicom({photo:'PALETTE COLOR',rows:2,columns:4,pixels,little,extra:broken}),'test:invalid-palette'),/Invalid segmented palette LUT/);
    }
  }
});

test('Modality LUT preserves signed stored pixels and windows the mapped non-padding range',()=>{
  for(const little of [true,false]){
    const words=values=>concat(...values.map(value=>integer(value,false,little)));
    const lut=item([['00283002','SS',words([4,65534,16])],['00283006','US',words([900,100,500,25])]],little);
    const bytes=dicom({signed:true,pixels:[-8,-1,0,5],padding:-8,little,extra:[['00283000','SQ',lut]]});
    const source=bytes.slice(), decoded=decodeDicom(bytes,'test:modality-lut');
    assert.deepEqual([...decoded.image.getPixelData()],[-8,-1,0,5]);
    assert.deepEqual(bytes,source);
    assert.deepEqual(decoded.range,[25,900]);
    assert.equal(decoded.image.windowWidth,476);
    assert.equal(decoded.image.windowCenter,263);
    const pixels=thumbnailPixels(decoded).pixels;
    assert.deepEqual([pixels[0],pixels[4],pixels[8],pixels[12]],[255,40,255,0]);
    const renderer=createWindowRenderer(decoded.image);
    assert.equal(typeof decoded.image.render,'function');
    renderer.destroy();
    assert.equal(decoded.image.render,undefined);
    assert.throws(()=>applyPreviewDisplay(decoded,preview()),/preview does not support a Modality LUT/);
    assert.throws(()=>decodeDicom(dicom({slope:1,little,extra:[['00283000','SQ',lut]]}),'test:lut-and-rescale'),/LUT and rescale/);
    assert.throws(()=>decodeDicom(dicom({little,extra:[['00283000','SQ',concat(lut,lut)]]}),'test:multiple-modality-luts'),/Invalid Modality LUT/);
  }
});

test('Modality LUT decodes packed and word-aligned 8-bit entries in both byte orders',()=>{
  for(const little of [true,false]){
    const words=values=>concat(...values.map(value=>integer(value,false,little)));
    for(const [vr,data] of [['OW',words([0xa000,0x00ff])],['US',words([0,160,255])]]){
      const lut=item([['00283002','US',words([3,0,8])],['00283006',vr,data]],little);
      const {image}=decodeDicom(dicom({little,extra:[['00283000','SQ',lut]]}),'test:modality-lut-8');
      assert.deepEqual([...image.modalityLut.values],[0,160,255]);
    }
  }
});

test('sampled image Presentation LUT uses the full stored range or the explicit VOI window',()=>{
  const samples=[64,96,160,192];
  for(const little of [true,false]){
    const words=values=>concat(...values.map(value=>integer(value,false,little)));
    const lut=item([['00283002','US',words([4,0,12])],['00283006','US',words([32,1536,3072,4095])]],little);
    for(const [voi,expected] of [[{},[96,96,191,191]],[{center:128,width:128},[2,96,191,255]]]){
      const bytes=dicom({pixels:samples,stored:8,photo:'MONOCHROME1',little,extra:[['20500010','SQ',lut]],...voi});
      const original=bytes.slice(),decoded=decodeDicom(bytes,'test:presentation-lut'),{image}=decoded;
      const window={center:image.windowCenter,width:image.windowWidth,function:image.voiLUTFunction};
      const display=buildStoredVoiLut(image,window),inverted=buildStoredVoiLut(image,window,{invert:true});
      assert.equal(image.invert,false);
      assert.deepEqual([...image.getPixelData()],samples);
      assert.deepEqual(bytes,original);
      assert.deepEqual(samples.map(sample=>display.values[sample+display.offset]),expected);
      assert.deepEqual(samples.map(sample=>inverted.values[sample+inverted.offset]),expected.map(gray=>255-gray));
      assert.deepEqual([...thumbnailPixels(decoded).pixels].filter((_,index)=>index%4===0),expected);
      const renderer=createWindowRenderer(image);
      assert.equal(typeof image.render,'function');
      renderer.destroy();
    }
  }
});

test('sampled image Presentation LUT rejects invalid descriptors and entry lengths',()=>{
  const words=values=>concat(...values.map(value=>integer(value)));
  for(const [descriptor,entries] of [[[4,1,12],[32,1536,3072,4095]],[[4,0,7],[0,16,32,64]],[[5,0,12],[32,1536,3072,4095]]]){
    const lut=item([['00283002','US',words(descriptor)],['00283006','US',words(entries)]]);
    assert.throws(()=>decodeDicom(dicom({extra:[['20500010','SQ',lut]]}),'test:invalid-presentation-lut'),/Invalid Presentation LUT/);
  }
});

test('new geometry recipes check actual aspect and its source while old recipes keep square display',()=>{
  const bytes=dicom({padding:0,extra:[['00280030','DS',text('0.4\\0.2')]]});
  const entry=preview({geometryMethod:'source-aspect-v1',geometrySource:'PixelSpacing',pixelAspectRatio:'2.00000000001:1'});
  const decoded=decodeDicom(bytes,'test:geometry-recipe',entry);assert.ok(Math.abs(decoded.image.rowPixelSpacing-2)<1e-9);
  assert.equal(decoded.metadata.imagePlaneModule.columnPixelSpacing,1);
  for(const overrides of [{geometrySource:'ImagerPixelSpacing'},{pixelAspectRatio:'3:1'},{geometryMethod:'unknown'}])
    assert.throws(()=>decodeDicom(bytes,'test:wrong-geometry',preview({...entry.displayAdjustments,...overrides})),/geometry|aspect/);
  const legacy=preview({windowMethod:'auto-min-max-v1',windowCenter:'100.5',windowWidth:'201'});
  assert.equal(decodeDicom(bytes,'test:legacy-geometry',legacy).image.rowPixelSpacing,1);
  assert.equal(applyPreviewDisplay(decodeDicom(bytes,'test:apply-legacy'),legacy).image.rowPixelSpacing,1);
  const narrow=dicom({padding:0,extra:[['00280030','DS',text('0.000001\\1')]]});
  assert.throws(()=>decodeDicom(narrow,'test:relative-ratio',preview({geometryMethod:'source-aspect-v1',geometrySource:'PixelSpacing',pixelAspectRatio:'0.000002:1'})),/aspect/);
});


test('source orientation is explicit provenance and never changes default renderer geometry',()=>{
  const absent=decodeDicom(dicom(),'test:no-orientation');assert.equal(absent.sourceOrientation,null);
  for(const anatomy of [undefined,'BIPED','QUADRUPED']){
    const extra=[['00200037','DS',text('1\\0\\0\\0\\1\\0')],...(anatomy?[['00102210','CS',text(anatomy)]]:[])];
    const decoded=decodeDicom(dicom({extra}),'test:source-orientation');
    assert.deepEqual(decoded.sourceOrientation,{iop:[1,0,0,0,1,0],anatomicalOrientationType:anatomy??null,provenance:'top-level'});
    assert.deepEqual(decoded.metadata.imagePlaneModule,{rows:2,columns:2,rowPixelSpacing:1,columnPixelSpacing:1,usingDefaultValues:true});
    assert.equal(decoded.metadata.imagePlaneModule.rowCosines,undefined);assert.equal(decoded.metadata.imagePlaneModule.imagePositionPatient,undefined);
  }
});
test('orientation resolves the selected frame before shared and top-level source values',()=>{
  const macro=value=>['00209116','SQ',item([['00200037','DS',text(value)]])];
  const root=['00200037','DS',text('1\\0\\0\\0\\1\\0')];
  const shared=['52009229','SQ',item([macro('0\\1\\0\\0\\0\\1')])];
  const perFrame=['52009230','SQ',concat(item([macro('0\\0\\1\\1\\0\\0')]),item([macro('0\\-1\\0\\1\\0\\0')]))];
  const bytes=dicom({pixels:[0,1,2,3,4,5,6,7],extra:[root,shared,perFrame,['00280008','IS',text('2')]]}),before=bytes.slice();
  for(const [frame,iop] of [[1,[0,0,1,1,0,0]],[2,[0,-1,0,1,0,0]]]){
    const decoded=decodeDicom(bytes,'test:per-frame',null,frame);
    assert.equal(decoded.sourceFrame,frame);assert.deepEqual(decoded.sourceOrientation,{iop,anatomicalOrientationType:null,provenance:'per-frame-functional-groups'});
    assert.equal(decoded.metadata.imagePlaneModule.usingDefaultValues,true);
  }
  assert.deepEqual(bytes,before);
  assert.deepEqual(decodeDicom(dicom({extra:[root,shared]}),'test:shared').sourceOrientation,{iop:[0,1,0,0,0,1],anatomicalOrientationType:null,provenance:'shared-functional-groups'});
  // A frame with no orientation macro can use the actual shared macro.
  const noFrameMacro=['52009230','SQ',item([])];
  assert.equal(decodeDicom(dicom({extra:[root,shared,noFrameMacro]}),'test:shared-fallback').sourceOrientation.provenance,'shared-functional-groups');
});
test('malformed first-present orientation is omitted without borrowing lower-priority geometry',()=>{
  const validRoot=['00200037','DS',text('1\\0\\0\\0\\1\\0')];
  const validShared=['52009229','SQ',item([['00209116','SQ',item([validRoot])]])];
  for(const value of ['1\\0\\0','1\\0\\0\\0\\NaN\\0','0x1\\0\\0\\0\\1\\0','1\\0\\0\\0\\\\0','0\\0\\0\\0\\1\\0','1\\0\\0\\1\\0\\0','2\\0\\0\\0\\1\\0']){
    assert.equal(decodeDicom(dicom({extra:[['00200037','DS',text(value)]]}),'test:bad-root').sourceOrientation,null);
    const perFrame=['52009230','SQ',item([['00209116','SQ',item([['00200037','DS',text(value)]])]])];
    assert.equal(decodeDicom(dicom({extra:[validRoot,validShared,perFrame]}),'test:bad-frame').sourceOrientation,null);
  }
  for(const malformed of [Buffer.alloc(0),item([]),concat(item([validRoot]),item([validRoot]))]){
    const shared=['52009229','SQ',item([['00209116','SQ',malformed]])];
    assert.equal(decodeDicom(dicom({extra:[validRoot,shared]}),'test:bad-shared').sourceOrientation,null);
    const perFrame=['52009230','SQ',item([['00209116','SQ',malformed]])];
    assert.equal(decodeDicom(dicom({extra:[validRoot,validShared,perFrame]}),'test:bad-frame-macro').sourceOrientation,null);
  }
});


test('all source window alternatives survive PDF preview baseline adjustments unchanged',()=>{
  const bytes=dicom({center:'40\\80',width:'400\\1200',extra:[['00281055','LO',text('Supplied one\\Supplied two')]]}),before=bytes.slice();
  const decoded=decodeDicom(bytes,'test:source-windows');
  assert.deepEqual(decoded.sourceWindowPresets,{presets:[{index:0,center:40,width:400,label:'Supplied one',function:'LINEAR'},{index:1,center:80,width:1200,label:'Supplied two',function:'LINEAR'}],
    provenance:'top-level',functionExplicit:false,diagnostics:[]});
  const original=structuredClone(decoded.sourceWindowPresets);
  applyPreviewDisplay(decoded,preview({windowMethod:'source-window-0',windowCenter:'20',windowWidth:'200'}));
  assert.equal(decoded.image.windowCenter,20);assert.equal(decoded.image.windowWidth,200);assert.deepEqual(decoded.sourceWindowPresets,original);assert.deepEqual(bytes,before);
});

test('real worker structured cloning retains the selected frame source orientation and encoded bytes',async()=>{
  const macro=value=>['00209116','SQ',item([['00200037','DS',text(value)]])];
  const voi=(center,width,label)=>['00289132','SQ',item([['00281050','DS',text(center)],['00281051','DS',text(width)],['00281055','LO',text(label)]])];
  const bytes=dicom({pixels:[0,1,2,3,4,5,6,7],extra:[['00280008','IS',text('2')],['00102210','CS',text('BIPED')],
    ['52009230','SQ',concat(item([macro('1\\0\\0\\0\\1\\0'),voi('2\\3','5\\7','First\\Alternative')]),item([macro('0\\1\\0\\0\\0\\1'),voi('5','9','Second frame')]))]]}),before=bytes.slice();
  const key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
  const messages=[],runtime=createDecoderWorkerRuntime({postMessage:(message,transfers=[])=>messages.push(structuredClone(message,{transfer:transfers}))});
  await runtime.handleMessage({type:'register',id:1,epoch:0,key,bytes:structuredClone(bytes)});
  for(const [id,frame] of [[2,1],[3,2]])await runtime.handleMessage({type:'decode',id,epoch:0,key,imageId:'test:worker-'+frame,sourceFrame:frame});
  for(let count=0;count<100&&messages.filter(message=>message.type==='decoded').length<2;count++)await new Promise(resolve=>setTimeout(resolve,0));
  const results=messages.filter(message=>message.type==='decoded').map(message=>message.result);
  assert.equal(results.length,2);
  for(const [index,result] of results.entries()){
    assert.equal(result.sourceFrame,index+1);assert.equal(result.image.imageId,'test:worker-'+(index+1));
    assert.deepEqual(result.sourceOrientation,{iop:index===0?[1,0,0,0,1,0]:[0,1,0,0,0,1],anatomicalOrientationType:'BIPED',provenance:'per-frame-functional-groups'});
    assert.deepEqual(result.sourceWindowPresets,{presets:index===0?[{index:0,center:2,width:5,label:'First',function:'LINEAR'},{index:1,center:3,width:7,label:'Alternative',function:'LINEAR'}]:[{index:0,center:5,width:9,label:'Second frame',function:'LINEAR'}],provenance:'per-frame-functional-groups',functionExplicit:false,diagnostics:[]});
    assert.deepEqual([...result.pixels],index===0?[0,1,2,3]:[4,5,6,7]);
  }
  assert.deepEqual(bytes,before);
});


test('source and recorded preview allow positive fractional non-LINEAR widths without changing original samples',()=>{
  for(const functionValue of ['LINEAR_EXACT','SIGMOID']){
    const bytes=dicom({pixels:[0,1,2,3],center:0.25,width:0.5,slope:0.25,extra:[['00281056','CS',text(functionValue)]]}),before=bytes.slice();
    const decoded=decodeDicom(bytes,'test:fractional-width');assert.equal(decoded.image.windowWidth,0.5);assert.equal(decoded.image.voiLUTFunction,functionValue);
    assert.deepEqual(decoded.sourceWindowPresets.presets,[{index:0,center:0.25,width:0.5,label:null,function:functionValue}]);
    const entry=preview({windowMethod:'source-window-0',rescaleSlope:'0.25',windowCenter:'0.125',windowWidth:'0.25',voiLUTFunction:functionValue});
    applyPreviewDisplay(decoded,entry);assert.equal(decoded.image.windowWidth,0.25);assert.equal(decoded.image.windowCenter,0.125);assert.equal(decoded.image.voiLUTFunction,functionValue);
    assert.deepEqual([...decoded.image.getPixelData()],[0,1,2,3]);assert.deepEqual(bytes,before);
    assert.throws(()=>applyPreviewDisplay(decoded,preview({...entry.displayAdjustments,windowWidth:'0'})),/window/);
  }
  assert.throws(()=>decodeDicom(dicom({center:0.25,width:0.5}),'test:invalid-linear-width'),/window/);
});
