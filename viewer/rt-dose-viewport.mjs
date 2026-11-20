import {Enums,cache,imageLoader,metaData} from '@cornerstonejs/core';
import {buildCornerstoneStack,createCornerstoneImageLoader,createCornerstoneStackViewport} from './cornerstone-stack.mjs';
import {bindCornerstoneGestures} from './cornerstone-gestures.mjs';
import {fitImageToViewport} from './image-fit.mjs';

const SCHEME='rt-dose';
let activeDose=null,nextGeneration=0;
imageLoader.registerImageLoader(SCHEME,id=>activeDose?.loader(id)??{promise:Promise.reject(new Error('The dose grid is closed.'))});
metaData.addProvider((type,id)=>activeDose?.stack.resolve(id)?activeDose.metadata[type]:undefined,10000);

/** Displays dose shades with the Cornerstone CPU image colormap. */
export function mountRtDoseViewport({engine,element,source,frameShades,palette,onFrame,onError}){
  const generation=++nextGeneration,viewportId=SCHEME+'-'+generation;
  engine.enableElement({viewportId,type:Enums.ViewportType.STACK,element,defaultOptions:{background:[0,0,0]}});
  element.tabIndex=0;
  const viewport=engine.getViewport(viewportId),abort=new AbortController(),owned=new Set();
  const {rows,columns,frames,spacing}=source;
  const rowPixelSpacing=spacing?spacing[0]/spacing[1]:1,columnPixelSpacing=1;
  const colormap={
    getId:()=>SCHEME,
    // The fixed palette already has the 256 entries requested by Cornerstone.
    setNumberOfColors:()=>{},
    createLookupTable:()=>palette,
  };
  const metadata={
    imagePixelModule:{bitsAllocated:8,bitsStored:8,highBit:7,pixelRepresentation:0,photometricInterpretation:'MONOCHROME2',samplesPerPixel:1},
    imagePlaneModule:{rows,columns,rowPixelSpacing,columnPixelSpacing,usingDefaultValues:true},
    generalSeriesModule:{modality:'RTDOSE'},
  };
  const entries=[{attachment:viewportId,fields:{NumberOfFrames:frames}}],indices=[0];
  let ready=false,revision=0,image=null;
  const stack=createCornerstoneStackViewport({viewport,element,events:Enums.Events,
    onNavigate:target=>{void show(target.frame);}});
  const loader=createCornerstoneImageLoader({
    getStack:()=>stack,getGeneration:()=>abort.signal.aborted?-1:generation,
    decode:({id,frame})=>{
      const pixels=frameShades(frame);
      owned.add(id);
      return {image:{imageFrame:{},imageId:id,rows,columns,height:rows,width:columns,
        minPixelValue:0,maxPixelValue:255,slope:1,intercept:0,windowCenter:128,windowWidth:256,voiLUTFunction:'LINEAR',
        color:false,rgba:false,numberOfComponents:1,colormap,invert:false,rowPixelSpacing,columnPixelSpacing,
        numberOfFrames:frames,sizeInBytes:pixels.byteLength,getPixelData:()=>pixels}};
    },
  });
  activeDose={stack,loader,metadata};
  const gestures=bindCornerstoneGestures({engine,element,viewport,ready:()=>ready,
    scrollReady:event=>ready&&stack.canScroll()&&!event.ctrlKey});
  const observer=new ResizeObserver(()=>{if(!abort.signal.aborted&&ready)engine.resize(true,true);});
  observer.observe(element);
  function releaseFrames(keep){
    for(const id of owned){
      if(id===keep)continue;
      if(cache.getImageLoadObject(id))cache.removeImageLoadObject(id);
      owned.delete(id);
    }
  }
  async function show(frame){
    const request=++revision,id=SCHEME+':'+generation+'-0-'+frame;
    const model=stack.plan(id,indices)||buildCornerstoneStack({entries,indices,index:0,frame,generation,scheme:SCHEME});
    try{
      await stack.show(model,{signal:abort.signal});
      if(abort.signal.aborted||request!==revision)return false;
      image=viewport.getCornerstoneImage();
      if(!ready){
        viewport.setProperties({interpolationType:Enums.InterpolationType.NEAREST});
        fitImageToViewport(viewport,image);ready=true;
      }
      viewport.render();releaseFrames(id);onFrame(frame);
      element.dataset.sourceFrame=String(frame);
      element.dataset.cornerstoneStackSize=String(stack.size);
      return true;
    }catch(error){
      if(!abort.signal.aborted&&request===revision&&error.name!=='AbortError')onError(error);
      return false;
    }
  }
  return {show,
    zoom(factor){if(ready){viewport.setZoom(Math.max(0.01,Math.min(1000,viewport.getZoom()*factor)));viewport.render();}},
    fit(){if(ready){fitImageToViewport(viewport,image);viewport.render();}},
    destroy(){
      abort.abort();ready=false;observer.disconnect();gestures.destroy();stack.destroy();releaseFrames();
      activeDose=null;engine.disableElement(viewportId);
      delete element.dataset.sourceFrame;delete element.dataset.cornerstoneStackSize;
    },
  };
}
