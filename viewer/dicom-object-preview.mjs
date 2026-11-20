import {utilities} from '@cornerstonejs/core';
import {presentationFrame,presentationLut} from './presentation-state.mjs';
import {spectroscopyTrace} from './mr-spectroscopy.mjs';
import {swapDoseWords} from './rt-dose.mjs';
import {mountRtDoseViewport} from './rt-dose-viewport.mjs';
import {frameFitsMemory} from './working-memory.mjs';

function surfaceFor(container,label,tag='canvas'){
  const surface=document.createElement('section');
  surface.className='dicom-object-preview';
  const bar=document.createElement('div');
  bar.className='dicom-object-controls';
  const canvas=document.createElement(tag);
  canvas.setAttribute('role',tag==='canvas'?'img':'region');
  canvas.setAttribute('aria-label',label);
  const message=document.createElement('p');
  message.setAttribute('role','status');message.hidden=true;
  surface.append(bar,canvas,message);
  container.replaceChildren(surface);
  return {surface,bar,canvas,message};
}
function control(bar,name,input){
  const label=document.createElement('label');
  label.append(name,input);bar.append(label);
  return input;
}
function spin(bar,name,max){
  const input=document.createElement('input');
  Object.assign(input,{type:'number',value:'1',min:'1',max:String(max),step:'1'});
  const field=control(bar,name,input);
  field.parentElement.hidden=max===1;
  return field;
}
function select(bar,name,labels){
  const input=document.createElement('select');
  labels.forEach((label,i)=>input.add(new Option(label,String(i))));
  return control(bar,name,input);
}

export function renderSpectroscopy(container,source){
  const {surface,bar,canvas,message}=surfaceFor(container,'MR spectroscopy plot. Vertical axis is relative signal amplitude.');
  const frame=spin(bar,'Frame',source.frames),row=spin(bar,'Voxel row',source.rows),column=spin(bar,'Voxel column',source.columns);
  const canTransform=source.domain==='TIME'&&source.representation==='COMPLEX';
  const display=canTransform?select(bar,'Display',['Spectrum','Time signal']):null;
  const legend=document.createElement('p');surface.append(legend);
  function draw(){
    try{
      const trace=spectroscopyTrace(source,{frame:Number(frame.value),row:Number(row.value),column:Number(column.value),
        frequency:source.domain==='FREQUENCY'||display?.value==='0'});
      canvas.hidden=false;message.hidden=true;
      canvas.width=Math.max(340,Math.min(1500,Math.floor(surface.clientWidth)));
      canvas.height=Math.max(260,Math.min(620,Math.floor(surface.clientHeight)-80));
      const ctx=canvas.getContext('2d'),width=canvas.width,height=canvas.height;
      const left=83,right=width-20,top=20,bottom=height-57;
      const length=trace.traces[0].values.length;
      let min=0,max=0;
      for(const entry of trace.traces)for(const value of entry.values){min=Math.min(min,value);max=Math.max(max,value);}
      if(min===max){min=-1;max=1;}
      ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
      ctx.font='12px system-ui';ctx.fillStyle='#243b54';ctx.strokeStyle='#ccd7e5';
      const format=new Intl.NumberFormat('en-US',{maximumSignificantDigits:4,notation:Math.abs(max)>1e5?'scientific':'standard'});
      for(let i=0;i<=4;i++){
        const y=top+(bottom-top)*i/4;
        ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
        ctx.textAlign='right';ctx.fillText(format.format(max-(max-min)*i/4),left-8,y+4);
        const x=left+(right-left)*i/4;
        ctx.textAlign='center';ctx.fillText(format.format(trace.first+trace.step*(length-1)*i/4),x,bottom+17);
      }
      ctx.font='13px system-ui';ctx.fillText(trace.label,(left+right)/2,height-15);
      ctx.save();ctx.translate(15,(top+bottom)/2);ctx.rotate(-Math.PI/2);ctx.fillText('Relative signal amplitude',0,0);ctx.restore();
      const colors=['#174f87','#a24913'];
      trace.traces.forEach(({values},index)=>{
        ctx.strokeStyle=colors[index];ctx.lineWidth=1.25;ctx.beginPath();
        values.forEach((value,i)=>{
          const x=left+i*(right-left)/(length-1),y=bottom-(value-min)*(bottom-top)/(max-min);
          if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);
        });
        ctx.stroke();
      });
      canvas.dataset.axis=trace.label;
      legend.replaceChildren(...trace.traces.map(({name},i)=>{
        const span=document.createElement('span');span.style.color=colors[i];span.textContent=name;return span;
      }));
      legend.className='spectrum-legend';
    }catch(error){canvas.hidden=true;message.hidden=false;message.textContent=error.message;}
  }
  bar.addEventListener('change',draw);
  const observer=new ResizeObserver(draw);observer.observe(surface);draw();
  return ()=>{observer.disconnect();surface.remove();};
}

