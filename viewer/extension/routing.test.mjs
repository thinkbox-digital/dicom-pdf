import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localPdfUrl,viewerLaunchUrl,createLocalSourceHandoffs,LOCAL_SOURCE_MESSAGE} from './routing.mjs';
import {openInitialPdf,readInitialPdf} from './initial-pdf.mjs';

const VIEWER='chrome-extension://dicom/viewer.html',SOURCE='file:///tmp/Synthetic%20Person/study%20images.pdf';
const tokenFor=value=>value.toString(16).padStart(64,'0');
const sender=(tabId=7,overrides={})=>({id:'dicom',frameId:0,url:VIEWER,tab:{id:tabId},...overrides});
const unavailable={ok:false,code:'unavailable'};
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function harness(options={}){
  let time=1000,sequence=1,nextTimer=1;const timers=new Map();
  const handoffs=createLocalSourceHandoffs({viewerUrl:VIEWER,extensionId:'dicom',now:()=>time,tokenFactory:()=>tokenFor(sequence++),
    setTimer:(callback,delay)=>{const id=nextTimer++;timers.set(id,{callback,at:time+delay});return id;},clearTimer:id=>timers.delete(id),...options});
  return {handoffs,timers,advance(ms,runTimers=true){time+=ms;if(runTimers){for(const [id,timer] of timers)if(timer.at<=time){timers.delete(id);timer.callback();}}}};
}

test('toolbar URL contains only an opaque token and strips old queries/fragments',()=>{
  assert.equal(localPdfUrl('file:///tmp/a%20b.PDF?download=1#page=3'),'file:///tmp/a%20b.PDF');
  const launch=new URL(viewerLaunchUrl(VIEWER+'?source='+encodeURIComponent(SOURCE)+'#page=1',tokenFor(9)));
  assert.equal(launch.searchParams.get('handoff'),tokenFor(9));assert.equal([...launch.searchParams].length,1);
  assert.equal(launch.hash,'');assert.ok(!launch.href.includes('Synthetic'));assert.ok(!launch.href.includes('file%3A'));
  assert.equal(viewerLaunchUrl(VIEWER,SOURCE),VIEWER);assert.equal(viewerLaunchUrl(VIEWER,'not-a-token'),VIEWER);
});
for(const input of ['https://example.com/patient.pdf','http://localhost/a.pdf','file://server/share/a.pdf','file:///tmp/secrets.txt','chrome://extensions','javascript:alert(1)','data:application/pdf,x',undefined,'not a URL']){
  test(`reject unsafe automatic toolbar source ${String(input)}`,()=>{
    const h=harness();assert.equal(localPdfUrl(input),null);assert.equal(h.handoffs.reserve(input),null);
    assert.equal(viewerLaunchUrl(VIEWER,input),VIEWER);assert.equal(h.handoffs.stats().pending,0);assert.equal(h.timers.size,0);
  });
}

test('source transfer is bound to one viewer tab and can be claimed exactly once',async()=>{
  const h=harness(),token=h.handoffs.reserve(SOURCE+'?download=1#page=2');
  assert.equal(h.handoffs.bind(token,7),true);
  assert.deepEqual(await h.handoffs.claim(token,sender(8)),unavailable,'Another tab must not consume the source');
  assert.deepEqual(await h.handoffs.claim(token,sender()),{ok:true,source:SOURCE});
  assert.deepEqual(await h.handoffs.claim(token,sender()),unavailable);assert.equal(h.timers.size,0);
});

test('only the owning extension full-tab viewer can claim; malformed senders cannot consume a token',async()=>{
  const h=harness(),token=h.handoffs.reserve(SOURCE);h.handoffs.bind(token,7);
  for(const altered of [null,{},sender(7,{id:'other'}),sender(7,{frameId:1}),sender(7,{url:'https://example.com/viewer.html'}),
    sender(7,{url:'chrome-extension://other/viewer.html'}),sender(7,{url:'chrome-extension://dicom/other.html'}),
    sender(7,{url:VIEWER+'?source='+encodeURIComponent(SOURCE)}),sender(7,{url:VIEWER+'?handoff='+tokenFor(20)}),sender(7,{tab:{id:'7'}})]){
    assert.deepEqual(await h.handoffs.claim(token,altered),unavailable);
  }
  assert.deepEqual(await h.handoffs.claim(token,sender(7,{url:viewerLaunchUrl(VIEWER,token)})),{ok:true,source:SOURCE});
});

