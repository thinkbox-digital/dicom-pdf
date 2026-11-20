import {orderSourceIndices} from './stack-order.mjs';
import {RT_DOSE_SOP} from './rt-dose.mjs';

const PAGE_SIZE = 40;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MODALITIES = Object.freeze({CT:'CT images',MR:'MRI images',CR:'X-ray images',DX:'X-ray images',IO:'X-ray images',MG:'Mammography images',US:'Ultrasound images',XA:'X-ray angiography images',NM:'Nuclear medicine images',PT:'PET images',RTDOSE:'Radiotherapy dose data',RTPLAN:'Radiotherapy plans',RTSTRUCT:'Radiotherapy structures',SEG:'Segmentation data',SR:'Structured reports',DOC:'Documents',OT:'Other images'});
const text = value => typeof value==='string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim() : typeof value==='number' && Number.isFinite(value) ? String(value) : '';
const fieldsOf = entry => ({...(entry.navigationFields || {}),...(entry.fields || {})});
const values = (entries,indices,keys) => [...new Set(indices.flatMap(index=>keys.map(key=>text(fieldsOf(entries[index])[key]))).filter(Boolean))];
const one = (supplied,missing) => supplied.length===0 ? missing : supplied.length===1 ? supplied[0] : 'Multiple supplied values';

/** Format an actual DA value without inventing a date or applying a time zone. */
export function formatStudyDate(value) {
  const raw=text(value); if (!raw) return 'Date not provided';
  if (!/^\d{8}$/.test(raw)) return 'Date unavailable';
  const year=Number(raw.slice(0,4)),month=Number(raw.slice(4,6)),day=Number(raw.slice(6,8));
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (year<1 || month<1 || month>12 || day<1 || day>days[month-1]) return 'Date unavailable';
  return `${day} ${MONTHS[month-1]} ${raw.slice(0,4)}`;
}
export function modalityLabel(value) {
  const supplied=text(value);
  return MODALITIES[supplied] || (supplied ? `${supplied} series` : 'Image type not provided');
}
function positiveInteger(value) { const supplied=text(value); return /^[1-9]\d*$/.test(supplied) && Number.isSafeInteger(Number(supplied)) ? Number(supplied) : null; }
function seriesInteger(value) { const supplied=text(value); return /^[+\-]?\d+$/.test(supplied) && Number.isSafeInteger(Number(supplied)) ? Number(supplied) : null; }
function imageEntry(entry) {
  const sop=entry.fields?.SOPClassUID||entry.fields?.MediaStorageSOPClassUID||entry.navigationFields?.SOPClassUID;
  return sop!==RT_DOSE_SOP&&sop!=='1.2.840.10008.5.1.4.1.1.4.2'&&(entry.status==='rendered'||Number(entry.fields?.Rows)>0&&Number(entry.fields?.Columns)>0);
}

/**
 * Source identity is the original global index, never a possibly duplicated UID.
 * An optional includeEntry predicate filters navigation without renumbering.
 * Included non-raster data remains navigable even when study metadata is absent.
 */
