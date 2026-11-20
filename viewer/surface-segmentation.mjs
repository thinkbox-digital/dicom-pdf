import dicomParser from 'dicom-parser';
import {readDicomText} from './metadata-export.mjs';
import {workingMemoryBytes} from './working-memory.mjs';

export const SURFACE_SEGMENTATION_SOP='1.2.840.10008.5.1.4.1.1.66.5';

function sequence(ds,tag){
  const element=ds.elements[tag];
  if(!element)return [];
  if((element.vr&&element.vr!=='SQ'&&element.vr!=='UN')||(!element.items&&element.length!==0))
    throw new Error('A surface segmentation sequence is unreadable.');
  return element.items||[];
}

function singleItem(ds,tag,required=true){
  const items=sequence(ds,tag);
  if(!required&&!items.length)return null;
  if(items.length!==1||!items[0].dataSet)
    throw new Error('A surface segmentation sequence has an invalid item count.');
  return items[0].dataSet;
}

function binary(ds,tag,vr,width){
  const element=ds.elements[tag];
  if(!element||element.vr&&element.vr!==vr&&element.vr!=='UN'||element.hadUndefinedLength
    ||!Number.isSafeInteger(element.dataOffset)||element.dataOffset<0
    ||!Number.isSafeInteger(element.length)||element.length<0||element.length%width!==0
    ||element.dataOffset+element.length>ds.byteArray.length)
    throw new Error('A surface segmentation data element has an invalid byte layout.');
  return element;
}

function parserFor(ds,element){
  return element.vr==='UN'?dicomParser.littleEndianByteArrayParser:element.parser||ds.byteArrayParser;
}

function scalar(ds,tag,vr){
  const width=vr==='US'?2:4,element=binary(ds,tag,vr,width);
  if(element.length!==width)throw new Error('A surface segmentation attribute has an invalid length.');
  const parser=parserFor(ds,element);
  const read=vr==='FL'?parser.readFloat:vr==='US'?parser.readUint16:parser.readUint32;
  return read(ds.byteArray,element.dataOffset);
}

function vectors(ds,tag,count,reserve){
  const element=binary(ds,tag,'OF',4);
  if(element.length!==count*12)throw new Error('The surface vector count does not match its data.');
  reserve(element.length);
  // Read the validated value as a view to avoid dicom-parser's per-float
  // temporary allocations for these bulk coordinate and normal arrays.
  const bytes=ds.byteArray, view=new DataView(bytes.buffer,bytes.byteOffset+element.dataOffset,element.length);
  const values=new Float32Array(count*3),little=parserFor(ds,element)!==dicomParser.bigEndianByteArrayParser;
  for(let i=0;i<values.length;i++){
    const value=view.getFloat32(i*4,little);
    if(!Number.isFinite(value))throw new Error('The surface contains a non-finite coordinate or normal.');
    values[i]=value;
  }
  return values;
}

function indices(ds,modernTag,legacyTag,pointCount){
  // PS3.3 C.27.4 uses OL. The retired OW attributes carry 16-bit indices.
  const tag=ds.elements[modernTag]?.length?modernTag:ds.elements[legacyTag]?.length?legacyTag:null;
  if(!tag)return null;
  const modern=tag===modernTag,width=modern?4:2,element=binary(ds,tag,modern?'OL':'OW',width);
  const parser=parserFor(ds,element),read=modern?parser.readUint32:parser.readUint16;
  return {
    count:element.length/width,
    index(i){
      const value=read(ds.byteArray,element.dataOffset+i*width);
      if(value<1||value>pointCount)throw new Error('A surface primitive references a point outside the surface.');
      return value-1;
    },
  };
}

function readVertices(ds,pointCount,reserve){
  const stream=indices(ds,'x00660043','x00660025',pointCount);
  if(!stream)return new Uint32Array(0);
  const length=2*stream.count;
  reserveCells(length,stream.count,reserve);
  const cells=new Uint32Array(length);
  for(let i=0;i<stream.count;i++){
    cells[i*2]=1;
    cells[i*2+1]=stream.index(i);
  }
  return cells;
}

function sequenceIndices(ds,tag,pointCount,min,reserve){
  const items=sequence(ds,tag);
  reserve(items.length*64);
  return items.map(({dataSet})=>{
    const stream=dataSet&&indices(dataSet,'x00660040','x00660029',pointCount);
    if(!stream||stream.count<min)throw new Error('A surface primitive has an invalid point count.');
    return stream;
  });
}

function reserveCells(length,renderVertices,reserve){
  // vtk.js expands indexed cells into position and normal streams. Allow for
  // the CPU staging data and graphics buffers as well as the decoded cells.
  reserve(length*4+renderVertices*72);
}

