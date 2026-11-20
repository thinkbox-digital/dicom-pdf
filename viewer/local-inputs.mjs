/** Open one local DICOM PDF at a time through the picker or viewer-wide drop target. */
export function bindLocalInputs({loadPdf,onError,root=document}){
  let generation=0;const removers=[];
  const listen=(element,type,handler,options)=>{if(!element)return;element.addEventListener(type,handler,options);removers.push(()=>element.removeEventListener(type,handler,options));};
  const $=id=>root.getElementById(id);
  const picker=$('pdf-file'),menu=$('save-menu');

  async function open(file){
    const request=++generation;
    try{
      const header=file?await file.slice(0,1024).text():'';
      if(request!==generation)return;
      if(!header.includes('%PDF-')){
        onError('Choose one converted DICOM PDF.');
        return;
      }
      await loadPdf(file,{name:file.name||'DICOM PDF'});
    }catch(error){
      if(request===generation)onError(error?.message||'The selected PDF could not be opened.');
    }
  }

  listen($('open-pdf'),'click',()=>picker?.click());
  listen(picker,'change',event=>{
    const file=event.target.files[0];
    if(!file)return;
    event.target.value='';
    void open(file);
  });
  // Close and restore focus before a Save action opens its dialog or starts a download.
  listen(menu,'click',event=>{if(event.target.closest('button:not(:disabled)')){menu.open=false;menu.querySelector('summary').focus();}},true);
  listen(menu,'keydown',event=>{if(event.key==='Escape'&&menu.open){event.preventDefault();menu.open=false;menu.querySelector('summary').focus();}});
  listen(root,'click',event=>{if(menu?.open&&!menu.contains(event.target))menu.open=false;},true);

  const target=root.defaultView||root,capture={capture:true};
  const fileDrag=event=>[...event.dataTransfer?.types||[]].includes('Files')||[...event.dataTransfer?.items||[]].some(item=>item.kind==='file')||event.dataTransfer?.files?.length>0;
  const hint=visible=>root.body?.classList.toggle('file-drop-active',visible);
  listen(target,'dragenter',event=>{if(fileDrag(event)){event.preventDefault();hint(true);}},capture);
  listen(target,'dragover',event=>{if(fileDrag(event)){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';hint(true);}},capture);
  listen(target,'dragleave',event=>{if(!event.relatedTarget)hint(false);},capture);
  listen(target,'dragend',()=>hint(false),capture);
  listen(target,'blur',()=>hint(false));
  listen(target,'drop',event=>{
    hint(false);
    if(!fileDrag(event))return;
    event.preventDefault();event.stopPropagation();
    const {files,items}=event.dataTransfer;
    const dropped=[...files||[]];
    if(!dropped.length)for(const item of items||[]){
      const file=item.getAsFile?.();
      if(file)dropped.push(file);
    }
    const hasDirectory=[...items||[]].some(item=>item.webkitGetAsEntry?.()?.isDirectory);
    void open(dropped.length===1&&!hasDirectory?dropped[0]:null);
  },capture);
  return {destroy(){++generation;hint(false);for(const remove of removers)remove();}};
}
