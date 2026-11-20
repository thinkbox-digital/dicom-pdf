import test from 'node:test';
import assert from 'node:assert/strict';
import {cineTiming,createCinePlayer} from '../cine.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class FakeClock {
  time=0;sequence=0;timers=new Map();cancelled=[];
  now=()=>this.time;
  schedule=(callback,delay)=>{const id=++this.sequence;this.timers.set(id,{at:this.time+delay,callback});return id;};
  cancel=id=>{const timer=this.timers.get(id);if(timer)this.cancelled.push(timer.callback);this.timers.delete(id);};
  async advance(milliseconds){
    const target=this.time+milliseconds;let guard=0;
    while(true){
      await flush();
      const next=[...this.timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next||next[1].at>target)break;
      assert.ok(++guard<1000,'Playback must not schedule an unbounded immediate backlog');
      this.timers.delete(next[0]);this.time=Math.max(this.time,next[1].at);next[1].callback();
    }
    this.time=target;await flush();
  }
}
function playerHarness(render,{count=3,timing=cineTiming({frameTime:50})}={}){
  const clock=new FakeClock(),states=[];let frame=1;
  const player=createCinePlayer({getFrame:()=>frame,getCount:()=>count,getTiming:()=>timing,
    renderFrame:async(next,options)=>{const accepted=await render(next,options,clock);if(accepted!==false&&!options.signal.aborted)frame=next;return accepted;},
    onState:state=>states.push(state),now:clock.now,schedule:clock.schedule,cancel:clock.cancel});
  return {player,clock,states,get frame(){return frame;}};
}

test('source timing precedence is recommended rate, vector, frame time, cine rate, default',()=>{
  const source={frameCount:3,recommendedDisplayFrameRate:20,frameTimeVector:[0,25,75],frameTime:200,cineRate:2};
  let timing=cineTiming(source);assert.equal(timing.label,'Recommended display rate');assert.equal(timing.delay(1,2),50);
  delete source.recommendedDisplayFrameRate;timing=cineTiming(source);assert.equal(timing.label,'Source frame time vector');assert.equal(timing.delay(1,2),25);assert.equal(timing.delay(2,3),75);
  delete source.frameTimeVector;timing=cineTiming(source);assert.equal(timing.label,'Source frame time');assert.equal(timing.delay(1,2),200);
  delete source.frameTime;timing=cineTiming(source);assert.equal(timing.label,'Source cine rate');assert.equal(timing.delay(1,2),500);
  delete source.cineRate;timing=cineTiming(source);assert.equal(timing.assumed,true);assert.equal(timing.fps,10);assert.equal(timing.delay(1,2),100);
});

test('variable timing vectors accept DICOM strings and preserve each transition including wrap',()=>{
  for(const vector of [[0,40,125,250],'0\\40\\125\\250']){
    const timing=cineTiming({frameCount:4,frameTimeVector:vector});
    assert.equal(timing.delay(1,2),40);assert.equal(timing.delay(2,3),125);assert.equal(timing.delay(3,4),250);
    assert.equal(timing.delay(4,1),40);assert.equal(timing.assumed,false);
    assert.ok(Math.abs(timing.fps-1000/((40+125+250)/3))<1e-10);
  }
});

test('malformed vectors and counts fall back to usable frame time',()=>{
  const malformed=[[],[0,40],[5,40,80],[0,0,80],[0,-1,80],[0,NaN,80],[0,Infinity,80],[0,3600001,80],'0\\bad\\80'];
  for(const frameTimeVector of malformed){
    const timing=cineTiming({frameCount:3,frameTimeVector,frameTime:200});
    assert.equal(timing.label,'Source frame time');assert.equal(timing.delay(1,2),200);
  }
  for(const frameCount of [undefined,0,1,2.5,Number.MAX_SAFE_INTEGER+1]){
    assert.equal(cineTiming({frameCount,frameTimeVector:[0,40,80],frameTime:200}).label,'Source frame time');
  }
});

test('null/boolean/blank vector components do not become numeric timing values',()=>{
  for(const frameTimeVector of [[null,40,80],[false,40,80],['',40,80],[' ',40,80],[0,true,80]]){
    assert.equal(cineTiming({frameCount:3,frameTimeVector,frameTime:200}).label,'Source frame time');
  }
});

test('explicit playback rate takes precedence and invalid rates preserve source timing',()=>{
  const source={frameCount:3,recommendedDisplayFrameRate:5,frameTimeVector:[0,40,80],frameTime:200,cineRate:2};
  for(const rate of [25,'25']){const timing=cineTiming(source,rate);assert.equal(timing.label,'Your playback rate');assert.equal(timing.delay(1,2),40);assert.equal(timing.assumed,false);}
  for(const rate of [0,-1,NaN,Infinity,'',' ',false,true,null,{}])assert.equal(cineTiming(source,rate).label,'Recommended display rate');
});

