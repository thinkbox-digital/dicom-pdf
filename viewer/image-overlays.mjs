import {formatStudyDate} from './study-navigation.mjs';

const PROVENANCE=new Set(['top-level','shared-functional-groups','per-frame-functional-groups']);
const EMPTY_MARKERS=Object.freeze({top:null,right:null,bottom:null,left:null});
const MAX_TEXT=80,MAX_NUMBER=1e9,ORTHOGONAL_TOLERANCE=0.001,COMPONENT_EPSILON=0.0001;
const DECIMAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function safeText(value,limit=MAX_TEXT){
  if(typeof value!=='string')return '';
  const cleaned=value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
  const result=[];
  for(const character of cleaned){if(result.length===limit)return result.slice(0,limit-1).join('')+'…';result.push(character);}
  return result.join('');
}

function integer(value){
  if(typeof value==='string'){
    if(!/^[+]?\d+$/.test(value.trim()))return null;
    value=Number(value);
  }
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function decimal(value,{positive=false}={}){
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>MAX_NUMBER||positive&&value<=0)return null;
  const rounded=Number(value.toFixed(3));
  if(positive&&rounded<=0)return null;
  return String(Object.is(rounded,-0)?0:rounded);
}

function sourceIop(orientation){
  if(!orientation||!PROVENANCE.has(orientation.provenance))return null;
  const type=orientation.anatomicalOrientationType;
  // PS3.3 uses BIPED coordinates when AnatomicalOrientationType is absent.
  if(type!=null&&(typeof type!=='string'||type.trim().toUpperCase()!=='BIPED'))return null;
  let values=orientation.iop;
  if(typeof values==='string')values=values.split('\\').map(value=>DECIMAL.test(value.trim())?Number(value):NaN);
  if(!Array.isArray(values)||values.length!==6||values.some(value=>typeof value!=='number'||!Number.isFinite(value)))return null;
  const row=values.slice(0,3),column=values.slice(3),rowLength=Math.hypot(...row),columnLength=Math.hypot(...column);
  if(Math.abs(rowLength-1)>ORTHOGONAL_TOLERANCE||Math.abs(columnLength-1)>ORTHOGONAL_TOLERANCE
    ||Math.abs(row.reduce((sum,value,index)=>sum+value*column[index],0))>ORTHOGONAL_TOLERANCE)return null;
  return {row:row.map(value=>value/rowLength),column:column.map(value=>value/columnLength)};
}

function direction(vector){
  // Positive patient X/Y/Z point towards left/posterior/head in BIPED coordinates.
  const positive=['L','P','H'],negative=['R','A','F'];
  return vector.map((value,axis)=>({magnitude:Math.abs(value),axis,letter:value>0?positive[axis]:negative[axis]}))
    .filter(component=>component.magnitude>COMPONENT_EPSILON)
    .sort((a,b)=>b.magnitude-a.magnitude||a.axis-b.axis).map(component=>component.letter).join('')||null;
}

/**
 * Patient direction at each screen edge. Only explicit decoder/source IOP with
 * known provenance is accepted; renderer fallback geometry is never evidence.
 * Rotation is clockwise image rotation in degrees. H/F mean head/feet.
 */
export function orientationMarkers(sourceOrientation,{rotation=0}={}){
  const axes=sourceIop(sourceOrientation);
  if(!axes||typeof rotation!=='number'||!Number.isFinite(rotation)||Math.abs(rotation)>MAX_NUMBER)return EMPTY_MARKERS;
  const angle=(rotation%360)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  // Inverse image-to-screen rotation maps screen edge directions to patient axes.
  const right=axes.row.map((value,index)=>value*cos-axes.column[index]*sin);
  const bottom=axes.row.map((value,index)=>value*sin+axes.column[index]*cos);
  return Object.freeze({top:direction(bottom.map(value=>-value)),right:direction(right),bottom:direction(bottom),left:direction(right.map(value=>-value))});
}

function zoomLine(zoom){
  const x=typeof zoom==='number'?zoom:zoom?.x,y=typeof zoom==='number'?zoom:zoom?.y;
  const first=decimal(typeof x==='number'?x*100:NaN,{positive:true}),second=decimal(typeof y==='number'?y*100:NaN,{positive:true});
  if(first===null||second===null)return null;
  return first===second||Math.abs(x-y)<=Math.max(x,y)*0.000001?`Zoom ${first}%`:`Zoom ${first}% × ${second}%`;
}

/** Compact supplied series/date context, shared by image and comparison labels. */
export function sourceContextLines(entry){
  const fields={...(entry?.navigationFields||{}),...(entry?.fields||{})},lines=[];
  const description=safeText(fields.SeriesDescription),number=safeText(fields.SeriesNumber,12);
  const seriesNumber=/^[+-]?\d+$/.test(number)&&Number.isSafeInteger(Number(number))?number:'';
  if(description||seriesNumber)lines.push([seriesNumber?`Series ${seriesNumber}`:'',description].filter(Boolean).join(' · '));
  const rawDate=typeof fields.StudyDate==='string'?fields.StudyDate.trim():'';
  if(/^\d{8}$/.test(rawDate)){
    const date=formatStudyDate(rawDate);if(date!=='Date unavailable')lines.push(`Study ${date}`);
  }
  return lines;
}

/**
 * Pure text for an image overlay; callers render it using textContent.
 * index is zero-based position in the actual visible stack; frame is one-based.
 * window is the LIVE {center,width}, not a source preset or baseline recipe.
 * zoom is actual source-pixel-axis CSS scale, a number or {x,y}; no measurement
 * calibration is implied. Series/date use supplied fields, never filenames or
 * patient/instance identifiers. Missing/invalid values produce no placeholder.
 */
export function imageOverlayContext({entry,decoded,frame,index,count,window:windowValue,zoom,rotation=0,
  sourceOrientation=decoded?.sourceOrientation}={}){
  const fields={...(entry?.navigationFields||{}),...(entry?.fields||{})};
  const topLeft=sourceContextLines(entry),bottomLeft=[],bottomRight=[];
  const total=integer(count);
  if(total!==null&&Number.isSafeInteger(index)&&index>=0&&index<total)bottomLeft.push(`Image ${index+1} of ${total}`);
  const frames=integer(decoded?.frameCount)??integer(fields.NumberOfFrames),current=integer(frame===undefined?decoded?.sourceFrame:frame);
  if(frames!==null&&frames>1&&current!==null&&current<=frames)bottomLeft.push(`Frame ${current} of ${frames}`);
  if(decoded?.image?.color===false){
    const center=decimal(windowValue?.center),width=decimal(windowValue?.width,{positive:true});
    if(center!==null&&width!==null)bottomRight.push(`WL ${center} · WW ${width}`);
  }
  const zoomText=zoomLine(zoom);if(zoomText)bottomRight.push(zoomText);
  return {lines:{topLeft,bottomLeft,bottomRight},markers:orientationMarkers(sourceOrientation,{rotation})};
}
