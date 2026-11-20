/** Yield between option batches so large multiframe inventories remain operable. */
export async function populateMetadataOptions(select,fields,{selectedPaths=new Set(),isCurrent=()=>true,onProgress=()=>{},batchSize=200,
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1000)throw new TypeError('Invalid metadata option batch size.');
  const ordered=[...fields].sort(([a],[b])=>a.localeCompare(b));
  if(!isCurrent())return false;
  select.replaceChildren();select.setAttribute('aria-busy','true');
  try{
    for(let offset=0;offset<ordered.length;offset+=batchSize){
      if(!isCurrent())return false;
      const fragment=select.ownerDocument.createDocumentFragment();
      for(const [path,element] of ordered.slice(offset,offset+batchSize)){
        const option=select.ownerDocument.createElement('option');option.value=path;
        option.textContent=`${element.keyword||element.tag} · ${path} · ${element.vr||'UN'}`;
        option.selected=selectedPaths.has(path);fragment.append(option);
      }
      select.append(fragment);onProgress(Math.min(offset+batchSize,ordered.length),ordered.length);
      if(offset+batchSize<ordered.length)await yieldControl();
    }
    return isCurrent();
  }finally{if(isCurrent())select.setAttribute('aria-busy','false');}
}

/** Keep all field selections in a model while showing a bounded native list. */
export function createMetadataFieldPicker(select,{pageSize=200}={}){
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200)throw new TypeError('Invalid metadata field page size.');
  const doc=select.ownerDocument,toolbar=doc.createElement('div'),search=doc.createElement('input'),previous=doc.createElement('button'),next=doc.createElement('button'),summary=doc.createElement('span');
  toolbar.className='metadata-field-toolbar';search.id='metadata-field-search';search.className='metadata-field-search';search.type='search';search.placeholder='Find a field or tag path';search.setAttribute('aria-label','Find metadata fields');
  previous.type=next.type='button';previous.textContent='Previous';next.textContent='Next';previous.setAttribute('aria-label','Previous metadata field page');next.setAttribute('aria-label','Next metadata field page');
  summary.className='metadata-field-page-count';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  toolbar.append(search,previous,next,summary);select.before(toolbar);
  let catalog=[],selected=new Set(),visible=[],filtered=[],page=0,query='',epoch=0,alive=true,parentCurrent=()=>true,loading=true,selectable=false,timer=null;
  const current=request=>alive&&request===epoch&&parentCurrent();
  function state(){
    select.disabled=loading||!selectable;search.disabled=loading;
    previous.disabled=loading||page<=0;next.disabled=loading||(page+1)*pageSize>=filtered.length;
    summary.textContent=`${filtered.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,filtered.length)}`:'0'} of ${filtered.length} matching fields · ${catalog.length} total · ${selected.size} selected`;
  }
  async function render(){
    const request=++epoch;if(!current(request))return false;
    filtered=query?catalog.filter(field=>field.search.includes(query)):catalog;
    page=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1));
    visible=filtered.slice(page*pageSize,(page+1)*pageSize);
    const result=await populateMetadataOptions(select,new Map(visible.map(field=>[field.path,field])),{selectedPaths:selected,isCurrent:()=>current(request)});
    if(result)state();return result;
  }
  const changed=()=>{
    const choices=new Set([...select.selectedOptions].map(option=>option.value));
    for(const field of visible){if(choices.has(field.path))selected.add(field.path);else selected.delete(field.path);}state();
  };
  const searched=()=>{clearTimeout(timer);timer=setTimeout(()=>{query=search.value.trim().toLocaleLowerCase();page=0;void render();},100);};
  const back=()=>{if(page>0){page--;void render();}},forward=()=>{if((page+1)*pageSize<filtered.length){page++;void render();}};
  select.addEventListener('change',changed);search.addEventListener('input',searched);previous.addEventListener('click',back);next.addEventListener('click',forward);
  state();
  return {
    async setFields(fields,{selectedPaths=selected,isCurrent=()=>true}={}){
      if(!alive||!isCurrent())return false;parentCurrent=isCurrent;
      catalog=[...fields].map(([path,element])=>{
        if(typeof path!=='string')throw new Error('Metadata inventory contains invalid field paths.');
        const keyword=typeof element.keyword==='string'?element.keyword:'',tag=typeof element.tag==='string'?element.tag:'',vr=typeof element.vr==='string'?element.vr:'';
        return {path,keyword,tag,vr,search:`${keyword} ${tag} ${path} ${vr}`.toLocaleLowerCase()};
      }).sort((a,b)=>a.path.localeCompare(b.path));
      const known=new Set(catalog.map(field=>field.path));selected=new Set([...selectedPaths].filter(path=>known.has(path)));return render();
    },
    setState(value){loading=value.loading;selectable=value.selectable;state();},
    selectAll(value){selected=value?new Set(catalog.map(field=>field.path)):new Set();for(const option of select.options)option.selected=selected.has(option.value);state();},
    getSelectedPaths:()=>new Set(selected),get fieldCount(){return catalog.length;},
    destroy(){alive=false;++epoch;clearTimeout(timer);select.removeEventListener('change',changed);search.removeEventListener('input',searched);previous.removeEventListener('click',back);next.removeEventListener('click',forward);toolbar.remove();select.replaceChildren();}
  };
}
