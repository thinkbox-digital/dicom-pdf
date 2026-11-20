import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Pure mathematical fixtures. This generator deliberately imports no viewer,
// decoder, VOI implementation or clinical images: expected window parameters
// and stored samples support an independent DICOM-equation oracle.
const repository=resolve(fileURLToPath(new URL('../..',import.meta.url))),target=join(repository,'target');
const destination=resolve(process.argv[2]||join(target,'window-inputs'));
const evidence=resolve(process.argv[3]||join(target,'window-fixtures'));
for(const directory of [destination,evidence]){
  const path=relative(target,directory);
  if(!path||path.startsWith('..')||isAbsolute(path))throw new Error('Generated window inputs and expectations must stay in a subdirectory of target/.');
}
const concat=(...parts)=>Buffer.concat(parts.map(part=>Buffer.from(part)));
const LONG=new Set(['OB','OD','OF','OL','OV','OW','SQ','UC','UN','UR','UT','SV','UV']);
function element(tag,vr,value){
  let bytes=typeof value==='string'?Buffer.from(value,'utf8'):Buffer.from(value);
  if(bytes.length%2)bytes=concat(bytes,Buffer.from([['UI','OB','OW'].includes(vr)?0:32]));
  const header=Buffer.alloc(LONG.has(vr)?12:8);header.writeUInt16LE(parseInt(tag.slice(0,4),16),0);header.writeUInt16LE(parseInt(tag.slice(4),16),2);header.write(vr,4,2,'ascii');
  if(LONG.has(vr))header.writeUInt32LE(bytes.length,8);else header.writeUInt16LE(bytes.length,6);return concat(header,bytes);
}
function numeric(value,size=2){const bytes=Buffer.alloc(size);if(size===2)bytes.writeUInt16LE(value);else bytes.writeUInt32LE(value);return bytes;}
function attributes(list){return concat(...list.slice().sort(([a],[b])=>a.localeCompare(b)).map(([tag,vr,value])=>element(tag,vr,value)));}
function sequence(items){return concat(...items.map(list=>{
  const body=attributes(list),header=Buffer.alloc(8);header.writeUInt16LE(0xfffe,0);header.writeUInt16LE(0xe000,2);header.writeUInt32LE(body.length,4);return concat(header,body);
}));}
const ROWS=24,COLUMNS=32,COUNT=ROWS*COLUMNS;
const gradient=Array.from({length:COUNT},(_,index)=>(index%COLUMNS*17+Math.floor(index/COLUMNS)*11)%256);
const boundaries=[-16,-8,-4,-2,-1,0,1,2,4,8,16];
const signed=Array.from({length:COUNT},(_,index)=>boundaries[(index+Math.floor(index/COLUMNS))%boundaries.length]);
const shape=(center,width,kind='LINEAR')=>({center,width,function:kind});
const row=(index,center,width,label,kind='LINEAR')=>({index,center,width,label,function:kind});
const presets=(values,{provenance='top-level',diagnostics=[],functionExplicit=true}={})=>({presets:values,provenance,functionExplicit,diagnostics});
function frame(pixels,baselineWindow,sourceWindowPresets,{slope=1,intercept=0,invert=false}={}){return {storedPixels:pixels,slope,intercept,invert,baselineWindow,sourceWindowPresets};}
const basicRows=[row(0,128,256,'Source full range'),row(1,64,64,'Source narrow'),row(2,128,128,'Source narrow')];
const specs=[
  {filename:'01-multiple-windows.dcm',description:'Synthetic supplied multiple windows',center:'128\\64\\128',width:'256\\64\\128',labels:'Source full range\\Source narrow\\Source narrow',kind:'LINEAR',
    frames:[frame(gradient,shape(128,256),presets(basicRows))]},
  {filename:'02-linear-exact.dcm',description:'Synthetic LINEAR_EXACT windows',center:'0.5\\0.5',width:'2\\0.5',labels:'Source wide exact\\Source narrow exact',kind:'LINEAR_EXACT',slope:1/256,
    frames:[frame(gradient,shape(0.5,2,'LINEAR_EXACT'),presets([row(0,0.5,2,'Source wide exact','LINEAR_EXACT'),row(1,0.5,0.5,'Source narrow exact','LINEAR_EXACT')]),{slope:1/256})]},
  {filename:'03-sigmoid.dcm',description:'Synthetic SIGMOID windows',center:'0.5\\0.5',width:'2\\0.5',labels:'Source wide sigmoid\\Source narrow sigmoid',kind:'SIGMOID',slope:1/256,
    frames:[frame(gradient,shape(0.5,2,'SIGMOID'),presets([row(0,0.5,2,'Source wide sigmoid','SIGMOID'),row(1,0.5,0.5,'Source narrow sigmoid','SIGMOID')]),{slope:1/256})]},
  {filename:'04-first-narrow-linear-exact.dcm',description:'Synthetic narrow initial LINEAR_EXACT',center:'0.5\\0.5',width:'0.5\\2',labels:'Source initial narrow exact\\Source wide exact',kind:'LINEAR_EXACT',slope:1/256,creatorPreviewExpected:false,
    frames:[frame(gradient,shape(0.5,0.5,'LINEAR_EXACT'),presets([row(0,0.5,0.5,'Source initial narrow exact','LINEAR_EXACT'),row(1,0.5,2,'Source wide exact','LINEAR_EXACT')]),{slope:1/256})]},
  {filename:'05-first-narrow-sigmoid.dcm',description:'Synthetic narrow initial SIGMOID',center:'0.5\\0.5',width:'0.5\\2',labels:'Source initial narrow sigmoid\\Source wide sigmoid',kind:'SIGMOID',slope:1/256,creatorPreviewExpected:false,
    frames:[frame(gradient,shape(0.5,0.5,'SIGMOID'),presets([row(0,0.5,0.5,'Source initial narrow sigmoid','SIGMOID'),row(1,0.5,2,'Source wide sigmoid','SIGMOID')]),{slope:1/256})]},
  {filename:'06-signed-negative-fractional.dcm',description:'Synthetic signed fractional negative rescale',bits:16,signed:true,slope:-0.25,intercept:0.125,center:'0.125\\0.125',width:'4\\0.5',labels:'Source signed wide\\Source signed narrow',kind:'LINEAR_EXACT',
    frames:[frame(signed,shape(0.125,4,'LINEAR_EXACT'),presets([row(0,0.125,4,'Source signed wide','LINEAR_EXACT'),row(1,0.125,0.5,'Source signed narrow','LINEAR_EXACT')]),{slope:-0.25,intercept:0.125})]},
  {filename:'07-monochrome1-threshold.dcm',description:'Synthetic MONOCHROME1 threshold',photo:'MONOCHROME1',center:'128\\100.5',width:'256\\1',labels:'Source inverted range\\Source threshold',kind:'LINEAR',
    frames:[frame(gradient,shape(128,256),presets([row(0,128,256,'Source inverted range'),row(1,100.5,1,'Source threshold')]),{invert:true})]},
  {filename:'08-enhanced-frame-windows.dcm',description:'Synthetic per-frame window alternatives',enhanced:true,bits:16,
    frameVoi:[{center:'128\\80',width:'256\\64',labels:'Frame one full\\Frame one alternative',kind:'LINEAR'},
      {center:'64\\180',width:'128\\80',labels:'Frame two full\\Frame two alternative',kind:'SIGMOID'}],
    frames:[frame(gradient,shape(128,256),presets([row(0,128,256,'Frame one full'),row(1,80,64,'Frame one alternative')],{provenance:'per-frame-functional-groups'})),
      frame(gradient.map(value=>255-value),shape(64,128,'SIGMOID'),presets([row(0,64,128,'Frame two full','SIGMOID'),row(1,180,80,'Frame two alternative','SIGMOID')],{provenance:'per-frame-functional-groups'}))]},
  {filename:'09-mismatched-window-vm.dcm',description:'Synthetic mismatched center width VM',center:'128\\64',width:'256',labels:'Full\\Second',kind:'LINEAR',
    frames:[frame(gradient,shape(128,256),presets([],{diagnostics:['WINDOW_VM_MISMATCH']}))]},
  {filename:'10-mismatched-label-vm.dcm',description:'Synthetic mismatched explanation VM',center:'128\\64',width:'256\\64',labels:'Only one supplied explanation',kind:'LINEAR',
    frames:[frame(gradient,shape(128,256),presets([row(0,128,256,null),row(1,64,64,null)],{diagnostics:['WINDOW_LABEL_VM_MISMATCH']}))]},
  {filename:'11-invalid-pair-stable-index.dcm',description:'Synthetic omitted invalid pair index',center:'128\\NaN\\64',width:'256\\128\\64',labels:'First supplied\\Invalid supplied\\Third supplied',kind:'LINEAR',
    frames:[frame(gradient,shape(128,256),presets([row(0,128,256,'First supplied'),row(2,64,64,'Third supplied')],{diagnostics:['INVALID_WINDOW_PAIR']}))]},
  {filename:'12-malformed-frame-voi.dcm',description:'Synthetic malformed frame VOI no fallback',enhanced:true,bits:16,center:'128\\64',width:'256\\64',labels:'Root full\\Root alternative',kind:'LINEAR',frameVoi:[null],
    frames:[frame(gradient,shape(128,256),presets([],{provenance:'per-frame-functional-groups',functionExplicit:false,diagnostics:['MALFORMED_FRAME_VOI_MACRO']}))]},
  {filename:'13-color-ignores-window-tags.dcm',description:'Synthetic color has no window menu',photo:'RGB',samples:3,center:'128\\64',width:'256\\64',labels:'Unusable color window\\Unusable color alternative',kind:'SIGMOID',
    frames:[frame(gradient.flatMap((value,index)=>[value,255-value,(index*13)%256]),shape(127.5,255,'SIGMOID'),
      presets([row(0,128,256,'Unusable color window','SIGMOID'),row(1,64,64,'Unusable color alternative','SIGMOID')]))]},
];
// A small shared-series stack gives deterministic slider/ordering tests without
// loading a clinical CT. Files are intentionally named out of instance order.
for(const [name,instance] of [['stack/01-instance-3.dcm',3],['stack/02-instance-1.dcm',1],['stack/03-instance-2.dcm',2]]){
  specs.push({filename:name,description:'Synthetic three-image stack',seriesNumber:20,seriesUID:'2.25.9200',instance,center:'128\\64',width:'256\\64',labels:'Stack full\\Stack narrow',kind:'LINEAR',
    frames:[frame(gradient.map(value=>(value+instance*17)%256),shape(128,256),presets([row(0,128,256,'Stack full'),row(1,64,64,'Stack narrow')]))]});
}
function voiAttributes(value){return [['00281050','DS',value.center],['00281051','DS',value.width],['00281055','LO',value.labels],['00281056','CS',value.kind]];}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected={schemaVersion:1,synthetic:true,rows:ROWS,columns:COLUMNS,files:{},stackOrder:['stack/02-instance-1.dcm','stack/03-instance-2.dcm','stack/01-instance-3.dcm'],
  notes:['Window formulas are intentionally not evaluated by this generator.','Stored samples, rescale and source parameters are supplied for an independent oracle.','The two first-narrow files are archival attachments with an intentionally rejected PDF preview; interactive source decoding is supported.']};
