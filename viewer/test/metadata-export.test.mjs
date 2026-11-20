import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'fflate';
import dicomParser from 'dicom-parser';
import {readDicomMetadata,metadataCsv} from '../metadata-export.mjs';
import {parseDicomCompatible} from '../dicom-parser-compat.mjs';

const concat=(...parts)=>Buffer.concat(parts.map(p=>Buffer.from(p)));
const text=(value,charset='utf8')=>Buffer.from(value,charset);
function number(value,size=2,signed=false,little=true){const b=Buffer.alloc(size);if(size===2)b[signed?(little?'writeInt16LE':'writeInt16BE'):(little?'writeUInt16LE':'writeUInt16BE')](value);else b[little?'writeUInt32LE':'writeUInt32BE'](value);return b;}
function element(hex,vr,value,{little=true,implicit=false,undefinedLength=false}={}){
 let body=Buffer.from(value);if(body.length%2)body=concat(body,Buffer.from([vr==='UI'||['OB','OW','UN'].includes(vr)?0:32]));
 const tag=concat(number(parseInt(hex.slice(0,4),16),2,false,little),number(parseInt(hex.slice(4),16),2,false,little));
 if(implicit)return concat(tag,number(body.length,4,false,little),body);
 return ['OB','OD','OF','OL','OV','OW','SQ','SV','UC','UN','UR','UT','UV'].includes(vr)?concat(tag,text(vr),Buffer.alloc(2),number(undefinedLength?0xffffffff:body.length,4,false,little),body):concat(tag,text(vr),number(body.length,2,false,little),body);
}
function dicom(attributes,{syntax='1.2.840.10008.1.2.1'}={}){
 const little=syntax!=='1.2.840.10008.1.2.2',implicit=syntax==='1.2.840.10008.1.2';
 const meta=element('00020010','UI',text(syntax));
 const body=concat(...attributes.sort((a,b)=>a[0].localeCompare(b[0])).map(([tag,vr,value,extra={}])=>element(tag,vr,value,{little,implicit,...extra})));
 const encoded=syntax.endsWith('.99')?deflateSync(body):body;
 return new Uint8Array(concat(Buffer.alloc(128),text('DICM'),element('00020000','UL',number(meta.length,4)),meta,encoded));
}
function item(attributes,{little=true,implicit=false}={}){
 const body=concat(...attributes.map(([tag,vr,value])=>element(tag,vr,value,{little,implicit})));
 return concat(number(0xfffe,2,false,little),number(0xe000,2,false,little),number(body.length,4,false,little),body);
}
const find=(rows,tag)=>rows.find(r=>r.tag===tag);