test('claim waits for tab creation binding and simultaneous claims cannot both succeed',async()=>{
  const h=harness(),token=h.handoffs.reserve(SOURCE);let resolved=false;
  const first=h.handoffs.claim(token,sender()).then(value=>{resolved=true;return value;});
  const second=h.handoffs.claim(token,sender());await Promise.resolve();assert.equal(resolved,false);
  assert.equal(h.handoffs.bind(token,7),true);
  const replies=await Promise.all([first,second]);assert.equal(replies.filter(reply=>reply.ok).length,1);assert.equal(replies.filter(reply=>!reply.ok).length,1);
  assert.equal(h.handoffs.stats().pending,0);assert.equal(h.timers.size,0);
});

test('expiry works with timers and by clock checks when a service-worker timer did not run',async()=>{
  for(const runTimers of [false,true]){
    const h=harness(),token=h.handoffs.reserve(SOURCE);h.handoffs.bind(token,7);h.advance(60000,runTimers);
    assert.deepEqual(await h.handoffs.claim(token,sender()),unavailable);assert.equal(h.handoffs.stats().pending,0);assert.equal(h.timers.size,0);
  }
  const h=harness(),pending=h.handoffs.reserve(SOURCE),claim=h.handoffs.claim(pending,sender());
  h.advance(60000);assert.deepEqual(await claim,unavailable,'Expiry must resolve a waiting startup claim');
});

test('bounded pending handoffs evict oldest entries and resolve pending creation claims',async()=>{
  const h=harness({maxEntries:2}),first=h.handoffs.reserve(SOURCE),claim=h.handoffs.claim(first,sender());
  const second=h.handoffs.reserve(SOURCE),third=h.handoffs.reserve(SOURCE);
  assert.deepEqual(await claim,unavailable);assert.equal(h.handoffs.stats().pending,2);assert.equal(h.timers.size,1);
  assert.equal(h.handoffs.bind(first,7),false);h.handoffs.bind(second,8);h.handoffs.bind(third,9);
  assert.equal((await h.handoffs.claim(second,sender(8))).ok,true);assert.equal((await h.handoffs.claim(third,sender(9))).ok,true);
  assert.equal(h.timers.size,0);
});

test('tab close, failed creation and service-worker restart recover without a reusable source',async()=>{
  const h=harness(),bound=h.handoffs.reserve(SOURCE);h.handoffs.bind(bound,7);h.handoffs.releaseTab(7);
  assert.deepEqual(await h.handoffs.claim(bound,sender()),unavailable);
  const failed=h.handoffs.reserve(SOURCE),claim=h.handoffs.claim(failed,sender(8));h.handoffs.release(failed);assert.deepEqual(await claim,unavailable);
  const closedBeforeBinding=h.handoffs.reserve(SOURCE);h.handoffs.releaseTab(9);assert.equal(h.handoffs.bind(closedBeforeBinding,9),false);
  assert.deepEqual(await h.handoffs.claim(closedBeforeBinding,sender(9)),unavailable);
  const old=h.handoffs.reserve(SOURCE);h.handoffs.bind(old,10);h.handoffs.clear();
  const restarted=harness();assert.deepEqual(await restarted.handoffs.claim(old,sender(10)),unavailable);assert.equal(h.timers.size,0);
});

test('production tokens use 256 bits of random material and never derive from a source name',()=>{
  const h=harness({tokenFactory:undefined});
  const one=h.handoffs.reserve(SOURCE),two=h.handoffs.reserve(SOURCE);assert.match(one,/^[a-f0-9]{64}$/);assert.match(two,/^[a-f0-9]{64}$/);
  assert.notEqual(one,two);h.handoffs.clear();assert.equal(h.timers.size,0);
});