await mkdir(destination,{recursive:true});await mkdir(evidence,{recursive:true});
for(const [index,spec] of specs.entries()){
  const bits=spec.bits??8,samples=spec.samples??1,photo=spec.photo??'MONOCHROME2',frameCount=spec.frames.length;
  const sop=spec.enhanced?'1.2.840.10008.5.1.4.1.1.4.1':'1.2.840.10008.5.1.4.1.1.7',uid='2.25.910'+(index+1),series=spec.seriesNumber??index+1;
  const pixelBytes=concat(...spec.frames.map(frame=>{
    const bytes=Buffer.alloc(frame.storedPixels.length*(bits/8));
    for(const [position,value] of frame.storedPixels.entries()){
      if(bits===8)bytes[position]=value;else if(spec.signed)bytes.writeInt16LE(value,position*2);else bytes.writeUInt16LE(value,position*2);
    }
    return bytes;
  }));
  const data=[['00080005','CS','ISO_IR 192'],['00080016','UI',sop],['00080018','UI',uid],['00080020','DA','20261115'],['00080060','CS',spec.enhanced?'MR':'OT'],
    ['00081030','LO','Synthetic window-navigation checks'],['0008103e','LO',spec.description],['00100010','PN','Synthetic^Windows'],['00100020','LO','SYNTHETIC-WINDOWS'],
    ['0020000d','UI','2.25.9100'],['0020000e','UI',spec.seriesUID??'2.25.930'+(index+1)],['00200011','IS',String(series)],['00200013','IS',String(spec.instance??1)],
    ['00280002','US',numeric(samples)],['00280004','CS',photo],['00280010','US',numeric(ROWS)],['00280011','US',numeric(COLUMNS)],
    ['00280100','US',numeric(bits)],['00280101','US',numeric(bits)],['00280102','US',numeric(bits-1)],['00280103','US',numeric(spec.signed?1:0)],
    ['7fe00010',bits===16?'OW':'OB',pixelBytes]];
  if(spec.center!==undefined)data.push(...voiAttributes(spec));
  if(spec.slope!==undefined)data.push(['00281053','DS',String(spec.slope)]);
  if(spec.intercept!==undefined)data.push(['00281052','DS',String(spec.intercept)]);
  if(samples===3)data.push(['00280006','US',numeric(0)]);
  if(spec.enhanced)data.push(['00280008','IS',String(frameCount)],['52009230','SQ',sequence(spec.frameVoi.map((value,index)=>[
    ['00289132','SQ',value===null?Buffer.alloc(0):sequence([voiAttributes(value)])],['00209113','SQ',sequence([[['00200032','DS','0\\0\\'+index]]])],
  ]))]);
  const meta=attributes([['00020001','OB',Buffer.from([0,1])],['00020002','UI',sop],['00020003','UI',uid],['00020010','UI','1.2.840.10008.1.2.1'],['00020012','UI','2.25.9199']]);
  const prefix=Buffer.alloc(132);prefix.write('DICM',128,'ascii');const bytes=concat(prefix,element('00020000','UL',numeric(meta.length,4)),meta,attributes(data));
  const output=join(destination,spec.filename);await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,bytes);
  expected.files[spec.filename]={sha256:sha(bytes),size:bytes.length,seriesDescription:spec.description,seriesNumber:series,instanceNumber:spec.instance??1,
    rows:ROWS,columns:COLUMNS,photometricInterpretation:photo,samplesPerPixel:samples,bitsAllocated:bits,pixelRepresentation:spec.signed?1:0,frameCount,
    creatorPreviewExpected:spec.creatorPreviewExpected!==false,windowMenuExpected:samples===1&&spec.frames.some(frame=>frame.sourceWindowPresets.presets.some(preset=>preset.center!==frame.baselineWindow.center||preset.width!==frame.baselineWindow.width||preset.function!==frame.baselineWindow.function)),
    frames:spec.frames.map((frame,index)=>({frame:index+1,...frame}))};
}
await writeFile(join(evidence,'expectations.json'),JSON.stringify(expected,null,2)+'\n');
console.log('Generated '+specs.length+' synthetic window-navigation DICOM inputs and independent sample expectations under target/.');
