const cancelled=()=>{const error=new Error('Image navigation superseded.');error.name='AbortError';return error;};
const frameCount=entry=>{
  const value=Number(entry?.fields?.NumberOfFrames||1);
  return Number.isSafeInteger(value)&&value>0?value:1;
};
const stackImageId=(scheme,generation,index,frame)=>scheme+':'+generation+'-'+index+'-'+frame;

/** Local originals remain the loader's responsibility, as in Cornerstone's
 * documented ImageLoader contract. Core owns request pooling and image caching. */
export function createCornerstoneImageLoader({getPinned=()=>null,getStack,getGeneration,decode}){
  return id=>({promise:(async()=>{
    const pinned=getPinned(id);if(pinned)return pinned.image;
    const stack=getStack(),target=stack.resolve(id);
    if(!target||target.generation!==getGeneration()||!stack.isRequested(id))throw cancelled();
    const decoded=await decode(target);
    const current=stack.resolve(id);
    if(!current||current.entry.attachment!==target.entry.attachment||current.entry.sha256!==target.entry.sha256||target.generation!==getGeneration()||!stack.isRequested(id))throw cancelled();
    return decoded.image;
  })()});
}

/** Stable source/frame IDs, never UID-based: duplicates remain distinct originals. */
export function buildCornerstoneStack({entries,indices,index,frame=1,generation,maxImages=20000,scheme='dicom'}){
  if(!Array.isArray(entries)||!Array.isArray(indices)||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||!entries[i])||!Number.isSafeInteger(maxImages)||maxImages<1||!Number.isInteger(index)||!entries[index]||!Number.isSafeInteger(frame)||frame<1||frame>frameCount(entries[index]))throw new TypeError('Invalid source stack target.');
  let scope='series',sources=[...indices];
  if(!sources.includes(index))sources=[index];
  const total=sources.reduce((sum,i)=>sum+frameCount(entries[i]),0);
  if(total>maxImages){sources=[index];scope='original';}
  if(frameCount(entries[index])>maxImages){scope='single-frame';}
  const targets=[],imageIds=[],byId=new Map();
  for(const source of sources){
    const count=frameCount(entries[source]),first=scope==='single-frame'?frame:1,last=scope==='single-frame'?frame:count;
    for(let sourceFrame=first;sourceFrame<=last;sourceFrame++){
      const id=stackImageId(scheme,generation,source,sourceFrame),target=Object.freeze({id,index:source,frame:sourceFrame,entry:entries[source],generation,stackIndex:imageIds.length});
      targets.push(target);imageIds.push(id);byId.set(id,target);
    }
  }
  const imageId=stackImageId(scheme,generation,index,frame),position=imageIds.indexOf(imageId);
  if(position<0)throw new TypeError('Source frame is absent from its stack.');
  return {imageIds,targets,byId,position,scope,sourceOrder:indices,key:`${generation}:${scope}:${sources.join(',')}${scope==='single-frame'?':'+frame:''}`};
}

/**
 * Public Cornerstone stack APIs own image requests/navigation. This adapter owns
 * cancellation and source commits; it never accesses private viewport state.
 */
