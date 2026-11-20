import {loadPdfBytes,beginInputRequest,isInputRequestCurrent} from '../app.js';
import {openInitialPdf} from './initial-pdf.mjs';

const message = text => { if (text) document.getElementById('status').textContent = text; };
const chromeApi = globalThis.chrome;
const mime = chromeApi?.mimeHandler ?? globalThis.browser?.mimeHandler;
const nativeButton = document.getElementById('native-pdf');
if (nativeButton) nativeButton.hidden = true;
let localAccessAction=null,startupPending=true,accessPending=false;
let accessButton=document.getElementById('enable-local-access');
function showLocalAccessAction(action){
  localAccessAction=action;
  if(action&&!accessButton){
    accessButton=document.createElement('button');accessButton.id='enable-local-access';accessButton.type='button';
    accessButton.className='secondary';accessButton.textContent='Enable local PDF access';
    accessButton.setAttribute('aria-label','Enable local PDF access for toolbar opening');
    (document.querySelector('.header-actions.global-actions')||document.querySelector('.app-header')||document.body).prepend(accessButton);
    accessButton.addEventListener('click',enableLocalAccess);
  }
  if(accessButton){accessButton.hidden=!action;accessButton.disabled=false;
    if(action){accessButton.type='button';accessButton.textContent='Enable local PDF access';accessButton.setAttribute('aria-label','Enable local PDF access for toolbar opening');}
    accessButton.title=action?.reason==='file-settings-required'?'After enabling Allow access to file URLs in Manage extension, retry this local PDF':'Optional access for opening the current local PDF from the toolbar';}
}
function enableLocalAccess(){
  const action=localAccessAction;if(!action)return;
  accessPending=true;accessButton.disabled=true;
  // Do not defer this call or await another API first: permissions.request must
  // execute in this actual click gesture, inside the action's synchronous prefix.
  const pending=action.enable();
  Promise.resolve(pending).catch(()=>{}).finally(()=>{accessPending=false;if(localAccessAction===action)accessButton.disabled=false;});
}
if(accessButton){accessButton.hidden=true;accessButton.addEventListener('click',enableLocalAccess);}
function inputIntent(){
  if(startupPending||accessPending||localAccessAction)beginInputRequest();
  showLocalAccessAction(null);
}
document.addEventListener('click',event=>{
  if(event.target?.closest?.('#open-pdf,#pdf-file'))inputIntent();
},true);
document.addEventListener('change',event=>{if(event.target?.matches?.('#pdf-file'))inputIntent();},true);
const dropTarget=document.defaultView||document;
dropTarget.addEventListener('drop',event=>{if([...event.dataTransfer?.types||[]].includes('Files'))inputIntent();},true);
const launchUrl=new URL(location.href),handoff=launchUrl.searchParams.get('handoff');
const legacySource=launchUrl.searchParams.has('source');
if(handoff!==null||legacySource){
  // The address bar/history needs neither the one-use token nor legacy paths.
  launchUrl.searchParams.delete('handoff');launchUrl.searchParams.delete('source');
  history.replaceState(null,'',launchUrl.href);
}

void openInitialPdf({beginInputRequest,isInputRequestCurrent,loadPdfBytes,mime,chromeApi,handoff,legacySource,
  onMessage:message,onLocalAccessAction:showLocalAccessAction,onRoute:route=>{document.body.dataset.openingRoute=route;}})
  .finally(()=>{startupPending=false;});
