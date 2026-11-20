import {createDecoderClient} from './decoder-client.mjs';
import {createViewControls} from './view-controls.mjs';
import {fitImageToViewport} from './image-fit.mjs';
import {createWindowRenderer} from './cpu-window-renderer.mjs';
import {buildWindowPresets} from './window-presets.mjs';
import {validWindow} from './voi-window.mjs';
import {sourceContextLines} from './image-overlays.mjs';
import {showGeometryWarning} from './display-status.mjs';

let instanceSequence=0;
const IDS=['comparison-brightness','comparison-contrast','comparison-previous','comparison-next','comparison-frame',
  'comparison-zoom-out','comparison-zoom-in','comparison-rotate-left','comparison-rotate-right','comparison-invert','comparison-fit','comparison-reset'];
const finite=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
function sourceBytes(value){
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  throw new Error('Invalid comparison source.');
}
function copyRecord(value){return value==null?null:structuredClone(value);}

/** One verified original, an independent worker and one comparison viewport. */
export function createCompareView({engine,root=document,onChange=()=>{},decoderFactory=createDecoderClient,
  releaseImage=()=>{},saveFile=null,gestureFactory=null}={}){
  const $=id=>root.getElementById(id),panel=$('comparison-pane'),element=$('comparison-viewport'),layout=$('image-comparison-layout');
  if(!engine||!panel||!element||!layout)throw new TypeError('The comparison viewer is unavailable.');
  const viewportId=`dicom-comparison-${++instanceSequence}`,images=new Map(),listeners=[];
  let decoder=null,viewport=null,source=null,request=0,controller=null,opened=false,destroyed=false,ready=false,saving=false;
  let frame=1,frameCount=1,initialInvert=false,initialWindow=null,renderTail=Promise.resolve(),lastWheel=-Infinity;
  let windowRenderer=null,currentDecoded=null,windowPreset='initial';
  let gestures=null;
  const listen=(target,type,handler,options)=>{if(!target)return;target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));};
  const current=version=>opened&&!destroyed&&request===version;
  const say=text=>{$('comparison-status').textContent=text;};
  const notify=()=>{try{onChange({isOpen:opened,ready,frame,attachment:source?.entry.attachment||null});}catch{}};
  const retire=()=>{for(const id of images.keys())try{releaseImage(id);}catch{}images.clear();};
  const resize=()=>{if(opened&&viewport&&element.clientWidth&&element.clientHeight)try{engine.resize(true,true);viewport.render();}catch{}};
  function enabled(value){
    ready=value;for(const id of IDS)if($(id))$(id).disabled=!value;
    if($('comparison-previous'))$('comparison-previous').disabled=!value||frame<=1;
    if($('comparison-next'))$('comparison-next').disabled=!value||frame>=frameCount;
    if($('comparison-save'))$('comparison-save').disabled=!source?.verified||saving;
  }
  function clearDisplay(){
    controls.cancelGesture();enabled(false);initialWindow=null;
    showGeometryWarning($('comparison-geometry-warning'),null);
    if(!source?.verified&&$('comparison-context')){
      $('comparison-context').textContent='';$('comparison-context').title='';$('comparison-context').hidden=true;
    }
    element.setAttribute('aria-busy','false');element.dataset.loadingFrame='';
    windowRenderer?.destroy();windowRenderer=null;currentDecoded=null;windowPreset='initial';
    for(const key of ['loadedAttachment','sourceFrame','windowCenter','windowWidth','sopInstanceUid','sha256'])element.dataset[key]='';
  }
  function label(){
    const name=source?.entry.sourcePath||source?.entry.attachment||'Original file';
    $('comparison-source').textContent=name;$('comparison-source').title=name;
    if($('comparison-context')){
      const context=source?.context||'';
      $('comparison-context').textContent=context;$('comparison-context').title=context;$('comparison-context').hidden=!context;
    }
    $('comparison-frame-label').textContent=`Frame ${frame} of ${frameCount}`;
    $('comparison-frame').value=String(frame);$('comparison-frame').max=String(frameCount);
    $('comparison-frame-controls').hidden=frameCount<=1;
    showGeometryWarning($('comparison-geometry-warning'),currentDecoded);
  }
  function windowControls(){
    if(!ready||!viewport||!initialWindow||!windowRenderer)return;
    const width=Math.max(initialWindow.function==='LINEAR'?1:Number.MIN_VALUE,initialWindow.width/(Number($('comparison-contrast').value)/100));
    const center=initialWindow.center-Number($('comparison-brightness').value)/100*initialWindow.width;
    windowRenderer.setWindow({center,width,function:initialWindow.function},viewport);viewport.render();
  }
  const controls=createViewControls({onCancelGesture:()=>gestures?.cancel(),viewport:{
    getRotation:()=>viewport.getRotation(),setRotation:value=>viewport.setRotation(value),
    getProperties:()=>viewport.getProperties(),setProperties:value=>viewport.setProperties(value),
    getPan:()=>viewport.getPan(),setPan:value=>viewport.setPan(value),getZoom:()=>viewport.getZoom(),setZoom:value=>viewport.setZoom(value),
    get getCamera(){return typeof viewport?.getCamera==='function'?()=>viewport.getCamera():undefined;},
    get setCamera(){return typeof viewport?.setCamera==='function'?value=>viewport.setCamera(value):undefined;},
    get canvasToWorld(){return typeof viewport?.canvasToWorld==='function'?value=>viewport.canvasToWorld(value):undefined;},
    resetCamera:()=>viewport.resetCamera(),render:()=>viewport.render(),
  },element,ready:()=>ready&&opened,sourceInvert:()=>initialInvert,onStep:direction=>{void step(direction);},
    fitCamera:()=>fitImageToViewport(viewport,currentDecoded?.image),
    onReset:()=>{
      if(currentDecoded){const model=buildWindowPresets(currentDecoded);initialWindow=model.window;windowPreset=model.selected;}
      $('comparison-brightness').value='0';$('comparison-contrast').value='100';windowControls();
    },
    onChange:({rotation,inverted})=>{
      element.dataset.rotation=String(rotation);element.dataset.inverted=String(inverted);
      $('comparison-invert')?.setAttribute('aria-pressed',String(inverted));
    }});
  function ensureViewport(){
    if(viewport)return;
    engine.enableElement({viewportId,type:'stack',element,defaultOptions:{background:[0,0,0]}});viewport=engine.getViewport(viewportId);
    gestures=gestureFactory?.({element,viewport,engine,ready:()=>ready&&opened});
  }
  function viewSnapshot(){return {brightness:Number($('comparison-brightness').value),contrast:Number($('comparison-contrast').value),windowPreset,
    rotation:viewport.getRotation(),inverted:!!viewport.getProperties().invert!==initialInvert,zoom:viewport.getZoom(),
    camera:typeof viewport.getCamera==='function'?copyRecord(viewport.getCamera()):null,
    pan:typeof viewport.getCamera==='function'?null:viewport.getPan()};}
  function applyDisplay(display){
    const rotation=((finite(display?.rotation,0)%360)+360)%360,inverted=display?.inverted===true;
    viewport.setRotation(rotation);viewport.setProperties({invert:inverted?!initialInvert:initialInvert});fitImageToViewport(viewport,currentDecoded?.image);
    if(typeof viewport.setCamera==='function'&&typeof viewport.getCamera==='function'){
      const camera=display?.camera;
      // CPU setCamera applies focal-point translation before changing its scale.
      // Restore scale first, then focal point, so both public values remain exact.
      if(Number.isFinite(camera?.scale)&&camera.scale>0)viewport.setCamera({scale:camera.scale});
      else if(Number.isFinite(camera?.parallelScale)&&camera.parallelScale>0)viewport.setCamera({parallelScale:camera.parallelScale});
      else if(Number.isFinite(display?.zoom)&&display.zoom>0)viewport.setZoom(clamp(display.zoom,0.0001,10000));
      const validPoint=value=>value&&value.length>=3&&[value[0],value[1],value[2]].every(Number.isFinite);
      if(validPoint(camera?.focalPoint)){
        const pose={focalPoint:Array.from(camera.focalPoint).slice(0,3)};
        if(validPoint(camera.position))pose.position=Array.from(camera.position).slice(0,3);
        viewport.setCamera(pose);
      }
    }else{
      if(display&&Number.isFinite(display.zoom)&&display.zoom>0)viewport.setZoom(clamp(display.zoom,0.0001,10000));
      if(Array.isArray(display?.pan)&&display.pan.length===2&&display.pan.every(Number.isFinite))viewport.setPan([...display.pan]);
    }
    $('comparison-brightness').value=String(clamp(finite(display?.brightness,0),-100,100));
    $('comparison-contrast').value=String(clamp(finite(display?.contrast,100),20,500));
    element.dataset.rotation=String(rotation);element.dataset.inverted=String(inverted);
    $('comparison-invert')?.setAttribute('aria-pressed',String(inverted));windowControls();
  }
  async function showFrame(nextFrame,display=null,version=request){
    const pinned=source;if(!pinned||!current(version))return false;
    controller?.abort();controller=new AbortController();const signal=controller.signal;
    const retain=ready&&pinned.verified&&currentDecoded&&element.dataset.loadedAttachment===pinned.entry.attachment;
    if(retain){controls.cancelGesture();enabled(false);}else{clearDisplay();retire();}
    element.setAttribute('aria-busy','true');element.dataset.loadingFrame=String(nextFrame);say('Opening pinned frame…');
    try{
      const id=`dicom:compare-${viewportId}-${version}-${nextFrame}`;
      const recipe=pinned.previewEntry&&nextFrame===(pinned.previewEntry.sourceFrame||1)?pinned.previewEntry:null;
      const decoded=await decoder.decode(pinned.bytes,id,recipe,nextFrame,{key:pinned.entry.sha256,signal,priority:'foreground',sourceParsing:pinned.sourceParsing,requireEmptyColorProfile:pinned.requireEmptyColorProfile});
      if(!current(version)||signal.aborted||source!==pinned)return false;
      // The decoder registers this snapshot only after its worker verifies SHA-256.
      pinned.verified=true;enabled(false);
      if(pinned.entry.sopInstanceUID&&decoded.sopInstanceUID!==pinned.entry.sopInstanceUID)throw new Error('Comparison identity mismatch.');
      if(decoded.sourceFrame!==nextFrame||!Number.isSafeInteger(decoded.frameCount)||decoded.frameCount<nextFrame
        ||!validWindow({center:decoded.image.windowCenter,width:decoded.image.windowWidth,function:decoded.image.color?'LINEAR':decoded.image.voiLUTFunction??'LINEAR'}))throw new Error('Invalid comparison frame.');
      const rendering=renderTail.catch(()=>{}).then(async()=>{
        if(!current(version)||signal.aborted||source!==pinned)return false;
        const nextRenderer=createWindowRenderer(decoded.image);images.set(id,decoded);
        const discard=()=>{nextRenderer.destroy();if(images.get(id)===decoded){try{releaseImage(id);}catch{}images.delete(id);}};
        try{await viewport.setStack([id]);}catch(error){discard();throw error;}
        if(!current(version)||signal.aborted||source!==pinned){discard();return false;}
        windowRenderer?.destroy();windowRenderer=nextRenderer;currentDecoded=decoded;
        for(const previous of images.keys())if(previous!==id){try{releaseImage(previous);}catch{}images.delete(previous);}
        frame=nextFrame;frameCount=decoded.frameCount;initialInvert=!!decoded.image.invert;
        const model=buildWindowPresets(decoded,{selected:display?.windowPreset??'initial'});
        initialWindow=model.window;windowPreset=model.selected;enabled(true);applyDisplay(display);label();
        element.dataset.loadedAttachment=pinned.entry.attachment;element.dataset.sourceFrame=String(frame);
        element.dataset.sopInstanceUid=decoded.sopInstanceUID||'';element.dataset.sha256=pinned.entry.sha256;
        element.dataset.windowCenter=String(initialWindow.center);element.dataset.windowWidth=String(initialWindow.width);
        say('Pinned original · SHA-256 verified · display changes leave the original unchanged.');notify();return true;
      });
      renderTail=rendering.then(()=>{},()=>{});return await rendering;
    }catch(error){
      if(current(version)&&!signal.aborted&&source===pinned){
        if(!pinned.verified){source=null;decoder?.clear();}
        clearDisplay();retire();say(error?.code==='CHECKSUM_MISMATCH'?'This original does not match its recorded checksum. It was not pinned.':error?.code==='INVALID_FRAME'
          ?'This frame is unavailable. Save the pinned original for another viewer.':source?.verified
            ?'This pinned image could not be displayed. Its original remains available to save.':'This original could not be pinned. Open an image and try again.');notify();
      }
      return false;
    }finally{
      if(current(version)&&source===pinned){element.setAttribute('aria-busy','false');element.dataset.loadingFrame='';}
    }
  }
  async function step(direction){
    if(!ready||!opened)return false;const next=frame+direction;if(next<1||next>frameCount)return false;
    const display=viewSnapshot(),version=++request;return showFrame(next,display,version);
  }
  async function pin({entry,bytes,frame:sourceFrame=1,previewEntry=null,sourceParsing=null,display=null}={}){
    if(destroyed)return false;
    const version=++request;controller?.abort();decoder?.clear();retire();
    source=null;opened=true;panel.hidden=false;layout.classList.add('has-comparison');clearDisplay();say('Checking pinned original…');notify();
    $('comparison-source').textContent='';$('comparison-source').title='';
    try{
      const input=sourceBytes(bytes);
      if(!entry||typeof entry.attachment!=='string'||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(entry.sha256)
        ||!Number.isSafeInteger(entry.size)||entry.size!==input.byteLength||!Number.isSafeInteger(sourceFrame)||sourceFrame<1)throw new Error('Invalid comparison source.');
      const pinned={bytes:input.slice(),verified:false,context:sourceContextLines(entry).join(' · '),entry:{attachment:entry.attachment,sourcePath:entry.sourcePath,
        sha256:entry.sha256.toLowerCase(),size:entry.size,sopInstanceUID:entry.sopInstanceUID||null},
        previewEntry:copyRecord(previewEntry),sourceParsing:copyRecord(sourceParsing),requireEmptyColorProfile:entry.reason==='Invalid ICC Profile Data'};
      source=pinned;frame=sourceFrame;frameCount=sourceFrame;label();
      ensureViewport();decoder??=decoderFactory();resize();
      return await showFrame(sourceFrame,copyRecord(display),version);
    }catch{
      if(current(version)){if(!source?.verified){source=null;decoder?.clear();}clearDisplay();say(source?.verified?'This pinned image could not be displayed. Its original remains available to save.':'This original could not be pinned. Open an image and try again.');notify();}return false;
    }
  }
  function close(){
    ++request;controller?.abort();decoder?.clear();controls.cancelGesture();ready=false;opened=false;source=null;initialWindow=null;
    windowRenderer?.destroy();windowRenderer=null;currentDecoded=null;windowPreset='initial';
    retire();panel.hidden=true;layout.classList.remove('has-comparison');enabled(false);
    gestures?.destroy();gestures=null;
    if(viewport){try{engine.disableElement(viewportId);}catch{}viewport=null;}
    for(const key of Object.keys(element.dataset))element.dataset[key]='';
    $('comparison-source').textContent='';$('comparison-source').title='';say('');notify();
    if($('comparison-context')){$('comparison-context').textContent='';$('comparison-context').title='';$('comparison-context').hidden=true;}
    try{engine.resize(true,true);}catch{}
    if(!destroyed&&!$('compare-current')?.disabled)$('compare-current')?.focus({preventScroll:true});
  }
  async function saveOriginal(){
    if(!opened||!source?.verified||saving)return;
    const pinned=source,ownsSource=()=>opened&&!destroyed&&source===pinned;
    saving=true;$('comparison-save').disabled=true;
    try{
      if(await sha256(pinned.bytes)!==pinned.entry.sha256){if(ownsSource())say('The pinned original no longer matches its checksum; saving was refused.');return;}
      if(!ownsSource())return;
      const name=(pinned.entry.sourcePath||pinned.entry.attachment).split(/[\\/]/).pop()||'original.dcm';
      if(saveFile)await saveFile(pinned.bytes.slice(),name);
      else{
        const url=URL.createObjectURL(new Blob([pinned.bytes],{type:'application/dicom'})),link=root.createElement('a');
        try{link.href=url;link.download=name;root.body.append(link);link.click();link.remove();}
        finally{setTimeout(()=>URL.revokeObjectURL(url),10000);}
      }
      if(ownsSource())say('Saved the pinned original unchanged · SHA-256 verified.');
    }catch{if(ownsSource())say('The pinned original could not be saved.');}
    finally{saving=false;$('comparison-save').disabled=!opened||!source?.verified;}
  }
  listen($('close-comparison'),'click',close);
  listen($('comparison-save'),'click',()=>{void saveOriginal();});
  listen($('comparison-previous'),'click',()=>{void step(-1);});listen($('comparison-next'),'click',()=>{void step(1);});
  listen($('comparison-frame'),'change',()=>{const next=Number($('comparison-frame').value);if(!ready||!Number.isSafeInteger(next)||next<1||next>frameCount){label();return;}const display=viewSnapshot();void showFrame(next,display,++request);});
  listen($('comparison-brightness'),'input',windowControls);listen($('comparison-contrast'),'input',windowControls);
  for(const [id,action] of [['comparison-zoom-in',()=>controls.zoom(1.25)],['comparison-zoom-out',()=>controls.zoom(0.8)],
    ['comparison-rotate-left',()=>controls.rotate(-90)],['comparison-rotate-right',()=>controls.rotate(90)],
    ['comparison-invert',()=>controls.invert()],['comparison-fit',()=>controls.fit()],['comparison-reset',()=>controls.reset()]])listen($(id),'click',action);
  listen(element,'wheel',event=>{if(!ready||!event.deltaY)return;event.preventDefault();if(event.ctrlKey){controls.zoom(event.deltaY<0?1.1:1/1.1);return;}
    if(event.timeStamp-lastWheel<70)return;lastWheel=event.timeStamp;void step(event.deltaY>0?1:-1);},{passive:false});
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;observer?.observe(element);enabled(false);
  return {pin,close,getDecoded:id=>images.get(id),get isOpen(){return opened;},destroy(){if(destroyed)return;destroyed=true;close();controls.destroy();observer?.disconnect();for(const remove of listeners)remove();decoder?.destroy();decoder=null;}};
}