export function createCornerstoneStackViewport({viewport,element,events,onNavigate=()=>{},onFailure=()=>{}}){
  let model=null,readyId=null,owned=0,epoch=0,lastFailure=null;
  const waiting=new Set();
  const originalSetIndex=viewport.setImageIdIndex;
  // Tools calls viewport.scroll() without awaiting its inner index promise.
  // Observe that promise while retaining its rejection for callers that await it.
  viewport.setImageIdIndex=function(index){
    let promise;
    try{promise=originalSetIndex.call(viewport,index);}catch(error){promise=Promise.reject(error);}
    const id=viewport.getImageIds?.()[index];
    Promise.resolve(promise).catch(error=>{
      if(!model?.byId.has(id))return;
      lastFailure=id;
      for(const request of [...waiting])if(request.id===id)request.finish(error);
      onFailure(error,model.byId.get(id));
    });
    return promise;
  };
  const loaded=event=>{
    const id=event.detail?.imageId,revision=epoch;
    // STACK_NEW_IMAGE precedes CPU viewport updates. Commit after those updates,
    // in the same microtask turn, before the rendering engine's next paint.
    queueMicrotask(()=>{
      if(revision!==epoch||!model?.byId.has(id)||viewport.getCurrentImageId()!==id)return;
      readyId=id;lastFailure=null;
      for(const request of [...waiting])if(request.id===id)request.finish(null,id);
    });
  };
  const scrolled=event=>{
    if(owned||!model)return;
    const target=model.byId.get(event.detail?.imageId);
    if(target)onNavigate(target);
  };
  element.addEventListener(events.STACK_NEW_IMAGE,loaded);
  element.addEventListener(events.STACK_VIEWPORT_SCROLL,scrolled);
  function wait(id,signal){
    if(signal?.aborted)return Promise.reject(cancelled());
    if(readyId===id&&viewport.getCurrentImageId()===id)return Promise.resolve(id);
    return new Promise((resolve,reject)=>{
      const request={id,finish(error,value){clearTimeout(timeout);signal?.removeEventListener('abort',stop);waiting.delete(request);error?reject(error):resolve(value);}};
      const stop=()=>request.finish(cancelled());
      const timeout=setTimeout(()=>request.finish(new Error('The requested image could not finish loading. Select it again to retry.')),10000);
      waiting.add(request);signal?.addEventListener('abort',stop,{once:true});
      if(signal?.aborted)stop();
    });
  }
  function clear(){++epoch;model=null;readyId=null;lastFailure=null;for(const request of [...waiting])request.finish(cancelled());}
  async function show(next,{signal}={}){
    if(signal?.aborted)throw cancelled();
    const target=next.imageIds[next.position],changed=model?.key!==next.key;
    if(changed){
      ++epoch;for(const request of [...waiting])request.finish(cancelled());
      model=next;readyId=null;
    }
    const completed=wait(target,signal);
    // Register an observer immediately; a cancellation can precede setStack's
    // asynchronous completion without becoming an unhandled rejection.
    completed.catch(()=>{});
    owned++;
    try{
      if(changed||lastFailure===target){
        const loading=viewport.setStack(model.imageIds,next.position);
        Promise.resolve(loading).catch(error=>{
          for(const request of [...waiting])if(request.id===target)request.finish(error);
        });
      }else if(readyId!==target||viewport.getCurrentImageId()!==target){
        viewport.scroll(next.position-viewport.getTargetImageIdIndex(),false,false);
      }
    }catch(error){for(const request of [...waiting])if(request.id===target)request.finish(error);}
    finally{owned--;}
    return completed;
  }
  return {show,clear,resolve:id=>model?.byId.get(id),canScroll:()=>!!readyId&&!!model&&model.imageIds.length>1,
    plan(id,sourceOrder){const target=model?.byId.get(id);return target&&model.sourceOrder===sourceOrder?{...model,position:target.stackIndex}:null;},
    isRequested:id=>!!model&&model.imageIds[viewport.getTargetImageIdIndex()]===id,
    requestedTarget:()=>model?.byId.get(model.imageIds[viewport.getTargetImageIdIndex()]),
    atBoundary:direction=>!!model&&(direction<0?viewport.getTargetImageIdIndex()<=0:viewport.getTargetImageIdIndex()>=model.imageIds.length-1),
    get size(){return model?.imageIds.length||0;},get scope(){return model?.scope||'none';},
    destroy(){clear();element.removeEventListener(events.STACK_NEW_IMAGE,loaded);element.removeEventListener(events.STACK_VIEWPORT_SCROLL,scrolled);viewport.setImageIdIndex=originalSetIndex;}};
}
