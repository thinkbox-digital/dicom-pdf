import test from 'node:test';
import assert from 'node:assert/strict';
import {readDicomDocument} from '../dicom-document.mjs';
import {parseDicomCompatible} from '../dicom-parser-compat.mjs';
import {SURFACE_SEGMENTATION_SOP,surfaceSegmentationSource} from '../surface-segmentation.mjs';

const longVrs=new Set(['OF','OL','OW','SQ','UN']);
const defaultPoints=[0,0,0,1,0,0,1,1,0,0,1,0];

function surfaceFile({syntax='1.2.840.10008.1.2.1',legacy=false,count=4,points=defaultPoints,normals=null,
    indices=[1,2,3],extra=[],surfaceCount=1,opacity=0.5}={}){
  const little=syntax!=='1.2.840.10008.1.2.2',explicit=syntax!=='1.2.840.10008.1.2';
  function binary(values,width,kind,le=little){
    const bytes=Buffer.alloc(width*values.length),view=new DataView(bytes.buffer);
    for(let i=0;i<values.length;i++)view[kind](i*width,values[i],le);
    return bytes;
  }
  function element(tag,vr,value,le=little,ex=explicit){
    let bytes=typeof value==='string'?Buffer.from(value):value;
    if(bytes.length%2)bytes=Buffer.concat([bytes,Buffer.of(vr==='UI'?0:32)]);
    const long=ex&&longVrs.has(vr),header=Buffer.alloc(long?12:8),view=new DataView(header.buffer);
    view.setUint16(0,parseInt(tag.slice(0,4),16),le);
    view.setUint16(2,parseInt(tag.slice(4),16),le);
    if(ex){
      header.write(vr,4,2,'ascii');
      if(long)view.setUint32(8,bytes.length,le);
      else view.setUint16(6,bytes.length,le);
    }else view.setUint32(4,bytes.length,le);
    return Buffer.concat([header,bytes]);
  }
  const ul=(tag,value)=>element(tag,'UL',binary([value],4,'setUint32'));
  const of=(tag,values)=>element(tag,'OF',binary(values,4,'setFloat32'));
  const index=(modern,old,values)=>legacy
    ?element(old,'OW',binary(values,2,'setUint16'))
    :element(modern,'OL',binary(values,4,'setUint32'));
  const seq=(tag,items)=>element(tag,'SQ',Buffer.concat(items.map(values=>
    element('FFFEE000','',Buffer.concat(values),little,false))));
  const tags={
    strip:'00660026',fan:'00660027',path:'00660028',facet:'00660034',
    edge:['00660042','00660024'],vertex:['00660043','00660025'],
  };
  const primitives=[
    index('00660041','00660023',indices),
    ...extra.map(([kind,values])=>Array.isArray(tags[kind])
      ?index(...tags[kind],values)
      :seq(tags[kind],[[index('00660040','00660029',values)]])),
  ];
  const surface=[
    ul('00660003',1),element('0066000C','FL',binary([opacity],4,'setFloat32')),
    element('0066000D','CS','SURFACE'),
    seq('00660011',[[ul('00660015',count),of('00660016',points)]]),
    ...(normals?[
      seq('00660012',[[ul('0066001E',count),element('0066001F','US',binary([3],2,'setUint16')),
        of('00660021',normals)]]),
    ]:[]),
    seq('00660013',[primitives]),
  ];
  const prefix=Buffer.alloc(132);
  prefix.write('DICM',128,4,'ascii');
  return new Uint8Array(Buffer.concat([
    prefix,element('00020002','UI',SURFACE_SEGMENTATION_SOP,true,true),element('00020010','UI',syntax,true,true),
    element('00080005','CS','ISO_IR 192'),element('00080016','UI',SURFACE_SEGMENTATION_SOP),
    seq('00620002',[[element('00620005','LO','Test surface é'),seq('0066002B',[[ul('0066002C',1)]])]]),
    ul('00660001',surfaceCount),seq('00660002',[surface]),
  ]));
}