test('reads UTF-8 text, explicit private attributes and value multiplicity',()=>{
 const rows=readDicomMetadata(dicom([
  ['00080005','CS',text('ISO_IR 192')],['00100010','PN',text('Zoë^王')],['00100020','LO',text('ID-1\\ID-2')],
  ['00111010','LO',text('Private,"value"')],['7FE00010','OB',Buffer.from([1,2,3,4])]
 ]));
 assert.equal(find(rows,'(0010,0010)').value,'Zoë^王');assert.equal(find(rows,'(0010,0010)').encoding,'UTF-8');
 assert.equal(find(rows,'(0010,0020)').value,'ID-1\\ID-2');
 assert.equal(find(rows,'(0011,1010)').value,'Private,"value"');assert.equal(find(rows,'(0011,1010)').keyword,'');
 assert.equal(find(rows,'(7FE0,0010)').value,null);assert.equal(find(rows,'(7FE0,0010)').encoding,'omitted-pixel-data');
 assert.equal(find(rows,'(0002,0010)').path,'fileMeta/(0002,0010)');
});
test('inherits Latin-1 inside one-based nested sequence paths',()=>{
 const rows=readDicomMetadata(dicom([
  ['00080005','CS',text('ISO_IR 100')],['00081140','SQ',item([['00100010','PN',text('René','latin1')],['00081155','UI',text('1.2.3')]])]
 ]));
 const nested=rows.find(r=>r.path==='dataset/(0008,1140)[1]/(0010,0010)');
 assert.equal(nested.value,'René');assert.equal(nested.encoding,'ISO_IR 100');
 assert.equal(find(rows,'(0008,1140)').value,'1');assert.equal(find(rows,'(0008,1140)').encoding,'sequence-item-count');
});
test('resolves implicit VR standard/repeating tags and signed padding from PixelRepresentation',()=>{
 const rows=readDicomMetadata(dicom([
  ['00100020','LO',text('IMPLICIT')],['00280103','US',number(1)],['00280120','SS',number(-1024,2,true)],
  ['60020010','US',number(32)],['00081140','SQ',item([['00081155','UI',text('1.2.3')]],{implicit:true})]
 ],{syntax:'1.2.840.10008.1.2'}));
 assert.equal(find(rows,'(0010,0020)').keyword,'PatientID');assert.equal(find(rows,'(0010,0020)').value,'IMPLICIT');
 assert.equal(find(rows,'(0028,0120)').vr,'SS');assert.equal(find(rows,'(0028,0120)').value,'-1024');
 assert.equal(find(rows,'(6002,0010)').keyword,'OverlayRows');assert.equal(find(rows,'(6002,0010)').value,'32');
 assert.equal(rows.find(r=>r.path==='dataset/(0008,1140)[1]/(0008,1155)').value,'1.2.3');
});
test('does not invent unsigned values for ambiguous implicit VR without PixelRepresentation',()=>{
 const rows=readDicomMetadata(dicom([['00280120','SS',number(-1,2,true)]],{syntax:'1.2.840.10008.1.2'}));
 const padding=find(rows,'(0028,0120)');assert.equal(padding.vr,'US/SS');assert.equal(padding.encoding,'ambiguous-vr;base64');assert.equal(padding.value,'//8=');
});
test('reads big-endian numeric values while file meta remains little endian',()=>{
 const rows=readDicomMetadata(dicom([
  ['00280010','US',number(513,2,false,false)],['00281052','DS',text('-10.25')],['00111010','SL',number(123456,4,false,false)]
 ],{syntax:'1.2.840.10008.1.2.2'}));
 assert.equal(find(rows,'(0028,0010)').value,'513');assert.equal(find(rows,'(0011,1010)').value,'123456');
 assert.equal(find(rows,'(0002,0010)').value,'1.2.840.10008.1.2.2');
 assert.equal(find(rows,'(0028,1052)').value,'-10.25');
});
test('reads deflated datasets with locally bundled inflater',()=>{
 const rows=readDicomMetadata(dicom([['00100020','LO',text('DEFLATED')],['00280010','US',number(48)]],{syntax:'1.2.840.10008.1.2.1.99'}));
 assert.equal(find(rows,'(0010,0020)').value,'DEFLATED');assert.equal(find(rows,'(0028,0010)').value,'48');
 assert.deepEqual(rows.map(row=>row.tag),['(0002,0000)','(0002,0010)','(0010,0020)','(0028,0010)'],'Preamble/file-meta bytes must not become invented dataset attributes');
});

