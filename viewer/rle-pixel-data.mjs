function requireValue(test,message){if(!test)throw new Error(message);}

function unpackBits(encoded,start,end,expected){
  const output=new Uint8Array(expected);let i=start,j=0;
  while(i<end&&j<expected){
    let control=encoded[i++];if(control>127)control-=256;
    if(control>=0){
      const length=control+1;
      requireValue(i+length<=end&&j+length<=expected,'Invalid RLE literal run.');
      output.set(encoded.subarray(i,i+length),j);i+=length;j+=length;
    }else if(control!==-128){
      const length=1-control;
      requireValue(i<end&&j+length<=expected,'Invalid RLE repeat run.');
      output.fill(encoded[i++],j,j+length);j+=length;
    }
  }
  requireValue(j===expected,'Truncated RLE segment.');return output;
}

/** Decode the byte planes of a single DICOM RLE frame to interleaved samples. */
export function decodeRleSamples(encoded,{bits,samples,rows,columns}){
  requireValue(encoded.length>=64,'Truncated RLE frame header.');
  const header=new DataView(encoded.buffer,encoded.byteOffset,encoded.byteLength);
  const segments=header.getUint32(0,true),planes=Math.ceil(bits/8),count=rows*columns;
  requireValue(segments===planes*samples&&segments<=15,'Invalid RLE segment count.');
  const output=bits===32?new Uint32Array(count*samples):new Uint16Array(count*samples);
  for(let segment=0;segment<segments;segment++){
    const start=header.getUint32(4+segment*4,true),end=segment+1<segments?header.getUint32(8+segment*4,true):encoded.length;
    requireValue(start>=64&&end>=start&&end<=encoded.length,'Invalid RLE segment offset.');
    const plane=unpackBits(encoded,start,end,count),sample=Math.floor(segment/planes),shift=8*(planes-1-segment%planes);
    for(let i=0;i<count;i++)output[i*samples+sample]|=plane[i]<<shift;
  }
  return output;
}
