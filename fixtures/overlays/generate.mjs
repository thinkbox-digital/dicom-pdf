import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// All pixels come from the checked-in mathematical phantom, never a patient image.
// No build dependencies are needed: node fixtures/overlays/generate.mjs
const repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const target=join(repository,'target');
const destination=resolve(process.argv[2]||join(target,'overlay-inputs'));
const evidence=resolve(process.argv[3]||join(target,'overlay-fixtures'));
for(const directory of [destination,evidence]){
  const path=relative(target,directory);
  if(!path||path.startsWith('..')||isAbsolute(path))throw new Error('Generated overlay inputs and expectations must stay in a subdirectory of target/.');
}
const text=value=>Buffer.from(String(value),'utf8'),concat=(...parts)=>Buffer.concat(parts.map(part=>Buffer.from(part)));
const LONG=new Set(['OB','OD','OF','OL','OV','OW','SQ','UC','UN','UR','UT','SV','UV']);
function element(tag,vr,value){
  let bytes=typeof value==='string'?text(value):Buffer.from(value);
  if(bytes.length%2)bytes=concat(bytes,Buffer.from([['UI','OB','OW'].includes(vr)?0:32]));
  const header=Buffer.alloc(LONG.has(vr)?12:8);
  header.writeUInt16LE(parseInt(tag.slice(0,4),16),0);header.writeUInt16LE(parseInt(tag.slice(4),16),2);header.write(vr,4,2,'ascii');
  if(LONG.has(vr))header.writeUInt32LE(bytes.length,8);else header.writeUInt16LE(bytes.length,6);
  return concat(header,bytes);
}
function numeric(value,bytes=2){const result=Buffer.alloc(bytes);if(bytes===2)result.writeUInt16LE(value);else result.writeUInt32LE(value);return result;}
function sequence(items){return concat(...items.map(attributes=>{
  const body=attributesBytes(attributes),header=Buffer.alloc(8);header.writeUInt16LE(0xfffe,0);header.writeUInt16LE(0xe000,2);header.writeUInt32LE(body.length,4);return concat(header,body);
}));}
function attributesBytes(attributes){return concat(...attributes.slice().sort(([a],[b])=>a.localeCompare(b)).map(([tag,vr,value])=>element(tag,vr,value)));}
function phantom(bytes){
  if(bytes.subarray(128,132).toString('ascii')!=='DICM')throw new Error('Synthetic source needs its Part10 header.');
  const values=new Map();let position=132;
  while(position<bytes.length){
    if(position+8>bytes.length)throw new Error('Synthetic source has a truncated element.');
    const tag=bytes.readUInt16LE(position).toString(16).padStart(4,'0')+bytes.readUInt16LE(position+2).toString(16).padStart(4,'0');
    const vr=bytes.toString('ascii',position+4,position+6),long=LONG.has(vr),header=long?12:8;
    if(position+header>bytes.length)throw new Error('Synthetic source has a truncated header.');
    const size=long?bytes.readUInt32LE(position+8):bytes.readUInt16LE(position+6),start=position+header;
    if(size===0xffffffff||start+size>bytes.length)throw new Error('Synthetic source must contain bounded explicit-VR elements.');
    values.set(tag,bytes.subarray(start,start+size));position=start+size;
  }
  const string=tag=>values.get(tag)?.toString('ascii').replace(/[\0 ]+$/,'');
  const number=tag=>values.get(tag)?.readUInt16LE(0),rows=number('00280010'),columns=number('00280011');
  if(string('00020010')!=='1.2.840.10008.1.2.1'||string('00280004')!=='MONOCHROME2'||number('00280002')!==1
      ||number('00280100')!==8||number('00280103')!==0||!rows||!columns||values.get('7fe00010')?.length<rows*columns)
    throw new Error('Synthetic source must be unsigned8-bit native grayscale.');
  return {rows,columns,pixels:Buffer.from(values.get('7fe00010').subarray(0,rows*columns))};
}
const source=phantom(await readFile(join(repository,'fixtures/expanded/sc-native-gray8.dcm')));
const axial=[1,0,0,0,1,0],second=[0,1,0,-1,0,0];
const axialMarkers={top:'A',right:'L',bottom:'P',left:'R'},secondMarkers={top:'L',right:'P',bottom:'R',left:'A'};
const noMarkers={top:null,right:null,bottom:null,left:null};
const orientation=(iop,provenance='top-level',anatomicalOrientationType=null)=>({iop,anatomicalOrientationType,provenance});
const plane=iop=>['00209116','SQ',sequence([[['00200037','DS',Array.isArray(iop)?iop.join('\\'):iop]]])];
const specs=[
  {filename:'01-axial.dcm',description:'Synthetic axial orientation',iop:axial,expected:[{sourceOrientation:orientation(axial),markers:axialMarkers}]},
  {filename:'02-enhanced-two-frames.dcm',description:'Synthetic per-frame orientation',enhanced:true,frameIop:[axial,second],expected:[
    {sourceOrientation:orientation(axial,'per-frame-functional-groups'),markers:axialMarkers},
    {sourceOrientation:orientation(second,'per-frame-functional-groups'),markers:secondMarkers}]},
  {filename:'03-malformed-frame-orientation.dcm',description:'Synthetic malformed orientation',enhanced:true,iop:axial,frameIop:['1\\0'],expected:[{sourceOrientation:null,markers:noMarkers}]},
  {filename:'04-quadruped.dcm',description:'Synthetic quadruped orientation',iop:axial,anatomy:'QUADRUPED',expected:[{sourceOrientation:orientation(axial,'top-level','QUADRUPED'),markers:noMarkers}]},
  {filename:'05-non-square.dcm',description:'Synthetic non-square pixels',iop:axial,spacing:[0.4,0.2],expected:[{sourceOrientation:orientation(axial),markers:axialMarkers}]},
];
const syntax='1.2.840.10008.1.2.1',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const expectations={schemaVersion:1,synthetic:true,sourceFixture:'fixtures/expanded/sc-native-gray8.dcm',sourceFixtureSha256:sha(await readFile(join(repository,'fixtures/expanded/sc-native-gray8.dcm'))),files:{}};
await mkdir(destination,{recursive:true});await mkdir(evidence,{recursive:true});
for(const [index,spec] of specs.entries()){
  const frameCount=spec.expected.length,bits=spec.enhanced?16:8,sop=spec.enhanced?'1.2.840.10008.5.1.4.1.1.4.1':'1.2.840.10008.5.1.4.1.1.7';
  const uid='2.25.811'+(index+1),frames=[];
  for(let frame=0;frame<frameCount;frame++){
    const pixels=Buffer.alloc(source.rows*source.columns*(bits/8));
    for(let pixel=0;pixel<source.pixels.length;pixel++){
      const value=frame===0?source.pixels[pixel]:255-source.pixels[pixel];
      if(bits===16)pixels.writeUInt16LE(value*16,pixel*2);else pixels[pixel]=value;
    }
    frames.push(pixels);
  }
  const attrs=[['00080005','CS','ISO_IR 192'],['00080016','UI',sop],['00080018','UI',uid],['00080020','DA','20261115'],
    ['00080060','CS',spec.enhanced?'MR':'OT'],['00081030','LO','Synthetic overlay software checks'],['0008103e','LO',spec.description],
    ['00100010','PN','Synthetic^Overlay'],['00100020','LO','SYNTHETIC-OVERLAY'],['0020000d','UI','2.25.8110'],['0020000e','UI','2.25.812'+(index+1)],
    ['00200011','IS',String(index+1)],['00200013','IS','1'],['00280002','US',numeric(1)],['00280004','CS','MONOCHROME2'],
    ['00280010','US',numeric(source.rows)],['00280011','US',numeric(source.columns)],['00280100','US',numeric(bits)],['00280101','US',numeric(spec.enhanced?12:8)],
    ['00280102','US',numeric(spec.enhanced?11:7)],['00280103','US',numeric(0)],['00281050','DS',spec.enhanced?'2048':'128'],['00281051','DS',spec.enhanced?'4096':'256'],
    ['7fe00010',bits===16?'OW':'OB',concat(...frames)]];
  if(spec.iop)attrs.push(['00200037','DS',spec.iop.join('\\')]);
  if(spec.anatomy)attrs.push(['00102210','CS',spec.anatomy]);
  if(spec.spacing)attrs.push(['00280030','DS',spec.spacing.join('\\')]);
  if(spec.enhanced){
    attrs.push(['00280008','IS',String(frameCount)],['52009230','SQ',sequence(spec.frameIop.map((iop,frame)=>[
      plane(iop),['00209113','SQ',sequence([[['00200032','DS','0\\0\\'+frame]]])],
    ]))]);
  }
  const meta=attributesBytes([['00020001','OB',Buffer.from([0,1])],['00020002','UI',sop],['00020003','UI',uid],['00020010','UI',syntax],['00020012','UI','2.25.8199']]);
  const prefix=Buffer.alloc(132);prefix.write('DICM',128,'ascii');
  const bytes=concat(prefix,element('00020000','UL',numeric(meta.length,4)),meta,attributesBytes(attrs));
  await writeFile(join(destination,spec.filename),bytes);
  expectations.files[spec.filename]={sha256:sha(bytes),size:bytes.length,seriesDescription:spec.description,seriesNumber:index+1,studyDate:'20261115',
    rows:source.rows,columns:source.columns,bitsAllocated:bits,frameCount,pixelAspectRatio:spec.spacing?spec.spacing[0]/spec.spacing[1]:1,
    window:{center:spec.enhanced?2048:128,width:spec.enhanced?4096:256},
    frames:spec.expected.map((expected,frame)=>({frame:frame+1,...expected,pixelSha256:sha(frames[frame])}))};
}
await writeFile(join(evidence,'expectations.json'),JSON.stringify(expectations,null,2)+'\n');
console.log('Generated 5 synthetic overlay DICOM inputs and independent expectations under target/.');