function value64(value,{signed=false,little=true}={}) {
 const bytes=Buffer.alloc(8);bytes[signed?(little?'writeBigInt64LE':'writeBigInt64BE'):(little?'writeBigUInt64LE':'writeBigUInt64BE')](BigInt(value));return bytes;
}
for(const syntax of ['1.2.840.10008.1.2.1','1.2.840.10008.1.2.2','1.2.840.10008.1.2.1.99'])test(`reads modern SV/UV/OV explicit long-length headers ${syntax}`,()=>{
 const little=syntax!=='1.2.840.10008.1.2.2',original=dicomParser.ByteStream.prototype.readFixedString;
 const opaque=text('SVUVOV!?');
 const bytes=dicom([
  ['00111010','SV',concat(value64(-9223372036854775808n,{signed:true,little}),value64(42,{signed:true,little}))],
  ['00111012','UV',concat(value64(18446744073709551615n,{little}),value64(9007199254740993n,{little}))],
  ['00111014','OV',opaque],['00111016','LO',text('AFTER-MODERN-VR')]
 ],{syntax}),snapshot=bytes.slice(),rows=readDicomMetadata(bytes);
 assert.equal(find(rows,'(0011,1010)').vr,'SV');assert.equal(find(rows,'(0011,1010)').value,'-9223372036854775808\\42');
 assert.equal(find(rows,'(0011,1012)').vr,'UV');assert.equal(find(rows,'(0011,1012)').value,'18446744073709551615\\9007199254740993');
 assert.equal(find(rows,'(0011,1014)').vr,'OV');assert.equal(find(rows,'(0011,1014)').value,opaque.toString('base64'));
 assert.equal(find(rows,'(0011,1016)').value,'AFTER-MODERN-VR');assert.ok(!rows.some(row=>row.encoding==='incomplete-dataset'));
 assert.deepEqual(bytes,snapshot,'Parser must leave original header and value bytes unchanged');
 assert.equal(dicomParser.ByteStream.prototype.readFixedString,original,'Scoped parser hook must be restored');
});
test('modern long VR values remain aligned in nested defined and undefined-length sequences',()=>{
 const modern=[['00111010','UV',value64(18446744073709551615n)],['00111012','LO',text('nested-after')]];
 const undefinedItem=concat(number(0xfffe),number(0xe000),number(0xffffffff,4),...modern.map(([tag,vr,value])=>element(tag,vr,value)),number(0xfffe),number(0xe00d),number(0,4));
 const sequenceEnd=concat(number(0xfffe),number(0xe0dd),number(0,4));
 const rows=readDicomMetadata(dicom([
  ['00081115','SQ',item(modern)],['00081140','SQ',concat(undefinedItem,sequenceEnd),{undefinedLength:true}],['00100020','LO',text('AFTER-SEQUENCES')]
 ]));
 for(const prefix of ['dataset/(0008,1115)[1]','dataset/(0008,1140)[1]']) {
  const value=rows.find(row=>row.path===prefix+'/(0011,1010)');assert.equal(value.vr,'UV');assert.equal(value.value,'18446744073709551615');
  assert.equal(rows.find(row=>row.path===prefix+'/(0011,1012)').value,'nested-after');
 }
 assert.equal(find(rows,'(0010,0020)').value,'AFTER-SEQUENCES');assert.ok(!rows.some(row=>row.encoding==='incomplete-dataset'));
});
test('rejects malformed modern headers and restores parser hooks after failures',()=>{
 const valid=dicom([['00111010','SV',value64(-1,{signed:true})]]),original=dicomParser.ByteStream.prototype.readFixedString;
 const offset=parseDicomCompatible(valid).elements.x00111010.dataOffset;
 const cases=[['reserved header bytes',bytes=>{bytes[offset-6]=1;}],['undefined length',bytes=>{new DataView(bytes.buffer,bytes.byteOffset).setUint32(offset-4,0xffffffff,true);}],['multiple of eight',bytes=>{new DataView(bytes.buffer,bytes.byteOffset).setUint32(offset-4,7,true);}]];
 for(const [message,mutate] of cases) {
  const changed=valid.slice();mutate(changed);const rows=readDicomMetadata(changed);assert.equal(rows.at(-1).encoding,'incomplete-dataset');assert.ok(rows.at(-1).value.includes(message));
  assert.equal(dicomParser.ByteStream.prototype.readFixedString,original);
 }
 const truncated=readDicomMetadata(valid.slice(0,-1));assert.equal(truncated.at(-1).encoding,'incomplete-dataset');assert.match(truncated.at(-1).value,/Truncated SV/);
 assert.equal(dicomParser.ByteStream.prototype.readFixedString,original);
 assert.equal(readDicomMetadata(valid).find(row=>row.vr==='SV').value,'-1','Later parses must remain usable');
});
test('exports unsupported character sets as labelled raw bytes instead of invented text',()=>{
 const rows=readDicomMetadata(dicom([['00080005','CS',text('ISO 2022 IR 87\\ISO 2022 IR 13')],['00100010','PN',Buffer.from([0x1b,0x24,0x42,0x21,0x22,0x20])]]));
 const name=find(rows,'(0010,0010)');assert.match(name.encoding,/^unsupported-character-set:/);assert.match(name.encoding,/;base64$/);assert.equal(name.value,'GyRCISIg');
});
test('bounds binary/text output and includes explicit parse failure records',()=>{
 const rows=readDicomMetadata(dicom([['00111010','UN',Buffer.from([1,2,3,4])],['00111012','UN',Buffer.alloc(5000)],['00111014','UT',Buffer.alloc(70000,65)]]));
 assert.equal(find(rows,'(0011,1010)').value,'AQIDBA==');assert.equal(find(rows,'(0011,1012)').encoding,'omitted-binary-data');
 assert.match(find(rows,'(0011,1014)').encoding,/omitted-large-text/);
 const broken=readDicomMetadata(new Uint8Array([1,2,3]));assert.equal(broken.at(-1).encoding,'incomplete-dataset');
});
test('detailed-row CSV keeps UTF-8 BOM, CRLF, quoting, formula defense and selected paths',()=>{
 const records=[{sourcePath:'a,"b.dcm',attachment:'original-0001.dcm',sopInstanceUID:'1.2.3',sha256:'abc',elements:[
  {path:'dataset/(0010,0010)',tag:'(0010,0010)',keyword:'PatientName',vr:'PN',value:'Zoë,\r\n"Beta"',encoding:'UTF-8'},
  {path:'dataset/(0010,0020)',tag:'(0010,0020)',keyword:'PatientID',vr:'LO',value:'=SUM(1,2)',encoding:'ASCII'},
 ]}];
 const csv=metadataCsv(records,null,{layout:'rows'});assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.endsWith('\r\n'));
 assert.ok(csv.includes('"a,""b.dcm"'));assert.ok(csv.includes('"Zoë,\r\n""Beta"""'));assert.ok(csv.includes('"\'=SUM(1,2)"'));
 assert.ok(csv.startsWith('\uFEFF"Source file","Attachment","SOP Instance UID","SHA-256","Path","Tag","Keyword","VR","Value","Encoding"\r\n'));
 const selected=metadataCsv(records,new Set(['dataset/(0010,0020)']),{layout:'rows'});assert.ok(selected.includes('PatientID'));assert.ok(!selected.includes('PatientName'));
 records[0].elements.push({path:'[parse-error]',tag:'',keyword:'',vr:'',value:'Unreadable metadata',encoding:'incomplete-dataset'});
 const diagnosed=metadataCsv(records,new Set(['dataset/(0010,0020)']),{layout:'rows'});assert.ok(diagnosed.includes('incomplete-dataset'));assert.ok(diagnosed.includes('Unreadable metadata'));assert.ok(!diagnosed.includes('PatientName'));
 for(const value of ['+1','-1','@SUM(A1)',' \t=1','\ttext']){records[0].elements[0].value=value;const safe=metadataCsv(records,new Set(['dataset/(0010,0010)']),{layout:'rows'});assert.ok(safe.includes('"\''+value+'"'));}
});

