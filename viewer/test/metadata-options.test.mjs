import test from 'node:test';
import assert from 'node:assert/strict';
import {populateMetadataOptions,createMetadataFieldPicker} from '../metadata-options.mjs';

function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
class Element {
  constructor(tag,ownerDocument){this.tag=tag;this.ownerDocument=ownerDocument;this.children=[];this.attributes=new Map();this.attributeWrites=[];this.listeners=new Map();this.selected=false;this.value='';this.textContent='';this.clears=0;this.disabled=false;this.parentElement=null;}
  set innerHTML(_value){throw new Error('File-derived text must never be assigned to innerHTML');}
  append(...nodes){for(const node of nodes){if(node.tag==='fragment'){this.append(...node.children);node.children=[];}else{this.children.push(node);node.parentElement=this;}}}
  replaceChildren(...nodes){this.clears++;this.children=[];this.append(...nodes);}
  setAttribute(name,value){this.attributes.set(name,value);this.attributeWrites.push([name,value]);}
  getAttribute(name){return this.attributes.get(name)??null;}
  get options(){return this.children.filter(child=>child.tag==='option');}
  get selectedOptions(){return this.options.filter(option=>option.selected);}
  before(node){if(!this.parentElement)return;const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),0,node);node.parentElement=this.parentElement;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  addEventListener(type,callback){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(callback);}
  removeEventListener(type,callback){this.listeners.get(type)?.delete(callback);}
  dispatch(type){for(const callback of this.listeners.get(type)||[])callback({type,target:this});}
  click(){if(!this.disabled)this.dispatch('click');}
}
function select(){
  const document={createElement:tag=>new Element(tag,document),createDocumentFragment:()=>new Element('fragment',document)};
  return document.createElement('select');
}
const fields=count=>new Map(Array.from({length:count},(_,index)=>[`dataset/(${String(index).padStart(4,'0')},0001)`,{keyword:`Field${index}`,tag:'(0000,0001)',vr:'DS'}]));
const settle=async()=>{for(let index=0;index<6;index++)await Promise.resolve();};
function pickerHarness(options){
  const box=select(),parent=box.ownerDocument.createElement('div');parent.append(box);
  const picker=createMetadataFieldPicker(box,options),toolbar=parent.children[0];
  return {box,parent,picker,toolbar,search:toolbar.children[0],previous:toolbar.children[1],next:toolbar.children[2],summary:toolbar.children[3]};
}
async function search(h,value){h.search.value=value;h.search.dispatch('input');await new Promise(resolve=>setTimeout(resolve,120));await settle();}
function choose(h,paths){for(const option of h.box.options)option.selected=paths.includes(option.value);h.box.dispatch('change');}

test('option paths, labels, fallback VR and selected paths are exact and sorted',async()=>{
  const box=select(),source=new Map([
    ['dataset/(0028,0010)',{keyword:'Rows',tag:'(0028,0010)',vr:'US'}],
    ['dataset/(0008,0005)',{keyword:'SpecificCharacterSet',tag:'(0008,0005)',vr:'CS'}],
    ['dataset/(0011,0010)',{tag:'(0011,0010)'}],
  ]),snapshot=structuredClone([...source]),selectedPaths=new Set(['dataset/(0028,0010)','not-present']);
  assert.equal(await populateMetadataOptions(box,source,{selectedPaths}),true);
  assert.deepEqual(box.children.map(option=>[option.value,option.textContent,option.selected]),[
    ['dataset/(0008,0005)','SpecificCharacterSet · dataset/(0008,0005) · CS',false],
    ['dataset/(0011,0010)','(0011,0010) · dataset/(0011,0010) · UN',false],
    ['dataset/(0028,0010)','Rows · dataset/(0028,0010) · US',true],
  ]);
  assert.deepEqual([...source],snapshot);assert.deepEqual([...selectedPaths],['dataset/(0028,0010)','not-present']);
  assert.deepEqual(box.attributeWrites,[['aria-busy','true'],['aria-busy','false']]);
});