function circleAxis({points:[a,b],units},map,center){
  const end=map([a[0]-(b[1]-a[1]),a[1]+(b[0]-a[0])],units);
  return [end[0]-center[0],end[1]-center[1]];
}

function paintPresentation(canvas,sourceCanvas,recipe,stage){
  const {point,left,top,right,bottom,aspect,annotations}=recipe;
  const width=right-left,height=bottom-top;
  const scale=Math.min(stage.clientWidth/width,stage.clientHeight/(height*aspect),1500/width,1500/(height*aspect));
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale*aspect));
  const sx=canvas.width/width,sy=canvas.height/height;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);
  const origin=point(0,0),across=point(1,0),down=point(0,1);
  ctx.save();
  ctx.setTransform((across[0]-origin[0])*sx,(across[1]-origin[1])*sy,(down[0]-origin[0])*sx,(down[1]-origin[1])*sy,
    (origin[0]-left)*sx,(origin[1]-top)*sy);
  ctx.drawImage(sourceCanvas,0,0);
  ctx.restore();
  const map=(p,units)=>{
    if(units==='DISPLAY')return [p[0]*canvas.width,p[1]*canvas.height];
    const [x,y]=point(...p);
    return [(x-left)*sx,(y-top)*sy];
  };
  for(const layer of annotations){
    ctx.strokeStyle=ctx.fillStyle=`rgb(${layer.gray} ${layer.gray} ${layer.gray})`;
    ctx.lineWidth=1.5;
    for(const graphic of layer.graphics){
      const points=graphic.points.map(p=>map(p,graphic.units));
      const [a,b,c,d]=points;
      ctx.beginPath();
      if(graphic.type==='POINT')ctx.arc(...a,2,0,2*Math.PI);
      if(graphic.type==='POLYLINE'){
        ctx.moveTo(...a);
        for(const p of points.slice(1))ctx.lineTo(...p);
      }
      if(graphic.type==='CIRCLE'||graphic.type==='ELLIPSE'){
        const [center,major,minor]=graphic.type==='CIRCLE'
          ?[a,[b[0]-a[0],b[1]-a[1]],circleAxis(graphic,map,a)]
          :[[(a[0]+b[0])/2,(a[1]+b[1])/2],[(b[0]-a[0])/2,(b[1]-a[1])/2],[(d[0]-c[0])/2,(d[1]-c[1])/2]];
        ctx.save();ctx.translate(...center);
        ctx.transform(...major,...minor,0,0);
        ctx.arc(0,0,1,0,2*Math.PI);
        ctx.restore();
      }
      if(graphic.filled||graphic.type==='POINT')ctx.fill();else ctx.stroke();
    }
    for(const {text,box,anchor} of layer.texts){
      const a=anchor?map(anchor.point,anchor.units):null;
      let x=a?.[0],y=a?.[1],maxWidth;
      ctx.textAlign='left';ctx.textBaseline='top';ctx.font='14px system-ui';
      ctx.save();
      if(box){
        const p=map(box.start,box.units),q=map(box.end,box.units);
        const left=Math.min(p[0],q[0]),right=Math.max(p[0],q[0]);
        y=Math.min(p[1],q[1]);maxWidth=right-left;
        ctx.textAlign=box.align.toLowerCase();x=box.align==='LEFT'?left:box.align==='RIGHT'?right:(left+right)/2;
        if(anchor?.visible){
          ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(Math.min(right,Math.max(left,a[0])),Math.min(Math.max(p[1],q[1]),Math.max(y,a[1])));ctx.stroke();
        }
        ctx.beginPath();ctx.rect(left,y,maxWidth,Math.abs(p[1]-q[1]));ctx.clip();
      }
      text.split(/\r\n|\r|\n/).forEach((line,i)=>{
        if(maxWidth===undefined)ctx.fillText(line,x,y+i*16);else if(maxWidth>0)ctx.fillText(line,x,y+i*16,maxWidth);
      });
      ctx.restore();
    }
  }
}

