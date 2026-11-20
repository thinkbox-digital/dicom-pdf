import {localPdfUrl,LOCAL_SOURCE_MESSAGE} from './routing.mjs';

const cancelled=()=>new DOMException('Opening this PDF was cancelled.','AbortError');
export async function readInitialPdf(response,isCurrent=()=>true){
  if(!isCurrent()){try{await response.body?.cancel();}catch{}throw cancelled();}
  if(!response.ok)throw new Error('The local PDF could not be read.');
  if(!response.body)throw new Error('The local PDF has no content.');
  const reader=response.body.getReader();let released=false;
  const release=()=>{if(!released){released=true;reader.releaseLock();}};
  const stream=new ReadableStream({
    async pull(controller){
      try{
        const {value,done}=await reader.read();
        if(!isCurrent()){try{await reader.cancel();}catch{}throw cancelled();}
        if(done){release();controller.close();}else controller.enqueue(value);
      }catch(error){release();controller.error(error);}
    },
    async cancel(){try{await reader.cancel();}finally{release();}}
  });
  // Let the browser manage Blob storage; PDF.js subsequently reads local ranges.
  const blob=await new Response(stream).blob();if(!isCurrent())throw cancelled();return blob;
}
function documentName(value){
  try{return decodeURIComponent(new URL(value).pathname.split('/').pop())||'DICOM PDF';}catch{return 'DICOM PDF';}
}

/**
 * All delayed startup work belongs to the same transaction as a picker/drop.
 * onLocalAccessAction receives null or {reason,enable}; no source URL escapes
 * that closure. The caller must invoke enable() directly in the user click and
 * hide/invalidate the action when a later PDF selection or drop begins.
 * This function checks optional access but never requests it during startup.
 */
export async function openInitialPdf({beginInputRequest,isInputRequestCurrent,loadPdfBytes,mime,chromeApi,handoff=null,
  legacySource=false,fetchPdf=fetch,onMessage=()=>{},onRoute=()=>{},onLocalAccessAction=()=>{}}){
  const inputToken=beginInputRequest(),current=()=>isInputRequestCurrent(inputToken);
  const say=text=>{if(current())onMessage(text);};
  const route=value=>{if(current())onRoute(value);};
  const accessAction=value=>{if(current())onLocalAccessAction(value);};
  accessAction(null);
  const read=async url=>{
    const response=await fetchPdf(url);
    return readInitialPdf(response,current);
  };
  let info;
  if(mime?.getStreamInfo){try{info=await mime.getStreamInfo();}catch{ /* Toolbar/picker pages have no MIME stream. */ }}
  if(!current())return false;
  if(info){
    const nativeFallback=async()=>{if(!current())return false;await mime.abortAndFallbackToNativeHandler();return current();};
    route('mime-handler');
    try{
      say('Opening this PDF locally…');
      // Consume only Chrome's received stream, never its original remote URL.
      const bytes=await read(info.streamUrl);if(!current())return false;
      say('');return await loadPdfBytes(bytes,{name:documentName(info.originalUrl),nativeFallback,inputToken});
    }catch{say('Unable to open this PDF. Use Open PDF to select a local file, or Open in Chrome.');return false;}
  }
  if(handoff===null&&!legacySource){
    say('Drop a converted DICOM PDF onto this viewer or choose Open PDF.');return false;
  }
  let reply;
  try{if(handoff!==null)reply=await chromeApi.runtime.sendMessage({type:LOCAL_SOURCE_MESSAGE,token:handoff});}catch{ /* A restarted worker has no pending handoff. */ }
  if(!current())return false;
  const source=reply?.ok===true?localPdfUrl(reply.source):null;
  if(!source){say('This PDF could not be opened automatically. Use Open PDF to select the file.');return false;}
  let enabling=false,finished=false;
  const permissionState=async()=>{
    const [granted,fileUrlsAllowed]=await Promise.all([
      Promise.resolve().then(()=>chromeApi.permissions.contains({origins:['file:///*']})).catch(()=>false),
      Promise.resolve().then(()=>chromeApi.extension.isAllowedFileSchemeAccess()).catch(()=>false)
    ]);
    return {granted:granted===true,fileUrlsAllowed:fileUrlsAllowed===true};
  };
  const offer=(state,denied=false)=>{
    accessAction({reason:state.granted?'file-settings-required':'grant-required',enable:enableAccess});
    if(denied)say('Local PDF access was not enabled. Use Open PDF to select the file, or choose Enable local PDF access to try again.');
    else if(!state.fileUrlsAllowed)say('Toolbar opening needs optional local PDF access and Chrome’s Allow access to file URLs setting. Choose Enable local PDF access, then enable that setting under Manage extension if needed, or use Open PDF here.');
    else say('Choose Enable local PDF access to allow toolbar opening, or use Open PDF to select the file.');
  };
  async function openLocal(){
    if(!current()||finished)return false;
    accessAction(null);
    try{
      say('Opening this local PDF…');
      const bytes=await read(source);if(!current())return false;
      // A grant can be revoked while the stream is being read. Do not load a
      // completed old stream after access or the user's input intent changed.
      const access=await permissionState();if(!current())return false;
      if(!access.granted||!access.fileUrlsAllowed){offer(access);return false;}
      finished=true;say('');route('local-toolbar');
      return await loadPdfBytes(bytes,{name:documentName(source),inputToken});
    }catch{say('Unable to open the local PDF. Use Open PDF to select it.');return false;}
  }
  async function enableAccess(){
    if(!current()||finished||enabling)return false;
    enabling=true;
    try{
      // Keep this call before the first await: entry invokes enableAccess
      // directly inside the explicit button's click gesture. Startup never asks.
      const request=chromeApi.permissions.request({origins:['file:///*']});
      const granted=await request;if(!current())return false;
      if(granted!==true){offer({granted:false,fileUrlsAllowed:false},true);return false;}
      const access=await permissionState();if(!current())return false;
      if(!access.granted||!access.fileUrlsAllowed){offer(access);return false;}
      return await openLocal();
    }catch{if(current())offer({granted:false,fileUrlsAllowed:false},true);return false;}
    finally{enabling=false;}
  }
  const access=await permissionState();if(!current())return false;
  if(!access.granted||!access.fileUrlsAllowed){offer(access);return false;}
  return openLocal();
}
