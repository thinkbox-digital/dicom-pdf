import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {strToU8,deflateSync} from 'fflate';
import {readDicomDocument,DOCUMENT_LIMITS} from '../dicom-document.mjs';
import {RT_DOSE_SOP,RT_DOSE_RLE,swapDoseWords} from '../rt-dose.mjs';
import {RT_PLAN_SOP} from '../rt-plan.mjs';

const PDF='1.2.840.10008.5.1.4.1.1.104.1',SR='1.2.840.10008.5.1.4.1.1.88.33';
const concat=(...parts)=>{const bytes=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;};
function element(hex,vr,value,{little=true,explicit=true}={}){
  let data=typeof value==='string'?strToU8(value):value;
  if(data.length%2)data=concat(data,new Uint8Array([vr==='UI'||['OB','OW'].includes(vr)?0:32]));
  const long=['OB','OW','SQ','UT','UN'].includes(vr),header=new Uint8Array(explicit&&long?12:8),view=new DataView(header.buffer);
  view.setUint16(0,parseInt(hex.slice(0,4),16),little);view.setUint16(2,parseInt(hex.slice(4),16),little);
  if(explicit){header[4]=vr.charCodeAt(0);header[5]=vr.charCodeAt(1);if(long)view.setUint32(8,data.length,little);else view.setUint16(6,data.length,little);}
  else view.setUint32(4,data.length,little);
  return concat(header,data);
}
function ul(hex,value,options={}){const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,options.little!==false);return element(hex,'UL',bytes,options);}
function sequence(hex,items,options={}){
  return element(hex,'SQ',concat(...items.map(item=>{
    const header=new Uint8Array(8),view=new DataView(header.buffer);view.setUint16(0,0xfffe,options.little!==false);view.setUint16(2,0xe000,options.little!==false);view.setUint32(4,item.length,options.little!==false);return concat(header,item);
  })),options);
}
function source(body,sop,{syntax='1.2.840.10008.1.2.1',raw=false,little=true,explicit=true,uid='2.25.999'}={}){
  const dataset=concat(element('00080016','UI',sop,{little,explicit}),...(uid?[element('00080018','UI',uid,{little,explicit})]:[]),...body);
  if(raw)return dataset;
  const prefix=new Uint8Array(132);prefix.set(strToU8('DICM'),128);
  return concat(prefix,element('00020002','UI',sop),element('00020010','UI',syntax),syntax==='1.2.840.10008.1.2.1.99'?deflateSync(dataset):dataset);
}
function pdfBytes(){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  let text='%PDF-1.4\n',offsets=[0];
  for(const [index,object] of objects.entries()){offsets.push(text.length);text+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}
  const xref=text.length;text+='xref\n0 4\n0000000000 65535 f \n';
  for(const offset of offsets.slice(1))text+=String(offset).padStart(10,'0')+' 00000 n \n';
  text+='trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  if(text.length%2===0)text+=' ';return strToU8(text);
}
function pdfSource(payload,{length=true,mime='application/pdf',...options}={}){
  return source([element('00420011','OB',payload,options),element('00420012','LO',mime,options),...(length?[ul('00420015',payload.length,options)]:[])],PDF,options);
}
function coded(meaning,code='123',scheme='99SYNTHETIC'){
  return concat(element('00080100','SH',code),element('00080102','SH',scheme),element('00080104','LO',meaning));
}
function content(type,value=[],children=[],relationship='CONTAINS',name='Supplied concept'){
  return concat(element('0040A010','CS',relationship),element('0040A040','CS',type),sequence('0040A043',[coded(name)]),...value,
    ...(children.length?[sequence('0040A730',children)]:[]));
}
const srSource=items=>source([element('00080005','CS','ISO_IR 192'),element('0040A040','CS','CONTAINER'),sequence('0040A043',[coded('Synthetic report')]),sequence('0040A730',items)],SR);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function words(values,little=true){
  const bytes=new Uint8Array(values.length*2),view=new DataView(bytes.buffer);
  values.forEach((value,index)=>view.setUint16(index*2,value,little));
  return bytes;
}
function doseSource(pixels,{frames='2',bits=32,type='PHYSICAL',scaling='0.001',offsets='0\\3',
    units='GY',little=true,explicit=true,syntax,literalPixelElement=false,unknownVr=false}={}){
  const options={little,explicit},el=(hex,vr,value)=>element(hex,vr,value,options);
  const us=(hex,value)=>el(hex,'US',words([value],little));
  const rtValue=(hex,vr,value)=>el(hex,unknownVr?'UN':vr,value);
  const reference=sequence('300C0002',[element('00081155','UI','2.25.15',{explicit:false})],{explicit:false});
  return source([
    el('00200032','DS','0\\0\\-5'),el('00200037','DS','1\\0\\0\\0\\1\\0'),
    us('00280002',1),el('00280004','CS','MONOCHROME2'),...(frames===null?[]:[el('00280008','IS',frames)]),
    rtValue('00280009','AT',words([0x3004,0x000c],little)),us('00280010',1),us('00280011',2),
    el('00280030','DS','2\\3'),us('00280100',bits),us('00280101',bits),us('00280102',bits-1),us('00280103',type==='ERROR'?1:0),
    rtValue('30040002','CS',units),rtValue('30040004','CS',type),rtValue('3004000A','CS','PLAN'),
    rtValue('3004000C','DS',offsets),rtValue('3004000E','DS',scaling),
    ...(unknownVr?[el('300C0002','UN',reference.subarray(8))]:[]),
    literalPixelElement?pixels:el('7FE00010','OW',pixels),
  ],RT_DOSE_SOP,{syntax,...options});
}