function usesNativePresentationWindow(image,pixels,{slope,intercept},window){
  if(window.function!=='LINEAR'||window.width<=1
    ||!(pixels instanceof Uint8Array||pixels instanceof Int8Array||pixels instanceof Uint16Array||pixels instanceof Int16Array))return false;
  if(!Number.isFinite(image.minPixelValue*slope+intercept)||!Number.isFinite(image.maxPixelValue*slope+intercept))return false;
  // The native path needs one extra full-size RGBA canvas in addition to the
  // frame allocations already accounted for by the viewer.
  if(!frameFitsMemory(image.rows,image.columns,{residentBytes:4*pixels.length}))return false;
  // Our window clips at its rounded boundaries. Cornerstone clamps the formula
  // instead, so retain the exact fallback when rounding shifts an endpoint.
  const midpoint=window.center-0.5,span=window.width-1;
  const lower=midpoint-span/2,upper=midpoint+span/2;
  const edges=new Uint8ClampedArray([((lower-midpoint)/span+0.5)*255,((upper-midpoint)/span+0.5)*255]);
  return edges[0]===0&&edges[1]===255;
}

async function renderPresentationSource(image,recipe,window){
  const {columns,rows}=image,pixels=image.getPixelData();
  const canvas=document.createElement('canvas');canvas.width=columns;canvas.height=rows;
  if(usesNativePresentationWindow(image,pixels,recipe,window)){
    // Apply saved contrast to unscaled source pixels. The presentation's own
    // pixel aspect ratio is applied during the final crop and annotation pass.
    await utilities.renderToCanvasCPU(canvas,{
      imageId:image.imageId,columns,rows,width:columns,height:rows,color:false,
      rowPixelSpacing:1,columnPixelSpacing:1,
      minPixelValue:image.minPixelValue,maxPixelValue:image.maxPixelValue,
      slope:recipe.slope,intercept:recipe.intercept,invert:recipe.invert,
      windowCenter:window.center,windowWidth:window.width,getPixelData:image.getPixelData,
      voxelManager:utilities.VoxelManager.createImageVoxelManager({width:columns,height:rows,scalarData:pixels}),
    });
    return canvas;
  }
  const {values,offset}=presentationLut(image,recipe,window);
  const ctx=canvas.getContext('2d'),rgba=ctx.createImageData(columns,rows);
  for(let i=0,j=0;i<pixels.length;i++,j+=4){
    const gray=values[pixels[i]+offset];
    rgba.data[j]=gray;rgba.data[j+1]=gray;rgba.data[j+2]=gray;rgba.data[j+3]=255;
  }
  ctx.putImageData(rgba,0,0);
  return canvas;
}

export function renderPresentation(container,recipe,targets,{decode,isCurrent}){
  const {surface,bar,canvas,message}=surfaceFor(container,'Grayscale image with the saved presentation state applied');
  surface.classList.add('presentation-preview');
  const stage=document.createElement('div');
  stage.className='presentation-preview-stage';
  stage.append(canvas,message);
  surface.append(stage);
  const image=targets.length>1?select(bar,'Referenced image',targets.map(target=>target.name)):null;
  const frame=select(bar,'Referenced frame',[]);
  let revision=0,sourceCanvas=null,settings=null,request=null;
  const draw=()=>{if(sourceCanvas&&settings&&isCurrent())paintPresentation(canvas,sourceCanvas,settings,stage);};
  const observer=new ResizeObserver(draw);
  function setFrames(){
    const {frames}=targets[Number(image?.value||0)];
    frame.replaceChildren(...frames.map(value=>new Option(String(value),String(value))));
    frame.parentElement.hidden=frames.length===1;
    bar.hidden=!image&&frame.parentElement.hidden;
  }
  async function show(){
    const rev=++revision,target=targets[Number(image?.value||0)],number=Number(frame.value);
    request?.abort();request=new AbortController();
    canvas.hidden=true;canvas.removeAttribute('data-source-frame');message.hidden=false;message.textContent='Reading the referenced frame…';
    sourceCanvas=null;settings=null;
    try{
      const decoded=await decode(target,number,request.signal);
      if(!isCurrent()||rev!==revision)return;
      const nextSettings=presentationFrame(recipe,decoded,{includeLut:false});
      const nextSource=await renderPresentationSource(decoded.image,recipe,nextSettings.window);
      if(!isCurrent()||rev!==revision)return;
      settings=nextSettings;sourceCanvas=nextSource;
      draw();message.hidden=true;canvas.hidden=false;
      canvas.dataset.sourceFrame=String(number);return true;
    }catch(error){
      if(isCurrent()&&rev===revision&&error.name!=='AbortError'){
        settings=null;sourceCanvas=null;
        message.textContent='The saved presentation could not be applied to this frame. '+error.message;
      }
    }
  }
  image?.addEventListener('change',()=>{setFrames();void show();});
  frame.addEventListener('change',()=>{void show();});
  setFrames();observer.observe(stage);
  return {ready:show(),cleanup(){revision++;request?.abort();observer.disconnect();surface.remove();}};
}