test('Surface Segmentation reads legacy OW indices, normals and inherited labels without modifying source bytes',()=>{
  const normals=[0,0,1,0,0,1,0,0,1,0,0,1];
  const bytes=surfaceFile({legacy:true,normals,indices:[1,2,4,3,4,2],opacity:0}),before=bytes.slice();
  const result=readDicomDocument(bytes);
  assert.equal(result.kind,'surface-segmentation');
  const [surface]=result.content.surfaces;
  assert.equal(surface.number,1);
  assert.equal(surface.label,'Test surface é');
  assert.equal(surface.opacity,0);
  assert.equal(surface.presentation,'SURFACE');
  assert.deepEqual(surface.points,Float32Array.from(defaultPoints));
  assert.deepEqual(surface.normals,Float32Array.from(normals));
  assert.deepEqual(surface.triangles,Uint32Array.of(3,0,1,3,3,2,3,1));
  assert.deepEqual(bytes,before);
});

test('Surface Segmentation preserves long indices outside the 16-bit range in implicit and big-endian inputs',()=>{
  const count=65538,points=new Float32Array(count*3);
  points.set([-2.5,3.25,1],0);
  points.set([4,3,2.25],(count-1)*3);
  for(const syntax of ['1.2.840.10008.1.2','1.2.840.10008.1.2.2']){
    const result=readDicomDocument(surfaceFile({count,points,indices:[1,65537,65538],syntax}));
    assert.equal(result.kind,'surface-segmentation');
    const [surface]=result.content.surfaces;
    assert.deepEqual(surface.points.slice(0,3),Float32Array.of(-2.5,3.25,1));
    assert.deepEqual(surface.points.slice(-3),Float32Array.of(4,3,2.25));
    assert.deepEqual(surface.triangles,Uint32Array.of(3,0,65536,65537));
    assert.equal(surface.normals,null);
  }
});

test('Surface Segmentation reads strips, fans, facets, paths, standalone edges, and vertices',()=>{
  const extra=[
    ['strip',[1,2,4,3]],['fan',[1,2,3,4]],['facet',[2,3,4]],
    ['edge',[2,3]],['path',[4,3,2]],['vertex',[1,4]],
  ];
  for(const legacy of [true,false]){
    const [surface]=surfaceSegmentationSource(parseDicomCompatible(surfaceFile({legacy,indices:[],extra}))).surfaces;
    assert.deepEqual(surface.triangles,Uint32Array.of(3,0,1,3,3,1,2,3,3,0,1,2,3,0,2,3,3,1,2,3));
    assert.deepEqual(surface.lines,Uint32Array.of(2,1,2,3,3,2,1));
    assert.deepEqual(surface.vertices,Uint32Array.of(1,0,1,3));
  }
});

test('Surface Segmentation rejects malformed mesh data and preserves safe viewer limits',()=>{
  const parse=options=>surfaceSegmentationSource(parseDicomCompatible(surfaceFile(options)));
  assert.throws(()=>parse({indices:[0,2,3]}),/outside the surface/);
  assert.throws(()=>parse({indices:[1,2,5]}),/outside the surface/);
  assert.throws(()=>parse({indices:[1,2]}),/invalid point count/);
  assert.throws(()=>parse({count:5}),/vector count/);
  assert.throws(()=>parse({points:[NaN,...defaultPoints.slice(1)]}),/non-finite coordinate/);
  assert.throws(()=>parse({normals:[0,0,1]}),/vector count/);
  assert.throws(()=>parse({surfaceCount:2}),/surface count/);
  assert.throws(()=>parse({indices:[],extra:[['facet',[1,2,3,4]]]}),/more than three points/);
  assert.throws(()=>parse({indices:[]}),/no mesh primitives/);
  const ds=parseDicomCompatible(surfaceFile());
  assert.throws(()=>surfaceSegmentationSource(ds,{residentBytes:Number.MAX_SAFE_INTEGER}),{code:'RESOURCE_LIMIT'});
});