test('background handoff survives a viewer claim racing tabs.create and cleans on tab removal',async()=>{
  const originalChrome=globalThis.chrome,created=deferred(),listeners={},requests=[];
  globalThis.chrome={runtime:{id:'dicom',getURL:()=>VIEWER,onMessage:{addListener:callback=>{listeners.message=callback;}}},
    action:{onClicked:{addListener:callback=>{listeners.action=callback;}}},tabs:{
      create:request=>{requests.push(request);return created.promise;},onRemoved:{addListener:callback=>{listeners.remove=callback;}}}};
  try{
    await import('./background.js?test=startup-race');listeners.action({url:SOURCE});
    const token=new URL(requests[0].url).searchParams.get('handoff');assert.match(token,/^[a-f0-9]{64}$/);
    assert.ok(!requests[0].url.includes('Synthetic'));assert.equal(new URL(requests[0].url).searchParams.has('source'),false);
    const reply=deferred();assert.equal(listeners.message({type:LOCAL_SOURCE_MESSAGE,token},sender(),reply.resolve),true);
    created.resolve({id:7});assert.deepEqual(await reply.promise,{ok:true,source:SOURCE});
    const reused=deferred();listeners.message({type:LOCAL_SOURCE_MESSAGE,token},sender(),reused.resolve);assert.deepEqual(await reused.promise,unavailable);
    listeners.message({type:LOCAL_SOURCE_MESSAGE,token},sender(),()=>{throw new Error('Test channel closed.');});
    await Promise.resolve();await Promise.resolve();
    assert.equal(listeners.message({type:'unrelated'},sender(),()=>{}),false);listeners.remove(7);
  }finally{globalThis.chrome=originalChrome;}
});