test('native RT Dose preserves the full unsigned 32-bit range, scaling and relative frame offsets',()=>{
  const native=words([0,0,0xffff,0xffff,0x0123,0x8000,1,0]);
  for(const options of [{},{syntax:'1.2.840.10008.1.2',explicit:false},{syntax:'1.2.840.10008.1.2.1.99'}]){
    const original=doseSource(native,options),before=hash(original),result=readDicomDocument(original);
    assert.equal(result.kind,'rt-dose');
    const {data,range,units,scaling,positions,spacing,swappedRange}=result.content;
    assert.deepEqual(data,new Uint32Array([0,0xffffffff,0x80000123,1]));
    assert.deepEqual(range,[0,0xffffffff]);assert.equal(units,'Gy');assert.equal(scaling,0.001);
    assert.deepEqual(positions,{label:'Offset from first slice',values:[0,3]});
    assert.deepEqual(spacing,[2,3]);assert.equal(swappedRange,null);
    data[0]=1;assert.equal(hash(original),before);
  }
});

test('RT Dose keeps both 32-bit Big Endian word layouts available and reads signed 16-bit axial offsets',()=>{
  const options={syntax:'1.2.840.10008.1.2.2',little:false};
  const original=doseSource(words([0xc3d4,0xa1b2,0x4567,0x0123],false),{...options,frames:null,units:'RELATIVE'});
  const {data,range,swappedRange,positions,units}=readDicomDocument(original).content;
  assert.deepEqual(data,new Uint32Array([0xa1b2c3d4,0x01234567]));
  assert.deepEqual(range,[0x01234567,0xa1b2c3d4]);
  assert.deepEqual(swappedRange,[0x45670123,0xc3d4a1b2]);
  assert.equal(swapDoseWords(data[0],false),0xc3d4a1b2);assert.equal(positions,null);assert.equal(units,'relative');
  const signed=doseSource(words([0xfffd,5,0x8000,0x7fff],false),{...options,bits:16,type:'ERROR',offsets:'-5\\-7'});
  const grid=readDicomDocument(signed).content;
  assert.deepEqual(grid.data,new Int16Array([-3,5,-32768,32767]));
  assert.deepEqual(grid.positions,{label:'Patient z',values:[-5,-7]});
});

function rleDosePixelElement(frames){
  const bytes=new Uint8Array(12),header=new DataView(bytes.buffer);
  header.setUint16(0,0x7fe0,true);header.setUint16(2,0x0010,true);
  bytes.set(strToU8('OB'),4);header.setUint32(8,0xffffffff,true);
  const item=(tag,value)=>{
    const itemHeader=new Uint8Array(8),view=new DataView(itemHeader.buffer);
    view.setUint16(0,0xfffe,true);view.setUint16(2,tag,true);view.setUint32(4,value.length,true);
    return concat(itemHeader,value);
  };
  const fragments=frames.map(values=>{
    const fragment=new Uint8Array(80),view=new DataView(fragment.buffer);
    view.setUint32(0,4,true);
    for(let plane=0;plane<4;plane++){
      const offset=64+plane*4,shift=8*(3-plane);
      view.setUint32(4+plane*4,offset,true);
      fragment.set([1,values[0]>>>shift,values[1]>>>shift,0],offset);
    }
    return item(0xe000,fragment);
  });
  return concat(bytes,item(0xe000,new Uint8Array()),...fragments,item(0xe0dd,new Uint8Array()));
}