function readTriangles(ds,pointCount,presentation,reserve){
  const list=indices(ds,'x00660041','x00660023',pointCount);
  if(list&&list.count%3!==0)throw new Error('A surface triangle list has an invalid point count.');
  const strips=sequenceIndices(ds,'x00660026',pointCount,3,reserve);
  const fans=sequenceIndices(ds,'x00660027',pointCount,3,reserve);
  const facets=sequenceIndices(ds,'x00660034',pointCount,3,reserve);
  if(facets.some(facet=>facet.count!==3))
    throw new Error('Surface facets with more than three points are unsupported.');
  const count=(list?.count||0)/3+facets.length
    +strips.reduce((total,strip)=>total+strip.count-2,0)
    +fans.reduce((total,fan)=>total+fan.count-2,0);
  reserveCells(count*4,count*(presentation==='WIREFRAME'?6:3),reserve);
  const triangles=new Uint32Array(count*4);
  let offset=0;
  function triangle(a,b,c){
    triangles[offset++]=3;
    triangles[offset++]=a;
    triangles[offset++]=b;
    triangles[offset++]=c;
  }
  if(list)for(let i=0;i<list.count;i+=3)triangle(list.index(i),list.index(i+1),list.index(i+2));
  for(const strip of strips){
    for(let i=0;i<strip.count-2;i++){
      // Alternate winding to preserve each strip triangle's normal direction.
      const flip=i%2;
      triangle(strip.index(i),strip.index(i+1+flip),strip.index(i+2-flip));
    }
  }
  for(const fan of fans){
    const center=fan.index(0);
    for(let i=1;i<fan.count-1;i++)triangle(center,fan.index(i),fan.index(i+1));
  }
  for(const facet of facets)triangle(facet.index(0),facet.index(1),facet.index(2));
  return triangles;
}

function readLines(ds,pointCount,reserve){
  const edges=indices(ds,'x00660042','x00660024',pointCount);
  if(edges&&edges.count%2!==0)throw new Error('A surface edge list has an invalid point count.');
  const paths=sequenceIndices(ds,'x00660028',pointCount,2,reserve);
  const edgeCount=(edges?.count||0)/2;
  const length=3*edgeCount+paths.reduce((total,path)=>total+path.count+1,0);
  const drawVertices=2*(edgeCount+paths.reduce((total,path)=>total+path.count-1,0));
  reserveCells(length,drawVertices,reserve);
  const lines=new Uint32Array(length);
  let offset=0;
  if(edges)for(let i=0;i<edges.count;i+=2){
    lines[offset++]=2;
    lines[offset++]=edges.index(i);
    lines[offset++]=edges.index(i+1);
  }
  for(const path of paths){
    lines[offset++]=path.count;
    for(let i=0;i<path.count;i++)lines[offset++]=path.index(i);
  }
  return lines;
}

function surfaceLabels(ds,reserve){
  const labels=new Map(),characterSet=readDicomText(ds,'x00080005')||'';
  for(const {dataSet:segment} of sequence(ds,'x00620002')){
    if(!segment)continue;
    const label=readDicomText(segment,'x00620005',characterSet);
    if(!label)continue;
    const references=sequence(segment,'x0066002b');
    reserve(references.length*32+label.length*2);
    for(const {dataSet:reference} of references){
      const number=reference?.uint32('x0066002c');
      if(number&&!labels.has(number))labels.set(number,label);
    }
  }
  return labels;
}

/** Decode Surface Segmentation Storage into zero-based vtk.js cell arrays. */
export function surfaceSegmentationSource(ds,{residentBytes=ds.byteArray.byteLength}={}){
  let remaining=workingMemoryBytes()-Math.max(residentBytes,ds.byteArray.byteLength);
  function reserve(bytes){
    if(!Number.isSafeInteger(remaining)||!Number.isSafeInteger(bytes)||bytes<0||bytes>remaining)
      throw Object.assign(new Error('The surface mesh exceeds the viewing memory limit.'),{code:'RESOURCE_LIMIT'});
    remaining-=bytes;
  }
  const items=sequence(ds,'x00660002');
  if(!items.length||scalar(ds,'x00660001','UL')!==items.length)
    throw new Error('The surface count does not match the DICOM Surface Sequence.');
  reserve(items.length*1024);
  const labels=surfaceLabels(ds,reserve),numbers=new Set();
  const surfaces=items.map(({dataSet:surface})=>{
    const number=surface&&scalar(surface,'x00660003','UL');
    if(!number||number>items.length||numbers.has(number))
      throw new Error('The surface has an invalid or duplicate surface number.');
    numbers.add(number);
    const coordinates=singleItem(surface,'x00660011'),count=scalar(coordinates,'x00660015','UL');
    if(!count)throw new Error('The surface has no point coordinates.');
    const points=vectors(coordinates,'x00660016',count,reserve);
    const normalItem=singleItem(surface,'x00660012',false);
    if(normalItem&&(scalar(normalItem,'x0066001e','UL')!==count||scalar(normalItem,'x0066001f','US')!==3))
      throw new Error('The surface normal count or dimensionality is invalid.');
    const normals=normalItem?vectors(normalItem,'x00660021',count,reserve):null;
    const primitives=singleItem(surface,'x00660013');
    const presentation=surface.string('x0066000d')?.trim();
    const triangles=readTriangles(primitives,count,presentation,reserve),lines=readLines(primitives,count,reserve);
    const vertices=readVertices(primitives,count,reserve);
    if(!triangles.length&&!lines.length&&!vertices.length)
      throw new Error('The surface has no mesh primitives to display.');
    const opacity=surface.elements.x0066000c?.length===4?scalar(surface,'x0066000c','FL'):null;
    return {number,label:labels.get(number)||'Surface '+number,points,normals,triangles,lines,vertices,
      opacity:Number.isFinite(opacity)&&opacity>=0&&opacity<=1?opacity:null,
      presentation:['SURFACE','WIREFRAME','POINTS'].includes(presentation)?presentation:null};
  });
  return {surfaces};
}