test('routing sources persist nothing, log nothing and build no filename-bearing viewer URL',async()=>{
  for(const file of ['routing.mjs','background.js','entry.js','initial-pdf.mjs']){
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\bconsole\s*\.|\b(?:localStorage|sessionStorage|indexedDB)\b|chrome(?:Api)?\.storage\b/);
    assert.doesNotMatch(source,/searchParams\.set\(['"]source['"]/);assert.doesNotMatch(source,/\$\{error\.message\}/);
  }
});

function startupHarness(options={}){
  let token=0;const effects={messages:[],routes:[],loads:[],fetches:[],permissions:0,contains:[],requests:[],actions:[],fallbacks:0};
  const defaults={runtime:{sendMessage:async()=>({ok:true,source:SOURCE})},
    extension:{isAllowedFileSchemeAccess:async()=>{effects.permissions++;return true;}},
    permissions:{contains:async query=>{effects.contains.push(query);return true;},request:query=>{effects.requests.push(query);return Promise.resolve(true);}}};
  const supplied=options.chromeApi||{},chromeApi={runtime:{...defaults.runtime,...supplied.runtime},extension:{...defaults.extension,...supplied.extension},permissions:{...defaults.permissions,...supplied.permissions}};
  const config={beginInputRequest:()=>++token,isInputRequestCurrent:value=>value===token,
    loadPdfBytes:async(bytes,settings)=>{effects.loads.push({bytes,settings});return true;},
    fetchPdf:async url=>{effects.fetches.push(url);return new Response(new Uint8Array([1,2,3]));},
    onMessage:value=>effects.messages.push(value),onRoute:value=>effects.routes.push(value),onLocalAccessAction:action=>effects.actions.push(action),...options,chromeApi};
  return {effects,config,run:()=>openInitialPdf(config),newIntent:()=>++token,current:()=>token};
}
async function until(predicate){for(let turn=0;turn<30;turn++){if(predicate())return;await Promise.resolve();}assert.fail('Expected asynchronous test phase was not reached');}

test('startup reserves the shared transaction before awaiting MIME info and cannot replace newer input',async()=>{
  const info=deferred(),h=startupHarness({mime:{getStreamInfo:()=>{assert.equal(h.current(),1);return info.promise;}}});
  const run=h.run();h.newIntent();info.resolve({streamUrl:'blob:synthetic-old',originalUrl:SOURCE});
  assert.equal(await run,false);assert.deepEqual(h.effects.fetches,[]);assert.deepEqual(h.effects.messages,[]);assert.deepEqual(h.effects.routes,[]);assert.deepEqual(h.effects.loads,[]);
});

test('a delayed toolbar claim or permission result cannot alter a newer selection',async()=>{
  const reply=deferred(),first=startupHarness({handoff:tokenFor(1),chromeApi:{runtime:{sendMessage:()=>reply.promise},extension:{isAllowedFileSchemeAccess:()=>assert.fail('Stale claim checked permission')}}});
  const old=first.run();first.newIntent();reply.resolve({ok:true,source:SOURCE});assert.equal(await old,false);assert.deepEqual(first.effects.messages,[]);assert.deepEqual(first.effects.loads,[]);
  const allowed=deferred(),second=startupHarness({handoff:tokenFor(2),chromeApi:{runtime:{sendMessage:async()=>({ok:true,source:SOURCE})},extension:{isAllowedFileSchemeAccess:()=>allowed.promise}}});
  const pending=second.run();await Promise.resolve();second.newIntent();allowed.resolve(false);assert.equal(await pending,false);
  assert.deepEqual(second.effects.messages,[]);assert.deepEqual(second.effects.fetches,[]);
});

test('a stale fetch response is cancelled without loading bytes or overwriting current status',async()=>{
  const fetched=deferred();let bodyCancelled=0;
  const h=startupHarness({handoff:tokenFor(1),fetchPdf:()=>fetched.promise});const run=h.run();
  await until(()=>h.effects.messages.length>0);
  assert.ok(h.effects.messages.length>0);const before=h.effects.messages.slice();h.newIntent();
  fetched.resolve({body:{cancel:async()=>{bodyCancelled++;}}});assert.equal(await run,false);
  assert.equal(bodyCancelled,1);assert.deepEqual(h.effects.loads,[]);assert.deepEqual(h.effects.messages,before);assert.deepEqual(h.effects.routes,[]);
});

test('a stale streaming read cancels its reader before allocating or loading the complete PDF',async()=>{
  const chunk=deferred();let readerStarted=false,cancelled=0,released=0;
  const response={ok:true,headers:{get:()=>null},body:{getReader:()=>{readerStarted=true;return {read:()=>chunk.promise,cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}};}}};
  const h=startupHarness({handoff:tokenFor(1),fetchPdf:async()=>response}),run=h.run();
  while(!readerStarted)await Promise.resolve();const before=h.effects.messages.slice();h.newIntent();chunk.resolve({value:new Uint8Array([1]),done:false});
  assert.equal(await run,false);assert.equal(cancelled,1);assert.equal(released,1);assert.deepEqual(h.effects.loads,[]);assert.deepEqual(h.effects.messages,before);
});

test('a rejected old fetch cannot publish an error over a newer input',async()=>{
  const fetched=deferred(),h=startupHarness({handoff:tokenFor(1),fetchPdf:()=>fetched.promise}),run=h.run();
  await until(()=>h.effects.messages.length>0);const before=h.effects.messages.slice();h.newIntent();
  fetched.resolve(Promise.reject(new Error('Synthetic old source failure')));assert.equal(await run,false);assert.deepEqual(h.effects.messages,before);assert.deepEqual(h.effects.loads,[]);
});

test('MIME opens only the supplied stream with its original transaction; stale native fallback is inert',async()=>{
  let fallbacks=0;const h=startupHarness({mime:{getStreamInfo:async()=>({streamUrl:'blob:received-stream',originalUrl:'https://example.invalid/Synthetic-report.pdf'}),abortAndFallbackToNativeHandler:async()=>{fallbacks++;}}});
  assert.equal(await h.run(),true);assert.deepEqual(h.effects.fetches,['blob:received-stream']);assert.deepEqual(h.effects.routes,['mime-handler']);
  const settings=h.effects.loads[0].settings;assert.equal(settings.inputToken,1);assert.equal(settings.name,'Synthetic-report.pdf');
  h.newIntent();assert.equal(await settings.nativeFallback(),false);assert.equal(fallbacks,0);
});

test('current toolbar startup passes its shared token and rejects a remote source reply',async()=>{
  const h=startupHarness({handoff:tokenFor(1)});assert.equal(await h.run(),true);assert.equal(h.effects.loads.length,1);
  assert.equal(h.effects.loads[0].settings.inputToken,1);assert.deepEqual(h.effects.routes,['local-toolbar']);assert.deepEqual(h.effects.fetches,[SOURCE]);
  const remote=startupHarness({handoff:tokenFor(2),chromeApi:{runtime:{sendMessage:async()=>({ok:true,source:'https://example.invalid/Synthetic.pdf'})}}});
  assert.equal(await remote.run(),false);assert.deepEqual(remote.effects.fetches,[]);assert.ok(remote.effects.messages[0].includes('Use Open PDF'));
});

test('startup errors are private and PDF streams use Blob storage without a fixed size ceiling',async()=>{
  const h=startupHarness({handoff:tokenFor(1),fetchPdf:async()=>{throw new Error('PRIVATE-SYNTHETIC-FILE-PATH');}});
  assert.equal(await h.run(),false);assert.ok(h.effects.messages.every(message=>!message.includes('PRIVATE-SYNTHETIC')));
  const blob=await readInitialPdf(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Length':String(512*1024*1024)}}));assert.equal(blob.size,3);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array([1,2,3]));
});

test('local file origins are optional and installation does not register a browser-wide PDF handler',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.permissions,['activeTab']);assert.deepEqual(manifest.host_permissions||[],[]);
  assert.deepEqual(manifest.optional_host_permissions,['file:///*']);
  assert.equal(manifest.mime_types_handler,undefined);assert.equal(manifest.content_scripts,undefined);
});

