const MAX_CHARACTERS=128*1024,MAX_ITEMS=10000;

/** Approximate PDF text order; never HTML and never a replacement for the PDF. */
export function pdfPageText(items,{maxCharacters=MAX_CHARACTERS,maxItems=MAX_ITEMS}={}){
  if(!Array.isArray(items)||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>MAX_CHARACTERS
    ||!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>MAX_ITEMS)throw new TypeError('Invalid page text limits.');
  const parts=[];let remaining=maxCharacters,truncated=items.length>maxItems;
  for(let index=0;index<Math.min(items.length,maxItems);index++){
    const item=items[index];if(typeof item?.str!=='string')continue;
    const value=item.str+(item.hasEOL?'\n':' ');
    if(value.length<=remaining){parts.push(value);remaining-=value.length;continue;}
    let prefix=value.slice(0,remaining);
    if(/[\ud800-\udbff]$/.test(prefix))prefix=prefix.slice(0,-1);
    parts.push(prefix);truncated=true;break;
  }
  return {text:parts.join('').trimEnd(),truncated};
}

/** Consume worker text incrementally, cancelling when the visible budget is full. */
export async function readPdfPageText(page,{isCurrent=()=>true}={}){
  const reader=page.streamTextContent().getReader(),items=[];
  let remaining=MAX_CHARACTERS+1,limited=false,done=false,scanned=0,chunks=0;
  try{
    while(!done&&!limited){
      if(!isCurrent())throw new DOMException('Report text cancelled.','AbortError');
      const next=await reader.read();done=next.done;
      if(!isCurrent())throw new DOMException('Report text cancelled.','AbortError');
      if(done)break;
      if(!Array.isArray(next.value?.items))throw new TypeError('Invalid PDF text response.');
      if(++chunks>MAX_ITEMS){limited=true;break;}
      for(const item of next.value.items){
        if(++scanned>MAX_ITEMS){limited=true;break;}
        if(typeof item?.str!=='string')continue;
        items.push({str:item.str.slice(0,remaining),hasEOL:item.hasEOL});
        remaining-=Math.min(item.str.length,remaining)+1;
        if(remaining<=0){limited=true;break;}
      }
    }
    const result=pdfPageText(items);result.truncated ||= limited;return result;
  }finally{
    if(!done)try{await reader.cancel();}catch{}
    reader.releaseLock();
  }
}
