const positive=value=>typeof value==='number'||typeof value==='string'&&value.trim()!=='' ? Number.isFinite(Number(value))&&Number(value)>0 ? Number(value) : null : null;
const rateValue=value=>{const rate=positive(value);return rate&&Number.isFinite(1000/rate)&&1000/rate<=3600000?rate:null;};

/** Space is one toggle per press; returning to a hidden page never starts cine. */
export function bindCinePlayback({element,player,canPlay,document:doc=element.ownerDocument}) {
  const keydown=event=>{
    if(event.target!==element||event.code!=='Space'||event.defaultPrevented||event.isComposing
      ||event.ctrlKey||event.metaKey||event.altKey||doc.hidden||!canPlay())return;
    event.preventDefault();
    if(!event.repeat)player.toggle();
  };
  const visibility=()=>{if(doc.hidden)player.stop();};
  const hide=()=>player.stop();
  // Own the application's Space shortcut before Cornerstone's generic keyboard
  // listener prevents every key's default action on an enabled viewport.
  const keyOptions={capture:true};
  element.addEventListener('keydown',keydown,keyOptions);
  doc.addEventListener('visibilitychange',visibility);
  doc.defaultView?.addEventListener('pagehide',hide);
  return ()=>{
    element.removeEventListener('keydown',keydown,keyOptions);
    doc.removeEventListener('visibilitychange',visibility);
    doc.defaultView?.removeEventListener('pagehide',hide);
  };
}

/** PS3.3 C.7.6.5 timing, kept separate from the source metadata and original bytes. */
export function cineTiming(source={},overrideFps=null) {
  const count=Number(source.frameCount),recommended=rateValue(source.recommendedDisplayFrameRate),frameTime=positive(source.frameTime),rate=rateValue(source.cineRate);
  const raw=source.frameTimeVector,items=Array.isArray(raw)?raw:typeof raw==='string'&&raw.trim()?raw.split('\\'):null;
  const vector=items?.every(value=>typeof value==='number'||typeof value==='string'&&value.trim()!=='')?items.map(Number):null;
  const validVector=Number.isSafeInteger(count)&&count>1&&vector?.length===count&&vector[0]===0&&vector.slice(1).every(value=>Number.isFinite(value)&&value>0&&value<=3600000);
  const requested=rateValue(overrideFps);
  let label,interval,vectorTiming=null,assumed=false;
  if(requested){interval=1000/requested;label='Your playback rate';}
  else if(recommended){interval=1000/recommended;label='Recommended display rate';}
  else if(validVector){vectorTiming=vector;interval=vector.slice(1).reduce((a,b)=>a+b,0)/(count-1);label='Source frame time vector';}
  else if(frameTime&&frameTime<=3600000){interval=frameTime;label='Source frame time';}
  else if(rate){interval=1000/rate;label='Source cine rate';}
  else {interval=100;label='Viewer default; no usable source timing';assumed=true;}
  const capped=interval<1000/60 || !!vectorTiming?.some((value,index)=>index>0&&value<1000/60);
  return {label,assumed,capped,fps:Math.min(60,1000/interval),
    delay(_current,next){const value=vectorTiming?(next===1?vectorTiming[1]:vectorTiming[next-1]):interval;return Math.max(1000/60,value);}};
}

/** One frame in flight. Late decoding slows playback; frames are never silently skipped. */
export function createCinePlayer({getFrame,getCount,getTiming,renderFrame,onState=()=>{},now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}) {
  let running=false,epoch=0,timer=null,abort=null,shown=0,started=0,nextDue=0,inFlight=null,firstShown=0;
  const state=()=>onState({playing:running,framesShown:shown,elapsed:now()-started,actualFps:shown>1&&now()>firstShown?(shown-1)*1000/(now()-firstShown):0});
  function stop(){if(!running&&timer===null&&!abort)return;running=false;++epoch;if(timer!==null)cancel(timer);timer=null;abort?.abort();abort=null;state();}
  async function pauseAndWait(){
    if(!running&&!inFlight)return;
    running=false;++epoch;if(timer!==null)cancel(timer);timer=null;
    const finishing=abort,pending=inFlight;state();
    // Finish a frame already handed to the renderer. Aborting setStack halfway
    // through could otherwise leave new pixels with the prior frame's labels.
    try{if(pending)await pending;}catch{}
    finally{finishing?.abort();if(abort===finishing)abort=null;}
  }
  function start(){
    if(running||getCount()<2)return;
    abort?.abort();running=true;const request=++epoch;abort=new AbortController();const runAbort=abort;shown=0;started=now();state();
    const queue=()=>{
      if(!running||request!==epoch)return;
      const current=getFrame(),count=getCount(),next=current>=count?1:current+1,delay=getTiming().delay(current,next);
      nextDue=Math.max(nextDue+delay,now());
      timer=schedule(async()=>{
        timer=null;if(!running||request!==epoch)return;
        try {
          if(inFlight)try{await inFlight;}catch{}
          if(!running||request!==epoch)return;
          const operation=Promise.resolve().then(()=>request===epoch&&!runAbort.signal.aborted?renderFrame(next,{signal:runAbort.signal}):false);inFlight=operation;
          let accepted;
          try{accepted=await operation;}finally{if(inFlight===operation)inFlight=null;}
          if(!running||request!==epoch)return;
          if(accepted===false){stop();return;}if(!shown)firstShown=now();shown++;state();
          // Avoid a backlog after slow decoding or a background-tab suspension.
          nextDue=Math.max(nextDue,now()-delay);queue();
        } catch {if(request===epoch)stop();}
      },Math.max(0,nextDue-now()));
    };
    nextDue=now();queue();
  }
  return {start,stop,pauseAndWait,toggle(){running?stop():start();},get playing(){return running;},destroy:stop};
}
