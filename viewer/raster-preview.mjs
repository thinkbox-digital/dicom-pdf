const MAX_COPY_PIXELS=16*1024*1024;

/** Raster-only viewing controls. The source image and original attachment stay unchanged. */
export function createRasterPreview({surface,image,name='Attached image',onStatus=()=>{},onSaveCopyChange=()=>{}}){
  const doc=surface.ownerDocument;
  const stage=doc.createElement('div'),frame=doc.createElement('div'),toolbar=doc.createElement('div');
  stage.className='raster-preview-stage';stage.tabIndex=0;stage.setAttribute('aria-label','Image preview viewing area');
  frame.className='raster-preview-frame';toolbar.className='image-controls raster-preview-controls';toolbar.id='preview-image-controls';
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Image preview controls');
  image.draggable=false;frame.append(image);stage.append(frame);surface.append(stage,toolbar);
  const state={rotation:0,brightness:0,contrast:100,inverted:false,fit:true,scale:1};
  const listeners=[],controls=[];let closed=false,drag=null;
  function listen(target,type,handler,options){target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));}
  function button(id,text,label,action){
    const element=doc.createElement('button');element.type='button';element.id=id;element.textContent=text;element.title=label;element.setAttribute('aria-label',label);
    element.disabled=true;toolbar.append(element);controls.push(element);listen(element,'click',action);return element;
  }
  function slider(id,text,min,max,value,key){
    const label=doc.createElement('label'),input=doc.createElement('input');label.textContent=text+' ';
    input.id=id;input.type='range';input.min=min;input.max=max;input.value=value;input.disabled=true;input.setAttribute('aria-label',text+' of preview image');
    label.append(input);toolbar.append(label);controls.push(input);listen(input,'input',()=>{state[key]=Number(input.value);adjust();});return input;
  }
  const brightness=slider('preview-brightness','Brightness',-100,100,0,'brightness');
  const contrast=slider('preview-contrast','Contrast',20,500,100,'contrast');
  button('preview-zoom-out','−','Zoom out preview image',()=>zoom(1/1.2));
  button('preview-zoom-in','+','Zoom in preview image',()=>zoom(1.2));
  button('preview-rotate-left','↶','Rotate preview image left 90 degrees',()=>rotate(-90));
  button('preview-rotate-right','↷','Rotate preview image right 90 degrees',()=>rotate(90));
  const invert=button('preview-invert','Invert','Invert preview image',()=>{state.inverted=!state.inverted;invert.setAttribute('aria-pressed',String(state.inverted));adjust();});
  invert.setAttribute('aria-pressed','false');
  button('preview-fit','Fit','Fit preview image to viewing area',fit);
  button('preview-reset','Reset','Reset preview image adjustments',()=>{
    Object.assign(state,{rotation:0,brightness:0,contrast:100,inverted:false});brightness.value='0';contrast.value='100';invert.setAttribute('aria-pressed','false');adjust();fit();
  });
  const fullscreen=button('preview-fullscreen','⛶','View preview image fullscreen',async()=>{
    try{if(doc.fullscreenElement===surface)await doc.exitFullscreen();else await surface.requestFullscreen();}
    catch{feedback('Fullscreen is unavailable in this browser.');}
  });
  const scaleLabel=doc.createElement('output');scaleLabel.className='raster-preview-scale';scaleLabel.setAttribute('aria-label','Preview image zoom');toolbar.append(scaleLabel);
  function feedback(message){if(!closed)onStatus(message);}
  function ready(){return !closed&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0;}
  function dimensions(){
    const sides=[image.naturalWidth,image.naturalHeight];
    if(state.rotation%180)sides.reverse();
    return {width:sides[0],height:sides[1]};
  }
  function filter(){return `brightness(${Math.max(0,1+state.brightness/100)}) contrast(${state.contrast/100}) invert(${state.inverted?1:0})`;}
  function adjust(){image.style.filter=filter();}
  function layout(center=true){
    if(!ready())return;
    const previous={x:stage.scrollLeft+stage.clientWidth/2,y:stage.scrollTop+stage.clientHeight/2,width:frame.offsetWidth,height:frame.offsetHeight};
    const size=dimensions(),padding=getComputedStyle(stage);
    if(state.fit){
      const width=stage.clientWidth-parseFloat(padding.paddingLeft)-parseFloat(padding.paddingRight);
      const height=stage.clientHeight-parseFloat(padding.paddingTop)-parseFloat(padding.paddingBottom);
      if(width<=0||height<=0)return;
      state.scale=Math.min(1,width/size.width,height/size.height);
    }
    frame.style.width=`${size.width*state.scale}px`;frame.style.height=`${size.height*state.scale}px`;
    image.style.width=`${image.naturalWidth*state.scale}px`;image.style.height=`${image.naturalHeight*state.scale}px`;
    image.style.transform=`translate(-50%,-50%) rotate(${state.rotation}deg)`;
    scaleLabel.textContent=`${Math.round(state.scale*100)}%`;
    surface.dataset.previewRotation=String(state.rotation);surface.dataset.previewScale=String(state.scale);surface.dataset.previewFit=String(state.fit);
    if(center||state.fit){stage.scrollLeft=(stage.scrollWidth-stage.clientWidth)/2;stage.scrollTop=(stage.scrollHeight-stage.clientHeight)/2;}
    else if(previous.width&&previous.height){stage.scrollLeft=previous.x*frame.offsetWidth/previous.width-stage.clientWidth/2;stage.scrollTop=previous.y*frame.offsetHeight/previous.height-stage.clientHeight/2;}
  }
  function fit(){state.fit=true;layout();}
  function zoom(factor){if(!ready())return;state.fit=false;state.scale=Math.min(16,Math.max(0.0001,state.scale*factor));layout(false);}
  function rotate(amount){state.rotation=(state.rotation+amount+360)%360;layout();}
  function loaded(){if(!ready())return;for(const control of controls)control.disabled=false;adjust();layout();onSaveCopyChange(saveCopy);}
  async function saveCopy(){
    if(!ready())return;
    const size=dimensions(),canvas=doc.createElement('canvas');
    if(size.width*(size.height+36)>MAX_COPY_PIXELS){feedback('This image is too large for a viewing copy. Use Save original to recover its unchanged bytes.');return;}
    canvas.width=size.width;canvas.height=size.height+36;
    const context=canvas.getContext('2d');
    if(!context){feedback('The browser could not create a viewing copy.');return;}
    context.save();context.translate(size.width/2,size.height/2);context.rotate(state.rotation*Math.PI/180);context.filter=filter();
    context.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);context.restore();
    context.fillStyle='#101722';context.fillRect(0,size.height,size.width,36);context.fillStyle='#fff';context.font='14px sans-serif';
    context.fillText('Viewing copy · original unchanged',12,size.height+23);
    /** @type {Promise<Blob|null>} */
    const encoding=new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const blob=await encoding;
    if(closed)return;
    if(!blob){feedback('The browser could not save a viewing copy.');return;}
    const url=URL.createObjectURL(blob),link=doc.createElement('a');link.href=url;
    link.download=(name.split(/[\\/]/).pop().replace(/\.[^.]*$/,'')||'image')+'-viewing-copy.png';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);feedback('Saved a PNG viewing copy. The original image is unchanged.');
  }
  listen(image,'load',loaded);
  listen(stage,'wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();zoom(event.deltaY<0?1.2:1/1.2);},{passive:false});
  listen(stage,'pointerdown',event=>{
    if(event.button!==0||!ready())return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop};stage.setPointerCapture(event.pointerId);stage.focus({preventScroll:true});event.preventDefault();
  });
  listen(stage,'pointermove',event=>{if(drag?.id===event.pointerId){stage.scrollLeft=drag.left+drag.x-event.clientX;stage.scrollTop=drag.top+drag.y-event.clientY;}});
  const endDrag=()=>{drag=null;};listen(stage,'pointerup',endDrag);listen(stage,'pointercancel',endDrag);listen(stage,'lostpointercapture',endDrag);
  listen(doc,'fullscreenchange',()=>{fullscreen.setAttribute('aria-label',doc.fullscreenElement===surface?'Exit preview image fullscreen':'View preview image fullscreen');layout();});
  const observer=new ResizeObserver(()=>layout(false));observer.observe(stage);
  loaded();
  return {destroy(){
    if(closed)return;closed=true;onSaveCopyChange(null);observer.disconnect();for(const remove of listeners)remove();
    if(drag&&stage.hasPointerCapture(drag.id))stage.releasePointerCapture(drag.id);drag=null;
    if(doc.fullscreenElement===surface)doc.exitFullscreen().catch(()=>{});
  }};
}