test('RLE RT Dose decodes each signed 32-bit frame and rejects inconsistent fragment counts',()=>{
  const pixels=rleDosePixelElement([[-1,0],[-2147483648,2147483647]]);
  const options={syntax:RT_DOSE_RLE,type:'ERROR',literalPixelElement:true};
  const result=readDicomDocument(doseSource(pixels,options));
  assert.equal(result.kind,'rt-dose');
  assert.deepEqual(result.content.data,new Int32Array([-1,0,-2147483648,2147483647]));
  assert.match(readDicomDocument(doseSource(pixels,{...options,frames:'3'})).detail,/one fragment per frame/);
});

test('legacy RLE RT Dose reads known attributes and implicit sequences carried in Unknown VR',()=>{
  const pixels=rleDosePixelElement([[1,3],[4,7]]);
  const original=doseSource(pixels,{syntax:RT_DOSE_RLE,literalPixelElement:true,unknownVr:true});
  const result=readDicomDocument(original);
  assert.equal(result.kind,'rt-dose');assert.deepEqual(result.content.data,new Uint32Array([1,3,4,7]));
  assert.equal(result.content.scaling,0.001);
  assert.deepEqual(result.content.positions.values,[0,3]);
  assert.deepEqual(result.content.plans,['2.25.15']);
});

test('malformed RT Dose frame counts, scaling and grid lengths are refused',()=>{
  const pixels=words([1,0,2,0,3,0,4,0]);
  for(const [data,options,reason] of [[pixels,{frames:'1A'},/Number of Frames/],
    [pixels,{scaling:'0'},/Grid Scaling/],[pixels.slice(0,-2),{},/Pixel Data length/]]){
    const result=readDicomDocument(doseSource(data,options));
    assert.equal(result.code,'UNSUPPORTED_RT_OBJECT');assert.match(result.detail,reason);
  }
});

test('implicit VR RT Plan retains UTF-8 labels, groups, dose references and initial beam settings',()=>{
  const options={syntax:'1.2.840.10008.1.2',explicit:false};
  const el=(tag,vr,value)=>element(tag,vr,value,options),sq=(tag,...children)=>sequence(tag,children,options);
  const original=source([
    el('00080005','CS','ISO_IR 192'),el('300A0002','SH','Plan A'),el('300A0003','LO','Plan é <img>'),
    sq('300A0010',concat(el('300A0012','IS','2'),el('300A0026','DS','30.5'))),
    sq('300A0070',concat(el('300A0071','IS','1'),el('300A0078','IS','10'),
      sq('300C0004',concat(el('300A0084','DS','1.25'),el('300C0006','IS','4'))))),
    sq('300A00B0',concat(el('300A00C0','IS','4'),el('300A00C2','LO','Faisceau é'),
      el('300A0110','IS','2'),sq('300A0111',concat(el('300A0112','IS','0'),el('300A011E','DS','90'))))),
    sq('300C0060',el('00081155','UI','2.25.123')),el('300E0002','CS','UNAPPROVED'),
  ],RT_PLAN_SOP,options);
  const before=hash(original),result=readDicomDocument(original);
  assert.equal(result.kind,'rt-plan');assert.equal(result.sopInstanceUID,'2.25.999');assert.equal(hash(original),before);
  const {fields,sections}=result.content;
  assert.equal(Object.fromEntries(fields)['Plan name'],'Plan é <img>');
  assert.equal(Object.fromEntries(fields)['Referenced structure set UID'],'2.25.123');
  const [fractions,beams,references]=sections.map(({items})=>Object.fromEntries(items[0].fields));
  assert.equal(fractions['Fractions planned'],'10');assert.equal(fractions['Beam 4 dose per fraction (Gy)'],'1.25');
  assert.equal(beams.Name,'Faisceau é');assert.equal(beams['Initial gantry angle (°)'],'90');
  assert.equal(references['Target prescription dose (Gy)'],'30.5');
});

