/** Only local PDF tabs may be fetched by the compatibility toolbar route. */
export function localPdfUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.host && url.host !== 'localhost') return null;
    if (!/\.pdf$/i.test(url.pathname)) return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch { return null; }
}

export const LOCAL_SOURCE_MESSAGE = 'dicom-pdf:claim-local-source';
const TOKEN = /^[a-f0-9]{64}$/;

/** The viewer URL may contain only an opaque handoff token, never a source URL. */
export function viewerLaunchUrl(base, token) {
  const viewer = new URL(base);
  viewer.search = ''; viewer.hash = '';
  if (typeof token === 'string' && TOKEN.test(token)) viewer.searchParams.set('handoff', token);
  return viewer.href;
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Short-lived, one-shot source handoffs. Nothing is persisted across restarts. */
export function createLocalSourceHandoffs({viewerUrl,extensionId,now=()=>performance.now(),tokenFactory=randomToken,
  ttlMs=60000,maxEntries=32,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  const viewer = new URL(viewerUrl),records = new Map(),closedTabs=new Map(); let timer = null;
  if (viewer.protocol !== 'chrome-extension:' || viewer.host !== extensionId || !Number.isFinite(ttlMs) || ttlMs<=0 || !Number.isInteger(maxEntries) || maxEntries<1) throw new TypeError('Invalid local handoff configuration.');
  function remove(token) {
    const record=records.get(token);if(!record)return;
    records.delete(token);record.resolveBinding?.(null);record.resolveBinding=null;
  }
  function prune() {
    const time=now();for(const [token,record] of records)if(record.expires<=time)remove(token);
    for(const [tabId,expires] of closedTabs)if(expires<=time)closedTabs.delete(tabId);
  }
  function schedule() {
    if(timer!==null){clearTimer(timer);timer=null;}
    if(!records.size)return;
    const expires=Math.min(...Array.from(records.values(),record=>record.expires));
    timer=setTimer(()=>{timer=null;prune();schedule();},Math.max(0,expires-now()));
  }
  function authorized(sender,token) {
    if(sender?.id!==extensionId || sender.frameId!==0 || !Number.isInteger(sender.tab?.id) || sender.tab.id<0)return false;
    try{
      const url=new URL(sender.url);
      return url.protocol===viewer.protocol && url.host===viewer.host && url.pathname===viewer.pathname
        && !url.hash && [...url.searchParams].every(([name,value])=>name==='handoff'&&value===token);
    }catch{return false;}
  }
  function reserve(source) {
    const local=localPdfUrl(source);if(!local)return null;
    prune();
    while(records.size>=maxEntries)remove(records.keys().next().value);
    let token;for(let tries=0;tries<16;tries++){
      const candidate=tokenFactory();if(typeof candidate==='string'&&TOKEN.test(candidate)&&!records.has(candidate)){token=candidate;break;}
    }
    if(!token){schedule();return null;}
    const record={source:local,expires:now()+ttlMs,tabId:null,resolveBinding:null};
    record.binding=new Promise(resolve=>{record.resolveBinding=resolve;});records.set(token,record);schedule();return token;
  }
  function bind(token,tabId) {
    prune();const record=records.get(token);
    if(!record||!Number.isInteger(tabId)||tabId<0||closedTabs.has(tabId)){if(record)remove(token);schedule();return false;}
    if(record.tabId!==null)return record.tabId===tabId;
    record.tabId=tabId;record.resolveBinding(tabId);record.resolveBinding=null;return true;
  }
  async function claim(token,sender) {
    prune();schedule();
    if(typeof token!=='string'||!TOKEN.test(token)||!authorized(sender,token))return {ok:false,code:'unavailable'};
    const record=records.get(token);if(!record)return {ok:false,code:'unavailable'};
    const tabId=record.tabId ?? await record.binding;
    prune();
    if(records.get(token)!==record||tabId!==sender.tab.id){schedule();return {ok:false,code:'unavailable'};}
    // Delete synchronously before resolving, so concurrent claims cannot reuse it.
    remove(token);schedule();return {ok:true,source:record.source};
  }
  function release(token){remove(token);schedule();}
  function releaseTab(tabId){
    prune();if(!Number.isInteger(tabId)||tabId<0)return;
    for(const [token,record] of records)if(record.tabId===tabId)remove(token);
    // tabs.onRemoved can race the tabs.create promise; remember a bounded set of
    // recently closed IDs so a delayed creation result cannot bind a dead tab.
    closedTabs.set(tabId,now()+ttlMs);while(closedTabs.size>maxEntries*2)closedTabs.delete(closedTabs.keys().next().value);
    schedule();
  }
  function clear(){for(const token of records.keys())remove(token);closedTabs.clear();schedule();}
  return {reserve,bind,claim,release,releaseTab,clear,stats:()=>({pending:records.size,timer:timer!==null})};
}