export function buildStudyModel(entries,{includeEntry=null,stackOrder=null}={}) {
  if (!Array.isArray(entries)) throw new TypeError('A source entry array is required.');
  if(includeEntry!==null&&typeof includeEntry!=='function')throw new TypeError('The source filter must be a function.');
  const studiesByKey=new Map(),byIndex=new Map(),otherIndices=[],excludedIndices=[];
  for (const [index,entry] of entries.entries()) {
    if(includeEntry&&!includeEntry(entry,index)){excludedIndices.push(index);continue;}
    const fields=fieldsOf(entry),uid=text(fields.StudyInstanceUID),seriesUid=text(fields.SeriesInstanceUID);
    if (!uid && !imageEntry(entry)&&!includeEntry) {otherIndices.push(index);byIndex.set(index,{studyKey:null,seriesKey:null});continue;}
    // An absent identifier cannot establish that otherwise unrelated files belong together.
    const key=JSON.stringify(uid?['study',uid]:['unassigned-study',index]);
    let study=studiesByKey.get(key);
    if (!study) {study={key,uid:uid || null,indices:[],series:[],_series:new Map(),firstIndex:index};studiesByKey.set(key,study);}
    study.indices.push(index);
    const seriesKey=JSON.stringify([key,...(seriesUid?['series',seriesUid]:['unassigned-series',index])]);
    let series=study._series.get(seriesKey);
    if (!series) {series={key:seriesKey,uid:seriesUid || null,indices:[],firstIndex:index};study._series.set(seriesKey,series);study.series.push(series);}
    series.indices.push(index);byIndex.set(index,{studyKey:key,seriesKey});
  }
  for (const study of studiesByKey.values()) {
    const dates=values(entries,study.indices,['StudyDate']);
    study.raw={dates,descriptions:values(entries,study.indices,['StudyDescription']),bodyAreas:values(entries,study.indices,['BodyPartExamined','AnatomicRegion[0].CodeMeaning']),facilities:values(entries,study.indices,['InstitutionName'])};
    study.date=dates.length===1?dates[0]:null;
    study.dateLabel=dates.length>1?'Multiple supplied dates':formatStudyDate(study.date);
    study.description=one(study.raw.descriptions,'Description not provided');
    study.bodyArea=one(study.raw.bodyAreas,'Body area not provided');
    study.facility=one(study.raw.facilities,'Facility not provided');
    study.count=study.indices.length;
    for (const series of study.series) {
      if(stackOrder)series.indices=orderSourceIndices(series.indices,stackOrder);
      const descriptions=values(entries,series.indices,['SeriesDescription']),modalities=values(entries,series.indices,['Modality']),numbers=values(entries,series.indices,['SeriesNumber']);
      series.raw={descriptions,modalities,numbers};
      series.description=one(descriptions,'Description not provided');
      series.modality=one(modalities,'');
      series.modalityLabel=modalities.length>1?'Multiple supplied image types':modalityLabel(series.modality);
      series.number=numbers.length===1?numbers[0]:null;
      series.count=series.indices.length;
      series.imageCount=series.indices.filter(index=>imageEntry(entries[index])).length;
      series.frameCount=series.indices.reduce((sum,index)=>{
        if(sum===null || !imageEntry(entries[index]))return sum;
        const raw=text(fieldsOf(entries[index]).NumberOfFrames),frames=positiveInteger(raw);
        return raw && frames===null ? null : sum+(frames || 1);
      },0);
      series.thumbnailIndex=series.indices.find(index=>entries[index].status==='rendered' && entries[index].displayRejected!==true)
        ?? series.indices.find(index=>imageEntry(entries[index])) ?? null;
      series.selectionIndex=series.thumbnailIndex ?? series.firstIndex;
    }
    study.series.sort((a,b)=>{
      const first=seriesInteger(a.number),second=seriesInteger(b.number);
      return first!==null && second!==null ? first-second || a.firstIndex-b.firstIndex : a.firstIndex-b.firstIndex;
    });
    delete study._series;
  }
  const studies=[...studiesByKey.values()].sort((a,b)=>{
    const first=a.date && formatStudyDate(a.date)!=='Date unavailable'?a.date:'',second=b.date && formatStudyDate(b.date)!=='Date unavailable'?b.date:'';
    return second.localeCompare(first) || a.firstIndex-b.firstIndex;
  });
  return {studies,byIndex,otherIndices,excludedIndices};
}

/**
 * Small patient-facing navigator. The original native source list is untouched.
 * getThumbnail(entry,index,{signal}) returns {pixels:RGBA,width,height} or null.
 * Only visible series representatives are requested, one at a time. Thumbnail
 * storage is bounded independently of the parent's original-image cache.
 */