// Decode independently of the exporter so embedded CRLF, commas and quotes are
// checked as cells, rather than by searching the serialized implementation.
function csvTable(csv) {
 const rows=[];let row=[],cell='',quoted=false;
 csv=csv.replace(/^\uFEFF/,'');
 for(let i=0;i<csv.length;i++) {
  const character=csv[i];
  if(quoted) {
   if(character==='"'&&csv[i+1]==='"'){cell+='"';i++;}
   else if(character==='"')quoted=false;
   else cell+=character;
  } else if(character==='"')quoted=true;
  else if(character===','){row.push(cell);cell='';}
  else if(character==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
  else cell+=character;
 }
 if(cell||row.length){row.push(cell);rows.push(row);}
 assert.equal(quoted,false,'CSV has an unterminated quoted field');
 const [headers,...values]=rows;assert.equal(new Set(headers).size,headers.length,'CSV headers collide');
 const records=values.map(value=>{assert.equal(value.length,headers.length,'CSV row width differs');return Object.fromEntries(headers.map((header,index)=>[header,value[index]]));});
 return {headers,records};
}
const rawHeader=(keyword,path)=>`${keyword} [${path}]`;
const columnElement=(path,keyword,value,encoding='dicom-value-string',vr='LO',tag='(0010,0020)')=>({path,tag,keyword,vr,value,encoding});
const contextElement=(label,value)=>columnElement('package/selected-original/'+label,label,value,'package-context','','');

test('default CSV exposes actual DICOM fields and Selected original values as columns',()=>{
 const records=[{sourcePath:'a,"b.dcm',attachment:'original-0001.dcm',sopInstanceUID:'1.2.3',sha256:'abc',status:'readable',elements:[
  columnElement('dataset/(0010,0010)','PatientName','Zoë,\r\n"Beta"','UTF-8','PN','(0010,0010)'),
  columnElement('dataset/(0010,0020)','PatientID','=SUM(1,2)'),
  contextElement('Source file','a,"b.dcm'),contextElement('Attachment','original-0001.dcm'),contextElement('SHA-256','abc'),
  contextElement('PDF reference page','7'),contextElement('Source frame','3'),contextElement('Original bytes','1024'),
  contextElement('PDF preview status','Displayed'),contextElement('Display: windowCenter','128.0'),
 ]}];
 const csv=metadataCsv(records),table=csvTable(csv);assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.endsWith('\r\n'));
 assert.deepEqual(table.headers.slice(0,6),['Source file','Attachment','SOP Instance UID','SHA-256','Metadata status','Metadata diagnostics']);
 assert.ok(!table.headers.includes('Path')&&!table.headers.includes('Value'),'Default export still has the generic row-per-field schema');
 assert.equal(table.records.length,1);const row=table.records[0];
 assert.equal(row['Source file'],'a,"b.dcm');assert.equal(row[rawHeader('PatientName','dataset/(0010,0010)')],'Zoë,\r\n"Beta"');
 assert.equal(row[rawHeader('PatientID','dataset/(0010,0020)')],"'=SUM(1,2)");
 for(const [key,value] of Object.entries({'PDF reference page':'7','Source frame':'3','Original bytes':'1024','PDF preview status':'Displayed','Display: windowCenter':'128.0'}))assert.equal(row[key],value,key);
 assert.equal(table.headers.filter(header=>header==='Source file').length,1,'Context duplicated source identity columns');
 assert.equal(row['Metadata status'],'readable');
});