test('encapsulated PDF recovers the actual document and strips only recorded DICOM zero padding',()=>{
  const payload=pdfBytes(),original=pdfSource(payload),before=hash(original),result=readDicomDocument(original);
  assert.equal(payload.length%2,1);assert.equal(result.kind,'pdf');assert.equal(result.mime,'application/pdf');assert.equal(result.sopClassUID,PDF);
  assert.equal(result.paddingRemoved,1);assert.equal(result.sourceUnchanged,true);assert.deepEqual(result.bytes,payload);assert.equal(hash(original),before);
  assert.equal(result.sopInstanceUID,'2.25.999');
  result.bytes[0]=0;assert.equal(hash(original),before,'returned PDF bytes must not alias the source');
});

test('missing EncapsulatedDocumentLength preserves every payload byte including the trailing zero',()=>{
  const payload=pdfBytes(),original=pdfSource(payload,{length:false}),result=readDicomDocument(original);
  assert.equal(result.kind,'pdf');assert.equal(result.paddingRemoved,0);assert.deepEqual(result.bytes,concat(payload,new Uint8Array([0])));
});

test('document identity is the actual dataset SOP Instance UID and remains null when absent',()=>{
  const payload=pdfBytes(),pdf=pdfSource(payload,{uid:'2.25.888'});
  assert.equal(readDicomDocument(pdf).sopInstanceUID,'2.25.888');
  assert.equal(readDicomDocument(pdfSource(payload,{uid:null})).sopInstanceUID,null);
  const body=[sequence('0040A730',[content('TEXT',[element('0040A160','UT','Synthetic report')])])];
  assert.equal(readDicomDocument(source(body,SR,{uid:'2.25.889'})).sopInstanceUID,'2.25.889');
  assert.equal(readDicomDocument(source(body,SR,{uid:null})).sopInstanceUID,null);
});

test('raw explicit little, implicit little and explicit big endian PDF datasets require the recorded parsing option',()=>{
  const payload=pdfBytes();
  for(const [syntax,little,explicit] of [['1.2.840.10008.1.2.1',true,true],['1.2.840.10008.1.2',true,false],['1.2.840.10008.1.2.2',false,true]]){
    const original=pdfSource(payload,{raw:true,syntax,little,explicit});
    assert.equal(readDicomDocument(original).code,'SOURCE_PARSING_REQUIRED');
    const result=readDicomDocument(original,{sourceParsing:{mode:'raw-dataset',transferSyntaxUID:syntax}});
    assert.equal(result.kind,'pdf',syntax);assert.deepEqual(result.bytes,payload);
  }
});

test('file-meta-without-preamble and deflated PDF sources retain their actual payload and never change source bytes',()=>{
  const payload=pdfBytes(),original=pdfSource(payload),without=original.slice(132),before=hash(without);
  const result=readDicomDocument(without,{sourceParsing:{mode:'file-meta-without-preamble',transferSyntaxUID:'1.2.840.10008.1.2.1'}});
  assert.equal(result.kind,'pdf');assert.deepEqual(result.bytes,payload);assert.equal(hash(without),before);
  const deflated=pdfSource(payload,{syntax:'1.2.840.10008.1.2.1.99'}),compressedHash=hash(deflated);
  assert.deepEqual(readDicomDocument(deflated).bytes,payload);assert.equal(hash(deflated),compressedHash);
  assert.equal(readDicomDocument(deflated,{limits:{maxInflatedBytes:32}}).code,'RESOURCE_LIMIT');
});

test('malformed MIME, PDF signatures, EOFs and inconsistent recorded lengths are labeled instead of exposed as a document',()=>{
  assert.equal(readDicomDocument(pdfSource(pdfBytes(),{mime:'text/html'})).code,'UNSUPPORTED_DOCUMENT_MIME');
  for(const payload of [strToU8('<script>not a PDF</script>'),strToU8('%PDF-1.4\nmissing EOF')])assert.equal(readDicomDocument(pdfSource(payload)).code,'MALFORMED_PDF_DOCUMENT');
  const payload=pdfBytes();
  for(const length of [payload.length+100,payload.length-5,0]){
    const original=source([element('00420011','OB',payload),element('00420012','LO','application/pdf'),ul('00420015',length)],PDF);
    assert.equal(readDicomDocument(original).code,'MALFORMED_PDF_DOCUMENT');
  }
  const extra=concat(payload,new Uint8Array([7]));
  const original=source([element('00420011','OB',extra),element('00420012','LO','application/pdf'),ul('00420015',payload.length)],PDF);
  assert.equal(readDicomDocument(original).code,'MALFORMED_PDF_DOCUMENT');
});