test('an ungranted toolbar handoff offers an explicit action without prompting or fetching',async()=>{
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async query=>{assert.deepEqual(query,{origins:['file:///*']});return false;}}}});
  assert.equal(await h.run(),false);assert.deepEqual(h.effects.requests,[]);assert.deepEqual(h.effects.fetches,[]);assert.deepEqual(h.effects.loads,[]);
  const action=h.effects.actions.at(-1);assert.equal(action.reason,'grant-required');assert.equal(typeof action.enable,'function');
  assert.deepEqual(Object.keys(action).sort(),['enable','reason']);assert.ok(h.effects.messages.at(-1).includes('Open PDF'));
  assert.ok(h.effects.messages.every(message=>!message.includes('Synthetic')&&!message.includes('file:///')));
});

test('the explicit grant starts synchronously in the click gesture and opens only after both checks pass',async()=>{
  let host=false,inGesture=false,requests=0;const answer=deferred();
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>host,request:query=>{
    assert.equal(inGesture,true,'request must execute before an await loses the gesture');assert.deepEqual(query,{origins:['file:///*']});requests++;return answer.promise;
  }}}});
  assert.equal(await h.run(),false);inGesture=true;const opening=h.effects.actions.at(-1).enable();inGesture=false;
  assert.equal(requests,1);assert.equal(h.effects.fetches.length,0);host=true;answer.resolve(true);
  assert.equal(await opening,true);assert.deepEqual(h.effects.fetches,[SOURCE]);assert.equal(h.effects.loads[0].settings.inputToken,1);
  assert.equal(h.effects.actions.at(-1),null);assert.deepEqual(h.effects.routes,['local-toolbar']);
});

test('denial or request rejection leaves the picker and retry action without exposing Chrome errors',async()=>{
  for(const reject of [false,true]){
    const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>false,request:()=>reject?Promise.reject(new Error('PRIVATE-SYNTHETIC-PATH')):Promise.resolve(false)}}});
    await h.run();assert.equal(await h.effects.actions.at(-1).enable(),false);
    assert.deepEqual(h.effects.fetches,[]);assert.deepEqual(h.effects.loads,[]);assert.equal(h.effects.actions.at(-1).reason,'grant-required');
    assert.match(h.effects.messages.at(-1),/Use Open PDF/);assert.ok(h.effects.messages.every(value=>!value.includes('PRIVATE-SYNTHETIC')));
  }
});

test('granting the host does not bypass Chrome separate file URL setting, and explicit retry can recover',async()=>{
  let host=false,fileUrls=false,requests=0;
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>host,request:()=>{host=true;requests++;return Promise.resolve(true);}},extension:{isAllowedFileSchemeAccess:async()=>fileUrls}}});
  await h.run();assert.match(h.effects.messages.at(-1),/Allow access to file URLs/);
  assert.equal(await h.effects.actions.at(-1).enable(),false);assert.equal(h.effects.actions.at(-1).reason,'file-settings-required');assert.equal(h.effects.fetches.length,0);
  fileUrls=true;assert.equal(await h.effects.actions.at(-1).enable(),true);assert.equal(requests,2);assert.equal(h.effects.loads.length,1);
});

test('existing host and file URL grants open automatically without any request',async()=>{
  const h=startupHarness({handoff:tokenFor(1)});assert.equal(await h.run(),true);
  assert.deepEqual(h.effects.requests,[]);assert.ok(h.effects.contains.length>=2);assert.equal(h.effects.actions.at(-1),null);
});

test('a grant or file URL setting revoked during reading refuses the completed stream',async()=>{
  for(const revoke of ['host','setting']){
    let host=true,setting=true;
    const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>host},extension:{isAllowedFileSchemeAccess:async()=>setting}},
      fetchPdf:async()=>{if(revoke==='host')host=false;else setting=false;return new Response(new Uint8Array([1,2,3]));}});
    assert.equal(await h.run(),false);assert.deepEqual(h.effects.loads,[]);assert.deepEqual(h.effects.routes,[]);
    assert.equal(h.effects.actions.at(-1).reason,revoke==='host'?'grant-required':'file-settings-required');assert.match(h.effects.messages.at(-1),/Open PDF/);
  }
});

