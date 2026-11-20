import { createLocalSourceHandoffs, LOCAL_SOURCE_MESSAGE, viewerLaunchUrl } from './routing.mjs';

const viewerUrl=chrome.runtime.getURL('viewer.html');
const handoffs=createLocalSourceHandoffs({viewerUrl,extensionId:chrome.runtime.id});

// Same explicit toolbar-launch pattern as the read-only EA-PDF reference,
// restricted here to local PDFs with no remote host access.
export async function openToolbarViewer(tab){
  const token=handoffs.reserve(tab?.url);
  try{
    const viewer=await chrome.tabs.create({url:viewerLaunchUrl(viewerUrl,token)});
    if(token&&!handoffs.bind(token,viewer?.id))handoffs.release(token);
    return viewer;
  }catch{if(token)handoffs.release(token);return null;}
}
chrome.action.onClicked.addListener(tab=>{void openToolbarViewer(tab);});

chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
  if(request?.type!==LOCAL_SOURCE_MESSAGE)return false;
  const reply=value=>{try{sendResponse(value);}catch{ /* The viewer may have closed while tab creation was pending. */ }};
  void handoffs.claim(request.token,sender).then(reply,()=>reply({ok:false,code:'unavailable'}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId=>handoffs.releaseTab(tabId));
