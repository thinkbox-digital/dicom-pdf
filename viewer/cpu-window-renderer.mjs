import {buildStoredVoiLut,floatingVoi,normalizeWindow} from './voi-window.mjs';
import {isFloatingPixels} from './parametric-map.mjs';

import {MAX_FRAME_PIXELS} from './working-memory.mjs';
const defaultCanvas=()=>{
  if(typeof document==='undefined')throw new Error('A local display canvas is unavailable.');
  return document.createElement('canvas');
};
function displayPixels(image){
  const pixels=image?.getPixelData?.(),rows=image?.rows,columns=image?.columns;
  if(image?.color||!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows*columns>MAX_FRAME_PIXELS
      ||!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray||pixels instanceof Int8Array||pixels instanceof Uint16Array||pixels instanceof Int16Array||isFloatingPixels(pixels))
      ||pixels.length!==rows*columns)throw new Error('The grayscale display matrix is invalid or excessive.');
  return pixels;
}
function surrogate(window){
  const width=Math.max(1,window.width),center=window.center;
  const lower=center-0.5-(width-1)/2,upper=center-0.5+(width-1)/2;
  if(!Number.isFinite(lower)||!Number.isFinite(upper))throw new Error('The display window exceeds the renderer range.');
  return {lower,upper};
}

/**
 * Main-thread adapter for Cornerstone's public IImage.render callback. The source
 * pixels, image identifiers and immutable source/preview window fields stay intact.
 * Logical windows remain separate from Cornerstone's LINEAR surrogate range.
 * Destroy controllers when their image leaves the application's decoded cache.
 */
export function createWindowRenderer(image,{canvasFactory=defaultCanvas}={}){
  const floating=!image?.color&&isFloatingPixels(displayPixels(image));
  if(typeof canvasFactory!=='function')throw new TypeError('A local canvas factory is required.');
  let state=normalizeWindow({center:image.windowCenter,width:image.windowWidth,function:image.color?'LINEAR':image.voiLUTFunction??'LINEAR'}),destroyed=false;
  const originalRender=image.render,hadRender=Object.hasOwn(image,'render');
  let canvas=null,context=null,rgba=null,cached=null;
  function releaseCanvas(){if(canvas){canvas.width=0;canvas.height=0;}canvas=null;context=null;rgba=null;cached=null;}
  function restore(){if(image.render===render){if(hadRender)image.render=originalRender;else delete image.render;}}
  function updateHook(){
    const custom=!image.color&&(floating||image.modalityLut||image.sampledVoiLut||state.function!=='LINEAR'||state.width===1);
    if(custom){
      if(image.render!==render&&image.render!==originalRender)throw new Error('The image display renderer changed unexpectedly.');
      image.render=render;
    }else{restore();releaseCanvas();}
  }
  function render(enabledElement){
    if(destroyed)throw new Error('The image display renderer has been released.');
    const pixels=displayPixels(image),viewport=enabledElement?.viewport,target=enabledElement?.canvas;
    const matrix=enabledElement?.transform?.getMatrix?.();
    if(enabledElement?.image!==image||!viewport||!target||!matrix||matrix.length!==6||!Array.from(matrix).every(Number.isFinite))
      throw new Error('The image display transform is unavailable.');
    const invert=!!viewport.invert;
    if(!canvas){
      canvas=canvasFactory(image.columns,image.rows);if(!canvas)throw new Error('A local display canvas is unavailable.');
      canvas.width=image.columns;canvas.height=image.rows;context=canvas.getContext?.('2d');
      if(!context?.createImageData||!context?.putImageData)throw new Error('A local grayscale canvas is unavailable.');
      rgba=context.createImageData(image.columns,image.rows);
      if(!(rgba?.data instanceof Uint8ClampedArray)||rgba.data.length!==pixels.length*4)throw new Error('The grayscale display buffer is invalid.');
    }
    if(!cached||cached.pixels!==pixels||cached.state!==state||cached.invert!==invert
        ||cached.slope!==image.slope||cached.intercept!==image.intercept||cached.minimum!==image.minPixelValue||cached.maximum!==image.maxPixelValue){
      const lut=floating?null:buildStoredVoiLut(image,state,{invert});
      const windowSample=floating?floatingVoi(image,state,{invert}):stored=>{
        const index=stored+lut.offset;
        if(index<0||index>=lut.values.length)throw new Error('A stored sample is outside its declared display range.');
        return lut.values[index];
      };
      for(let index=0;index<pixels.length;index++){
        const gray=windowSample(pixels[index]),offset=index*4;rgba.data[offset]=rgba.data[offset+1]=rgba.data[offset+2]=gray;rgba.data[offset+3]=255;
      }
      context.putImageData(rgba,0,0);
      cached={pixels,state,invert,slope:image.slope,intercept:image.intercept,minimum:image.minPixelValue,maximum:image.maxPixelValue};
    }
    const area=viewport.displayedArea??{tlhc:{x:1,y:1},brhc:{x:image.columns,y:image.rows}};
    const sx=area.tlhc?.x-1,sy=area.tlhc?.y-1,width=area.brhc?.x-sx,height=area.brhc?.y-sy;
    if(![sx,sy,width,height].every(Number.isFinite)||sx<0||sy<0||width<=0||height<=0||sx+width>image.columns||sy+height>image.rows)
      throw new Error('The displayed image area is invalid.');
    const output=target.getContext?.('2d');if(!output)throw new Error('The image viewport canvas is unavailable.');
    output.setTransform(1,0,0,1,0,0);output.fillStyle='black';output.fillRect(0,0,target.width,target.height);
    output.imageSmoothingEnabled=!viewport.pixelReplication;output.setTransform(...matrix);
    output.drawImage(canvas,sx,sy,width,height,0,0,width,height);
  }
  function setWindow(window,viewport=null){
    if(destroyed)throw new Error('The image display renderer has been released.');
    const next=normalizeWindow(image.color?{...window,function:'LINEAR'}:window),range=surrogate(next);
    if(next.center!==state.center||next.width!==state.width||next.function!==state.function)state=next;
    updateHook();
    // CPU viewports reject setVOILUTFunction; the public image.render hook owns
    // the logical function while Cornerstone receives only its range surrogate.
    if(viewport)viewport.setProperties({voiRange:range});
    return state;
  }
  updateHook();
  return {setWindow,getWindow:()=>state,destroy(){if(destroyed)return;destroyed=true;restore();releaseCanvas();}};
}