test('stale actions never prompt and stale grant responses never revive an earlier source',async()=>{
  let requests=0,host=false;const granted=deferred();
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>host,request:()=>{requests++;return granted.promise;}}}});
  await h.run();const action=h.effects.actions.at(-1),opening=action.enable(),messages=h.effects.messages.slice(),actions=h.effects.actions.slice();
  h.newIntent();host=true;granted.resolve(true);assert.equal(await opening,false);assert.equal(await action.enable(),false);
  assert.equal(requests,1);assert.deepEqual(h.effects.fetches,[]);assert.deepEqual(h.effects.loads,[]);
  assert.deepEqual(h.effects.messages,messages);assert.deepEqual(h.effects.actions,actions);
  const stale=startupHarness({handoff:tokenFor(2),chromeApi:{permissions:{contains:async()=>false}}});await stale.run();const old=stale.effects.actions.at(-1);stale.newIntent();
  assert.equal(await old.enable(),false);assert.deepEqual(stale.effects.requests,[]);
});

test('delayed host checks cannot offer or fetch an old handoff after a newer input intent',async()=>{
  const host=deferred(),h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:()=>host.promise}}});
  const run=h.run();await Promise.resolve();h.newIntent();host.resolve(false);assert.equal(await run,false);
  assert.deepEqual(h.effects.fetches,[]);assert.deepEqual(h.effects.messages,[]);assert.deepEqual(h.effects.actions,[null]);
});

test('concurrent enable clicks and already completed actions cannot duplicate requests or loads',async()=>{
  let host=false,requests=0;const grant=deferred();
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{permissions:{contains:async()=>host,request:()=>{requests++;return grant.promise;}}}});
  await h.run();const action=h.effects.actions.at(-1),one=action.enable();assert.equal(await action.enable(),false);assert.equal(requests,1);
  host=true;grant.resolve(true);assert.equal(await one,true);assert.equal(await action.enable(),false);assert.equal(h.effects.loads.length,1);assert.equal(requests,1);
});

test('MIME streams and ordinary picker pages never consult or request file host access',async()=>{
  const denied={permissions:{contains:()=>assert.fail('MIME/picker checked an optional host'),request:()=>assert.fail('MIME/picker requested access')},extension:{isAllowedFileSchemeAccess:()=>assert.fail('MIME/picker checked file settings')}};
  const mime=startupHarness({chromeApi:denied,mime:{getStreamInfo:async()=>({streamUrl:'blob:received',originalUrl:SOURCE})}});
  assert.equal(await mime.run(),true);assert.deepEqual(mime.effects.fetches,['blob:received']);assert.deepEqual(mime.effects.actions,[null]);
  const picker=startupHarness({chromeApi:denied});assert.equal(await picker.run(),false);assert.deepEqual(picker.effects.actions,[null]);assert.deepEqual(picker.effects.fetches,[]);
});

test('missing or restarted handoffs retain picker fallback without asking for a broad grant',async()=>{
  const h=startupHarness({handoff:tokenFor(1),chromeApi:{runtime:{sendMessage:async()=>({ok:false,code:'unavailable'})},permissions:{contains:()=>assert.fail('Unavailable source checked a host')}}});
  assert.equal(await h.run(),false);assert.match(h.effects.messages.at(-1),/Use Open PDF/);assert.deepEqual(h.effects.actions,[null]);assert.deepEqual(h.effects.requests,[]);
});