test('markup-like keywords and paths are rendered literally without executable nodes',async()=>{
  const box=select(),path='dataset/<script>globalThis.__metadataExecuted=true</script>',keyword='<img src=x onerror=alert(1)>';
  await populateMetadataOptions(box,new Map([[path,{keyword,vr:'LO'}]]));
  assert.equal(box.children.length,1);assert.equal(box.children[0].tag,'option');
  assert.equal(box.children[0].value,path);assert.equal(box.children[0].textContent,`${keyword} · ${path} · LO`);
  assert.equal(globalThis.__metadataExecuted,undefined);
});

test('default 200-option batches yield twice for 450 fields while retaining final selections',async()=>{
  const box=select(),source=fields(450),last=[...source.keys()].at(-1),progress=[],yields=[];
  const result=await populateMetadataOptions(box,source,{selectedPaths:new Set([last]),
    onProgress:(completed,total)=>progress.push([completed,total]),yieldControl:async()=>{yields.push(box.children.length);assert.equal(box.getAttribute('aria-busy'),'true');}});
  assert.equal(result,true);assert.deepEqual(yields,[200,400]);assert.deepEqual(progress,[[200,450],[400,450],[450,450]]);
  assert.equal(box.children.length,450);assert.equal(box.children.at(-1).value,last);assert.equal(box.children.at(-1).selected,true);
  assert.equal(box.getAttribute('aria-busy'),'false');assert.equal(box.clears,1);
});

test('an empty current inventory clears the selector and finishes its busy state without yields',async()=>{
  const box=select();box.append(box.ownerDocument.createElement('option'));let yields=0;
  assert.equal(await populateMetadataOptions(box,new Map(),{yieldControl:async()=>yields++}),true);
  assert.equal(box.children.length,0);assert.equal(yields,0);assert.equal(box.getAttribute('aria-busy'),'false');
});

test('an already stale request cannot clear or change the current selector or aria state',async()=>{
  const box=select(),current=box.ownerDocument.createElement('option');current.value='current';box.append(current);box.setAttribute('aria-busy','true');
  const writes=box.attributeWrites.slice();
  assert.equal(await populateMetadataOptions(box,fields(300),{isCurrent:()=>false}),false);
  assert.deepEqual(box.children,[current]);assert.equal(box.clears,0);assert.deepEqual(box.attributeWrites,writes);
});

test('cancellation between batches stops further options and progress immediately',async()=>{
  const box=select(),progress=[];let current=true,yields=0;
  assert.equal(await populateMetadataOptions(box,fields(501),{isCurrent:()=>current,onProgress:done=>progress.push(done),
    yieldControl:async()=>{yields++;current=false;}}),false);
  assert.equal(box.children.length,200);assert.deepEqual(progress,[200]);assert.equal(yields,1);
});

test('a cancelled old batch cannot append to new DOM or clear a newer aria-busy state',async()=>{
  const box=select(),oldGate=deferred(),newGate=deferred();let owner='old';
  const old=populateMetadataOptions(box,fields(500),{isCurrent:()=>owner==='old',yieldControl:()=>oldGate.promise});
  assert.equal(box.children.length,200);owner='new';
  const fresh=new Map([['new-a',{keyword:'New A'}],['new-b',{keyword:'New B'}],['new-c',{keyword:'New C'}]]);
  const next=populateMetadataOptions(box,fresh,{batchSize:2,isCurrent:()=>owner==='new',yieldControl:()=>newGate.promise});
  assert.deepEqual(box.children.map(option=>option.value),['new-a','new-b']);assert.equal(box.getAttribute('aria-busy'),'true');
  oldGate.resolve();assert.equal(await old,false);
  assert.deepEqual(box.children.map(option=>option.value),['new-a','new-b']);assert.equal(box.getAttribute('aria-busy'),'true');
  newGate.resolve();assert.equal(await next,true);
  assert.deepEqual(box.children.map(option=>option.value),['new-a','new-b','new-c']);assert.equal(box.getAttribute('aria-busy'),'false');
});

