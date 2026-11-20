import dicomParser from 'dicom-parser';

const MODERN_LONG_VRS = new Set(['SV','UV','OV']);
let parsing = false;

function part10Header(bytes,start=132) {
  if(start===132&&(bytes.length<132||String.fromCharCode(...bytes.subarray(128,132))!=='DICM'))throw new Error('DICOM Part 10 prefix is missing.');
  const parser=dicomParser.littleEndianByteArrayParser,stream=new dicomParser.ByteStream(parser,bytes,start);
  const header=new dicomParser.DataSet(parser,bytes,{});header.warnings=stream.warnings;
  let end=null;
  // Do not call the dependency's readPart10Header: it parses the complete first
  // dataset element as look-ahead using little endian, including nested items.
  // Read only group 0002 and honor its declared boundary instead.
  while(stream.position<bytes.length&&(end===null||stream.position<end)) {
    if(stream.position+8>bytes.length)throw new Error('Truncated DICOM file-meta header.');
    if(parser.readUint16(bytes,stream.position)!==0x0002) {
      if(end!==null)throw new Error('File-meta group length extends outside group 0002.');
      break;
    }
    const element=dicomParser.readDicomElementExplicit(stream,header.warnings);
    element.parser=parser;header.elements[element.tag]=element;
    if(element.tag==='x00020000') {
      if(element.vr!=='UL'||element.length!==4)throw new Error('Invalid File Meta Information Group Length.');
      end=element.dataOffset+4+parser.readUint32(bytes,element.dataOffset);
      if(end<stream.position||end>bytes.length)throw new Error('File-meta group length is outside the supplied file.');
    }
    if(end!==null&&stream.position>end)throw new Error('File-meta element extends beyond the declared group length.');
  }
  header.position=stream.position;return header;
}

/**
 * dicom-parser 1.8.21 predates SV/UV/OV in its explicit-VR long-length table.
 * Use its existing defined-length UN reader, then restore the actual VR at the
 * exact offsets read by ByteStream. No byte search, input rewrite, evaluation or
 * installed dependency modification is involved. PS3.5 2026d §7.1.2/Table 7.1-1
 * specifies reserved zero bytes plus a 32-bit length for these VRs.
 *
 * The public ByteStream hook is scoped to this synchronous call and restored
 * even on parse failure. The dependency remains pinned; its MIT source/notice
 * is already distributed by the viewer build. Re-entrant calls are refused.
 */
export function parseDicomCompatible(byteArray,options={}) {
  if(parsing)throw new Error('DICOM metadata parsing cannot be re-entered.');
  if(!(byteArray instanceof Uint8Array))throw new TypeError('DICOM input must be a Uint8Array.');
  const prototype=dicomParser.ByteStream.prototype, original=prototype.readFixedString;
  const modern=new Map();let dataSet,header;
  parsing=true;
  prototype.readFixedString=function(length) {
    const start=this.position,value=original.call(this,length);
    if(length!==2||!MODERN_LONG_VRS.has(value))return value;
    const dataOffset=start+8,bytes=this.byteArray;
    if(dataOffset>bytes.length)throw new Error(`Truncated ${value} element header.`);
    if(bytes[start+2]!==0||bytes[start+3]!==0)throw new Error(`${value} reserved header bytes are not zero.`);
    const size=this.byteArrayParser.readUint32(bytes,start+4);
    if(size===0xffffffff)throw new Error(`${value} does not permit undefined length.`);
    if(size%8!==0)throw new Error(`${value} value length is not a multiple of eight bytes.`);
    if(dataOffset+size>bytes.length)throw new Error(`Truncated ${value} element value.`);
    modern.set(dataOffset,value);
    return 'UN';
  };
  try {
    // Build the dataset with public parser components so deflated input starts
    // at the real dataset offset, rather than reparsing its preserved preamble
    // and file-meta bytes as invented dataset elements.
    const source=options.sourceParsing;
    const hasPrefix=byteArray.length>=132&&String.fromCharCode(...byteArray.subarray(128,132))==='DICM';
    if(hasPrefix||!source)header=part10Header(byteArray);
    else if(source.mode==='file-meta-without-preamble')header=part10Header(byteArray,0);
    else if(source.mode==='raw-dataset'&&['1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.2'].includes(source.transferSyntaxUID)){
      header=new dicomParser.DataSet(dicomParser.littleEndianByteArrayParser,byteArray,{});header.position=0;
    }else throw new Error('Unsupported raw DICOM parsing assumption.');
    const actualSyntax=header.string('x00020010')?.trim();
    if(actualSyntax&&source?.transferSyntaxUID&&actualSyntax!==source.transferSyntaxUID)throw new Error('DICOM transfer syntax differs from its parsing record.');
    const syntax=actualSyntax||source?.transferSyntaxUID;
    if(!syntax)throw new Error('DICOM Transfer Syntax UID is missing.');
    let bytes=byteArray;
    if(syntax==='1.2.840.10008.1.2.1.99') {
      if(typeof options.inflater!=='function')throw new Error('A local inflater is required for deflated DICOM metadata.');
      bytes=options.inflater(byteArray,header.position);
      if(!(bytes instanceof Uint8Array)||bytes.length<header.position)throw new Error('Invalid inflated DICOM byte array.');
    }
    const parser=syntax==='1.2.840.10008.1.2.2'?dicomParser.bigEndianByteArrayParser:dicomParser.littleEndianByteArrayParser;
    const stream=new dicomParser.ByteStream(parser,bytes,header.position);
    dataSet=new dicomParser.DataSet(parser,bytes,{});dataSet.warnings=stream.warnings;
    const parse=syntax==='1.2.840.10008.1.2'?dicomParser.parseDicomDataSetImplicit:dicomParser.parseDicomDataSetExplicit;
    parse(dataSet,stream,bytes.length,options);
    return dataSet;
  } catch(error) {
    throw {exception:error,dataSet};
  } finally {
    prototype.readFixedString=original;parsing=false;
    if(dataSet&&header) {
      Object.assign(dataSet.elements,header.elements);
      dataSet.warnings=[...(header.warnings||[]),...(dataSet.warnings||[])];
    }
    const pending=dataSet?[dataSet]:[],seen=new Set();
    while(pending.length) {
      const current=pending.pop();if(seen.has(current))continue;seen.add(current);
      for(const element of Object.values(current.elements||{})) {
        if(element.vr==='UN'&&modern.has(element.dataOffset))element.vr=modern.get(element.dataOffset);
        for(const item of element.items||[])if(item.dataSet)pending.push(item.dataSet);
      }
    }
  }
}
