import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStackPosition,createStackScrubber} from '../stack-position.mjs';
import {createStackOrder} from '../stack-order.mjs';

const image=(position,extra={})=>({attachment:`source-${position}`,sha256:`hash-${position}`,sourceFrame:1,display:true,
  fields:{StudyInstanceUID:'study',SeriesInstanceUID:'series',ImageOrientationPatient:'1\\0\\0\\0\\1\\0',ImagePositionPatient:`0\\0\\${position}`,InstanceNumber:String(position),...extra.fields},...extra});
const canDisplay=entry=>entry.display===true;
function setup(entries,index=0,frame=1){
  const state={entries,index,frame,frameCount:undefined},order=createStackOrder(entries,{canDisplay});
  return {state,order,getPosition:()=>buildStackPosition({...state,canDisplay,stackOrder:order})};
}
function scheduler(){
  const callbacks=new Map();let next=0;
  return {schedule:callback=>{callbacks.set(++next,callback);return next;},cancelSchedule:handle=>callbacks.delete(handle),
    run(){const pending=[...callbacks.values()];callbacks.clear();for(const callback of pending)callback();},get size(){return callbacks.size;}};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('reused immutable orders avoid rechecking every source on selection while rejecting stale targets',()=>{
  const entries=Array.from({length:200},(_,index)=>image(index+1));
  let checks=0;
  const eligible=entry=>{checks++;return entry.display;};
  const stackOrder=createStackOrder(entries,{canDisplay:eligible});
  const get=index=>buildStackPosition({entries,canDisplay:eligible,stackOrder,index});
  get(0);checks=0;
  const next=get(99);
  assert.deepEqual(next.targetAt(next.value),{index:99,frame:1});
  assert.ok(checks<5);
  entries[88].display=false;
  assert.equal(next.targetAt(89),null);
  entries[12].sha256='new identity';
  assert.equal(next.targetAt(13),null);
  stackOrder.clear();
  assert.equal(get(99).max,199);
});

test('image positions follow physical order, preserve global indices and retain duplicate IDs',()=>{
  const entries=[image(30,{sopInstanceUID:'duplicate'}),image(10,{sopInstanceUID:'duplicate'}),image(20,{display:false}),image(40,{sopInstanceUID:'duplicate'})];
  const {getPosition}=setup(entries,0),position=getPosition();
  assert.equal(position.kind,'image');assert.equal(position.value,2);assert.equal(position.max,3);assert.equal(position.label,'Image 2 of 3');assert.equal(position.hidden,false);
  assert.deepEqual(position.targetAt(1),{index:1,frame:1});assert.deepEqual(position.targetAt('3'),{index:3,frame:1});
  assert.equal(position.labelAt(3),'Image 3 of 3');assert.ok(Object.isFrozen(position));assert.ok(Object.isFrozen(position.targetAt(1)));
});

test('multiframe positions stay within one original and use actual decoder count when supplied',()=>{
  const entries=[image(1,{fields:{NumberOfFrames:'184'}}),image(2)];
  const {getPosition,state}=setup(entries,0,80),position=getPosition();
  assert.equal(position.kind,'frame');assert.equal(position.max,184);assert.equal(position.value,80);assert.equal(position.label,'Frame 80 of 184');
  assert.deepEqual(position.targetAt(184),{index:0,frame:184});assert.equal(position.targetAt(185),null);
  state.frameCount=200;state.frame=200;assert.equal(getPosition().label,'Frame 200 of 200');
});

test('unsupported sources, different study/series and missing series IDs never join the image domain',()=>{
  const entries=[image(1),image(2,{fields:{StudyInstanceUID:'other',SeriesInstanceUID:'series'}}),
    image(3,{fields:{StudyInstanceUID:'study',SeriesInstanceUID:'other'}}),image(4,{display:false}),image(5,{fields:{}})];
  const hostileOrder={indices:()=>Object.freeze([0,1,2,3,4,0,-1,500])};
  const one=buildStackPosition({entries,canDisplay,stackOrder:hostileOrder,index:0});assert.equal(one.max,1);assert.equal(one.hidden,true);
  const missing=buildStackPosition({entries,canDisplay,stackOrder:hostileOrder,index:4});assert.equal(missing.max,1);assert.deepEqual(missing.targetAt(1),{index:4,frame:1});
});

test('invalid positions, counts, source index and eligibility produce no out-of-bounds selections',()=>{
  const entries=[image(1),image(2)],{getPosition}=setup(entries),position=getPosition();
  for(const value of [0,-1,3,1.5,NaN,Infinity,'','2.5','NaN',null,{},true]){assert.equal(position.targetAt(value),null);assert.equal(position.labelAt(value),'');}
  for(const index of [-1,2,NaN,0.5])assert.equal(buildStackPosition({entries,canDisplay,index}).kind,'none');
  assert.equal(buildStackPosition({entries,canDisplay:()=>false,index:0}).kind,'none');
  for(const frameCount of [0,-1,NaN,'bad'])assert.equal(buildStackPosition({entries,canDisplay,index:0,frameCount}).kind,'none');
  assert.throws(()=>buildStackPosition({entries:null,canDisplay}),TypeError);
});

test('captured domains keep their physical order and reject changed source identities',()=>{
  const entries=[image(3),image(1),image(2)],{getPosition}=setup(entries),position=getPosition();
  entries[0].fields.ImagePositionPatient='0\\0\\-100';
  assert.deepEqual(position.targetAt(1),{index:1,frame:1});assert.deepEqual(position.targetAt(3),{index:0,frame:1});
  entries[1]={...entries[1]};assert.equal(position.targetAt(1),null);
  entries[2].attachment='replacement';assert.equal(position.targetAt(2),null);
});

test('range input is coalesced to one latest target per animation frame with an immediate pending label',async()=>{
  const entries=[image(1),image(2),image(3),image(4)],{getPosition}=setup(entries),clock=scheduler(),selected=[];
  const scrubber=createStackScrubber({getPosition,onSelect:target=>selected.push(target),...clock});
  for(const value of [2,3,4,2,4])assert.equal(scrubber.input(String(value)),true);
  assert.equal(clock.size,1);assert.equal(selected.length,0);assert.equal(scrubber.pendingPosition.label,'Image 4 of 4');
  clock.run();await tick();assert.deepEqual(selected,[{index:3,frame:1}]);assert.equal(scrubber.pendingPosition,null);scrubber.destroy();
});

test('new requests abort the old signal immediately and start without waiting for old settlement',async()=>{
  const entries=[image(1),image(2),image(3)],{getPosition}=setup(entries),clock=scheduler(),jobs=[],commits=[];
  const scrubber=createStackScrubber({getPosition,...clock,onSelect:async(target,guard)=>{
    const done=deferred();jobs.push({target,guard,done});await done.promise;
    if(!guard.signal.aborted&&guard.isCurrent())commits.push(target.index);
  }});
  scrubber.input(2);clock.run();assert.equal(jobs.length,1);assert.equal(jobs[0].guard.signal.aborted,false);
  scrubber.input(3);assert.equal(jobs[0].guard.signal.aborted,true);assert.equal(jobs[0].guard.isCurrent(),false);
  clock.run();assert.equal(jobs.length,2,'The latest target must not wait for the previous promise.');
  jobs[1].done.resolve();await tick();jobs[0].done.resolve();await tick();assert.deepEqual(commits,[2]);scrubber.destroy();
});

test('same-series pending movement keeps the captured global domain after selection index updates',async()=>{
  const entries=[image(30),image(10),image(20)],{getPosition,state}=setup(entries),clock=scheduler(),selected=[];
  const scrubber=createStackScrubber({getPosition,...clock,onSelect:target=>{state.index=target.index;selected.push(target.index);}});
  scrubber.input(1);clock.run();await tick();assert.equal(state.index,1);
  scrubber.input(3);scrubber.input(2);clock.run();await tick();assert.deepEqual(selected,[1,2]);scrubber.destroy();
});

test('rapid multiframe requests retain the same original and latest frame',async()=>{
  const entries=[image(1,{fields:{NumberOfFrames:'184'}})],{getPosition,state}=setup(entries),clock=scheduler(),selected=[];
  const scrubber=createStackScrubber({getPosition,...clock,onSelect:target=>{state.frame=target.frame;selected.push(target);}});
  scrubber.input(184);scrubber.input(40);scrubber.input(90);clock.run();await tick();
  assert.deepEqual(selected,[{index:0,frame:90}]);assert.equal(getPosition().label,'Frame 90 of 184');scrubber.destroy();
});

test('cancel invalidates queued/in-flight work when a manual source or PDF selection takes over',async()=>{
  const entries=[image(1),image(2)],{getPosition}=setup(entries),clock=scheduler(),jobs=[];
  const scrubber=createStackScrubber({getPosition,...clock,onSelect:async(target,guard)=>{const done=deferred();jobs.push({guard,done});await done.promise;}});
  scrubber.input(2);scrubber.cancel();clock.run();assert.equal(jobs.length,0);assert.equal(scrubber.pendingPosition,null);
  scrubber.input(2);clock.run();scrubber.cancel();assert.equal(jobs[0].guard.signal.aborted,true);assert.equal(jobs[0].guard.isCurrent(),false);
  jobs[0].done.resolve();await tick();scrubber.destroy();
});

test('new documents or series automatically refuse queued selections even with identical numeric indices',async()=>{
  for(const replacement of ['document','series','identity']){
    const entries=[image(1),image(2)],base=setup(entries),clock=scheduler(),selected=[];
    const scrubber=createStackScrubber({getPosition:base.getPosition,...clock,onSelect:target=>selected.push(target)});
    scrubber.input(2);
    if(replacement==='document')base.state.entries=entries.map(entry=>({...entry}));
    if(replacement==='series')base.state.index=1,entries[1].fields.SeriesInstanceUID='other';
    if(replacement==='identity')entries[1].sha256='different-original';
    clock.run();await tick();assert.deepEqual(selected,[],replacement);scrubber.destroy();
  }
});

test('flush supports keyboard/change completion, ignores duplicate targets and suppresses stale errors',async()=>{
  const entries=[image(1),image(2)],{getPosition}=setup(entries),clock=scheduler(),jobs=[],errors=[];
  const scrubber=createStackScrubber({getPosition,...clock,onError:error=>errors.push(error.message),onSelect:async(target,guard)=>{
    const done=deferred();jobs.push({target,guard,done});return done.promise;
  }});
  scrubber.input(2);const first=scrubber.flush();assert.equal(clock.size,0);assert.equal(jobs.length,1);
  scrubber.input(2);clock.run();assert.equal(jobs.length,1);
  scrubber.input(1);const second=scrubber.flush();jobs[0].done.reject(new Error('obsolete'));jobs[1].done.resolve(true);
  assert.equal(await first,false);assert.equal(await second,true);assert.deepEqual(errors,[]);scrubber.destroy();
});

test('invalid/hidden inputs do not schedule work, and destroy makes every old guard inert',async()=>{
  const entries=[image(1),image(2)],{getPosition}=setup(entries),clock=scheduler(),jobs=[];
  const scrubber=createStackScrubber({getPosition,...clock,onSelect:async(target,guard)=>{const done=deferred();jobs.push({guard,done});await done.promise;}});
  for(const value of [-1,0,3,1.2,'bad'])assert.equal(scrubber.input(value),false);
  assert.equal(clock.size,0);scrubber.input(2);clock.run();scrubber.destroy();
  assert.equal(jobs[0].guard.signal.aborted,true);assert.equal(jobs[0].guard.isCurrent(),false);assert.equal(scrubber.input(1),false);
  jobs[0].done.resolve();await tick();assert.equal(await scrubber.flush(),false);
  const single=setup([image(1)]),hidden=createStackScrubber({getPosition:single.getPosition,onSelect:()=>{throw new Error('hidden slider selected');},...clock});
  assert.equal(hidden.input(1),false);hidden.destroy();
});