test('column union retains distinct files with duplicate UIDs, nested paths, private fields and exact integers',()=>{
 const first={sourcePath:'one.dcm',attachment:'original-0001.dcm',sopInstanceUID:'1.2.3',sha256:'aaa',status:'readable',elements:[
  columnElement('dataset/(0010,0010)','PatientName','First','UTF-8','PN','(0010,0010)'),
  columnElement('dataset/(0008,1140)[1]/(0008,1155)','ReferencedSOPInstanceUID','1.2.10','dicom-value-string','UI','(0008,1155)'),
  columnElement('dataset/(0008,1140)[2]/(0008,1155)','ReferencedSOPInstanceUID','1.2.20','dicom-value-string','UI','(0008,1155)'),
  columnElement('dataset/(0011,1010)','','18446744073709551615','numeric','UV','(0011,1010)'),
 ]};
 const second={sourcePath:'two.dcm',attachment:'original-0002.dcm',sopInstanceUID:'1.2.3',sha256:'bbb',status:'readable',elements:[
  columnElement('dataset/(0010,0020)','PatientID','Second'),contextElement('PDF reference page','8'),
 ]};
 const {records,headers}=csvTable(metadataCsv([first,second]));assert.equal(records.length,2,'Duplicate instance IDs must never merge source files');
 assert.deepEqual(records.map(row=>row.Attachment),['original-0001.dcm','original-0002.dcm']);
 assert.equal(records[0][rawHeader('ReferencedSOPInstanceUID','dataset/(0008,1140)[1]/(0008,1155)')],'1.2.10');
 assert.equal(records[0][rawHeader('ReferencedSOPInstanceUID','dataset/(0008,1140)[2]/(0008,1155)')],'1.2.20');
 assert.equal(records[0][rawHeader('(0011,1010)','dataset/(0011,1010)')],'18446744073709551615');
 assert.equal(records[1][rawHeader('PatientName','dataset/(0010,0010)')],'');assert.equal(records[0][rawHeader('PatientID','dataset/(0010,0020)')],'');
 assert.equal(records[1]['PDF reference page'],'8');assert.ok(headers.length>6);
});