test('PDF payload and overall source bounds are enforced before document copying and cannot be increased',()=>{
  const original=pdfSource(pdfBytes());
  assert.equal(readDicomDocument(original,{limits:{maxPdfBytes:16}}).code,'PDF_RESOURCE_LIMIT');
  assert.equal(readDicomDocument(original,{limits:{maxSourceBytes:16}}).code,'RESOURCE_LIMIT');
  assert.equal(readDicomDocument(original,{limits:{maxPdfBytes:DOCUMENT_LIMITS.maxPdfBytes+1}}).code,'INVALID_LIMITS');
});

test('SR text tree preserves Unicode, actual relationship/type/concept labels, and inert HTML without clinical interpretation',()=>{
  const text='Supplied \u00e9\u6f22 text <img src=x onerror="globalThis.__documentExecuted=true">\nSecond line';
  const original=srSource([content('TEXT',[element('0040A160','UT',text)],[],'CONTAINS','Actual \u6f22 concept')]),before=hash(original),result=readDicomDocument(original);
  assert.equal(result.kind,'sr');assert.equal(result.mime,'text/plain');assert.equal(result.contentItems,2);assert.equal(result.unsupportedContentItems,0);
  assert.match(result.text,/CONTAINER Synthetic report/);assert.match(result.text,/\[CONTAINS\] TEXT Actual \u6f22 concept/);
  assert.ok(result.text.includes('Supplied \u00e9\u6f22 text <img src=x onerror="globalThis.__documentExecuted=true">'));
  assert.ok(result.text.includes('Second line'));assert.equal(globalThis.__documentExecuted,undefined);assert.equal(hash(original),before);
});

test('raw SR datasets inherit actual UTF-8 text correctly in each recorded native transfer syntax',()=>{
  for(const [syntax,little,explicit] of [['1.2.840.10008.1.2.1',true,true],['1.2.840.10008.1.2',true,false],['1.2.840.10008.1.2.2',false,true]]){
    const options={little,explicit},item=concat(element('0040A040','CS','TEXT',options),element('0040A160','UT','Actual \u00e9\u6f22 source',options));
    const original=source([element('00080005','CS','ISO_IR 192',options),sequence('0040A730',[item],options)],SR,{raw:true,syntax,...options});
    const before=hash(original),result=readDicomDocument(original,{sourceParsing:{mode:'raw-dataset',transferSyntaxUID:syntax}});
    assert.equal(result.kind,'sr',syntax);assert.ok(result.text.includes('Actual \u00e9\u6f22 source'));assert.equal(hash(original),before);
  }
});

test('SR PNAME DATE TIME DATETIME UIDREF CODE and NUM preserve actual values and unit codes',()=>{
  const measured=concat(element('0040A30A','DS','0'),sequence('004008EA',[coded('millimetre','mm','UCUM')]));
  const result=readDicomDocument(srSource([
    content('PNAME',[element('0040A123','PN','Synthetic^Person')]),content('DATE',[element('0040A121','DA','20261115')]),
    content('TIME',[element('0040A122','TM','123456')]),content('DATETIME',[element('0040A120','DT','20261115123456-0500')]),
    content('UIDREF',[element('0040A124','UI','2.25.456')]),content('CODE',[sequence('0040A168',[coded('Actual coded value','ABC','99TEST')])]),
    content('NUM',[sequence('0040A300',[measured])])
  ]));
  assert.equal(result.kind,'sr');assert.equal(result.unsupportedContentItems,0);
  for(const value of ['Synthetic^Person','20261115','123456','20261115123456-0500','2.25.456','Actual coded value [99TEST:ABC]','0 millimetre [UCUM:mm]'])assert.ok(result.text.includes(value),value);
});

test('SR IMAGE references retain original instance, class and frame IDs without resolving or rendering them',()=>{
  const reference=concat(element('00081150','UI','1.2.840.10008.5.1.4.1.1.2'),element('00081155','UI','2.25.12345'),element('00081160','IS','1\\3'));
  const result=readDicomDocument(srSource([content('IMAGE',[sequence('00081199',[reference])])]));
  assert.equal(result.kind,'sr');assert.ok(result.text.includes('SOP Instance UID 2.25.12345'));assert.ok(result.text.includes('SOP Class UID 1.2.840.10008.5.1.4.1.1.2'));
  assert.ok(result.text.includes('frames 1\\3'));assert.equal(result.unsupportedContentItems,0);
});

