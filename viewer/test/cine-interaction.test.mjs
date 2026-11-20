import test from 'node:test';
import assert from 'node:assert/strict';
import {bindCinePlayback} from '../cine.mjs';

function harness(){
  const element=new EventTarget(),doc=new EventTarget(),window=new EventTarget();
  doc.hidden=false;doc.defaultView=window;
  let playable=true,toggles=0,stops=0;
  const unbind=bindCinePlayback({element,document:doc,canPlay:()=>playable,
    player:{toggle(){toggles++;},stop(){stops++;}}});
  const key=(values={},target=element)=>{
    const e=new Event('keydown',{cancelable:true});
    Object.assign(e,{code:'Space',...values});target.dispatchEvent(e);return e.defaultPrevented;
  };
  return {element,doc,window,key,unbind,setPlayable:value=>{playable=value;},
    get toggles(){return toggles;},get stops(){return stops;}};
}

test('Space toggles once per press and consumes repeats without toggling',()=>{
  const h=harness();assert.equal(h.key(),true);assert.equal(h.toggles,1);
  for(let i=0;i<5;i++)assert.equal(h.key({repeat:true}),true);
  assert.equal(h.toggles,1);assert.equal(h.key(),true);assert.equal(h.toggles,2);
});

test('unavailable playback, composition, modifiers and handled events are left alone',()=>{
  const h=harness();
  for(const values of [{code:'KeyI'},{isComposing:true},{ctrlKey:true},{metaKey:true},{altKey:true}]){
    assert.equal(h.key(values),false);
  }
  const event=new Event('keydown',{cancelable:true});event.code='Space';event.preventDefault();h.element.dispatchEvent(event);
  h.setPlayable(false);assert.equal(h.key(),false);
  assert.equal(h.toggles,0);
});

test('hiding or leaving stops playback; returning never starts playback',()=>{
  const h=harness();h.key();assert.equal(h.toggles,1);
  h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(h.stops,1);
  assert.equal(h.key(),false);assert.equal(h.toggles,1);
  h.doc.hidden=false;h.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.toggles,1);assert.equal(h.stops,1);
  h.window.dispatchEvent(new Event('pagehide'));assert.equal(h.stops,2);
  h.window.dispatchEvent(new Event('pageshow'));assert.equal(h.toggles,1);
});

test('disposing bindings removes keyboard and lifecycle handlers',()=>{
  const h=harness();h.unbind();h.unbind();
  assert.equal(h.key(),false);h.doc.hidden=true;
  h.doc.dispatchEvent(new Event('visibilitychange'));h.window.dispatchEvent(new Event('pagehide'));
  assert.equal(h.toggles,0);assert.equal(h.stops,0);
});
