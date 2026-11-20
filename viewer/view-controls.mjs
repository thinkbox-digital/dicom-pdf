import {floatingVoi,windowInputValue,voiValue} from './voi-window.mjs';
import {isFloatingPixels} from './parametric-map.mjs';

/** Temporary display controls; original pixels and the preservation recipe stay unchanged. */
export function createViewControls({viewport,element,ready,sourceInvert,onStep,fitCamera=()=>viewport.resetCamera(),onReset=()=>{},onChange=()=>{},onCancelGesture=()=>{}}) {
  const listeners=[];
  const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));};
  const changed=()=>{viewport.render();onChange({rotation:viewport.getRotation(),inverted:!!viewport.getProperties().invert!==!!sourceInvert(),zoom:viewport.getZoom()});};
  const available=()=>Boolean(ready());
  function rotate(degrees){if(!available())return;viewport.setRotation(((viewport.getRotation()+degrees)%360+360)%360);changed();}
  function invert(){if(!available())return;viewport.setProperties({invert:!viewport.getProperties().invert});changed();}
  function zoom(factor){if(!available()||!Number.isFinite(factor)||factor<=0)return;viewport.setZoom(Math.min(10000,Math.max(0.0001,viewport.getZoom()*factor)));changed();}
  function fit(){if(!available())return;fitCamera();changed();}
  function reset(){if(!available())return;viewport.setRotation(0);viewport.setProperties({invert:!!sourceInvert()});fitCamera();onReset();changed();}
  const point=value=>value&&value.length>=3&&[value[0],value[1],value[2]].every(Number.isFinite)?[value[0],value[1],value[2]]:null;
  const cameraPan=()=>typeof viewport.getCamera==='function'&&typeof viewport.setCamera==='function'&&typeof viewport.canvasToWorld==='function';
  function cameraSnapshot(){
    if(!cameraPan())return null;
    try{const camera=viewport.getCamera(),focalPoint=point(camera?.focalPoint);return focalPoint?{focalPoint,position:point(camera.position)}:null;}catch{return null;}
  }
  function panCamera(dx,dy,camera){
    if(!camera)return false;
    try{
      const origin=point(viewport.canvasToWorld([0,0])),shift=point(viewport.canvasToWorld([dx,dy]));if(!origin||!shift)return false;
      const delta=shift.map((value,index)=>value-origin[index]);
      const next={focalPoint:camera.focalPoint.map((value,index)=>value-delta[index])};
      if(camera.position)next.position=camera.position.map((value,index)=>value-delta[index]);
      viewport.setCamera(next);return true;
    }catch{return false;}
  }
  function pan(dx,dy){
    if(!available()||!Number.isFinite(dx)||!Number.isFinite(dy))return;
    if(cameraPan()){if(!panCamera(dx,dy,cameraSnapshot()))return;}
    else{const p=viewport.getPan();viewport.setPan([p[0]+dx,p[1]+dy]);}
    changed();
  }
  listen(element,'keydown',event=>{
    if(!available()||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    const target=event.target;
    if(interactive(target))return;
    const key=event.key;
    if(event.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)){
      event.preventDefault();pan(key==='ArrowLeft'?-30:key==='ArrowRight'?30:0,key==='ArrowUp'?-30:key==='ArrowDown'?30:0);return;
    }
    const actions={ArrowLeft:()=>onStep(-1),ArrowUp:()=>onStep(-1),ArrowRight:()=>onStep(1),ArrowDown:()=>onStep(1),
      '+':()=>zoom(1.25),'=':()=>zoom(1.25),'-':()=>zoom(0.8),'0':fit,'[':()=>rotate(-90),']':()=>rotate(90),
      i:invert,I:invert,r:reset,R:reset};
    if(actions[key]){event.preventDefault();actions[key]();}
  },{capture:true});
  return {rotate,invert,zoom,fit,reset,pan,cancelGesture:onCancelGesture,destroy(){for(const remove of listeners)remove();onCancelGesture();}};
}

/** Sample a small thumbnail directly from decoded source values using its baseline display. */
export function thumbnailPixels(decoded,maxEdge=160) {
  const image=decoded.image,pixels=image.getPixelData(),ratio=image.rowPixelSpacing/image.columnPixelSpacing;
  const scale=Math.min(maxEdge/image.columns,maxEdge/(image.rows*ratio),1);
  const width=Math.max(1,Math.round(image.columns*scale)),height=Math.max(1,Math.round(image.rows*ratio*scale));
  const rgba=new Uint8ClampedArray(width*height*4),window={center:image.windowCenter,width:image.windowWidth,function:image.voiLUTFunction??'LINEAR'};
  const windowFloat=isFloatingPixels(pixels)?floatingVoi(image,window,{invert:image.invert}):null;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const row=Math.min(image.rows-1,Math.floor(y*image.rows/height)),column=Math.min(image.columns-1,Math.floor(x*image.columns/width));
    const source=row*image.columns+column,target=(y*width+x)*4;
    if(image.color){rgba.set(pixels.subarray(source*4,source*4+3),target);}
    else if(windowFloat)rgba[target]=rgba[target+1]=rgba[target+2]=windowFloat(pixels[source]);
    else {
      const value=windowInputValue(image,pixels[source]);
      let gray=voiValue(value,window);
      if(image.invert)gray=255-gray;rgba[target]=rgba[target+1]=rgba[target+2]=gray;
    }
    rgba[target+3]=255;
  }
  return {pixels:rgba,width,height};
}
const INTERACTIVE='input,select,textarea,button,a[href],summary,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"]';
const interactive=target=>target?.isContentEditable||target?.matches?.(INTERACTIVE)||target?.closest?.(INTERACTIVE);

/** Install before enabling the Cornerstone element: preserve child controls and
 * composing/already-owned keys before its generic listener calls preventDefault. */
export function preserveViewportKeyboardInputs(element){
  const guard=event=>{if(event.defaultPrevented||event.isComposing||interactive(event.target))event.stopImmediatePropagation();};
  element.addEventListener('keydown',guard);return()=>element.removeEventListener('keydown',guard);
}

