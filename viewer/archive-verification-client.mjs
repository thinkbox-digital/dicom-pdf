import {attachmentBytes} from './pdf-attachments.mjs';

const aborted=()=>new DOMException('File check cancelled.','AbortError');
function failure(){return new Error('The file check could not finish. Try again or use the independent verifier.');}
function factory(){
  if(typeof Worker!=='function')throw failure();
  if(typeof ARCHIVE_CHECK_WORKER_URL==='string')return {worker:new Worker(new URL(ARCHIVE_CHECK_WORKER_URL,document.baseURI),{type:'module'})};
  if(typeof ARCHIVE_CHECK_WORKER_SOURCE==='string'){
    const url=URL.createObjectURL(new Blob([ARCHIVE_CHECK_WORKER_SOURCE],{type:'text/javascript'}));
    try{return {worker:new Worker(url),dispose:()=>URL.revokeObjectURL(url)};}catch(error){URL.revokeObjectURL(url);throw error;}
  }
  throw failure();
}
export function createArchiveVerifier({workerFactory=factory}={}){
  let active=null,completed=null,sequence=0;
  function dispose(record){record.worker.terminate();record.dispose?.();}
  function cancel(){
    active?.();
    if(completed){dispose(completed);completed=null;}
  }
  async function chooseTrust(files,roots,{single=false}={}){
    const created=workerFactory(),record=created.worker?created:{worker:created};
    const worker=record.worker;
    return new Promise((resolve,reject)=>{
      const finish=(error,selection)=>{
        clearTimeout(deadline);
        dispose(record);
        error?reject(error):resolve(selection);
      };
      const failed=event=>{
        event?.preventDefault?.();
        finish(new Error('The selected certificates could not be read.'));
      };
      const deadline=setTimeout(failed,15000);
      worker.onmessage=({data})=>data.selection?finish(null,data.selection):finish(new Error(data.error));
      worker.onerror=failed;
      worker.onmessageerror=failed;
      try{worker.postMessage({type:'choose-trust',files,roots,single});}catch{failed();}
    });
  }
  function verify(plan,getFile,options={}){
    cancel();if(options.signal?.aborted)return Promise.reject(aborted());
    let record;
    try{const created=workerFactory();record=created.worker?created:{worker:created};}catch{return Promise.reject(failure());}
    return run(record,plan,getFile,options);
  }
  function recheckTrust(pdfSecurity){
    if(!completed)return null;
    const record=completed;completed=null;
    return run(record,null,null,{pdfSecurity});
  }
  function run(record,plan,getFile,{signal,onProgress=()=>{},canRun=()=>true,getDigest=()=>null,rememberDigest=()=>{},pdfSecurity}){
    const worker=record.worker,id=++sequence,allowed=new Set(plan?.tasks.map(task=>task.attachment));
    if(plan?.manifestSignature)for(const name of [plan.manifestSignature.attachment,plan.manifestSignature.manifest])allowed.add(name);
    return new Promise((resolve,reject)=>{
      let done=false,current=null,checksums=record.checksums,securityDeadline;
      const stop=()=>finish(aborted());
      function finish(error,result,keepWorker=false){
        if(done)return;done=true;current=null;clearTimeout(securityDeadline);signal?.removeEventListener('abort',stop);
        worker.removeEventListener('message',message);worker.removeEventListener('error',errorEvent);worker.removeEventListener('messageerror',errorEvent);
        if(keepWorker){record.checksums=checksums;completed=record;}
        else dispose(record);
        if(active===stop)active=null;
        error?reject(error):resolve(result);
      }
      function startSecurityDeadline(){
        securityDeadline=setTimeout(()=>incompleteSecurity('PDF security verification exceeded 120 seconds.'),120000);
      }
      function incompleteSecurity(detail){
        if(!checksums){finish(failure());return;}
        finish(null,{...checksums,pdfSecurity:{status:'UNKNOWN',trustStatus:'UNKNOWN',checks:[{category:'Other checks',name:'PDF security verification',status:'UNKNOWN',detail}]}});
      }
      const errorEvent=event=>{event.preventDefault?.();incompleteSecurity('PDF security verification could not finish.');};
      async function message(event){
        const data=event.data;if(done||data?.id!==id)return;
        if(data.type==='need'||data.type==='chunk'){
          while(!done&&!canRun())await new Promise(resolve=>setTimeout(resolve,40));
          if(done)return;
        }
        if(data.type==='chunk'){
          if(!allowed.has(data.name)||!Number.isSafeInteger(data.start)||!Number.isSafeInteger(data.end)||data.start<0||data.end<data.start||data.end-data.start>1024*1024){finish(failure());return;}
          try{
            const source=current?.name===data.name?current.bytes:null;
            if(!(source instanceof Uint8Array)||data.start>source.length){finish(failure());return;}
            const bytes=source.slice(data.start,Math.min(data.end,source.length));
            worker.postMessage({type:'chunk',id,request:data.request,bytes},[bytes.buffer]);
          }catch{finish(failure());}
        }else if(data.type==='need'){
          if(!allowed.has(data.name)){finish(failure());return;}
          try{
            const file=await getFile(data.name);if(done)return;
            if(data.forDigest&&file?.readDigest){
              current=null;
              const cached=file.peek();
              const digest=cached&&await getDigest(file,cached);
              const result=digest?{size:cached.byteLength,digest}:await file.readDigest();
              if(!done)worker.postMessage({type:'file',id,request:data.request,file:result?{size:result.size,verifiedDigest:result.digest}:null});
              return;
            }
            const bytes=file?await attachmentBytes(file):null;
            if(done)return;
            current={name:data.name,bytes,file};
            const verifiedDigest=bytes&&await getDigest(file,bytes);
            if(done)return;
            worker.postMessage({type:'file',id,request:data.request,file:bytes==null?null:{size:bytes.byteLength,verifiedDigest}});
          }catch{finish(failure());}
        }else if(data.type==='digest'){
          if(current?.name===data.name&&current.bytes&&/^[a-f0-9]{64}$/.test(data.digest))
            rememberDigest(current.file,current.bytes,data.digest);
        }else if(data.type==='progress'){try{onProgress(data.progress);}catch{}}
        else if(data.type==='checksums'&&pdfSecurity){
          checksums=data.result;
          startSecurityDeadline();
          pdfSecurity.onChecksums(checksums);
        }else if(data.type==='timestamp-sources'&&pdfSecurity){
          let value=[];
          try{value=await pdfSecurity.loadTimestampSources?.()??[];}catch{}
          if(!done)worker.postMessage({type:'response',id,request:data.request,value});
        }else if((data.type==='security-input'||data.type==='security-revisions')&&pdfSecurity){
          try{
            while(!done&&!canRun())await new Promise(resolve=>setTimeout(resolve,40));
            if(done)return;
            const value=data.type==='security-input'?await pdfSecurity.getInput():await pdfSecurity.readRevisions(data.ends,data.hasCredentials);
            if(!done)worker.postMessage({type:'response',id,request:data.request,value});
          }catch{incompleteSecurity('The PDF security evidence could not be read.');}
        }else if(data.type==='security-progress'&&pdfSecurity)pdfSecurity.onProgress(data.detail);
        else if(data.type==='result')finish(null,data.result,!!data.result.pdfSecurity);
        else if(data.type==='error')incompleteSecurity('PDF security verification could not finish.');
      }
      active=stop;signal?.addEventListener('abort',stop,{once:true});
      worker.addEventListener('message',message);worker.addEventListener('error',errorEvent);worker.addEventListener('messageerror',errorEvent);
      if(signal?.aborted){stop();return;}
      if(!plan)startSecurityDeadline();
      try{worker.postMessage({type:plan?'verify':'recheck-trust',id,plan,pdfSecurity:!!pdfSecurity,
        sessionRoots:pdfSecurity?.sessionRoots,signerCertificateOrigin:pdfSecurity?.signerCertificateOrigin});}catch{finish(failure());}
    });
  }
  return {verify,recheckTrust,chooseTrust,cancel,destroy:cancel};
}