test('selected column paths retain diagnostics and unreadable originals without unrelated metadata columns',()=>{
 const patient='dataset/(0010,0020)',page='package/selected-original/PDF reference page';
 const records=[{sourcePath:'one.dcm',attachment:'original-0001.dcm',sopInstanceUID:'1.2.3',sha256:'aaa',status:'readable',elements:[
  columnElement(patient,'PatientID','PATIENT-1'),columnElement('dataset/(0010,0010)','PatientName','Must not be selected'),contextElement('PDF reference page','7'),
 ]},{sourcePath:'broken.dcm',attachment:'original-0002.dcm',sopInstanceUID:null,sha256:'bbb',status:'unreadable',reason:'Not DICOM',elements:[
  columnElement('[parse-error]','','Not DICOM','incomplete-dataset','',''),
 ]}];
 const table=csvTable(metadataCsv(records,new Set([patient,page])));assert.equal(table.records.length,2);
 assert.ok(table.headers.includes(rawHeader('PatientID',patient)));assert.ok(table.headers.includes('PDF reference page'));
 assert.ok(!table.headers.some(header=>header.includes('PatientName')),'Selected fields leaked an unselected metadata column');
 assert.equal(table.records[0][rawHeader('PatientID',patient)],'PATIENT-1');assert.equal(table.records[0]['PDF reference page'],'7');
 assert.equal(table.records[1]['Metadata status'],'unreadable');assert.match(table.records[1]['Metadata diagnostics'],/Not DICOM/);
 assert.equal(table.records[1].Attachment,'original-0002.dcm');
});

test('column cells distinguish omitted payloads from empty metadata and retain spreadsheet formula protection',()=>{
 const record={sourcePath:'one.dcm',attachment:'original-0001.dcm',sopInstanceUID:'1.2.3',sha256:'aaa',status:'readable',elements:[
  columnElement('dataset/(7FE0,0010)','PixelData',null,'omitted-pixel-data','OW','(7FE0,0010)'),
  columnElement('dataset/(0010,0040)','PatientSex','','dicom-value-string','CS','(0010,0040)'),
  columnElement('dataset/(0010,0020)','PatientID','placeholder'),
 ]};
 const row=csvTable(metadataCsv([record])).records[0];
 assert.match(row[rawHeader('PixelData','dataset/(7FE0,0010)')],/omitted-pixel-data/);
 assert.equal(row[rawHeader('PatientSex','dataset/(0010,0040)')],'');
 for(const value of ['+1','-1','@SUM(A1)',' \t=1','\ttext']) {
  record.elements[2].value=value;assert.equal(csvTable(metadataCsv([record])).records[0][rawHeader('PatientID','dataset/(0010,0020)')],"'"+value);
 }
});