function appendText(parent,tag,value){
  const item=document.createElement(tag);
  item.textContent=value;parent.append(item);
  return item;
}

function appendRtFields(parent,fields){
  if(!fields.length)return;
  const list=document.createElement('dl');list.className='rt-fields';
  for(const [label,value] of fields){
    appendText(list,'dt',label);appendText(list,'dd',value);
  }
  parent.append(list);
}

export function renderRtPlan(container,plan){
  const surface=document.createElement('section');surface.className='rt-plan-preview';
  appendText(surface,'h2','RT Plan');
  appendRtFields(surface,plan.fields);
  for(const {title,items} of plan.sections){
    const section=document.createElement('section');
    appendText(section,'h3',title);
    for(const item of items){
      appendText(section,'h4',item.title);
      appendRtFields(section,item.fields);
    }
    surface.append(section);
  }
  container.replaceChildren(surface);
  return ()=>surface.remove();
}

const DOSE_COLORS=['#440154','#3b528b','#21918c','#5ec962','#fde725'];
const DOSE_GRADIENT='linear-gradient(to right, '+DOSE_COLORS.join(', ')+')';
const DOSE_PALETTE=(()=>{
  const stops=DOSE_COLORS.map(color=>[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)));
  return Array.from({length:256},(_,i)=>{
    const position=i/255*(stops.length-1),left=Math.min(stops.length-2,Math.floor(position)),fraction=position-left;
    const rgb=stops[left].map((value,channel)=>value*(1-fraction)+stops[left+1][channel]*fraction);
    return Uint8ClampedArray.of(...rgb,255);
  });
})();
const doseNumber=new Intl.NumberFormat('en-US',{maximumSignificantDigits:12,useGrouping:false});
const doseExponent=new Intl.NumberFormat('en-US',{maximumSignificantDigits:12,notation:'scientific'});
function doseText(value){
  const magnitude=Math.abs(value);
  return (magnitude>=1e7||magnitude>0&&magnitude<1e-4?doseExponent:doseNumber).format(value);
}