export function createStudyNavigation({container,entries,onSelect,getThumbnail,isCurrent=()=>true,includeEntry=null,stackOrder=null}) {
  if (!container) throw new TypeError('A navigation container is required.');
  const model=buildStudyModel(entries,{includeEntry,stackOrder}),doc=container.ownerDocument;
  const showStudyPicker=model.studies.filter(study=>study.uid).length>1;
  let alive=true,selectedIndex=-1,studyKey=model.studies[0]?.key || '',query='',page=0,epoch=0,running=false;
  let observer=null,renderAbort=new AbortController(),queue=[];
  const cache=new Map(),queued=new Set(),buttons=new Map();
  const element=(tag,className,content)=>{const node=doc.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;};
  const shell=element('div','study-nav-shell');
  const heading=element('label','study-picker-label','Exam');
  const picker=element('select','study-picker');picker.setAttribute('aria-label','Choose an exam');
  heading.append(picker);
  const prompt=element('option','','Choose an exam');prompt.value='';prompt.disabled=true;picker.append(prompt);
  for (const [ordinal,study] of model.studies.entries()) {
    const option=element('option','',`${study.dateLabel} · ${study.bodyArea}${study.uid?'':` · original ${study.firstIndex+1}`}`);
    option.value=study.key;picker.append(option);
  }
  const summary=element('p','study-summary');
  const search=element('input','series-search');search.type='search';search.placeholder='Find a series';search.setAttribute('aria-label','Find a series in this exam');
  const list=element('div','series-cards');list.setAttribute('aria-label','Series in this exam');
  const paging=element('div','series-paging'),previous=element('button','','Previous'),position=element('span'),next=element('button','','More');
  previous.type=next.type='button';previous.setAttribute('aria-label','Previous series page');next.setAttribute('aria-label','Next series page');
  paging.append(previous,position,next);shell.append(heading,summary,search,list,paging);container.replaceChildren(shell);container.hidden=!model.studies.length;
  const current=()=>{try{return alive && Boolean(isCurrent());}catch{return false;}};
  const matches=series=>!query || [series.description,series.modality,series.modalityLabel,series.number].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  function markSelection() {
    const selection=model.byIndex.get(selectedIndex);
    for (const [key,button] of buttons) {
      const active=key===selection?.seriesKey;button.classList.toggle('is-selected',active);
      if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
    }
  }
  function placeholder(box,label) {
    box.title=label;box.setAttribute('aria-label',label);
    const mark=element('span','thumbnail-note thumbnail-placeholder','—');mark.setAttribute('aria-hidden','true');box.replaceChildren(mark);
  }
  function paint(box,thumbnail) {
    if (!thumbnail) {placeholder(box,'Preview unavailable');return;}
    box.removeAttribute('aria-label');box.removeAttribute('title');
    const {width,height,pixels}=thumbnail;
    if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>512||height>512||!ArrayBuffer.isView(pixels)||pixels.byteLength!==width*height*4)throw new Error('Invalid thumbnail data');
    const canvas=element('canvas');canvas.width=width;canvas.height=height;canvas.setAttribute('aria-hidden','true');
    const imageData=canvas.getContext('2d').createImageData(width,height);imageData.data.set(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
    canvas.getContext('2d').putImageData(imageData,0,0);box.replaceChildren(canvas);
  }
  async function drain() {
    if (running) return;running=true;
    try {
      while(queue.length && current()) {
        const task=queue.shift();
        if(task.epoch!==epoch || task.signal.aborted){queued.delete(task.series.key);continue;}
        try {
          const thumbnail=await getThumbnail?.(entries[task.series.thumbnailIndex],task.series.thumbnailIndex,{signal:task.signal});
          if (!current() || task.signal.aborted || task.epoch!==epoch) continue;
          paint(task.box,thumbnail);
          if(thumbnail){
            cache.set(task.series.key,{width:thumbnail.width,height:thumbnail.height,pixels:new Uint8ClampedArray(new Uint8Array(thumbnail.pixels.buffer,thumbnail.pixels.byteOffset,thumbnail.pixels.byteLength))});
            while(cache.size>64)cache.delete(cache.keys().next().value);
          }
        } catch {
          if(current() && !task.signal.aborted && task.epoch===epoch)placeholder(task.box,'Preview unavailable');
        } finally {queued.delete(task.series.key);}
      }
    } finally {running=false;if(queue.length && current())void drain();}
  }
  function request(series,box) {
    if(!current())return;
    if(series.thumbnailIndex===null){box.replaceChildren(element('span','thumbnail-note',series.modality==='SR'?'Report':'File'));return;}
    if(cache.has(series.key)){paint(box,cache.get(series.key));return;}
    if(queued.has(series.key))return;
    queued.add(series.key);queue.push({series,box,signal:renderAbort.signal,epoch});void drain();
  }
  function updateSummary(study) {
    if(!study)return;
    summary.textContent=`${study.description}\n${study.facility}`;
    summary.title=`Body area: ${study.raw.bodyAreas.join('; ') || 'Not provided'}\nFacility: ${study.raw.facilities.join('; ') || 'Not provided'}\nStudy ID: ${study.uid || 'Not provided'}`;
  }
  function render() {
    ++epoch;renderAbort.abort();renderAbort=new AbortController();observer?.disconnect();queue=[];queued.clear();buttons.clear();
    const study=model.studies.find(study=>study.key===studyKey);picker.value=studyKey;
    heading.hidden=!showStudyPicker;
    if (!study) {list.replaceChildren();summary.textContent='No exam metadata available.';paging.hidden=true;search.hidden=true;markSelection();return;}
    updateSummary(study);
    const filtered=study.series.filter(matches);page=Math.min(page,Math.max(0,Math.ceil(filtered.length/PAGE_SIZE)-1));
    const visible=filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);list.replaceChildren();search.hidden=study.series.length<5 && !query;
    if(!visible.length)list.append(element('p','series-empty','No matching series.'));
    if(typeof globalThis.IntersectionObserver==='function')observer=new IntersectionObserver(items=>{
      for(const item of items)if(item.isIntersecting){observer.unobserve(item.target);const series=visible.find(series=>series.key===item.target.dataset.seriesKey);if(series)request(series,item.target.querySelector('.series-thumbnail'));}
    },{root:list,rootMargin:'80px'});
    for(const [ordinal,series] of visible.entries()) {
      const button=element('button','series-card');button.type='button';button.dataset.seriesKey=series.key;button.dataset.sourceIndex=String(series.selectionIndex);
      const box=element('span','series-thumbnail');placeholder(box,'Preview pending');
      const information=element('span','series-information'),name=element('strong','series-name',series.modalityLabel),description=element('span','series-description',series.description);
      const count=element('span','series-count',`${series.count} file${series.count===1?'':'s'}${series.frameCount>series.imageCount?` · ${series.frameCount} frames`:''}${series.number?` · Series ${series.number}`:''}`);
      information.append(name,description,count);button.append(box,information);
      button.setAttribute('aria-label',`${series.modalityLabel}: ${series.description}, ${count.textContent}`);
      button.title=`Supplied description: ${series.raw.descriptions.join('; ') || 'Not provided'}\nSeries ID: ${series.uid || 'Not provided'}`;
      button.addEventListener('click',()=>{if(current())onSelect?.(series.selectionIndex);});
      button.addEventListener('focus',()=>request(series,box));list.append(button);buttons.set(series.key,button);
      if(cache.has(series.key))paint(box,cache.get(series.key));else if(observer)observer.observe(button);else if(ordinal<4)request(series,box);
    }
    paging.hidden=filtered.length<=PAGE_SIZE;previous.disabled=page===0;next.disabled=(page+1)*PAGE_SIZE>=filtered.length;
    position.textContent=filtered.length?`${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,filtered.length)} of ${filtered.length}`:'0 series';
    markSelection();
  }
  picker.addEventListener('change',()=>{studyKey=picker.value;query='';search.value='';page=0;render();const study=model.studies.find(study=>study.key===studyKey);if(study)onSelect?.(study.series[0]?.selectionIndex ?? study.firstIndex);});
  search.addEventListener('input',()=>{query=search.value.trim().toLocaleLowerCase();page=0;render();});
  search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();list.querySelector('button')?.click();}});
  previous.addEventListener('click',()=>{page=Math.max(0,page-1);render();});next.addEventListener('click',()=>{page++;render();});
  render();
  return {model,refreshFacilities(){
    if(!current())return;
    for(const study of model.studies) {
      study.raw.facilities=values(entries,study.indices,['InstitutionName']);
      study.facility=one(study.raw.facilities,'Facility not provided');
    }
    updateSummary(model.studies.find(study=>study.key===studyKey));
  },updateSelection(index){
    if(!current())return;selectedIndex=index;const selection=model.byIndex.get(index);
    if(!selection){markSelection();return;}
    if(selection.studyKey===null){studyKey='';render();return;}
    const study=model.studies.find(study=>study.key===selection.studyKey);if(!study)return;
    let rerender=studyKey!==study.key;studyKey=study.key;
    if(!study.series.some(series=>series.key===selection.seriesKey && matches(series))){query='';search.value='';rerender=true;}
    const at=study.series.filter(matches).findIndex(series=>series.key===selection.seriesKey),selectedPage=Math.floor(Math.max(0,at)/PAGE_SIZE);
    if(page!==selectedPage){page=selectedPage;rerender=true;}
    if(rerender)render();else markSelection();
  },destroy(){alive=false;++epoch;renderAbort.abort();observer?.disconnect();queue=[];queued.clear();cache.clear();container.replaceChildren();container.hidden=true;}};
}
