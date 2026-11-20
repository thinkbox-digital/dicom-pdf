import {buildStoredVoiLut,validWindow} from './voi-window.mjs';

export const GSPS_SOP='1.2.840.10008.5.1.4.1.1.11.1';

const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};
const str=(ds,tag)=>ds.string(tag)?.trim();
const items=(ds,tag)=>ds.elements[tag]?.items?.map(item=>item.dataSet)||[];
const number=(ds,tag)=>{const value=ds.string(tag,0)?.trim();return value?Number(value):undefined;};
const pair=(ds,tag,read)=>[ds[read](tag,0),ds[read](tag,1)];
const finitePair=values=>values.every(Number.isFinite);
const uid=value=>value?.length<=64&&/^[0-9]+(?:\.[0-9]+)+$/.test(value);

function references(ds){
  const refs=items(ds,'x00081140').map(item=>{
    const instance=str(item,'x00081155'),sopClass=str(item,'x00081150');
    const frames=str(item,'x00081160')?.split('\\').map(Number)??null;
    requireValue(uid(instance)&&uid(sopClass)&&(!frames||frames.every(frame=>Number.isSafeInteger(frame)&&frame>=1)),
      'The presentation state has an invalid image or frame reference.');
    return {instance,sopClass,frames};
  });
  requireValue(!ds.elements.x00081140||refs.length,'The presentation state has an empty image reference sequence.');
  return refs;
}

function graphics(ds){
  return items(ds,'x00700009').map(item=>{
    const count=item.uint16('x00700021'),type=str(item,'x00700023'),units=str(item,'x00700005');
    const fill=str(item,'x00700024')||'N',length=item.elements.x00700022?.length;
    const countValid=type==='POLYLINE'?count>=2:({POINT:1,CIRCLE:2,ELLIPSE:4})[type]===count;
    requireValue(item.uint16('x00700020')===2&&countValid&&count<=4096&&length===count*8
      &&['PIXEL','DISPLAY'].includes(units)&&['Y','N'].includes(fill),'The presentation state uses an unsupported graphic.');
    const points=Array.from({length:count},(_,i)=>[item.float('x00700022',i*2),item.float('x00700022',i*2+1)]);
    requireValue(points.every(finitePair),'The presentation state has invalid graphic coordinates.');
    return {type,units,points,filled:fill==='Y'};
  });
}

function texts(ds,encoding){
  return items(ds,'x00700008').map(item=>{
    const el=item.elements.x00700006;
    requireValue(el?.length>0&&el.length<=8192,'The presentation state has invalid annotation text.');
    const data=item.byteArray.subarray(el.dataOffset,el.dataOffset+el.length);
    requireValue(encoding!=='ascii'||data.every(byte=>byte<128),'The presentation state text uses an unsupported character set.');
    const text=new TextDecoder(encoding,{fatal:true}).decode(data).trimEnd();
    const box=item.elements.x00700010?{
      start:pair(item,'x00700010','float'),end:pair(item,'x00700011','float'),
      units:str(item,'x00700003'),align:str(item,'x00700012'),
    }:null;
    const anchor=item.elements.x00700014?{
      point:pair(item,'x00700014','float'),units:str(item,'x00700004'),visible:str(item,'x00700015')==='Y',
    }:null;
    requireValue((box||anchor)&&(!box||finitePair(box.start)&&finitePair(box.end)
      &&['LEFT','RIGHT','CENTER'].includes(box.align)&&['PIXEL','DISPLAY'].includes(box.units))
      &&(!anchor||finitePair(anchor.point)&&['PIXEL','DISPLAY'].includes(anchor.units)),
    'The presentation state has invalid text coordinates.');
    return {text,box,anchor};
  });
}

