import {windowInputValue,validWindow,voiValue} from './voi-window.mjs';

const cachedBounds=new WeakMap();

/** Ignore only complete, exactly zero-filled outer strips that are black in
 * the initial display. Dark anatomy, internal gaps and the source matrix stay
 * intact; window/brightness changes never redefine the fitted area. */
export function imageFitBounds(image){
  if(!image)return null;
  if(cachedBounds.has(image))return cachedBounds.get(image);
  const {rows,columns}=image;
  if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows*columns>16777216)return null;
  const full={left:0,top:0,right:columns,bottom:rows};
  let bounds=full;
  const window={center:image.windowCenter,width:image.windowWidth,function:image.voiLUTFunction??'LINEAR'};
  if(!image.color&&validWindow(window)){
    const zero=voiValue(windowInputValue(image,0),window),black=image.invert?zero===255:zero===0;
    const pixels=black?image.getPixelData?.():null;
    if(pixels?.length===rows*columns){
      let {left,top,right,bottom}=full;
      const emptyRow=row=>{for(let x=0;x<columns;x++)if(pixels[row*columns+x]!==0)return false;return true;};
      const emptyColumn=column=>{for(let y=top;y<bottom;y++)if(pixels[y*columns+column]!==0)return false;return true;};
      while(top<bottom&&emptyRow(top))top++;
      // An entirely blank image retains its full frame and finite fit scale.
      if(top<bottom){
        while(emptyRow(bottom-1))bottom--;
        while(left<right&&emptyColumn(left))left++;
        while(emptyColumn(right-1))right--;
        bounds={left,top,right,bottom};
      }
    }
  }
  cachedBounds.set(image,bounds);return bounds;
}

/** Fit through public image/camera APIs; never crop or rewrite source pixels. */
export function fitImageToViewport(viewport,image){
  viewport.resetCamera();
  const bounds=imageFitBounds(image),data=viewport.getImageData?.()?.imageData,element=viewport.element;
  if(!bounds||typeof data?.indexToWorld!=='function'||!element?.clientWidth||!element?.clientHeight)return;
  const {left,top,right,bottom}=bounds;
  const points=[[left,top,0],[right,top,0],[right,bottom,0],[left,bottom,0]]
    .map(point=>viewport.worldToCanvas(data.indexToWorld(point)));
  const width=Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]));
  const height=Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]));
  const factor=Math.min(element.clientWidth/width,element.clientHeight/height);
  if(!Number.isFinite(factor)||factor<=0)return;
  // CPU cameras apply focal translation before scale, so restore scale first.
  viewport.setZoom(viewport.getZoom()*factor);
  viewport.setCamera({focalPoint:Array.from(data.indexToWorld([(left+right)/2,(top+bottom)/2,0]))});
}