test('current failures clear aria-busy while preserving the thrown error',async()=>{
  const box=select(),problem=new Error('Synthetic progress failure');
  await assert.rejects(populateMetadataOptions(box,fields(300),{onProgress:()=>{throw problem;}}),error=>error===problem);
  assert.equal(box.getAttribute('aria-busy'),'false');
});

test('paged picker holds all 450 fields while rendering at most 200 exact options',async()=>{
  const h=pickerHarness(),source=fields(450),keys=[...source.keys()];
  try{
    assert.equal(await h.picker.setFields(source,{selectedPaths:new Set([keys[0],keys[449],'missing'])}),true);
    h.picker.setState({loading:false,selectable:true});
    assert.equal(h.picker.fieldCount,450);assert.deepEqual(h.box.options.map(option=>option.value),keys.slice(0,200));
    assert.equal(h.box.options[0].selected,true);assert.equal(h.previous.disabled,true);assert.equal(h.next.disabled,false);
    assert.match(h.summary.textContent,/1–200 of 450 matching fields · 450 total · 2 selected/);
    h.next.click();await settle();assert.deepEqual(h.box.options.map(option=>option.value),keys.slice(200,400));
    h.next.click();await settle();assert.deepEqual(h.box.options.map(option=>option.value),keys.slice(400));assert.equal(h.next.disabled,true);
    assert.equal(h.box.options.at(-1).selected,true);assert.match(h.summary.textContent,/401–450/);
    h.previous.click();await settle();assert.equal(h.box.options.length,200);assert.equal(h.box.options[0].value,keys[200]);
    assert.equal(h.search.getAttribute('aria-label'),'Find metadata fields');assert.equal(h.summary.getAttribute('aria-live'),'polite');
    assert.equal(h.box.getAttribute('aria-busy'),'false');
  }finally{h.picker.destroy();}
});

test('selections survive page changes, searches and clearing a filter',async()=>{
  const h=pickerHarness({pageSize:2}),source=fields(6),keys=[...source.keys()];
  try{
    await h.picker.setFields(source);h.picker.setState({loading:false,selectable:true});choose(h,[keys[1]]);
    h.next.click();await settle();choose(h,[keys[2]]);
    await search(h,'  fIeLd5  ');assert.deepEqual(h.box.options.map(option=>option.value),[keys[5]]);choose(h,[keys[5]]);
    await search(h,'');assert.deepEqual(h.box.options.map(option=>option.value),keys.slice(0,2));assert.equal(h.box.options[1].selected,true);
    assert.deepEqual([...h.picker.getSelectedPaths()].sort(),[keys[1],keys[2],keys[5]].sort());
    choose(h,[]);assert.deepEqual([...h.picker.getSelectedPaths()].sort(),[keys[2],keys[5]].sort());
    const snapshot=h.picker.getSelectedPaths();snapshot.clear();assert.equal(h.picker.getSelectedPaths().size,2);
  }finally{h.picker.destroy();}
});

test('Select all and Clear apply to the complete catalog across filters and pages',async()=>{
  const h=pickerHarness({pageSize:2}),source=fields(6),keys=[...source.keys()];
  try{
    await h.picker.setFields(source);h.picker.setState({loading:false,selectable:true});await search(h,'Field5');
    h.picker.selectAll(true);assert.equal(h.picker.getSelectedPaths().size,6);assert.equal(h.box.options[0].selected,true);
    await search(h,'');assert.ok(h.box.options.every(option=>option.selected));
    h.picker.selectAll(false);assert.equal(h.picker.getSelectedPaths().size,0);assert.ok(h.box.options.every(option=>!option.selected));
    await search(h,keys[5]);assert.equal(h.box.options[0].selected,false);
  }finally{h.picker.destroy();}
});

