const CACHE_LIMIT=128;
const EMPTY=Object.freeze([]);
const DECIMAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const numbers=value=>typeof value==='string'?value.split('\\').map(part=>DECIMAL.test(part.trim())?Number(part):NaN):[];

/** Sidebar order uses the same stacks while retaining original source indices. */
export function orderSourceIndices(indices,stackOrder,currentIndex=-1){
  const included=new Set(indices),emitted=new Set(),ordered=[];
  const active=stackOrder.indices(currentIndex),activeIndices=new Set(active);
  for(const index of indices){
    if(emitted.has(index))continue;
    const stack=activeIndices.has(index)?active:stackOrder.indices(index);
    const group=stack.includes(index)?stack:[index];
    for(const candidate of group)if(included.has(candidate)&&!emitted.has(candidate)){
      emitted.add(candidate);ordered.push(candidate);
    }
  }
  return ordered;
}
function instanceNumber(value){
  if(typeof value==='string'){
    if(!/^[+-]?\d+$/.test(value.trim()))return null;
    value=Number(value);
  }
  return typeof value==='number'&&Number.isInteger(value)&&value>=-2147483648&&value<=2147483647?value:null;
}

/** Derive projection only from supplied decimal orientation components. */
function normalOf(entry){
  const orientation=numbers(entry?.fields?.ImageOrientationPatient);
  if(orientation.length!==6)return null;
  const normal=[orientation[1]*orientation[5]-orientation[2]*orientation[4],
    orientation[2]*orientation[3]-orientation[0]*orientation[5],
    orientation[0]*orientation[4]-orientation[1]*orientation[3]];
  return normal.every(Number.isFinite)&&normal.some(value=>Math.abs(value)>0.0001)?normal:null;
}

/**
 * Cache physical stack order independently of rendering and source identity.
 * Entries are never reordered or merged. Missing series IDs isolate originals;
 * present study/series values retain strict source-value equality. The current
 * image's orientation determines projection. Missing/invalid geometry falls
 * back to complete integer instance numbers, otherwise supplied source order.
 * Returned arrays are frozen and reused. At most 128 group/orientation orders
 * are retained. clear() also refreshes displayable membership on the next use.
 */
export function createStackOrder(entries,{canDisplay=()=>true}={}){
  if(!Array.isArray(entries)||typeof canDisplay!=='function')throw new TypeError('Source entries and a display eligibility function are required.');
  let membership=null;const cache=new Map();
  function indexMembership(){
    const studies=new Map();membership=new Array(entries.length);let groupId=0;
    for(const [index,entry] of entries.entries()){
      const series=entry?.fields?.SeriesInstanceUID,study=entry?.fields?.StudyInstanceUID;
      let group;
      if(!series)group={id:groupId++,indices:[]};
      else{
        let groups=studies.get(study);if(!groups){groups=new Map();studies.set(study,groups);}
        group=groups.get(series);if(!group){group={id:groupId++,indices:[]};groups.set(series,group);}
      }
      membership[index]=group;if(canDisplay(entry))group.indices.push(index);
    }
  }
  return {
    indices(currentIndex){
      if(!Number.isInteger(currentIndex)||currentIndex<0||currentIndex>=entries.length)return EMPTY;
      if(!membership)indexMembership();
      const group=membership[currentIndex],normal=normalOf(entries[currentIndex]);
      const key=group.id+':'+(normal?normal.join(','):'fallback');
      if(cache.has(key)){const result=cache.get(key);cache.delete(key);cache.set(key,result);return result;}
      const positions=new Map(),indices=[...group.indices];
      if(normal)for(const index of indices){
        const xyz=numbers(entries[index]?.fields?.ImagePositionPatient);
        positions.set(index,xyz.length===3&&xyz.every(Number.isFinite)?xyz.reduce((sum,value,axis)=>sum+value*normal[axis],0):NaN);
      }
      if(normal&&indices.every(index=>Number.isFinite(positions.get(index))))indices.sort((a,b)=>positions.get(a)-positions.get(b)||a-b);
      else {
        const instances=new Map(indices.map(index=>[index,instanceNumber(entries[index]?.fields?.InstanceNumber)]));
        if(indices.every(index=>instances.get(index)!==null))
          indices.sort((a,b)=>instances.get(a)-instances.get(b)||a-b);
      }
      const result=Object.freeze(indices);cache.set(key,result);
      while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);
      return result;
    },
    clear(){cache.clear();membership=null;}
  };
}
