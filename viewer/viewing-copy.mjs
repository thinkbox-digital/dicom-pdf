/** Draw bounded, inert text blocks captured from the visible Info overlay. */
export function drawViewingOverlays(context,blocks,{width,height,scaleX=1,scaleY=1}){
  if(![width,height,scaleX,scaleY].every(value=>Number.isFinite(value)&&value>0))throw new Error('Invalid viewing-copy dimensions.');
  context.save();context.beginPath();context.rect(0,0,width,height);context.clip();context.scale(scaleX,scaleY);
  try{
    for(const block of blocks.slice(0,7)){
      const {x,y,width:w,height:h,font,size,lineHeight,align='left',text}=block;
      if(![x,y,w,h,size,lineHeight].every(Number.isFinite)||w<=0||h<=0||size<=0||lineHeight<=0||typeof text!=='string')continue;
      context.save();
      try{
        context.beginPath();context.rect(x,y,w,h);context.clip();context.font=font;context.fillStyle='#fff';
        context.shadowColor='#000';context.shadowBlur=2;context.textBaseline='middle';context.textAlign=align==='right'?'right':'left';
        const lines=[];
        for(const paragraph of text.slice(0,4096).split('\n')){
          let line='';
          for(const word of paragraph.split(/\s+/)){
            const proposed=line+word;
            if(line&&context.measureText(proposed).width>w){lines.push(line.trimEnd());line='';}
            for(const character of word){
              const next=line?line+character:character;
              if(context.measureText(next).width>w&&line){lines.push(line.trimEnd());line='';}
              line+=character;
            }
            line+=' ';
          }
          lines.push(line.trimEnd());
        }
        for(let index=0;index<lines.length&&index<3;index++){
          const top=y+index*lineHeight;if(top>=y+h)break;
          context.fillText(lines[index],align==='right'?x+w:x,top+lineHeight/2);
        }
      }finally{context.restore();}
    }
  }finally{context.restore();}
}