test('unsupported SR spatial and by-reference content remain explicitly labeled while actual text remains readable',()=>{
  const result=readDicomDocument(srSource([content('SCOORD'),content('',[ul('0040DB73',2)]),content('TEXT',[element('0040A160','UT','Actual supplied text')])]));
  assert.equal(result.kind,'sr');assert.equal(result.unsupportedContentItems,2);assert.ok(result.text.includes('[not rendered: SCOORD]'));
  assert.ok(result.text.includes('[not rendered: by-reference or unspecified content] content item 2'));assert.ok(result.text.includes('Actual supplied text'));
});

test('unsupported SR text encodings are shown as unavailable instead of inventing decoded values',()=>{
  const original=source([element('00080005','CS','UNSUPPORTED'),sequence('0040A730',[content('TEXT',[element('0040A160','UT','undecoded source')])])],SR);
  const result=readDicomDocument(original);assert.equal(result.kind,'sr');assert.ok(result.text.includes('[not rendered: value encoding unavailable]'));
  assert.equal(result.unsupportedContentItems,1);
  assert.ok(!result.text.includes('undecoded source'));
});

test('SR resource limits stop excessive depth, content count, metadata fields and output text',()=>{
  let nested=content('TEXT',[element('0040A160','UT','Deep source')]);
  for(let index=0;index<6;index++)nested=content('CONTAINER',[],[nested]);
  assert.equal(readDicomDocument(srSource([nested]),{limits:{maxDepth:2}}).code,'RESOURCE_LIMIT');
  const many=srSource(Array.from({length:5},()=>content('TEXT',[element('0040A160','UT','Repeated source')])));
  assert.equal(readDicomDocument(many,{limits:{maxContentItems:3}}).code,'RESOURCE_LIMIT');
  assert.equal(readDicomDocument(many,{limits:{maxElements:5}}).code,'RESOURCE_LIMIT');
  assert.equal(readDicomDocument(many,{limits:{maxTextBytes:32}}).code,'RESOURCE_LIMIT');
  assert.equal(readDicomDocument(many,{limits:{maxMetadataBytes:32}}).code,'RESOURCE_LIMIT');
});

test('report preflight inspects metadata after pixel data before the full SR metadata reader runs',()=>{
  const pixel=element('7fe00010','OB',new Uint8Array([1,2]));
  const valid=source([pixel,sequence('0040A730',[content('TEXT',[element('0040A160','UT','Actual trailing text')])])],SR);
  const report=readDicomDocument(valid);assert.equal(report.kind,'sr');assert.ok(report.text.includes('Actual trailing text'));
  const excessive=source([pixel,...Array.from({length:30},()=>element('fffcfffc','OB',new Uint8Array([0,0])))],SR);
  assert.equal(readDicomDocument(excessive,{limits:{maxElements:20}}).code,'RESOURCE_LIMIT');
});

test('malformed sequences and missing report content refuse output with safe generic codes',()=>{
  const malformed=srSource([content('TEXT',[element('0040A160','UT','Original text')])]).slice(0,-1);
  assert.equal(readDicomDocument(malformed).code,'MALFORMED_DICOM');
  assert.equal(readDicomDocument(source([],SR)).code,'EMPTY_SR');
  assert.deepEqual(readDicomDocument(source([],'1.2.840.10008.5.1.4.1.1.2')),{kind:'unsupported',code:'UNSUPPORTED_DOCUMENT_OBJECT'});
  assert.deepEqual(readDicomDocument(strToU8('<script>anything</script>')),{kind:'unsupported',code:'SOURCE_PARSING_REQUIRED'});
});

test('SR control characters are escaped visibly and cancellation rejects before parsing',()=>{
  const original=srSource([content('TEXT',[element('0040A160','UT','Actual\u0001source')])]),result=readDicomDocument(original);
  assert.equal(result.kind,'sr');assert.ok(result.text.includes('Actual\\u0001source'));assert.ok(!result.text.includes('\u0001'));
  const controller=new AbortController();controller.abort();assert.throws(()=>readDicomDocument(original,{signal:controller.signal}),{name:'AbortError'});
});
