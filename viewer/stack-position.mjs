const contexts=new WeakMap();
// createStackOrder reuses frozen arrays until its membership is cleared.
const imageDomains=new WeakMap();
const noTarget=()=>null,noLabel=()=>'';
const EMPTY=Object.freeze({kind:'none',min:1,max:0,value:0,label:'',hidden:true,targetAt:noTarget,labelAt:noLabel});

function integer(value){
  if(typeof value==='string'){
    if(!/^\d+$/.test(value.trim()))return null;
    value=Number(value);
  }
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function signature(entry){
  return [entry,entry?.attachment,entry?.sourcePath,entry?.sha256,entry?.sopInstanceUID,
    entry?.fields?.StudyInstanceUID,entry?.fields?.SeriesInstanceUID,entry?.fields?.ImageOrientationPatient];
}
function unchanged(entries,index,before){
  const current=signature(entries[index]);
  return current.every((value,part)=>value===before[part]);
}
function displayable(canDisplay,entry,index){try{return !!canDisplay(entry,index);}catch{return false;}}
function framesOf(entry){return entry?.fields?.NumberOfFrames==null?1:integer(entry.fields.NumberOfFrames);}

function imageDomain(entries,canDisplay,order,index){
  const series=entries[index].fields?.SeriesInstanceUID,study=entries[index].fields?.StudyInstanceUID;
  const cacheable=Array.isArray(order)&&Object.isFrozen(order);
  const cached=cacheable?imageDomains.get(order):null;
  if(cached&&cached.entries===entries&&cached.canDisplay===canDisplay&&cached.series===series
      &&cached.study===study&&(series||cached.index===index)&&cached.positions.has(index)
      &&unchanged(entries,index,cached.identities.get(index)))return cached;

  const indices=[],positions=new Map(),identities=new Map();
  for(const candidate of Array.isArray(order)?order:[index]){
    if(!Number.isSafeInteger(candidate)||candidate<0||candidate>=entries.length||positions.has(candidate))continue;
    const source=entries[candidate];
    const same=series?source?.fields?.SeriesInstanceUID===series&&source?.fields?.StudyInstanceUID===study:candidate===index;
    if(same&&displayable(canDisplay,source,candidate)){
      positions.set(candidate,indices.push(candidate));
      identities.set(candidate,signature(source));
    }
  }
  const domain={entries,canDisplay,series,study,index,indices:Object.freeze(indices),positions,identities};
  if(cacheable)imageDomains.set(order,domain);
  return domain;
}

/**
 * Immutable slider domain. Frame positions stay in the selected original; image
 * positions follow the supplied physical stack order without sorting again.
 * Global indices, rather than SOP UIDs, identify files, including duplicate IDs.
 * targetAt rejects invalid positions or a source whose identity changed later.
 * frameCount may supply the selected decoder's actual count when it is known.
 */
export function buildStackPosition({entries,canDisplay,stackOrder,index,frame=1,frameCount}={}){
  if(!Array.isArray(entries)||typeof canDisplay!=='function')throw new TypeError('Source entries and display eligibility are required.');
  if(!Number.isSafeInteger(index)||index<0||index>=entries.length||!displayable(canDisplay,entries[index],index))return EMPTY;
  const entry=entries[index],frames=frameCount===undefined?framesOf(entry):integer(frameCount),currentFrame=integer(frame);
  if(frames===null||currentFrame===null||currentFrame>frames)return EMPTY;
  let kind,indices,identities,value;
  if(frames>1){kind='frame';indices=[index];value=currentFrame;identities=new Map([[index,signature(entry)]]);}
  else{
    kind='image';
    let order;
    try{order=typeof stackOrder?.indices==='function'?stackOrder.indices(index):null;}catch{return EMPTY;}
    const domain=imageDomain(entries,canDisplay,order,index);
    ({indices,identities}=domain);
    value=domain.positions.get(index);
    if(value===undefined)return EMPTY;
  }
  const max=kind==='frame'?frames:indices.length;
  const targetAt=position=>{
    position=integer(position);if(position===null||position>max)return null;
    const sourceIndex=kind==='frame'?index:indices[position-1],source=entries[sourceIndex];
    if(!unchanged(entries,sourceIndex,identities.get(sourceIndex))||!displayable(canDisplay,source,sourceIndex))return null;
    const sourceCount=kind==='frame'?frames:framesOf(source),baseline=integer(source?.sourceFrame);
    return Object.freeze({index:sourceIndex,frame:kind==='frame'?position:baseline!==null&&(sourceCount===null||baseline<=sourceCount)?baseline:1});
  };
  const labelAt=position=>{position=integer(position);return position!==null&&position<=max?`${kind==='frame'?'Frame':'Image'} ${position} of ${max}`:'';};
  const result=Object.freeze({kind,min:1,max,value,label:labelAt(value),hidden:max<=1,targetAt,labelAt});
  contexts.set(result,{entries,kind,index,frames,indices});return result;
}

function sameContext(first,second){
  const a=contexts.get(first),b=contexts.get(second);
  if(!a||!b||a.entries!==b.entries||a.kind!==b.kind)return false;
  if(a.kind==='frame')return a.index===b.index&&a.frames===b.frames;
  if(a.indices===b.indices)return true;
  if(a.indices.length!==b.indices.length)return false;
  return a.indices.every((index,position)=>index===b.indices[position]);
}
const sameTarget=(a,b)=>a&&b&&a.index===b.index&&a.frame===b.frame;
const defaultSchedule=callback=>typeof globalThis.requestAnimationFrame==='function'?globalThis.requestAnimationFrame(callback):setTimeout(callback,0);
const defaultCancel=handle=>typeof globalThis.cancelAnimationFrame==='function'?globalThis.cancelAnimationFrame(handle):clearTimeout(handle);

/**
 * One pending target per animation frame. A newer input aborts the previous
 * signal immediately, then starts the latest request without waiting for old
 * work to settle. onSelect MUST honor signal/isCurrent before committing UI;
 * cancellation cannot undo an arbitrary callback's external side effects.
 *
 * getPosition returns a fresh buildStackPosition snapshot. Manual wheel/picker,
 * PDF-mode and document changes should call cancel(); changing document/group
 * or source identity also refuses queued targets. Scrubber-owned selections
 * should not cancel themselves. pendingPosition supplies an immediate label.
 */
export function createStackScrubber({getPosition,onSelect,onError,schedule=defaultSchedule,cancelSchedule=defaultCancel}={}){
  if(typeof getPosition!=='function'||typeof onSelect!=='function'||typeof schedule!=='function'||typeof cancelSchedule!=='function')throw new TypeError('Stack position, selection and scheduling callbacks are required.');
  let alive=true,sequence=0,pending=null,active=null,scheduled=null;
  const currentPosition=()=>{try{return getPosition();}catch{return null;}};
  function unschedule(){if(scheduled!==null){cancelSchedule(scheduled);scheduled=null;}}
  function cancel(){sequence++;pending=null;unschedule();active?.controller.abort();active=null;}
  async function flush(){
    unschedule();if(!alive||!pending)return false;
    const request=pending;pending=null;
    const target=request.position.targetAt(request.value);
    if(!sameContext(request.position,currentPosition())||!sameTarget(target,request.target)){cancel();return false;}
    active?.controller.abort();
    const controller=new AbortController(),job={...request,controller};active=job;
    const isCurrent=()=>alive&&sequence===job.sequence&&!controller.signal.aborted
      &&sameTarget(job.position.targetAt(job.value),job.target);
    try{
      const result=await onSelect(job.target,{signal:controller.signal,isCurrent});
      return isCurrent()&&result!==false;
    }catch(error){if(isCurrent()&&error?.name!=='AbortError')try{onError?.(error);}catch{}return false;}
    finally{if(active===job)active=null;}
  }
  function input(value){
    if(!alive)return false;
    const current=currentPosition();
    let position=pending?.position||active?.position||current;
    if(!sameContext(position,current)){cancel();position=current;}
    if(!contexts.has(position)||position.hidden)return false;
    const target=position.targetAt(value);if(!target)return false;
    value=integer(value);
    if(pending?.value===value&&sameContext(position,pending.position)||!pending&&active&&!active.controller.signal.aborted&&active.value===value&&sameContext(position,active.position))return true;
    sequence++;active?.controller.abort();
    pending={position,target,value,sequence};
    if(scheduled===null)scheduled=schedule(()=>{scheduled=null;void flush();});
    return true;
  }
  return {
    input,flush,cancel,
    get pendingPosition(){const request=pending||active;return request?Object.freeze({kind:request.position.kind,min:1,max:request.position.max,value:request.value,label:request.position.labelAt(request.value),target:request.target}):null;},
    destroy(){cancel();alive=false;}
  };
}