export function renderRtDose(container,source,engine){
  const {surface,bar,canvas:display,message}=surfaceFor(container,'RT Dose slice viewport','div');
  surface.classList.add('rt-dose-preview');
  display.className='rt-dose-viewport';display.tabIndex=0;
  const heading=appendText(surface,'h2','RT Dose');
  surface.prepend(heading);
  const order=source.swappedRange?select(bar,'32-bit Big Endian word order',[
    'Choose word order','DICOM OW (low word first)','32-bit samples (high word first)',
  ]):null;
  const slice=spin(bar,'Slice',source.frames),row=spin(bar,'Voxel row',source.rows),column=spin(bar,'Voxel column',source.columns);
  slice.setAttribute('aria-label','Dose slice');
  if(source.frames>1)slice.parentElement.append(' / '+source.frames);
  const zoom=document.createElement('div');zoom.className='zoom-controls';bar.append(zoom);
  for(const [text,label,factor] of [['−','Zoom out',0.8],['+','Zoom in',1.25],['Fit','Fit dose slice',null]]){
    const button=appendText(zoom,'button',text);button.type='button';button.setAttribute('aria-label',label);
    button.addEventListener('click',()=>factor===null?stack?.fit():stack?.zoom(factor));
  }
  const position=appendText(surface,'p','');position.className='rt-slice-position';bar.after(position);
  const legend=document.createElement('div');legend.className='rt-dose-legend';
  appendText(legend,'div','Grid dose scale ('+source.units+')');
  const gradient=document.createElement('div');gradient.className='rt-dose-gradient';legend.append(gradient);
  const bounds=document.createElement('div');bounds.className='rt-dose-bounds';legend.append(bounds);
  const minimum=appendText(bounds,'span',''),maximum=appendText(bounds,'span','');
  const sample=appendText(surface,'output','');sample.className='rt-dose-sample';
  surface.insertBefore(legend,sample);
  appendRtFields(surface,[
    ['Dose type',source.type],
    ...(source.summation?[['Dose summation type',source.summation]]:[]),
    ...(source.spacing?[['Pixel spacing (row × column)',source.spacing.map(doseText).join(' × ')+' mm']]:[]),
    ...source.plans.map(uid=>['Referenced plan UID',uid]),
  ]);
  if(!source.spacing)appendText(surface,'p','Pixel spacing unavailable. The preview uses square pixels.');
  let frame=1,voxelRow=1,voxelColumn=1,stack=null;
  let valueAt=index=>source.data[index];
  function updateSample(){
    const index=((frame-1)*source.rows+voxelRow-1)*source.columns+voxelColumn-1;
    sample.textContent='Voxel dose '+doseText(valueAt(index)*source.scaling)+' '+source.units;
  }
  function readIndex(input,current){
    const next=input.valueAsNumber;
    if(Number.isInteger(next)&&next>=1&&next<=Number(input.max))return next;
    input.value=String(current);return current;
  }
  function showFrame(number){
    frame=number;slice.value=String(number);
    message.hidden=true;legend.hidden=sample.hidden=false;
    position.hidden=source.frames===1;
    position.textContent=source.positions
      ?source.positions.label+' '+doseText(source.positions.values[frame-1])+' mm'
      :'Slice positions unavailable';
    updateSample();
  }
  function showError(){
    slice.value=String(frame);
    message.textContent='The dose slice could not be displayed. Select the slice again to retry.';
    message.hidden=false;
  }
  async function startStack(){
    stack?.destroy();stack=null;
    const pending=order?.value==='0';
    slice.parentElement.hidden=pending||source.frames===1;
    row.parentElement.hidden=pending||source.rows===1;
    column.parentElement.hidden=pending||source.columns===1;
    display.hidden=zoom.hidden=pending;
    legend.hidden=sample.hidden=position.hidden=true;message.hidden=false;
    if(pending){
      message.textContent='Choose the source’s word order to display its dose values.';
      return true;
    }
    const swapped=order?.value==='2',[low,high]=swapped?source.swappedRange:source.range;
    const storedAt=swapped?index=>swapDoseWords(source.data[index],source.signed):index=>source.data[index];
    valueAt=storedAt;
    minimum.textContent=doseText(low*source.scaling);
    maximum.textContent=high===low?'':doseText(high*source.scaling);
    gradient.style.background=high===low?DOSE_COLORS[2]:DOSE_GRADIENT;
    message.textContent='Reading dose slice…';
    try{
      stack=mountRtDoseViewport({engine,element:display,source,palette:DOSE_PALETTE,onFrame:showFrame,onError:showError,frameShades:number=>{
        const count=source.rows*source.columns,offset=(number-1)*count,pixels=new Uint8Array(count);
        for(let i=0;i<count;i++){
          pixels[i]=high===low?128:Math.round((storedAt(offset+i)-low)/(high-low)*255);
        }
        return pixels;
      }});
      return await stack.show(frame);
    }catch{
      showError();return false;
    }
  }
  const updateVoxel=()=>{
    voxelRow=readIndex(row,voxelRow);voxelColumn=readIndex(column,voxelColumn);
    updateSample();
  };
  order?.addEventListener('change',()=>{void startStack();});
  slice.addEventListener('change',()=>{void stack?.show(readIndex(slice,frame));});
  row.addEventListener('change',updateVoxel);column.addEventListener('change',updateVoxel);
  display.addEventListener('keydown',event=>{
    if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.isComposing)return;
    const step={ArrowUp:-1,ArrowLeft:-1,ArrowDown:1,ArrowRight:1}[event.key];
    if(!step||source.frames===1)return;
    event.preventDefault();
    void stack?.show(Math.min(source.frames,Math.max(1,frame+step)));
  },true);
  return {ready:startStack(),cleanup(){stack?.destroy();stack=null;surface.remove();}};
}