test('search matches keywords, tag paths, tags and VR without interpreting literal markup',async()=>{
  const h=pickerHarness({pageSize:2}),path='dataset/<img src=x onerror=alert(1)>',source=new Map([
    [path,{keyword:'Literal <script>',tag:'(0011,0010)',vr:'LO'}],['dataset/(0028,0010)',{keyword:'Rows',tag:'(0028,0010)',vr:'US'}],
  ]);
  try{
    await h.picker.setFields(source);h.picker.setState({loading:false,selectable:true});
    for(const query of ['literal','(0011,0010)','src=x','LO']){await search(h,query);assert.equal(h.box.options.length,1);assert.equal(h.box.options[0].value,path);}
    assert.equal(h.box.options[0].textContent,`Literal <script> · ${path} · LO`);
    await search(h,'no such field');assert.equal(h.box.options.length,0);assert.match(h.summary.textContent,/0 of 0 matching fields · 2 total/);
    assert.equal(h.previous.disabled,true);assert.equal(h.next.disabled,true);
  }finally{h.picker.destroy();}
});

test('loading state disables controls while all-fields mode still permits browsing',async()=>{
  const h=pickerHarness({pageSize:2});
  try{
    await h.picker.setFields(fields(5));assert.equal(h.box.disabled,true);assert.equal(h.search.disabled,true);assert.equal(h.next.disabled,true);
    h.picker.setState({loading:false,selectable:false});assert.equal(h.box.disabled,true);assert.equal(h.search.disabled,false);assert.equal(h.next.disabled,false);
    h.picker.setState({loading:false,selectable:true});assert.equal(h.box.disabled,false);
    h.picker.setState({loading:true,selectable:true});assert.equal(h.box.disabled,true);assert.equal(h.search.disabled,true);assert.equal(h.previous.disabled,true);assert.equal(h.next.disabled,true);
  }finally{h.picker.destroy();}
});

test('stale replacement leaves current DOM intact and new catalogs remove unknown selections',async()=>{
  const h=pickerHarness({pageSize:2}),first=fields(4),keys=[...first.keys()];
  try{
    await h.picker.setFields(first,{selectedPaths:new Set([keys[0],keys[3]])});h.picker.setState({loading:false,selectable:true});
    const original=h.box.options.slice();assert.equal(await h.picker.setFields(new Map([['stale',{keyword:'Stale'}]]),{isCurrent:()=>false}),false);
    assert.deepEqual(h.box.options,original);assert.equal(h.picker.fieldCount,4);
    await h.picker.setFields(new Map([[keys[3],first.get(keys[3])],['new',{keyword:'New'}]]));
    assert.equal(h.picker.fieldCount,2);assert.deepEqual([...h.picker.getSelectedPaths()],[keys[3]]);assert.ok(h.box.options.length<=2);
  }finally{h.picker.destroy();}
});

test('destroy removes controls, listeners and pending search without stale DOM writes',async()=>{
  const h=pickerHarness(),source=fields(450);await h.picker.setFields(source);h.picker.setState({loading:false,selectable:true});
  h.search.value='Field449';h.search.dispatch('input');h.picker.destroy();
  const marker=h.box.ownerDocument.createElement('option');marker.value='new-controller';h.box.append(marker);
  await new Promise(resolve=>setTimeout(resolve,120));await settle();
  assert.deepEqual(h.parent.children,[h.box]);assert.deepEqual(h.box.options,[marker]);assert.equal(h.box.listeners.get('change').size,0);
  assert.equal(await h.picker.setFields(source),false);assert.deepEqual(h.box.options,[marker]);
});

test('invalid batch and page sizes are rejected before creating or clearing controls',async()=>{
  for(const batchSize of [0,-1,1.5,1001,Infinity])await assert.rejects(populateMetadataOptions(select(),fields(1),{batchSize}),TypeError);
  for(const pageSize of [0,-1,1.5,201,Infinity])assert.throws(()=>pickerHarness({pageSize}),TypeError);
});
