import {workingMemoryBytes} from './working-memory.mjs';

export const MR_SPECTROSCOPY_SOP='1.2.840.10008.5.1.4.1.1.4.2';

/** PS3.3 C.8.14.4.1 stores contiguous voxels with real/imaginary pairs. */
export function readMrSpectroscopy(ds){
  const rows=ds.uint16('x00280010'),columns=ds.uint16('x00280011');
  const frames=Number(ds.string('x00280008')??1),points=ds.uint32('x00289002');
  const domain=ds.string('x00289003')?.trim(),representation=ds.string('x00289108')?.trim();
  const width=ds.double('x00189052'),components=representation==='COMPLEX'?2:1;
  const el=ds.elements.x56000020, count=rows*columns*frames*points*components;
  const length=count*4;
  if(![rows,columns,frames,points].every(value=>Number.isSafeInteger(value)&&value>0)||points<2||points>65536
    ||ds.uint32('x00289001')!==1||!['TIME','FREQUENCY'].includes(domain)
    ||!['COMPLEX','REAL','IMAGINARY','MAGNITUDE'].includes(representation)
    ||!Number.isFinite(width)||width<=0||!Number.isFinite(1000/width)||!Number.isSafeInteger(length)||length>workingMemoryBytes()-ds.byteArray.length
    ||!el||el.vr&&el.vr!=='OF'||el.hadUndefinedLength||el.length!==length||el.dataOffset+length>ds.byteArray.length)
    throw new Error('The spectroscopy sample layout or spectral width could not be verified.');
  const data=new Float32Array(count);
  for(let index=0;index<count;index++){
    const value=ds.byteArrayParser.readFloat(ds.byteArray,el.dataOffset+index*4);
    if(!Number.isFinite(value))throw new Error('The spectroscopy data contains a non-finite sample.');
    data[index]=value;
  }
  return {rows,columns,frames,points,domain,representation,components,width,data};
}

function spectrum(real,imaginary){
  const n=real.length;
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;
    for(;j&bit;bit>>=1)j^=bit;
    j^=bit;
    if(i<j){
      [real[i],real[j]]=[real[j],real[i]];
      [imaginary[i],imaginary[j]]=[imaginary[j],imaginary[i]];
    }
  }
  for(let stride=2;stride<=n;stride*=2){
    const half=stride/2;
    for(let k=0;k<half;k++){
      const theta=-2*Math.PI*k/stride,cos=Math.cos(theta),sin=Math.sin(theta);
      for(let i=k;i<n;i+=stride){
        const j=i+half,r=real[j]*cos-imaginary[j]*sin,m=real[j]*sin+imaginary[j]*cos;
        real[j]=real[i]-r;imaginary[j]=imaginary[i]-m;
        real[i]+=r;imaginary[i]+=m;
      }
    }
  }
}

// Frame, row and column are one-based, matching the source voxel controls.
export function spectroscopyTrace(source,{frame=1,row=1,column=1,frequency=source.domain==='FREQUENCY'}={}){
  if(![[frame,source.frames],[row,source.rows],[column,source.columns]]
    .every(([value,max])=>Number.isInteger(value)&&value>=1&&value<=max))throw new Error('Choose a voxel within the acquired grid.');
  const {rows,columns,points,data,components,domain,representation,width}=source;
  const start=(((frame-1)*rows+row-1)*columns+column-1)*points*components;
  const transform=frequency&&domain==='TIME';
  if(transform&&representation!=='COMPLEX')throw new Error('Fourier display requires complex time-domain samples.');
  const count=transform?2**Math.ceil(Math.log2(points)):points;
  const real=new Float64Array(count),imaginary=components===2?new Float64Array(count):null;
  for(let i=0;i<points;i++){
    real[i]=data[start+i*components];
    if(imaginary)imaginary[i]=data[start+i*components+1];
  }
  if(transform){
    spectrum(real,imaginary);
    const step=width/count;
    // DICOM orders spectral points from high to low frequency. Use the
    // standard signed DFT bins, omitting the unrepresented +Nyquist bin.
    const first=count/2-1;
    const values=Float64Array.from({length:count},(_,i)=>{
      const bin=(first-i+count)%count;
      return Math.hypot(real[bin],imaginary[bin])/points;
    });
    return {first:first*step,step:-step,label:'Frequency offset (Hz)',traces:[{name:'Magnitude',values}]};
  }
  const step=domain==='FREQUENCY'?-width/count:1000/width;
  return {first:domain==='FREQUENCY'?Math.floor(count/2)*-step:0,step,
    label:domain==='FREQUENCY'?'Frequency offset (Hz)':'Time (ms)',
    traces:imaginary?[{name:'Real',values:real},{name:'Imaginary',values:imaginary}]:
      [{name:representation[0]+representation.slice(1).toLowerCase(),values:real}]};
}