/** Supported GSPS transformations in PS3.3 C.10 and PS3.4 N.2. */
export function readPresentationState(ds){
  requireValue(!['x00283000','x20500010','x00181600','x00286100','x00089410']
    .some(tag=>ds.elements[tag])&&!Object.keys(ds.elements).some(tag=>/^x60[0-1][0-9a-f]/.test(tag)),
  'This presentation state requires a LUT, shutter, mask, or bitmap overlay.');
  const rotation=ds.uint16('x00700042')??0,flip=str(ds,'x00700041')||'N';
  const shape=str(ds,'x20500020');
  const slope=number(ds,'x00281053')??1,intercept=number(ds,'x00281052')??0;
  requireValue([0,90,180,270].includes(rotation)&&['N','Y'].includes(flip)&&['IDENTITY','INVERSE'].includes(shape)
    &&Number.isFinite(slope)&&slope!==0&&Number.isFinite(intercept),'The presentation state has an invalid spatial or contrast transformation.');
  const refs=items(ds,'x00081115').flatMap(references);
  requireValue(refs.length>0,'The presentation state has no image references.');
  const areas=items(ds,'x0070005a').map(item=>{
    const start=pair(item,'x00700052','int32'),end=pair(item,'x00700053','int32');
    const spacing=str(item,'x00700101')||str(item,'x00700102');
    const [row,column]=spacing?.split('\\').map(Number)||[];
    requireValue(finitePair(start)&&finitePair(end)&&row>0&&column>0
      &&Number.isFinite(row/column)&&row/column>=1e-6&&row/column<=1e6
      &&str(item,'x00700100')==='SCALE TO FIT'&&[undefined,'FRAME'].includes(str(item,'x00480301')),
    'The presentation state uses an unsupported displayed area.');
    return {refs:references(item),start,end,aspect:row/column};
  });
  requireValue(areas.length,'The presentation state has no displayed area.');
  const windows=items(ds,'x00283110').map(item=>{
    const window={center:number(item,'x00281050'),width:number(item,'x00281051'),function:str(item,'x00281056')||'LINEAR'};
    requireValue(!item.elements.x00283010&&validWindow(window),'The presentation state uses an unsupported VOI transformation.');
    return {refs:references(item),window};
  });
  const characterSet=str(ds,'x00080005')||'ISO_IR 6';
  const encodings={'ISO_IR 6':'ascii','ISO_IR 100':'iso-8859-1','ISO_IR 192':'utf-8'};
  const layers=new Map(items(ds,'x00700060').map(item=>[str(item,'x00700002'),{
    order:number(item,'x00700062'),gray:Math.round((item.uint16('x00700066')??65535)*255/65535),
  }]));
  const annotations=items(ds,'x00700001').map(item=>{
    const layer=layers.get(str(item,'x00700002'));
    requireValue(layer&&Number.isFinite(layer.order)&&!item.elements.x00700209&&!item.elements.x00700295
      &&(!item.elements.x00700008||Object.hasOwn(encodings,characterSet)),'The presentation state uses an unsupported annotation layer.');
    return {refs:references(item),...layer,graphics:graphics(item),texts:texts(item,encodings[characterSet])};
  }).sort((a,b)=>a.order-b.order);
  return {refs,areas,windows,annotations,rotation,flip:flip==='Y',invert:shape==='INVERSE',slope,intercept};
}

const applies=(refs,instance,frame)=>!refs.length||refs.some(ref=>ref.instance===instance&&(!ref.frames||ref.frames.includes(frame)));

export function presentationLut(image,{slope,intercept,invert},window){
  return buildStoredVoiLut({...image,slope,intercept,modalityLut:null,sampledVoiLut:null,presentationLut:null},window,{invert});
}

export function presentationFrame(presentation,decoded,{includeLut=true}={}){
  const {image,sopInstanceUID:instance,sourceFrame:frame}=decoded;
  requireValue(!image.color&&applies(presentation.refs,instance,frame),'The grayscale presentation state does not reference this frame.');
  const areas=presentation.areas.filter(item=>applies(item.refs,instance,frame));
  const windows=presentation.windows.filter(item=>applies(item.refs,instance,frame));
  requireValue(areas.length===1&&windows.length<=1,'The saved display settings are missing or ambiguous for this frame.');
  const {start,end,aspect}=areas[0];
  const {columns,rows}=image;
  const {rotation,flip,slope,intercept}=presentation;
  const point=(x,y)=>{
    let p=[x,y];
    switch(rotation){
      case 90:p=[rows-y,x];break;
      case 180:p=[columns-x,rows-y];break;
      case 270:p=[y,columns-x];break;
    }
    if(flip)p[0]=(rotation%180?rows:columns)-p[0];
    return p;
  };
  const [left,top]=point(start[0]-0.5,start[1]-0.5).map(value=>value-0.5);
  const [right,bottom]=point(end[0]-0.5,end[1]-0.5).map(value=>value+0.5);
  requireValue(right>left&&bottom>top&&right-left<100000&&bottom-top<100000,'The saved crop is invalid.');
  const bits=decoded.metadata.imagePixelModule.bitsStored;
  const signed=decoded.metadata.imagePixelModule.pixelRepresentation===1;
  const min=(signed?-(2**(bits-1)):0)*slope+intercept;
  const max=(signed?2**(bits-1)-1:2**bits-1)*slope+intercept;
  const window=windows[0]?.window??{center:(min+max)/2,width:Math.abs(max-min),function:'LINEAR_EXACT'};
  return {point,left,top,right,bottom,aspect:rotation%180?1/aspect:aspect,window,
    ...(includeLut?{lut:presentationLut(image,presentation,window)}:{}),
    annotations:presentation.annotations.filter(item=>applies(item.refs,instance,frame))};
}