class EntryElement {
  constructor(id='',type='ordinary'){this.id=id;this.type=type;this.hidden=false;this.disabled=false;this.dataset={};this.handlers=new Map();this.attributes={};}
  addEventListener(type,handler){if(!this.handlers.has(type))this.handlers.set(type,[]);this.handlers.get(type).push(handler);}
  setAttribute(name,value){this.attributes[name]=value;}
  closest(selector){return selector.split(',').some(part=>this.matches(part))?this:null;}
  matches(selector){return selector==='#'+this.id;}
}
let entrySequence=0;
async function entryHarness({existing=false}={}){
  const previous=Object.fromEntries(['document','location','history','chrome','fetch','__entryApp'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let input=0,host=false,setting=true,requests=0,fetches=0,inGesture=false;const nodes=new Map(),events=new Map(),loads=[];
  const status=new EntryElement('status'),body=new EntryElement(),header={prepend:node=>nodes.set(node.id,node)};nodes.set('status',status);
  if(existing)nodes.set('enable-local-access',new EntryElement('enable-local-access'));
  const root={body,getElementById:id=>nodes.get(id)||null,createElement:()=>new EntryElement(),querySelector:()=>header,
    addEventListener:(type,handler,capture)=>{assert.equal(capture,true);if(!events.has(type))events.set(type,[]);events.get(type).push(handler);}};
  const app={beginInputRequest:()=>++input,isInputRequestCurrent:token=>token===input,loadPdfBytes:async(bytes,options)=>{loads.push({bytes,options});return true;}};
  const api={runtime:{sendMessage:async()=>({ok:true,source:SOURCE})},extension:{isAllowedFileSchemeAccess:async()=>setting},permissions:{contains:async()=>host,request:query=>{assert.equal(inGesture,true);assert.deepEqual(query,{origins:['file:///*']});host=true;requests++;return Promise.resolve(true);}}};
  let finalUrl;
  for(const [key,value] of Object.entries({document:root,location:{href:viewerLaunchUrl(VIEWER,tokenFor(existing?2:1))},history:{replaceState:(_state,_unused,url)=>{finalUrl=url;}},chrome:api,
    fetch:async()=>{fetches++;return new Response(new Uint8Array([1,2,3]));},__entryApp:app}))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  const original=await readFile(new URL('entry.js',import.meta.url),'utf8');
  const source=original.replace("import {loadPdfBytes,beginInputRequest,isInputRequestCurrent} from '../app.js';",'const {loadPdfBytes,beginInputRequest,isInputRequestCurrent}=globalThis.__entryApp;')
    .replace("import {openInitialPdf} from './initial-pdf.mjs';",'import {openInitialPdf} from '+JSON.stringify(new URL('initial-pdf.mjs',import.meta.url).href)+';');
  await import('data:text/javascript;base64,'+Buffer.from(source+'\n// harness '+(++entrySequence)).toString('base64'));
  await until(()=>nodes.get('enable-local-access')?.hidden===false);
  return {nodes,events,loads,button:nodes.get('enable-local-access'),get input(){return input;},get requests(){return requests;},get fetches(){return fetches;},get finalUrl(){return finalUrl;},
    dispatch(type,event){for(const handler of events.get(type)||[])handler(event);},
    clickButton(){inGesture=true;try{for(const handler of nodes.get('enable-local-access').handlers.get('click')||[])handler();}finally{inGesture=false;}},
    async restore(){app.beginInputRequest();for(let i=0;i<8;i++)await Promise.resolve();for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
  };
}

test('entry creates or reuses a labeled optional action and requests only its direct click',async()=>{
  for(const existing of [false,true]){
    const h=await entryHarness({existing});
    try{
      assert.equal(h.requests,0);assert.equal(h.fetches,0);assert.equal(h.finalUrl,VIEWER);
      assert.equal(h.button.hidden,false);h.clickButton();assert.equal(h.requests,1,'entry must call the action before returning from click');
      await until(()=>h.loads.length===1);assert.equal(h.button.hidden,true);assert.equal(h.loads[0].options.inputToken,1);
    }finally{await h.restore();}
  }
});

test('entry immediately hides and invalidates old access for PDF picker and drop intent',async()=>{
  const h=await entryHarness();
  try{
    const before=h.input;h.dispatch('click',{target:new EntryElement('compare-current')});assert.equal(h.input,before);assert.equal(h.button.hidden,false);
    h.dispatch('drop',{dataTransfer:{types:['text/plain']}});assert.equal(h.input,before);
    for(const [type,event] of [['click',{target:new EntryElement('open-pdf')}],['change',{target:new EntryElement('pdf-file')}],['drop',{dataTransfer:{types:['Files']}}]]){
      // Each captured intent hides the existing action synchronously. Once its
      // transaction is invalidated, a retained button event cannot revive it.
      h.button.hidden=false;h.dispatch(type,event);assert.equal(h.button.hidden,true);h.clickButton();assert.equal(h.requests,0);assert.equal(h.fetches,0);
    }
    assert.ok(h.input>before);assert.equal(h.loads.length,0);
  }finally{await h.restore();}
});
