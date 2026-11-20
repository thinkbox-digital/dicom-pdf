import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCornerstoneStack,createCornerstoneStackViewport,createCornerstoneImageLoader} from '../cornerstone-stack.mjs';
const events={STACK_NEW_IMAGE:'loaded',STACK_VIEWPORT_SCROLL:'scroll'};
const entries=[{attachment:'first.dcm',sopInstanceUID:'1.2.3',fields:{NumberOfFrames:'1'}},{attachment:'duplicate.dcm',sopInstanceUID:'1.2.3',fields:{NumberOfFrames:'3'}},{attachment:'last.dcm',fields:{}}];
const model=(index=0,frame=1,generation=1,extra={})=>buildCornerstoneStack({entries,indices:[2,0,1],index,frame,generation,...extra});
class Element extends EventTarget {emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}}
class Viewport {
  constructor(element){this.element=element;this.ids=[];this.current=0;this.target=0;this.sets=0;this.loads=0;this.fail=false;this.deferred=false;this.pending=[];}
  getImageIds(){return this.ids;}
  getCurrentImageId(){return this.ids[this.current];}
  getTargetImageIdIndex(){return this.target;}
  setStack(ids,index){this.ids=ids;this.current=this.target=index;this.sets++;return this.load();}
  setImageIdIndex(index){if(this.current===index)return Promise.resolve(this.getCurrentImageId());this.current=index;return this.load();}
  load(){this.loads++;const id=this.getCurrentImageId();return new Promise((resolve,reject)=>{
    const finish=()=>{if(this.fail){reject(new Error('Synthetic load failure'));return;}this.element.emit(events.STACK_NEW_IMAGE,{imageId:id});resolve(id);};
    if(this.deferred)this.pending.push(finish);else queueMicrotask(finish);
  });}
  scroll(delta){const old=this.target;this.target=Math.max(0,Math.min(this.ids.length-1,this.target+delta));this.setImageIdIndex(this.target);if(old!==this.target)this.element.emit(events.STACK_VIEWPORT_SCROLL,{imageId:this.ids[this.target]});}
}
function setup(){const element=new Element(),viewport=new Viewport(element),navigated=[],failed=[];
  const adapter=createCornerstoneStackViewport({viewport,element,events,onNavigate:target=>navigated.push(target),onFailure:error=>failed.push(error)});
  return {element,viewport,adapter,navigated,failed};}
test('physical source order and every frame retain distinct IDs despite duplicate UIDs',()=>{
  const stack=model(1,2);assert.deepEqual(stack.targets.map(t=>[t.index,t.frame]),[[2,1],[0,1],[1,1],[1,2],[1,3]]);
  assert.equal(stack.position,3);assert.equal(new Set(stack.imageIds).size,5);assert.notEqual(stack.imageIds[1],stack.imageIds[2]);
  assert.equal(stack.byId.get(stack.imageIds[3]).entry,entries[1]);assert.notEqual(model(0,1,2).imageIds[0],stack.imageIds[0]);
});
test('large catalogs fall back explicitly without decoding or merging originals',()=>{
  assert.equal(model(1,2,1,{maxImages:3}).scope,'original');assert.equal(model(1,2,1,{maxImages:1}).scope,'single-frame');
  assert.deepEqual(model(1,2,1,{maxImages:1}).targets.map(t=>t.frame),[2]);
  assert.throws(()=>model(1,0));assert.throws(()=>model(1,1,1,{indices:[0,0]}));
});
test('loads a complete stack once then uses native scrolling for owned navigation',async()=>{
  const h=setup(),first=model();await h.adapter.show(first);await h.adapter.show(model(1,2));
  assert.equal(h.viewport.sets,1);assert.equal(h.adapter.size,5);assert.equal(h.viewport.getCurrentImageId(),'dicom:1-1-2');assert.equal(h.viewport.getTargetImageIdIndex(),3);
  assert.equal(h.navigated.length,0);assert.equal(h.adapter.isRequested('dicom:1-1-2'),true);h.adapter.destroy();
  // The actual application reuses its frozen physical order, avoiding a rebuild.
  const reused=setup();await reused.adapter.show(first);
  assert.equal(reused.adapter.plan('dicom:1-1-2',first.sourceOrder).imageIds,first.imageIds);reused.adapter.destroy();
});
test('native wheel target maps back to its exact original and frame after loading',async()=>{
  const h=setup();await h.adapter.show(model());h.viewport.scroll(1);
  assert.equal(h.navigated.at(-1).index,1);assert.equal(h.navigated.at(-1).frame,1);
  await h.adapter.show(model(1,1));assert.equal(h.viewport.loads,2);assert.equal(h.adapter.canScroll(),true);h.adapter.destroy();
});
test('aborting a render wait releases callers without waiting for an obsolete load',async()=>{
  const h=setup();h.viewport.deferred=true;const controller=new AbortController();
  const pending=h.adapter.show(model(),{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});
  h.adapter.clear();h.viewport.pending.shift()();await Promise.resolve();assert.equal(h.adapter.size,0);assert.equal(h.adapter.canScroll(),false);h.adapter.destroy();
});
test('replacing the document rejects its old wait and rejects stale image IDs',async()=>{
  const h=setup();h.viewport.deferred=true;const old=h.adapter.show(model());const rejected=assert.rejects(old,{name:'AbortError'});
  const current=h.adapter.show(model(0,1,2));await rejected;assert.equal(h.adapter.resolve('dicom:1-0-1'),undefined);
  h.viewport.pending.shift()();h.viewport.pending.shift()();await current;assert.equal(h.viewport.getCurrentImageId(),'dicom:2-0-1');h.adapter.destroy();
});
test('native request errors are observed and surfaced, and failed targets can retry',async()=>{
  const h=setup();await h.adapter.show(model());h.viewport.fail=true;h.viewport.scroll(1);
  await Promise.resolve();await Promise.resolve();assert.equal(h.failed.length,1);
  h.viewport.fail=false;await h.adapter.show(model(1,1));assert.equal(h.viewport.sets,2);h.adapter.destroy();
});
test('lazy loader loads uncached originals and refuses obsolete queued targets',async()=>{
  const stack=model();let requested=stack.imageIds[0],decoded=0;
  const loader=createCornerstoneImageLoader({getStack:()=>({resolve:id=>stack.byId.get(id),isRequested:id=>id===requested}),getGeneration:()=>1,decode:async target=>{decoded++;return {image:{id:target.id}};}});
  assert.equal((await loader(requested).promise).id,requested);assert.equal(decoded,1);
  await assert.rejects(loader(stack.imageIds[1]).promise,{name:'AbortError'});assert.equal(decoded,1);
});
test('lazy loader rejects late document results but retains same-source stack rebuilds',async()=>{
  let stack=model(),generation=1,finish;
  const loader=createCornerstoneImageLoader({getStack:()=>({resolve:id=>stack.byId.get(id),isRequested:()=>true}),getGeneration:()=>generation,decode:()=>new Promise(resolve=>{finish=resolve;})});
  const first=loader('dicom:1-0-1').promise;generation=2;finish({image:{}});await assert.rejects(first,{name:'AbortError'});
  generation=1;const same=loader('dicom:1-0-1').promise;stack=model();const image={id:'unchanged'};finish({image});assert.equal(await same,image);
});