test('all timing paths cap at 60 fps, including short individual vector entries',()=>{
  for(const [source,override] of [[{},120],[{recommendedDisplayFrameRate:120},null],[{frameTime:1},null],[{cineRate:120},null]]){
    const timing=cineTiming(source,override);assert.equal(timing.capped,true);assert.equal(timing.fps,60);assert.equal(timing.delay(1,2),1000/60);
  }
  const variable=cineTiming({frameCount:3,frameTimeVector:[0,1,100]});
  assert.equal(variable.capped,true);assert.equal(variable.delay(1,2),1000/60);assert.equal(variable.delay(2,3),100);
  assert.equal(cineTiming({frameTime:1000/60}).capped,false);
});

test('invalid scalar timing is rejected instead of producing zero/NaN delays',()=>{
  for(const value of [0,-1,NaN,Infinity,'',' ',true,false,null,{}]){
    const timing=cineTiming({recommendedDisplayFrameRate:value,frameTime:value,cineRate:value});
    assert.equal(timing.assumed,true);assert.equal(timing.delay(1,2),100);
  }
  assert.equal(cineTiming({frameTime:3600001,cineRate:5}).label,'Source cine rate');
});

test('extremely low rates cannot create infinite or impractically large browser timer delays',()=>{
  for(const rate of [1e-300,1e-10]){
    assert.equal(cineTiming({recommendedDisplayFrameRate:rate,frameTime:100}).label,'Source frame time');
    assert.equal(cineTiming({cineRate:rate}).assumed,true);
    assert.equal(cineTiming({frameTime:100},rate).label,'Source frame time');
    assert.equal(cineTiming({recommendedDisplayFrameRate:rate}).delay(1,2),100);
  }
});

test('playback follows source cadence, loops, and start is idempotent',async()=>{
  const calls=[];const h=playerHarness(async(next,options,clock)=>{calls.push([next,clock.time]);return true;});
  h.player.start();h.player.start();assert.equal(h.clock.timers.size,1);
  await h.clock.advance(151);
  assert.deepEqual(calls,[[2,50],[3,100],[1,150]]);assert.equal(h.frame,1);assert.equal(h.player.playing,true);
  assert.equal(h.states.at(-1).framesShown,3);h.player.stop();assert.equal(h.clock.timers.size,0);
});

test('ordinary decode time consumes the interval instead of accumulating after it',async()=>{
  const gates=[],calls=[];const h=playerHarness((next,options,clock)=>{const gate=deferred();gates.push(gate);calls.push([next,clock.time]);return gate.promise;});
  h.player.start();await h.clock.advance(50);await h.clock.advance(20);gates[0].resolve(true);await flush();
  await h.clock.advance(29);assert.deepEqual(calls,[[2,50]]);
  await h.clock.advance(1);assert.deepEqual(calls,[[2,50],[3,100]]);h.player.stop();gates[1].resolve(false);await flush();
});

test('slow decoding applies backpressure without concurrent renders or skipped frames',async()=>{
  const gates=[],calls=[];let active=0,maximum=0;
  const h=playerHarness(async(next,options,clock)=>{const gate=deferred();gates.push(gate);active++;maximum=Math.max(maximum,active);calls.push([next,clock.time]);await gate.promise;active--;return true;});
  h.player.start();await h.clock.advance(50);await h.clock.advance(150);
  assert.deepEqual(calls,[[2,50]]);assert.equal(h.clock.timers.size,0);
  gates[0].resolve();await flush();await h.clock.advance(0);
  assert.deepEqual(calls,[[2,50],[3,200]]);assert.equal(maximum,1);
  gates[1].resolve();await flush();await h.clock.advance(50);
  assert.deepEqual(calls,[[2,50],[3,200],[1,250]]);assert.equal(maximum,1);
  h.player.stop();gates[2].resolve();await flush();
});

test('pause cancels scheduled callbacks; stale timers cannot restart rendering',async()=>{
  const calls=[];const h=playerHarness(async next=>{calls.push(next);return true;});
  h.player.start();await h.clock.advance(20);h.player.stop();
  assert.equal(h.player.playing,false);assert.equal(h.clock.timers.size,0);
  for(const callback of h.clock.cancelled)callback();await h.clock.advance(500);
  assert.deepEqual(calls,[]);h.player.start();await h.clock.advance(50);assert.deepEqual(calls,[2]);h.player.destroy();
});

