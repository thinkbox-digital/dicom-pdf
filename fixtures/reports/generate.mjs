import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

// Entirely generated test documents and a mathematical image. No patient data.
const destination=resolve(process.argv[2]||'target/report-inputs');
const evidence=resolve(process.argv[3]||'target/report-fixtures');
const reportsOnly=resolve(process.argv[4]||'target/report-only-inputs');
const encoder=new TextEncoder(),text=value=>encoder.encode(value);
const concat=(...parts)=>{const bytes=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;};
function element(hex,vr,value){
  let bytes=typeof value==='string'?text(value):value;
  if(bytes.length%2)bytes=concat(bytes,new Uint8Array([['UI','OB','OW'].includes(vr)?0:32]));
  const long=['OB','OW','SQ','UT','UN'].includes(vr),header=new Uint8Array(long?12:8),view=new DataView(header.buffer);
  view.setUint16(0,parseInt(hex.slice(0,4),16),true);view.setUint16(2,parseInt(hex.slice(4),16),true);
  header[4]=vr.charCodeAt(0);header[5]=vr.charCodeAt(1);if(long)view.setUint32(8,bytes.length,true);else view.setUint16(6,bytes.length,true);
  return concat(header,bytes);
}
function number(hex,vr,value){const bytes=new Uint8Array(vr==='US'?2:4),view=new DataView(bytes.buffer);if(vr==='US')view.setUint16(0,value,true);else view.setUint32(0,value,true);return element(hex,vr,bytes);}
function sequence(hex,items){return element(hex,'SQ',concat(...items.map(item=>{
  const header=new Uint8Array(8),view=new DataView(header.buffer);view.setUint16(0,0xfffe,true);view.setUint16(2,0xe000,true);view.setUint32(4,item.length,true);return concat(header,item);
})));}
function coded(meaning,code='SYNTHETIC'){return concat(element('00080100','SH',code),element('00080102','SH','99TEST'),element('00080104','LO',meaning));}
const IMAGE_SOP='1.2.840.10008.5.1.4.1.1.7',PDF_SOP='1.2.840.10008.5.1.4.1.1.104.1',SR_SOP='1.2.840.10008.5.1.4.1.1.88.33';
function dicom(sop,instance,modality,body){
  const uid='2.25.710'+instance,meta=concat(element('00020001','OB',new Uint8Array([0,1])),element('00020002','UI',sop),element('00020003','UI',uid),element('00020010','UI','1.2.840.10008.1.2.1'),element('00020012','UI','2.25.7999'));
  const prefix=new Uint8Array(132);prefix.set(text('DICM'),128);
  const dataset=concat(element('00080005','CS','ISO_IR 192'),element('00080016','UI',sop),element('00080018','UI',uid),element('00080020','DA','20260101'),
    element('00080060','CS',modality),element('00081030','LO','Synthetic report workflow'),element('0008103e','LO',modality==='OT'?'Mathematical image':'Synthetic report'),
    element('00100010','PN','Synthetic^Report'),element('00100020','LO','SYNTHETIC-REPORT'),element('0020000d','UI','2.25.7000'),element('0020000e','UI','2.25.720'+instance),
    element('00200011','IS',String(instance)),element('00200013','IS',String(instance)),body);
  return concat(prefix,number('00020000','UL',meta.length),meta,dataset);
}
function pdf(){
  const stream='BT /F1 18 Tf 25 150 Td (SYNTHETIC REPORT) Tj 0 -30 Td /F1 10 Tf (Software test fixture. No clinical findings.) Tj ET\n';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length '+stream.length+' >>\nstream\n'+stream+'endstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let document='%PDF-1.4\n';const offsets=[];
  for(const [index,object] of objects.entries()){offsets.push(document.length);document+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}
  const xref=document.length;document+='xref\n0 6\n0000000000 65535 f \n';
  for(const offset of offsets)document+=String(offset).padStart(10,'0')+' 00000 n \n';
  document+='trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';if(document.length%2===0)document+=' ';return text(document);
}
const reportPdf=pdf(),imagePixels=Uint8Array.from({length:24*32},(_,index)=>((index%32)*7+Math.floor(index/32)*3)%256);
const image=dicom(IMAGE_SOP,1,'OT',concat(number('00280002','US',1),element('00280004','CS','MONOCHROME2'),number('00280010','US',24),number('00280011','US',32),
  number('00280100','US',8),number('00280101','US',8),number('00280102','US',7),number('00280103','US',0),element('00281050','DS','128'),element('00281051','DS','256'),element('7fe00010','OB',imagePixels)));
const encapsulated=dicom(PDF_SOP,2,'DOC',concat(element('00420010','LO','Synthetic report'),element('00420011','OB',reportPdf),element('00420012','LO','application/pdf'),number('00420015','UL',reportPdf.length)));
const inertText='Synthetic report — café 漢字. No clinical findings. <img src="https://example.invalid/report" onerror="globalThis.__reportScriptRan=true"> <script>globalThis.__reportScriptRan=true;fetch("https://example.invalid/upload")</script>';
function content(type,name,values){return concat(element('0040A010','CS','CONTAINS'),element('0040A040','CS',type),sequence('0040A043',[coded(name)]),...values);}
const reference=concat(element('00081150','UI',IMAGE_SOP),element('00081155','UI','2.25.7101'),element('00081160','IS','1'));
const sr=dicom(SR_SOP,3,'SR',concat(element('0040A040','CS','CONTAINER'),sequence('0040A043',[coded('Synthetic report')]),sequence('0040A730',[
  content('TEXT','Supplied text',[element('0040A160','UT',inertText)]),content('SCOORD','Unsupported spatial content',[element('00700023','CS','POINT')]),
  content('IMAGE','Supplied image reference',[sequence('00081199',[reference])])])));
await mkdir(destination,{recursive:true});await mkdir(evidence,{recursive:true});await mkdir(reportsOnly,{recursive:true});
const files={'01-image.dcm':image,'02-encapsulated-pdf.dcm':encapsulated,'03-structured-report.dcm':sr};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [name,bytes] of Object.entries(files))await writeFile(join(destination,name),bytes);
for(const [name,bytes] of Object.entries(files))if(name!=='01-image.dcm')await writeFile(join(reportsOnly,name),bytes);
await writeFile(join(evidence,'expected-report.pdf'),reportPdf);
await writeFile(join(evidence,'expectations.json'),JSON.stringify({schemaVersion:1,synthetic:true,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{size:bytes.length,sha256:sha(bytes)}])),pdf:{sha256:sha(reportPdf),size:reportPdf.length},sr:{literalText:inertText,unsupportedMarker:'[not rendered: SCOORD]',imageReferenceUID:'2.25.7101'}},null,2)+'\n');
console.log('Generated 3 synthetic DICOM report-workflow inputs and independent expectations under target/.');
