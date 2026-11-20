const states=new Set(['PASS','FAIL','UNKNOWN','NOT_APPLICABLE']);
export function readStructureInventory(value,entries){
  if(value?.schemaVersion!==1||value.rulesVersion!=='1'||value.fullIodValidation!==false||typeof value.standardEdition!=='string'||!Array.isArray(value.images)||value.images.length!==entries.length)throw new Error('Unsupported structural inventory.');
  const sources=new Map(entries.map(entry=>[entry.attachment,entry])),seen=new Set();
  for(const record of value.images){
    const source=sources.get(record?.attachment);
    if(!source||seen.has(record.attachment)||record.sourcePath!==source.sourcePath||record.sha256!==source.sha256||!states.has(record.status)||!Array.isArray(record.issues)||record.issues.length>200000||!record.checks||typeof record.checks!=='object'||Array.isArray(record.checks))throw new Error('Structural inventory source mapping is invalid.');
    for(const check of Object.values(record.checks))if(!states.has(check?.status)||typeof check.scope!=='string')throw new Error('Structural check result is invalid.');
    for(const issue of record.issues)if(!issue||!['ERROR','WARNING'].includes(issue.severity)||typeof issue.code!=='string'||typeof issue.message!=='string'||typeof issue.path!=='string')throw new Error('Structural diagnostic is invalid.');
    for(const key of ['expectedPixelBytes','suppliedPixelBytes'])if(record[key]!=null&&(!Number.isSafeInteger(record[key])||record[key]<0))throw new Error('Structural byte count is invalid.');
    seen.add(record.attachment);
  }
  return value;
}
export function structureDetails(inventory,entry){
  const record=inventory?.images.find(image=>image.attachment===entry?.attachment);if(!record)return {};
  return {'Stored structural checks':record.status,
    'Structural check scope':`${inventory.standardEdition} · selected module rules and pixel structure; full IOD validity not established`,
    ...(record.checks.pixelStructure?{'Pixel structure check':`${record.checks.pixelStructure.status} · ${record.checks.pixelStructure.scope}`} : {}),
    ...(record.suppliedPixelBytes!=null?{'Encoded pixel bytes':String(record.suppliedPixelBytes)}:{}),
    ...(record.expectedPixelBytes!=null?{'Expected native pixel bytes':String(record.expectedPixelBytes)}:{}),
    ...(record.issues.length?{'Structural findings':record.issues.map(issue=>`${issue.severity} · ${issue.code} · ${issue.path}: ${issue.message}`).join('\n')}:{})};
}