test('pause aborts decoding; restart waits for its settlement and ignores old completion',async()=>{
  const gates=[],signals=[],calls=[];let active=0,maximum=0;
  const h=playerHarness(async(next,options,clock)=>{const gate=deferred();gates.push(gate);signals.push(options.signal);calls.push([next,clock.time]);active++;maximum=Math.max(maximum,active);await gate.promise;active--;return !options.signal.aborted;});
  h.player.start();await h.clock.advance(50);h.player.stop();assert.equal(signals[0].aborted,true);
  h.player.start();await h.clock.advance(50);assert.equal(calls.length,1);assert.equal(h.player.playing,true);
  gates[0].resolve();await flush();assert.equal(calls.length,2);assert.equal(maximum,1);assert.equal(signals[1].aborted,false);
  assert.equal(h.states.at(-1).framesShown,0);gates[1].resolve();await flush();assert.equal(h.states.at(-1).framesShown,1);
  h.player.stop();await h.clock.advance(500);assert.equal(calls.length,2);
});

test('failed/rejected renders stop playback and do not schedule further frames',async()=>{
  for(const render of [async()=>false,async()=>{throw new Error('Synthetic decoder rejection');}]){
    const h=playerHarness(render);h.player.start();await h.clock.advance(50);
    assert.equal(h.player.playing,false);assert.equal(h.clock.timers.size,0);assert.equal(h.states.at(-1).framesShown,0);
  }
});

test('an aborted old decoder rejection cannot stop a newly started playback session',async()=>{
  const gate=deferred(),calls=[];let first=true;
  const h=playerHarness(async next=>{calls.push(next);if(first){first=false;await gate.promise;}return true;});
  h.player.start();await h.clock.advance(50);h.player.stop();h.player.start();await h.clock.advance(50);
  assert.equal(calls.length,1);gate.reject(new Error('Synthetic aborted decoder'));await flush();
  assert.equal(h.player.playing,true);assert.equal(calls.length,2);assert.equal(h.states.at(-1).framesShown,1);
  h.player.stop();
});

test('single-frame inputs do not start, and toggle/destroy control normal playback',async()=>{
  const single=playerHarness(async()=>true,{count:1});single.player.start();assert.equal(single.player.playing,false);assert.equal(single.clock.timers.size,0);
  const h=playerHarness(async()=>true);h.player.toggle();assert.equal(h.player.playing,true);h.player.toggle();assert.equal(h.player.playing,false);
  h.player.toggle();await h.clock.advance(50);assert.equal(h.frame,2);h.player.destroy();assert.equal(h.player.playing,false);assert.equal(h.clock.timers.size,0);
});

test('capture pause cancels queued playback without rendering another frame',async()=>{
  const calls=[],h=playerHarness(async next=>{calls.push(next);return true;});
  h.player.start();await h.clock.advance(20);await h.player.pauseAndWait();
  for(const callback of h.clock.cancelled)callback();await h.clock.advance(500);
  assert.equal(h.player.playing,false);assert.equal(h.clock.timers.size,0);assert.deepEqual(calls,[]);
});

test('capture pause finishes one in-flight frame before resolving and never queues the next',async()=>{
  const gate=deferred(),signals=[],calls=[];
  const h=playerHarness(async(next,options)=>{signals.push(options.signal);calls.push(next);await gate.promise;return true;});
  h.player.start();await h.clock.advance(50);
  let finished=false;const capture=h.player.pauseAndWait().then(()=>{finished=true;});await flush();
  assert.equal(h.player.playing,false);assert.equal(signals[0].aborted,false);assert.equal(finished,false);
  gate.resolve();await capture;assert.equal(h.frame,2);assert.equal(signals[0].aborted,true);
  await h.clock.advance(500);assert.deepEqual(calls,[2]);assert.equal(h.clock.timers.size,0);
});

test('destroy still aborts a frame being drained for capture',async()=>{
  const gate=deferred();let signal;
  const h=playerHarness(async(next,options)=>{signal=options.signal;await gate.promise;return !signal.aborted;});
  h.player.start();await h.clock.advance(50);const capture=h.player.pauseAndWait();h.player.destroy();
  assert.equal(signal.aborted,true);gate.resolve();await capture;
  assert.equal(h.frame,1);assert.equal(h.player.playing,false);assert.equal(h.clock.timers.size,0);
});

test('restarting during capture pause cancels the old frame and keeps the new session alive',async()=>{
  const gates=[],signals=[];
  const h=playerHarness(async(next,options)=>{const gate=deferred();gates.push(gate);signals.push(options.signal);await gate.promise;return !options.signal.aborted;});
  h.player.start();await h.clock.advance(50);const capture=h.player.pauseAndWait();
  h.player.start();assert.equal(signals[0].aborted,true);await h.clock.advance(50);
  assert.equal(signals.length,1,'The new session waits for the previous operation');
  gates[0].resolve();await capture;await flush();
  assert.equal(signals.length,2);assert.equal(signals[1].aborted,false);assert.equal(h.player.playing,true);
  h.player.stop();assert.equal(signals[1].aborted,true);gates[1].resolve();await flush();
});
