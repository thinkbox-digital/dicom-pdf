import { RenderingEngine, Enums, imageLoader, metaData, setUseCPURendering, cache } from '@cornerstonejs/core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDecoderClient } from './decoder-client.mjs';
import { createStudyNavigation } from './study-navigation.mjs';
import { createViewControls, thumbnailPixels, preserveViewportKeyboardInputs } from './view-controls.mjs';
import {fitImageToViewport} from './image-fit.mjs';
import {initializeGestures,bindCornerstoneGestures} from './cornerstone-gestures.mjs';
import { buildOriginalsZip } from './original-export.mjs';
import { cineTiming, createCinePlayer, bindCinePlayback } from './cine.mjs';
import { bindLocalInputs } from './local-inputs.mjs';
import { bundledPdfFonts } from './pdf-fonts.mjs';
import { createMetadataFieldPicker } from './metadata-options.mjs';
import { createCompareView } from './compare-view.mjs';
import { createDecodedImageCache } from './decoded-image-cache.mjs';
import { createStackOrder, orderSourceIndices } from './stack-order.mjs';
import { buildPaneInventory } from './pane-inventory.mjs';
import { readXmpInventory } from './xmp-metadata.mjs';
import { imageOverlayContext } from './image-overlays.mjs';
import { buildStackPosition, createStackScrubber } from './stack-position.mjs';
import { buildWindowPresets } from './window-presets.mjs';
import { createWindowRenderer } from './cpu-window-renderer.mjs';
import { drawViewingOverlays } from './viewing-copy.mjs';
import { fileActionIcon } from './file-icons.mjs';
import { attachmentKind, renderAttachmentPreview } from './attachment-preview.mjs';
import { metadataCsv } from './metadata-export.mjs';
import {createArchiveVerificationPanel} from './archive-verification-panel.mjs';
import {localPdfRange} from './pdf-blob-range.mjs';
import {openPdfAttachments,attachmentBytes} from './pdf-attachments.mjs';
import {workingMemoryBytes} from './working-memory.mjs';
import {readStructureInventory,structureDetails} from './source-structure.mjs';
import {buildCornerstoneStack,createCornerstoneStackViewport,createCornerstoneImageLoader} from './cornerstone-stack.mjs';
import {bindPaneResizing} from './pane-resize.mjs';
import {unavailableDisplay,unavailableArchiveDisplay,supportingSourceDisplay,sourceListPresentation,showGeometryWarning,isZeroPixelSpacing} from './display-status.mjs';
import {JPEG_LS,JPEG2000} from './image-transfer-syntax.mjs';
import {renderPresentation,renderSpectroscopy,renderRtDose,renderRtPlan} from './dicom-object-preview.mjs';
import {createLoadingDialog} from './loading-dialog.mjs';
import {PARAMETRIC_MAP_SOP} from './parametric-map.mjs';
import {RT_DOSE_SOP} from './rt-dose.mjs';
import {RT_PLAN_SOP} from './rt-plan.mjs';
import {SURFACE_SEGMENTATION_SOP} from './surface-segmentation.mjs';
import {renderSurfaceSegmentation} from './surface-segmentation-viewport.mjs';

const $ = id => document.getElementById(id);
for(const id of ['viewport','comparison-viewport'])if($(id))preserveViewportKeyboardInputs($(id));
function selectedSourceIndex(){
  const value=$('image-list').value;
  return /^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):-1;
}
const files = createDecodedImageCache({maxBytes:64*1024*1024,onEvict:id=>{if(cache.getImageLoadObject(id))cache.removeImageLoadObject(id);}});
const decoding=new Map();
let entries = [], attachments = null, pdf = null, pdfSource = null, viewport, initialWindow, activeImageId, generation = 0;
let attachmentsByName=new Map();
let selectedGeneration = 0, manifestVersion = 1, manifest = null, manifestBytes = null, selectedOriginal = null;
let viewedFrame = 1;
let nativeFallback = null, pdfMode = false, pageNumber = 1, pageRender = null, pageGeneration = 0;
let previewGeneration = 0, previewCleanup = null, previewVisible = false, previewAbort = null;
let previewSaveCopy=null;
let metadataCache = new Map(), metadataSidecarPromise = null, exportGeneration = 0, exportRecords = [];
let metadataFieldPicker=null;
let comparison=null;
let paneInventory=null;
const sourceOptions=new Map();
let sourceListStack=null;
let xmpInventory=null,xmpFile=null,xmpError=null,xmpPromise=null;
let overlayDisplay=null,overlaysEnabled=true,overlayRequest=null;
let activeWindowRenderer=null,windowPresetModel=null,lastImageSelection=null;
let stackOrder=null,displayLoading=false,pendingSelection=null,prefetchAbort=null,detailsTimer=null,detailEntry=null;
let displayTail=Promise.resolve();
let inputInventory = null, directoryInventory = null, inventoryProblems = [];
let structureInventory=null;
let navigation = null, initialInvert = false, selectionAbort = null, zipAbort = null;
let attachmentChecks = new WeakMap(), originalStates = new Map();
let currentTiming = cineTiming(), cineOverride = null, lastCineStatus = 0;
const decoder = createDecoderClient();
const previewDecoder=navigator.hardwareConcurrency>=4&&workingMemoryBytes()>=128*1024*1024
  ?createDecoderClient({sourceCacheBytes:16*1024*1024}):decoder;
const loading=createLoadingDialog($('loading-dialog'));
let inputRequest=0,loadingArchiveGeneration=0;
const archiveVerification=createArchiveVerificationPanel({getArchive:()=>({manifest,manifestBytes,attachments,pdf,blob:pdfSource,busy:loadingArchiveGeneration===generation||displayLoading||$('viewport').dataset.playing==='true'}),
  getDigest:(_file,bytes)=>attachmentChecks.get(bytes),
  rememberDigest:(_file,bytes,digest)=>{if(!attachmentChecks.has(bytes))attachmentChecks.set(bytes,Promise.resolve(digest));},
  onComplete:result=>{
  for(const file of result.files)if(file.kind==='original')originalStates.set(file.attachment,{...originalStates.get(file.attachment),integrity:file.status==='PASS'?'matched':file.code==='ATTACHMENT_MISSING'?'missing':'mismatch'});
  updateInventorySummary();details(entries[selectedSourceIndex()]||null);
}});
export function beginInputRequest(){loading.reset();archiveVerification.reset();return ++inputRequest;}
export function isInputRequestCurrent(token){return token===inputRequest;}
let workerSource, pdfWorkerType='module';
if (typeof PDF_WORKER_URL === 'string') {
  // A supplied Worker prevents PDF.js from wrapping chrome-extension URLs in a Blob,
  // which would conflict with the extension's local-only worker policy.
  workerSource = new URL(PDF_WORKER_URL, document.baseURI).href;
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerSource, {type:'module'});
} else {
  workerSource = URL.createObjectURL(new Blob([PDF_WORKER_SOURCE], {type:'text/javascript'}));
  pdfWorkerType='classic';
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerSource, {type:pdfWorkerType});
}
pdfjs.GlobalWorkerOptions.workerSrc = workerSource;
function createPdfWorker() {
  const port = new Worker(workerSource, {type:pdfWorkerType});
  return {worker:new pdfjs.PDFWorker({port}),port};
}
setUseCPURendering(true);
initializeGestures();
cache.setMaxCacheSize(128*1024*1024);
const engine = new RenderingEngine('dicom-offline');
engine.enableElement({viewportId: 'dicom', type: Enums.ViewportType.STACK, element: $('viewport'), defaultOptions: {background: [0,0,0]}});
viewport = engine.getViewport('dicom');
const decodedFile=id=>files.peek(id)||comparison?.getDecoded(id)||(overlayDisplay?.id===id?overlayDisplay.decoded:null);
const cornerstoneStack=createCornerstoneStackViewport({viewport,element:$('viewport'),events:Enums.Events,onNavigate:target=>{
  if(pdfMode||previewVisible||target.generation!==generation)return;
  const retainedDisplay=captureDisplay();
  $('image-list').value=String(target.index);
  void openSelected(target.frame,{scrolling:true,retainedDisplay});
}});
imageLoader.registerImageLoader('dicom',createCornerstoneImageLoader({getPinned:id=>comparison?.getDecoded(id),getStack:()=>cornerstoneStack,getGeneration:()=>generation,
  decode:target=>decodedFrame(target.entry,target.index,target.frame,{documentGeneration:target.generation})}));
metaData.addProvider((type, id) => decodedFile(id)?.metadata[type], 10000);
$('viewport').dataset.loadedAttachment = '';
const controls = [...document.querySelectorAll('#controls input, #controls button')];
let imageControlsEnabled=false;
if($('comparison-pane'))comparison=createCompareView({engine,
  gestureFactory:bindCornerstoneGestures,
  releaseImage:id=>{if(cache.getImageLoadObject(id))cache.removeImageLoadObject(id);},
  onChange:({isOpen})=>{
    $('compare-current')?.setAttribute('aria-pressed',String(isOpen));
    if($('compare-current'))$('compare-current').textContent=isOpen?'Replace pinned image':'Compare';
  }});
function refreshSaveCopy(){
  if($('save-view'))$('save-view').disabled=previewVisible?!previewSaveCopy:pdfMode||!imageControlsEnabled||!activeImageId;
}
function enableControls(enabled) { imageControlsEnabled=enabled;controls.forEach(x => x.disabled = !enabled);refreshSaveCopy(); }
function status(text) { $('status').textContent = text; }
export function setExtensionMessage(text) {
  if (text) status(text);
}
function clearDisplay() {
  enableControls(false);
  initialWindow = null; activeImageId = null; selectedOriginal = null;
  overlayDisplay=null;refreshImageOverlays();
  activeWindowRenderer?.renderer.destroy();activeWindowRenderer=null;windowPresetModel=null;
  if($('window-preset-control'))$('window-preset-control').hidden=true;
  if($('stack-position-control'))$('stack-position-control').hidden=true;
  viewControls.cancelGesture();
  displayLoading=false;pendingSelection=null;
  if ($('cine-controls')) $('cine-controls').hidden=true;
  for (const key of ['loadedAttachment', 'sourceFrame', 'windowCenter', 'windowWidth']) $('viewport').dataset[key] = '';
  if ($('download-original')) $('download-original').disabled = true;
  if ($('export-csv')) $('export-csv').disabled = !entries.length;
}
function emptyState(title, description, technical=null) {
  const empty = $('viewport').querySelector('.empty-state');
  if (!empty) return;
  empty.querySelector('h2').textContent = title;
  empty.querySelector('p').textContent = description;
  empty.querySelector('.unsupported-details')?.remove();
  if(technical){
    const details=document.createElement('details'),summary=document.createElement('summary'),message=document.createElement('p');
    details.className='unsupported-details';summary.textContent='Technical details';message.textContent=technical;
    details.append(summary,message);empty.append(details);
  }
}
function fail(e) { status(e.message || 'This file could not be displayed.'); enableControls(false); emptyState('Image unavailable',e.message || 'Save the unchanged original for another viewer.'); }
function windowControls() {
  if (!initialWindow || !activeWindowRenderer) return;
  const minimum=initialWindow.function==='LINEAR'?1:Number.MIN_VALUE;
  const width = Math.max(minimum, initialWindow.width / (Number($('contrast').value) / 100));
  const center = initialWindow.center - Number($('brightness').value) / 100 * initialWindow.width;
  activeWindowRenderer.renderer.setWindow({center,width,function:initialWindow.function},viewport);
  viewport.render();
  refreshImageOverlays();
}
function refreshWindowPresets(){
  const select=$('window-preset'),control=$('window-preset-control');
  if(!select||!control)return;
  select.replaceChildren();
  if(!windowPresetModel){control.hidden=true;return;}
  for(const item of windowPresetModel.options){
    const option=document.createElement('option');option.value=item.value;option.textContent=item.label;select.append(option);
  }
  select.value=windowPresetModel.selected;control.hidden=windowPresetModel.hidden;
  $('viewport').dataset.windowPreset=windowPresetModel.selected;
  $('viewport').dataset.windowFunction=windowPresetModel.window.function;
}
function resetWindow(){
  if(overlayDisplay){
    windowPresetModel=buildWindowPresets(overlayDisplay.decoded);initialWindow=windowPresetModel.window;refreshWindowPresets();
  }
  $('brightness').value=0;$('contrast').value=100;windowControls();
}
function currentStackPosition(){
  const index=selectedSourceIndex(),entry=entries[index],pending=pendingSelection?.index===index?pendingSelection:null;
  const displayed=overlayDisplay?.index===index?overlayDisplay:null;
  return buildStackPosition({entries,canDisplay,stackOrder,index,frame:pending?.frame??displayed?.frame??entry?.sourceFrame??1,
    ...(displayed?{frameCount:displayed.decoded.frameCount}:{} )});
}
const stackScrubber=createStackScrubber({getPosition:currentStackPosition,
  onSelect:async(target,{signal,isCurrent})=>{
    if(!isCurrent())return false;
    $('image-list').value=String(target.index);
    return openSelected(target.frame,{scrolling:true,scrubbing:true,signal});
  },onError:()=>status('This image position could not be opened.')});
function refreshStackPosition(){
  const range=$('stack-position'),control=$('stack-position-control');if(!range||!control)return;
  const position=currentStackPosition(),pending=stackScrubber.pendingPosition;
  control.hidden=position.hidden||!activeImageId&&!pendingSelection;
  range.min=String(position.min);range.max=String(Math.max(position.min,position.max));
  range.value=String(pending?.value??(position.value||position.min));
  const label=pending?.label??position.label;
  if($('stack-position-label'))$('stack-position-label').textContent=label.replace(/^(Image|Frame) /,'');
  if($('stack-position-kind'))$('stack-position-kind').textContent=position.kind==='frame'?'Frame':'Image';
  range.setAttribute('aria-label',position.kind==='frame'?'Frame position':'Image position');range.setAttribute('aria-valuetext',label);
  range.disabled=control.hidden;
}
function overlayPixelPoints(){
  try{
    const image=viewport.getImageData()?.imageData;
    if(typeof image?.indexToWorld!=='function')return null;
    return [[0,0,0],[1,0,0],[0,1,0]].map(point=>Array.from(image.indexToWorld(point)));
  }catch{return null;}
}
function overlayZoom(points){
  if(!points)return null;
  try{
    const [origin,x,y]=points.map(point=>viewport.worldToCanvas(point));
    const distance=point=>Math.hypot(point[0]-origin[0],point[1]-origin[1]);
    return {x:distance(x),y:distance(y)};
  }catch{return null;}
}
function refreshImageOverlays(){
  const container=$('image-overlays');
  if(!container)return;
  const display=overlayDisplay;
  const current=display&&activeImageId===display.id&&$('viewport').dataset.loadedAttachment===display.entry.attachment;
  showGeometryWarning($('image-geometry-warning'),current&&!pdfMode&&!previewVisible?display.decoded:null);
  container.hidden=!overlaysEnabled||!current||pdfMode||previewVisible;
  if(container.hidden)return;
  const order=stackIndices(display.index),position=order.indexOf(display.index),range=viewport.getProperties().voiRange;
  const window=activeWindowRenderer?.image===display.decoded.image?activeWindowRenderer.renderer.getWindow()
    :range?{center:(range.lower+range.upper+1)/2,width:Math.abs(range.upper-range.lower)+1}:null;
  const context=imageOverlayContext({entry:display.entry,decoded:display.decoded,frame:display.frame,
    index:position,count:order.length,window,zoom:overlayZoom(display.points),rotation:viewport.getRotation()});
  for(const [key,id] of [['topLeft','overlay-top-left'],['bottomLeft','overlay-bottom-left'],['bottomRight','overlay-bottom-right']]){
    const node=$(id),text=(context.lines[key]||[]).join('\n');
    if(node&&node.textContent!==text)node.textContent=text;
  }
  for(const side of ['top','right','bottom','left']){
    const node=$(`orientation-${side}`),text=context.markers[side]||'';
    if(node&&node.textContent!==text)node.textContent=text;
  }
}
function scheduleImageOverlays(){
  if(overlayRequest!==null)return;
  overlayRequest=requestAnimationFrame(()=>{overlayRequest=null;refreshImageOverlays();});
}
for(const event of [Enums.Events.CAMERA_MODIFIED,Enums.Events.VOI_MODIFIED,Enums.Events.IMAGE_RENDERED]){
  $('viewport').addEventListener(event,scheduleImageOverlays);
}
const mainGestures=bindCornerstoneGestures({element:$('viewport'),viewport,engine,
  ready:()=>!!activeImageId&&!!initialWindow&&!displayLoading,
  scrollReady:event=>canUseNativeStackScroll()&&!pdfMode&&!previewVisible&&!event.ctrlKey});
const viewControls = createViewControls({viewport,element:$('viewport'),onCancelGesture:()=>mainGestures.cancel(),
  fitCamera:()=>fitImageToViewport(viewport,decodedFile(activeImageId)?.image),
  ready:()=>!!activeImageId && !!initialWindow && !displayLoading,sourceInvert:()=>initialInvert,
  onStep:direction=>stepStack(direction),
  onReset:resetWindow,
  onChange:({rotation,inverted})=>{
    $('viewport').dataset.rotation=String(rotation);$('viewport').dataset.inverted=String(inverted);
    $('invert')?.setAttribute('aria-pressed',String(inverted));
  }});
const cine = createCinePlayer({getFrame:()=>viewedFrame,getCount:()=>Number($('viewport').dataset.frameCount||1),getTiming:()=>currentTiming,
  renderFrame:(frame,{signal})=>openSelected(frame,{playback:true,signal}),
  onState:state=>{
    $('viewport').dataset.playing=String(state.playing);
    if($('cine-play')){$('cine-play').textContent=state.playing?'Pause':'Play';$('cine-play').setAttribute('aria-pressed',String(state.playing));}
    if($('cine-status')&&(!state.playing||performance.now()-lastCineStatus>1000)){
      lastCineStatus=performance.now();$('cine-status').textContent=`${currentTiming.label}${currentTiming.capped?' (limited to 60 fps)':''}${state.playing&&state.actualFps?` · playing ${state.actualFps.toFixed(1)} fps`:''}`;
    }
  }});
function attachment(name) {
  return attachmentsByName.get(name) || (attachments&&Object.hasOwn(attachments,name)?attachments[name]:null);
}
function setAttachments(files) {
  attachments=files;attachmentsByName=new Map();
  for(const file of Object.values(files||{}))if(!attachmentsByName.has(file.filename))attachmentsByName.set(file.filename,file);
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x=>x.toString(16).padStart(2,'0')).join('');
}
function readJson(bytes,label){
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new Error(`${label} cannot be read as UTF-8 JSON.`);}
}
function selectedOriginalValues(entry) {
  const input = inputInventory?.images.find(image=>image.attachment === entry?.attachment);
  const state = originalStates.get(entry?.attachment);
  return entry ? {
    'Source file': entry.sourcePath || entry.attachment, 'Attachment': entry.attachment,
    'PDF preview status': entry.status === 'rendered' ? 'Available' : 'Unavailable',
    ...(entry.reason ? {'PDF preview details': entry.reason} : {}),
    'PDF reference page': entry.referencePage, 'Source frame': entry.sourceFrame ?? (manifestVersion === 1 && entry.status === 'rendered' ? '1 (legacy)' : 'None'),
    'SHA-256': entry.sha256, 'Original bytes': entry.size,
    ...(entry.parsing ? {'Parsing mode':entry.parsing.mode,'Parsing transfer syntax':entry.parsing.transferSyntaxUID,
      'Transfer syntax source':entry.parsing.transferSyntaxSource} : {}),
    ...(entry.kind?{'Input kind':entry.kind}:{}),
    ...(entry.archiveStatus?{'Archive expansion status':entry.archiveStatus}:{}),
    ...(entry.diagnostics?.length?{'Input diagnostics':entry.diagnostics.map(diagnostic=>diagnostic.code).join(', ')}:{}),
    'Original integrity': state?.integrity === 'matched' ? 'Matches recorded checksum' : state?.integrity === 'mismatch' ? 'Does not match recorded checksum' : state?.integrity === 'missing' ? 'Original attachment missing' : 'Not checked',
    'Interactive display': state?.display === 'displayed' ? 'Opened successfully' : state?.display === 'unsupported' ? 'Not supported; original available' : state?.display === 'failed' ? 'Could not open; see status' : 'Not checked',
    ...(state?.geometryWarning?{'Display geometry':state.geometryWarning}:{}),
    ...(state?.windowNotes?.length?{'Source window notes':state.windowNotes.join('\n')}:{}),
    ...entry.navigationFields,...entry.fields,
    ...Object.fromEntries(Object.entries(entry.displayAdjustments || {}).map(([key,value])=>[`Display: ${key}`,value])),
    ...(input ? {'DICOM input checks':input.status,'DICOM check scope':`${inputInventory.standardEdition} documented subset; full IOD validation not established`,
      ...(input.issues.length ? {'DICOM findings':input.issues.map(issue=>`${issue.severity} · ${issue.code}: ${issue.message}`).join('\n')} : {})} : {}),
    ...structureDetails(structureInventory,entry),
  } : {};
}
function sourceWindowNotes(codes=[]){
  const messages={MALFORMED_FRAME_VOI_MACRO:'Frame window metadata is malformed; alternate presets are unavailable.',
    WINDOW_VALUES_MISSING:'Frame window metadata supplies no complete window values.',
    WINDOW_VM_MISMATCH:'Source window centers and widths do not pair consistently; alternate presets are unavailable.',
    INVALID_WINDOW_VALUES:'Some supplied window values could not be read.',INVALID_WINDOW_PAIR:'Some supplied window pairs are invalid and were not offered.',
    WINDOW_PRESET_LIMIT:'The number of supplied window presets exceeds the viewer limit.',
    WINDOW_LABEL_VM_MISMATCH:'Source labels do not match the window values; choices use their source order.',
    UNREADABLE_WINDOW_LABELS:'Some source window labels could not be decoded; choices use their source order.',
    UNSUPPORTED_VOI_FUNCTION:'The source window function is unsupported.',INVALID_VOI_FUNCTION:'The source window function is invalid.'};
  return [...new Set(codes.map(code=>messages[code]||'Some supplied window metadata could not be used.'))];
}
function details(entry,{force=false}={}) {
  detailEntry=entry;clearTimeout(detailsTimer);
  const sourceTab=$('show-image');
  const tabLabel=sourceViewKind(selectedSourceIndex())==='surface-segmentation'?'3D surface':'DICOM image';
  if(sourceTab&&sourceTab.textContent!==tabLabel)sourceTab.textContent=tabLabel;
  if($('show-metadata'))$('show-metadata').disabled=!entry;
  if ($('selected-source')) {
    const name=entry ? entry.sourcePath || entry.attachment : 'No source selected';
    $('selected-source').textContent=name;
    $('selected-source').title=entry?name:'';
  }
  const fields = $('metadata-fields');
  if (!fields) return;
  const section=$('metadata-section');
  if(entry&&section&&!section.open&&!force){
    detailsTimer=setTimeout(()=>{if(detailEntry===entry)details(entry,{force:true});},150);
    return;
  }
  fields.replaceChildren();
  const values = selectedOriginalValues(entry);
  for (const [key,value] of Object.entries(values)) {
    const term = document.createElement('dt'), description = document.createElement('dd');
    term.textContent = key; description.textContent = value == null ? 'Not supplied' : String(value);
    fields.append(term, description);
  }
}
async function checkedAttachment(file, source, action) {
  if (!file) throw new Error('The original attachment is missing from this package.');
  const documentGeneration=generation;
  // Reuse the original held for download during frame navigation and prefetch.
  const bytes = selectedOriginal?.file === file && selectedOriginal.entry === source
    ? selectedOriginal.bytes : await attachmentBytes(file);
  if(documentGeneration!==generation)throw new DOMException('Document changed.','AbortError');
  const expected = source?.sha256 || manifest?.artifactSha256?.[file.filename];
  let check = attachmentChecks.get(bytes);
  if (!check&&expected) { check = sha256(bytes); attachmentChecks.set(bytes,check); }
  const matches=!expected||await check===expected.toLowerCase();
  if(documentGeneration!==generation)throw new DOMException('Document changed.','AbortError');
  if (source?.size != null && bytes.byteLength !== source.size || !matches) {
    if (source) originalStates.set(source.attachment,{...originalStates.get(source.attachment),integrity:'mismatch'});
    throw new Error(`SHA-256 mismatch or original size differs; ${action} refused.`);
  }
  if (source) originalStates.set(source.attachment,{...originalStates.get(source.attachment),integrity:expected ? 'matched' : 'unchecked'});
  if (file.filename === 'manifest.sha256' && manifestBytes) {
    const expectedSidecar = `${await sha256(manifestBytes)}  manifest.json\n`;
    if (new TextDecoder('ascii').decode(bytes) !== expectedSidecar) throw new Error(`Manifest checksum sidecar differs; ${action} refused.`);
  }
  return {bytes,verified:!!expected || file.filename === 'manifest.sha256'};
}
function closeAttachmentPreview() {
  ++previewGeneration;
  previewAbort?.abort();previewAbort=null;
  if (previewCleanup) { Promise.resolve(previewCleanup()).catch(()=>{}); previewCleanup = null; }
  previewVisible = false;
  previewSaveCopy=null;refreshSaveCopy();
  if ($('attachment-content')) $('attachment-content').replaceChildren();
  if ($('attachment-view')) {
    $('attachment-view').hidden = true;
    $('attachment-view').setAttribute('aria-labelledby','show-attachment');
  }
  $('show-image')?.setAttribute('aria-controls','image-view');
  if ($('close-attachment')) $('close-attachment').hidden = false;
  if ($('show-attachment')) { $('show-attachment').hidden = true; $('show-attachment').setAttribute('aria-selected','false'); }
}
const SPECIALIZED_PREVIEWS=new Set(['presentation-state','spectroscopy','rt-dose','rt-plan','surface-segmentation']);
const FILE_PREVIEWS=new Set(['image','pdf','dicom-document',...SPECIALIZED_PREVIEWS]);
function referencedImages(presentation){
  const targets=[];
  for(const ref of presentation.refs){
    const matches=entries.filter(entry=>(entry.sopInstanceUID||entry.fields?.SOPInstanceUID)===ref.instance
      &&entry.fields?.SOPClassUID===ref.sopClass&&canDisplay(entry)&&attachment(entry.attachment));
    if(!matches.length||matches.some(entry=>entry.sha256!==matches[0].sha256))continue;
    const entry=matches[0],count=Number(entry.fields?.NumberOfFrames||1);
    if(!Number.isSafeInteger(count)||count<1||count>10000)continue;
    const frames=ref.frames?[...new Set(ref.frames.filter(frame=>frame<=count))]:Array.from({length:count},(_,i)=>i+1);
    if(frames.length)targets.push({entry,ref,frames,name:entry.sourcePath||entry.attachment});
  }
  return targets;
}

async function previewAttachment(file, source, kind, signal) {
  const documentGeneration = generation, selection = ++previewGeneration;
  const result = await checkedAttachment(file,source,'preview');
  if (documentGeneration !== generation || selection !== previewGeneration || signal?.aborted) return;
  if (kind === 'dicom') {
    $('image-list').value = String(entries.indexOf(source));
    await showMode('image',{reopenContent:false});
    await openSelected();
    return;
  }
  cine.stop();
  let previewBytes=result.bytes,previewName=source?.sourcePath||file.filename;
  let specialized=null,targets=null;
  if(kind==='dicom-document'||SPECIALIZED_PREVIEWS.has(kind)){
    previewAbort?.abort();previewAbort=new AbortController();
    const report=await decoder.readDocument(result.bytes,{key:source.sha256,signal:signal||previewAbort.signal,sourceParsing:source.parsing});
    if(documentGeneration!==generation||selection!==previewGeneration||signal?.aborted)return;
    if(report.kind==='unsupported')throw Object.assign(new Error(report.detail||'This DICOM object could not be displayed.'),{code:report.code});
    if(source.sopInstanceUID&&report.sopInstanceUID!==source.sopInstanceUID)throw new Error('The DICOM instance identifier differs from the recorded source.');
    const fields={...source.navigationFields,...source.fields},recordedClass=fields.SOPClassUID||fields.MediaStorageSOPClassUID;
    if(recordedClass&&report.sopClassUID!==recordedClass)throw new Error('The DICOM object type differs from the recorded source.');
    if(SPECIALIZED_PREVIEWS.has(kind)){
      if(report.kind!==kind)throw new Error('The DICOM object differs from the recorded source type.');
      specialized=report.content;
      if(kind==='presentation-state'){
        targets=referencedImages(specialized);
        if(!targets.length)throw new Error('None of the presentation state’s referenced images are available to display.');
      }
    }else{
      kind=report.kind==='pdf'?'pdf':'text';
      previewBytes=report.kind==='pdf'?report.bytes:new TextEncoder().encode(report.text);
      previewName=report.kind==='pdf'?'Encapsulated PDF report':'DICOM structured report';
    }
  }
  if (!$('attachment-view')) return;
  closeAttachmentPreview();
  const request = previewGeneration;
  const isCurrent = () => request === previewGeneration && documentGeneration === generation && !signal?.aborted;
  previewVisible = true;
  refreshSaveCopy();
  ++pageGeneration;
  pageRender?.cancel();
  $('image-view').hidden = true; $('pdf-view').hidden = true; $('attachment-view').hidden = false;
  if(kind==='surface-segmentation'){
    $('show-image').setAttribute('aria-controls','attachment-view');
    $('show-image').setAttribute('aria-selected','true');
    $('show-pdf').setAttribute('aria-selected','false');
    $('attachment-view').setAttribute('aria-labelledby','show-image');
    $('close-attachment').hidden=true;
    $('attachment-title').textContent=previewName;
    try{
      previewCleanup=renderSurfaceSegmentation($('attachment-content'),specialized);
    }catch(error){
      await showMode('image',{reopenContent:false});
      throw Object.assign(error,{code:'SURFACE_RENDER_UNAVAILABLE'});
    }
    status('Surface segmentation'+(result.verified?' · original SHA-256 verified.':'.'));
    return true;
  }
  $('show-image').setAttribute('aria-selected','false'); $('show-pdf').setAttribute('aria-selected','false');
  $('show-attachment').hidden = false; $('show-attachment').setAttribute('aria-selected','true');
  $('attachment-title').textContent = `${file.filename}${source ? ` · ${source.sourcePath}` : ''}`;
  if(kind==='rt-dose'){
    const preview=renderRtDose($('attachment-content'),specialized,engine);
    previewCleanup=preview.cleanup;
    const shown=await preview.ready;
    if(isCurrent()&&shown)status('RT Dose'+(result.verified?' · original SHA-256 verified.':'.'));
    return shown;
  }
  if(kind==='rt-plan'){
    previewCleanup=renderRtPlan($('attachment-content'),specialized);
    status('RT Plan'+(result.verified?' · original SHA-256 verified.':'.'));
    return true;
  }
  if(kind==='spectroscopy'){
    previewCleanup=renderSpectroscopy($('attachment-content'),specialized);
    status('MR spectroscopy · original SHA-256 verified.');
    return true;
  }
  if(kind==='presentation-state'){
    const preview=renderPresentation($('attachment-content'),specialized,targets,{isCurrent,decode:async({entry,ref},frame,signal)=>{
      const {bytes}=await checkedAttachment(attachment(entry.attachment),entry,'display');
      const decoded=await decoder.decode(bytes,'presentation:'+ref.instance,null,frame,{key:entry.sha256,sourceParsing:entry.parsing,signal});
      if(decoded.sopInstanceUID!==ref.instance||decoded.sopClassUID!==ref.sopClass)
        throw new Error('The referenced image identifier or type differs from the original.');
      return decoded;
    }});
    previewCleanup=preview.cleanup;
    const shown=await preview.ready;
    if(isCurrent()&&shown)status('Saved grayscale presentation · original SHA-256 verified.');
    return !!shown;
  }
  const cleanup = await renderAttachmentPreview({bytes:previewBytes,name:previewName,kind,
    container:$('attachment-content'),createPdfWorker,isCurrent,onStatus:message=>{if(isCurrent())status(message);},
    onSaveCopyChange:action=>{if(isCurrent()){previewSaveCopy=action;refreshSaveCopy();}}});
  if (!isCurrent()) { await cleanup?.(); return; }
  previewCleanup = cleanup;
  status(`Viewing ${file.filename}${result.verified ? ' · SHA-256 verified' : ''}${kind === 'text' ? ' · text source' : ''}.`);
}
function isDataIndex(index){return paneInventory?.byIndex.get(index)?.pane==='data';}
function sourceViewKind(index){return paneInventory?.byIndex.get(index)?.viewKind;}
function packageFiles() {
  if(!$('package-files'))return;
  const inventory=paneInventory||buildPaneInventory(entries,attachments);
  const others=inventory.otherSuppliedIndices.map(index=>attachment(entries[index].attachment)).filter(Boolean);
  const metadataFiles=[...inventory.generatedFiles,...(xmpFile?[xmpFile]:[])];
  if($('file-count'))$('file-count').textContent=String(metadataFiles.length);
  if($('other-file-count'))$('other-file-count').textContent=String(others.length);
  renderPackageFiles($('package-files'),metadataFiles);
  if($('other-supplied-files'))renderPackageFiles($('other-supplied-files'),others);
}
function renderPackageFiles(list,items){
  list.replaceChildren();
  if(!items.length){const empty=document.createElement('p');empty.className='file-empty';empty.textContent='No files in this group.';list.append(empty);return;}
  for (const file of items) {
    const name = file.filename;
    const row = document.createElement('div'); row.className = 'package-file'; row.dataset.attachment = name;
    const title = document.createElement('span'); title.className = 'file-name';
    const facts = document.createElement('span'); facts.className = 'file-facts';
    const sourceIndex = entries.findIndex(e=>e.attachment === name);
    const source = entries[sourceIndex];
    const kind = source?sourceViewKind(sourceIndex):attachmentKind(name,file.contentType);
    const reason=source&&!kind?supportingSourceDisplay(source)?.description:null;
    title.textContent=file.derivedLabel||source?.sourcePath?.split('/').pop()||name;
    const size=file.content?.byteLength??file.byteLength??source?.size;
    facts.textContent = `${size==null?'Size available after reading':size.toLocaleString()+' bytes'}${file.derivedLabel?' · PDF document metadata':''}${source ? ` · ${source.sourcePath}${reason?` · ${reason}`:''}` : ''}`;
    const actions = document.createElement('div'); actions.className = 'file-actions';
    if (kind) {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'file-view';
      view.dataset.viewAttachment = name; view.title = `View ${name}`; view.setAttribute('aria-label',view.title);
      view.append(fileActionIcon('view'));
      view.addEventListener('click',async()=>{
        view.disabled = true;
        try { await previewAttachment(file,source,kind); }
        catch (error) { if(error.name!=='AbortError')status(error.message); }
        finally { view.disabled = false; }
      });
      actions.append(view);
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'file-download';
    button.dataset.downloadAttachment = name; button.title = `Download ${name}`; button.setAttribute('aria-label',button.title);
    button.append(fileActionIcon('download'));
    button.addEventListener('click',async()=>{
      button.disabled = true;
      try {
        const {bytes,verified} = await checkedAttachment(file,source,'download');
        download(bytes,(source?.sourcePath||name).split(/[\\/]/).pop() || 'attachment','application/octet-stream');
        status(`Saved ${name} unchanged${verified ? ' · SHA-256 verified' : ''}.`);
      } catch (error) { status(error.message); }
      finally { button.disabled = false; }
    });
    actions.append(button); row.append(title,facts,actions); list.append(row);
  }
}
function updateInventorySummary() {
  const displayed = entries.filter(e=>e.status === 'rendered').length;
  const images = entries.filter((_entry,index)=>['dicom-image','image'].includes(paneInventory?.byIndex.get(index)?.kind));
  const opened = images.filter(e=>originalStates.get(e.attachment)?.display === 'displayed').length;
  const unavailable = images.filter(e=>['failed','unsupported'].includes(originalStates.get(e.attachment)?.display)).length;
  const matched = entries.filter(e=>originalStates.get(e.attachment)?.integrity === 'matched').length;
  if ($('image-count')) $('image-count').textContent = String(paneInventory?.dataIndices.length||0);
  if ($('inventory-summary')) $('inventory-summary').textContent = manifest
    ? [`${entries.length} supplied files\n${entries.filter(e=>!!attachment(e.attachment)).length} embedded originals\n${displayed} PDF previews`,
      `Interactive images:\n${opened} opened\n${unavailable} unavailable\n${images.length-opened-unavailable} not checked`,
      `${matched} originals match recorded checksums.\n${paneInventory?.otherSuppliedIndices.length||0} other supplied files.`].join('\n\n')
    : 'No DICOM manifest.';
}
function packageDetails() {
  packageFiles();
  updateInventorySummary();
  const list = $('references-list');
  if (!list) return;
  list.replaceChildren();
  const groups = new Map();
  const references = [...(manifest?.references || []),...(directoryInventory?.references || []).map(ref=>({...ref,
    sopInstanceUID:ref.referencedSopInstanceUID,sopClassUID:ref.referencedSopClassUID,frames:[]}))];
  for (const ref of references) {
    const key = JSON.stringify([ref.status,ref.sopInstanceUID,ref.sopClassUID,ref.fileID]);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(ref);
  }
  const labels = {missing:'Referenced object not included',resolved:'Referenced object included',ambiguous:'More than one supplied file has this instance ID',
    'invalid-frame':'Referenced frame outside the supplied image', 'class-mismatch':'Referenced class differs from the supplied object',unassessed:'Reference scan incomplete',
    'invalid-file-id':'Invalid DICOM File ID','unsafe-file-id':'Unsafe DICOM File ID','instance-mismatch':'DICOMDIR instance ID differs from supplied file',
    'identity-mismatch':'DICOMDIR instance ID differs from supplied file',
    'transfer-syntax-mismatch':'DICOMDIR encoding differs from supplied file','unreadable-target':'Referenced file cannot be read',
    'duplicate-reference':'DICOMDIR references the same file more than once','invalid-reference':'DICOMDIR reference lacks required identity fields'};
  const classes = {'1.2.840.10008.5.1.4.1.1.2':'CT image','1.2.840.10008.3.1.2.3.1':'Study-management record (retired)','1.3.12.2.1107.5.9.1':'Siemens non-image object'};
  const sourceName = name => entries.find(entry=>entry.attachment === name)?.sourcePath || name;
  for (const refs of groups.values()) {
    const ref = refs[0], item = document.createElement('li'); item.dataset.referenceStatus = ref.status;
    const heading = document.createElement('strong'); heading.textContent = labels[ref.status] || ref.status;
    const target = document.createElement('p'); target.className = 'reference-target';
    target.textContent = `${classes[ref.sopClassUID] ? `${classes[ref.sopClassUID]} · ` : ''}${ref.sopInstanceUID || 'No target instance ID recorded'}${ref.fileID ? ` · File ID: ${ref.fileID}` : ''}`;
    const sources = new Map();
    for (const occurrence of refs) {
      if (!sources.has(occurrence.sourceAttachment)) sources.set(occurrence.sourceAttachment,[]);
      sources.get(occurrence.sourceAttachment).push(occurrence);
    }
    const occurrences = document.createElement('p'); occurrences.textContent = `${sources.size} referring file${sources.size === 1 ? '' : 's'} · ${refs.length} reference${refs.length === 1 ? '' : 's'}`;
    const disclosure = document.createElement('details'), summary = document.createElement('summary'), sourceList = document.createElement('ul');
    summary.textContent = 'Referring files and metadata paths';
    for (const [name,items] of sources) {
      const sourceItem = document.createElement('li');
      sourceItem.textContent = `${sourceName(name)} (${attachment(name) ? 'embedded' : 'source attachment unavailable'})`;
      const paths = document.createElement('ul');
      for (const occurrence of items) {
        const path = document.createElement('li');
        path.textContent = `${occurrence.sequencePath || 'DICOM reference'}${occurrence.frames?.length ? ` · frame ${occurrence.frames.join(', ')}` : ''}`;
        if (occurrence.reason) path.textContent += ` · ${occurrence.reason}`;
        paths.append(path);
      }
      sourceItem.append(paths); sourceList.append(sourceItem);
    }
    disclosure.append(summary,sourceList); item.append(heading,target,occurrences,disclosure); list.append(item);
  }
  for (const [uid,candidates] of Object.entries(manifest?.duplicateInstanceUIDs || {})) {
    const item = document.createElement('li'); item.textContent = `Duplicate instance UID ${uid}: ${candidates.join(', ')}`; list.append(item);
  }
  for (const directory of directoryInventory?.directories || []) if (directory.status !== 'checked') {
    const item = document.createElement('li'); item.dataset.referenceStatus = 'directory-issues';
    item.textContent = `DICOMDIR ${directory.sourcePath}: ${(directory.problems || [directory.reason]).filter(Boolean).join('; ')}`; list.append(item);
  }
  for (const problem of inventoryProblems) {
    const item = document.createElement('li'); item.dataset.referenceStatus = 'unassessed'; item.textContent = problem; list.append(item);
  }
  if (!list.childElementCount) {
    const item = document.createElement('li'); item.textContent = 'No explicit references inventoried. Study completeness is not inferred.'; list.append(item);
  }
  if ($('reference-help')) {
    const absent = [...groups.values()].filter(refs=>refs[0].status === 'missing').length;
    $('reference-help').textContent = `${absent} referenced object${absent === 1 ? '' : 's'} absent from the supplied files. These metadata links do not mean supplied images were lost. Repeated links are grouped by target and status.${inventoryProblems.length ? ' Supplemental inventory coverage is incomplete; see diagnostics below.' : ''}`;
  }
}
async function readSupplementaryInventories(documentGeneration) {
  for (const name of ['dicom-validation.json','dicom-directory.json','dicom-structure.json']) {
    const file=attachment(name); if (!file) continue;
    try {
      if (!manifest.artifactSha256?.[name]) throw new Error('No manifest SHA-256 for this inventory');
      const {bytes}=await checkedAttachment(file,null,'inventory');
      const value=readJson(bytes,'Supplementary inventory');
      if (documentGeneration !== generation) return;
      if (value.schemaVersion !== 1 && !(name==='dicom-validation.json'&&value.schemaVersion===2)) throw new Error('Unsupported inventory schema version');
      if (name === 'dicom-validation.json') {
        if (!Array.isArray(value.images) || value.images.length !== entries.length) throw new Error('Invalid source count');
        const seen=new Set(),entriesByName=new Map(entries.map(entry=>[entry.attachment,entry]));
        for (const image of value.images) {
          const entry=entriesByName.get(image.attachment);
          if (!entry || seen.has(image.attachment) || entry.sourcePath !== image.sourcePath || entry.sha256 !== image.sha256 || !Array.isArray(image.issues)) throw new Error('Input-check source mapping differs');
          seen.add(image.attachment);
        }
        inputInventory=value;
      } else if(name==='dicom-structure.json') {
        structureInventory=readStructureInventory(value,entries);
      } else {
        if (!Array.isArray(value.directories) || !Array.isArray(value.references) || value.references.length>200000) throw new Error('Invalid directory inventory');
        directoryInventory=value;
      }
    } catch (error) {
      if (documentGeneration === generation) inventoryProblems.push(`${name} could not be assessed: ${error.message}`);
    }
  }
}
function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
function openOriginalsExport() {
  if (!entries.length || !$('originals-export-dialog')) return;
  $('originals-export-scope').value='all';$('originals-export-confirm').disabled=false;
  const study=entries[selectedSourceIndex()]?.fields?.StudyInstanceUID;
  const examOption=$('originals-export-scope').querySelector('option[value="study"]');
  if(examOption)examOption.disabled=typeof study!=='string'||!study.trim();
  $('originals-export-status').textContent='Originals retain their source paths. No metadata or pixels are removed.';
  $('originals-export-dialog').showModal();
}
async function saveOriginalsZip() {
  const documentGeneration=generation;
  zipAbort?.abort();zipAbort=new AbortController();const signal=zipAbort.signal;
  $('originals-export-confirm').disabled=true;$('originals-export-scope').disabled=true;
  try {
    const result=await buildOriginalsZip({entries,attachments,manifestBytes,
      scope:$('originals-export-scope').value,selectedIndex:selectedSourceIndex(),signal,
      onProgress:progress=>{
        if(documentGeneration===generation&&!signal.aborted) $('originals-export-status').textContent=
          `${progress.phase==='checking'?'Checking unchanged files':'Preparing ZIP'}: ${progress.completed} of ${progress.total}…`;
      }});
    if(documentGeneration!==generation||signal.aborted)return;
    download(result.bytes,result.filename,'application/zip');
    $('originals-export-status').textContent=`Saved ${result.originals} unchanged original file${result.originals===1?'':'s'} with recovery instructions. Checksums matched.`;
  } catch(error) {
    if(documentGeneration===generation&&!signal.aborted)$('originals-export-status').textContent=error.message||'The original files could not be exported.';
  } finally {
    if(documentGeneration===generation){$('originals-export-confirm').disabled=false;$('originals-export-scope').disabled=false;}
  }
}
async function saveViewCopy() {
  if(previewVisible){await previewSaveCopy?.();return;}
  if(pdfMode||!imageControlsEnabled||!activeImageId)return;
  const documentGeneration=generation,selection=selectedGeneration;
  await cine.pauseAndWait();
  if(documentGeneration!==generation||selection!==selectedGeneration||!activeImageId||cine.playing||pdfMode||previewVisible)return;
  // Wait for the pixels to catch up with any just-changed window or camera
  // before baking the current information into the viewing copy.
  await new Promise((resolve,reject)=>{
    const element=$('viewport');
    const finish=()=>{clearTimeout(timeout);element.removeEventListener(Enums.Events.IMAGE_RENDERED,finish);resolve();};
    const timeout=setTimeout(()=>{element.removeEventListener(Enums.Events.IMAGE_RENDERED,finish);reject(new Error('The view could not be rendered for export.'));},2000);
    element.addEventListener(Enums.Events.IMAGE_RENDERED,finish);viewport.render();
  });
  if(documentGeneration!==generation||selection!==selectedGeneration||!activeImageId||pdfMode||previewVisible)return;
  if(viewport.getCurrentImageId()!==activeImageId)throw new Error('The displayed frame is still changing. Select the frame again before saving a copy.');
  const source=viewport.getCanvas();
  if(!source.width||!source.height||source.width*(source.height+36)>16*1024*1024)throw new Error('This view is too large to save; reduce the window size and try again.');
  const copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height+36;
  const context=copy.getContext('2d');context.fillStyle='#101722';context.fillRect(0,0,copy.width,copy.height);context.drawImage(source,0,0);
  refreshImageOverlays();
  if(!$('image-overlays').hidden){
    const origin=source.getBoundingClientRect(),blocks=[];
    for(const node of $('image-overlays').querySelectorAll('.overlay-text,.orientation-marker')){
      const box=node.getBoundingClientRect(),style=getComputedStyle(node),size=parseFloat(style.fontSize);
      const left=parseFloat(style.paddingLeft)||0,right=parseFloat(style.paddingRight)||0,top=parseFloat(style.paddingTop)||0,bottom=parseFloat(style.paddingBottom)||0;
      if(!node.textContent||!box.width||!box.height)continue;
      blocks.push({text:node.textContent,x:box.left-origin.left+left,y:box.top-origin.top+top,
        width:box.width-left-right,height:box.height-top-bottom,size,lineHeight:parseFloat(style.lineHeight)||size*1.45,
        font:`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,align:style.textAlign});
    }
    drawViewingOverlays(context,blocks,{width:source.width,height:source.height,scaleX:source.width/origin.width,scaleY:source.height/origin.height});
  }
  context.fillStyle='#fff';context.font='14px sans-serif';
  context.fillText(`Viewing copy · frame ${viewedFrame} · ${viewport.getRotation()}°${viewport.getProperties().invert!==initialInvert?' · inverted':''} · original unchanged`,12,source.height+23);
  const blob=await new Promise(resolve=>copy.toBlob(resolve,'image/png'));
  if(documentGeneration!==generation||selection!==selectedGeneration||pdfMode||previewVisible)return;
  if(!blob)throw new Error('The browser could not save this view.');
  download(blob,'dicom-view-copy.png','image/png');status('Saved a PNG viewing copy with the current adjustments. The original DICOM is unchanged.');
}
async function metadataSidecar() {
  const documentGeneration=generation;
  await ensurePdfMetadata(documentGeneration);
  if(documentGeneration!==generation)throw new DOMException('Document changed.','AbortError');
  if(xmpError)throw new Error(xmpError);
  if(xmpInventory)return xmpInventory;
  if (!metadataSidecarPromise) metadataSidecarPromise = (async()=>{
    const file = attachment('dicom-metadata.json');
    if (!file) return null;
    if (!manifest?.artifactSha256?.[file.filename]) throw new Error('Metadata inventory has no manifest SHA-256; export refused.');
    const {bytes} = await checkedAttachment(file,null,'metadata export');
    const inventory = readJson(bytes,'Metadata inventory');
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.images) || inventory.images.length !== entries.length) throw new Error('Unsupported metadata inventory or source count.');
    return inventory;
  })();
  return metadataSidecarPromise;
}
async function enrichNavigationFields(documentGeneration) {
  try {
    const inventory=await metadataSidecar();
    if(!inventory||documentGeneration!==generation)return;
    const records=new Map(inventory.images.map(record=>[record.attachment,record]));
    const wanted=new Set(['InstitutionName','InstitutionAddress','LossyImageCompression','LossyImageCompressionRatio','LossyImageCompressionMethod','BurnedInAnnotation']);
    for(const entry of entries){
      const record=records.get(entry.attachment);
      if(!record||record.sha256!==entry.sha256||record.sourcePath!==entry.sourcePath||!Array.isArray(record.elements))continue;
      entry.navigationFields=Object.fromEntries(record.elements.filter(element=>wanted.has(element.keyword)
        && /^dataset\/\([0-9A-F]{4},[0-9A-F]{4}\)$/.test(element.path)
        && element.encoding==='dicom-value-string'&&typeof element.value==='string').map(element=>[element.keyword,element.value]));
    }
  } catch { /* An untrusted optional sidecar never prevents recovery of originals. */ }
}
async function metadataRecord(entry) {
  if (!metadataCache.has(entry.attachment)) metadataCache.set(entry.attachment,(async()=>{
    const file = attachment(entry.attachment);
    if (!file) throw new Error(`Original attachment missing: ${entry.attachment}`);
    const {bytes} = await checkedAttachment(file,entry,'metadata export');
    const inventory = await metadataSidecar();
    if (inventory) {
      const matches = inventory.images.filter(image=>image.attachment === entry.attachment);
      const record = matches[0];
      if (matches.length !== 1 || record.sourcePath !== entry.sourcePath || record.sha256 !== entry.sha256
          || (record.sopInstanceUID ?? null) !== (entry.sopInstanceUID ?? null) || !Array.isArray(record.elements)) throw new Error(`Metadata source mapping differs for ${entry.attachment}; export refused.`);
      return record;
    }
    try {
      const elements = await decoder.readMetadata(bytes,{key:entry.sha256,sourceParsing:entry.parsing}), problem = elements.find(element=>element.encoding === 'incomplete-dataset');
      return {attachment:entry.attachment,sourcePath:entry.sourcePath,sopInstanceUID:entry.sopInstanceUID,sha256:entry.sha256,
        status:problem ? 'partial' : 'readable',reason:problem?.value,elements};
    } catch (error) {
      return {attachment:entry.attachment,sourcePath:entry.sourcePath,sopInstanceUID:entry.sopInstanceUID,sha256:entry.sha256,
        status:'unreadable',reason:error.message,elements:[]};
    }
  })());
  return metadataCache.get(entry.attachment);
}
function exportFieldMode() {
  const loading=$('export-csv-confirm').disabled,selectable=$('export-field-scope')?.value==='selected';
  if(metadataFieldPicker)metadataFieldPicker.setState({loading,selectable});
  else if ($('export-metadata-fields')) $('export-metadata-fields').disabled = loading || !selectable;
  for (const id of ['export-fields-all','export-fields-none']) if ($(id)) $(id).disabled = loading || !(metadataFieldPicker?.fieldCount||$('export-metadata-fields').options.length);
}
async function populateExportFields() {
  const request = ++exportGeneration, documentGeneration = generation;
  $('export-csv-confirm').disabled = true;
  exportFieldMode();
  $('export-csv-status').textContent = 'Reading source metadata…';
  const selected = entries[selectedSourceIndex()];
  const sources = $('export-image-scope').value === 'all' ? entries : selected ? [selected] : [];
  const records = [];
  try {
    for (let index=0;index<sources.length;index++) {
      const entry=sources[index],record=await metadataRecord(entry);
      const context=Object.entries(selectedOriginalValues(entry)).map(([key,value])=>({
        path:`package/selected-original/${key}`,tag:'',keyword:key,vr:'',
        value:value==null?'Not supplied':String(value),encoding:'package-context',
      }));
      records.push({...record,elements:[...record.elements,...context]});
      if (request !== exportGeneration || documentGeneration !== generation) return;
      if (index % 10 === 0) { $('export-csv-status').textContent = `Reading metadata: ${index+1} of ${sources.length} files…`; await new Promise(resolve=>setTimeout(resolve,0)); }
      if (request !== exportGeneration || documentGeneration !== generation) return;
    }
    const fieldList = $('export-metadata-fields'), selectedPaths = metadataFieldPicker?.getSelectedPaths()||new Set([...fieldList.selectedOptions].map(option=>option.value));
    const fields = new Map();
    for (const record of records) for (const element of record.elements) if (!fields.has(element.path)) fields.set(element.path,element);
    metadataFieldPicker??=createMetadataFieldPicker(fieldList);
    const rendered=await metadataFieldPicker.setFields(fields,{selectedPaths,isCurrent:()=>request===exportGeneration&&documentGeneration===generation});
    if(!rendered)return;
    exportRecords = records;
    const incomplete = records.filter(record=>record.status === 'unreadable' || record.status === 'partial').length;
    $('export-csv-status').textContent = `${records.length} source file${records.length === 1 ? '' : 's'} · ${fields.size} metadata fields${xmpInventory?' · metadata from PDF XMP':''}${incomplete ? ` · ${incomplete} incomplete or unreadable file${incomplete === 1 ? '' : 's'}; diagnostics are included` : ''}. Pixel payloads are excluded; omissions are labeled.`;
    $('export-csv-confirm').disabled = !records.length;
    exportFieldMode();
  } catch (error) {
    if (request === exportGeneration && documentGeneration === generation) { exportRecords=[]; $('export-csv-status').textContent = error.message; }
  }
}
async function openMetadataExport() {
  const dialog = $('metadata-export-dialog');
  if (!dialog || !entries.length) return;
  if($('export-xmp'))$('export-xmp').disabled=true;
  $('export-image-scope').value = entries[selectedSourceIndex()] ? 'selected' : 'all';
  $('export-field-scope').value = 'all';
  if ($('export-csv-layout')) $('export-csv-layout').value = 'columns';
  details(entries[selectedSourceIndex()],{force:true});
  dialog.showModal();
  const documentGeneration=generation;
  void ensurePdfMetadata(documentGeneration).then(()=>{
    if(documentGeneration===generation&&$('export-xmp'))$('export-xmp').disabled=!xmpFile;
  });
  await populateExportFields();
}
function saveMetadataCsv() {
  const selectedPaths = $('export-field-scope').value === 'selected' ? metadataFieldPicker?.getSelectedPaths()||new Set([...$('export-metadata-fields').selectedOptions].map(option=>option.value)) : null;
  if (selectedPaths && !selectedPaths.size) { $('export-csv-status').textContent = 'Select one or more metadata fields.'; return; }
  const rows = exportRecords.map(record=>{
    if (record.elements.some(element=>element.encoding === 'incomplete-dataset')) return record;
    if (record.status === 'partial' || record.status === 'unreadable' || !record.elements.length) return {...record,elements:[...record.elements,{
      path:'[parse-error]',tag:'',keyword:'',vr:'',value:`Metadata unavailable: ${record.reason || 'DICOM metadata could not be read'}`,encoding:'incomplete-dataset'}]};
    return record;
  });
  const layout=$('export-csv-layout')?.value || 'columns';
  const filename=layout==='rows'?'dicom-metadata-details.csv':'dicom-metadata.csv';
  try { download(metadataCsv(rows,selectedPaths,{layout}),filename,'text/csv;charset=utf-8'); }
  catch(error) { $('export-csv-status').textContent=error.message; return; }
  $('metadata-export-dialog').close();
  status(`Exported metadata from ${rows.length} source file${rows.length === 1 ? '' : 's'} to ${filename}.`);
}
function setPdfControls() {
  const count = pdf?.numPages || 0;
  if ($('page-number')) { $('page-number').value = String(pageNumber); $('page-number').max = String(count); $('page-number').disabled = !count; }
  if ($('page-count')) $('page-count').textContent = `of ${count}`;
  if ($('previous-page')) $('previous-page').disabled = !count || pageNumber <= 1;
  if ($('next-page')) $('next-page').disabled = !count || pageNumber >= count;
  if ($('show-pdf')) $('show-pdf').disabled = !count;
}
async function renderPdfPage() {
  if (!pdf || !$('pdf-canvas') || !pdfMode) return;
  const renderGeneration = ++pageGeneration, documentGeneration = generation, document = pdf;
  if (pageRender) { pageRender.cancel(); try { await pageRender.promise; } catch {} }
  const page = await document.getPage(pageNumber);
  if (renderGeneration !== pageGeneration || documentGeneration !== generation || !pdfMode) return;
  const available = Math.max(200, $('pdf-view').clientWidth - 40);
  const natural = page.getViewport({scale:1});
  const scale = Math.min(2, available/natural.width), viewport = page.getViewport({scale});
  const canvas = $('pdf-canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
  pageRender = page.render({canvasContext:canvas.getContext('2d'),viewport});
  try { await pageRender.promise; }
  catch (e) { if (e.name !== 'RenderingCancelledException') throw e; }
}
async function showMode(mode,{reopenContent=true}={}) {
  if(mode!=='image'){cine.stop();stackScrubber.cancel();}
  if (!$('pdf-view')) return;
  const enteringPdf = mode === 'pdf' && (!pdfMode || previewVisible);
  const returningFromPdf = mode === 'image' && pdfMode && !previewVisible;
  const mappedIndex = returningFromPdf ? entries.findIndex(entry=>entry.referencePage === pageNumber) : -1;
  closeAttachmentPreview();
  if (enteringPdf) {
    const entry = entries[selectedSourceIndex()];
    if (Number.isInteger(entry?.referencePage) && entry.referencePage>=1 && entry.referencePage<=pdf?.numPages) pageNumber = entry.referencePage;
  }
  pdfMode = mode === 'pdf';
  if ($('image-view')) $('image-view').hidden = pdfMode;
  $('viewport').hidden = pdfMode; $('controls').hidden = pdfMode; $('pdf-view').hidden = !pdfMode;
  if ($('show-image')) $('show-image').setAttribute('aria-selected', String(!pdfMode));
  if ($('show-pdf')) $('show-pdf').setAttribute('aria-selected', String(pdfMode));
  if (pdfMode) {
    setPdfControls(); await renderPdfPage();
    const entry = entries[selectedSourceIndex()];
    if (entry) {
      const frame=entry.sourceFrame||1;
      const frameStatus=sourceViewKind(selectedSourceIndex())==='surface-segmentation'?'':` · source frame ${frame}${viewedFrame!==frame?` (interactive image was on frame ${viewedFrame})`:''}`;
      status(`${entry.sourcePath || entry.attachment} · PDF reference page ${pageNumber}${frameStatus}.`);
    }
  }
  else {
    ++pageGeneration; if (pageRender) pageRender.cancel(); engine.resize(true,true);
    if (isDataIndex(mappedIndex) && mappedIndex !== selectedSourceIndex()) {
      $('image-list').value = String(mappedIndex); await openSelected();
    } else if (reopenContent && canDisplay(entries[selectedSourceIndex()]||{}) && lastImageSelection?.index===selectedSourceIndex()
      && (!activeImageId||overlayDisplay?.index!==lastImageSelection.index||overlayDisplay?.frame!==lastImageSelection.frame)) {
      await openSelected(lastImageSelection.frame,{scrolling:true});
    } else if (reopenContent && !activeImageId && FILE_PREVIEWS.has(sourceViewKind(selectedSourceIndex()))) {
      await openSelected();
    } else if (activeImageId) viewport.render();
  }
  refreshImageOverlays();refreshSaveCopy();
}
async function navigatePdfPage(number) {
  if (!pdf || !Number.isInteger(number) || number<1 || number>pdf.numPages) { setPdfControls(); return; }
  pageNumber = number; setPdfControls();
  const mappedIndex = entries.findIndex(entry=>entry.referencePage === pageNumber);
  // Summary and inventory pages keep the last selected original. Reference pages
  // select their mapped original; retaining the same original preserves its frame/adjustments.
  if (isDataIndex(mappedIndex) && mappedIndex !== selectedSourceIndex()) {
    $('image-list').value = String(mappedIndex);
    await openSelected();
  } else await renderPdfPage();
}
function hasLutPreviewRejection(entry) {
  return entry.reason==='Modality/VOI/presentation LUT sequences are not implemented; original preserved';
}
function isJpegExtendedCandidate(entry) {
  const fields = entry.fields || {};
  return (entry.status !== 'rendered' || entry.displayRejected === true)
    && fields.TransferSyntaxUID === '1.2.840.10008.1.2.4.51'
    && ['MONOCHROME1','MONOCHROME2'].includes(fields.PhotometricInterpretation)
    && Number(fields.BitsAllocated) === 16 && Number(fields.PixelRepresentation ?? 0) === 0;
}
function isRgb32Candidate(entry) {
  const fields = entry.fields || {};
  return entry.reason?.startsWith('Unsupported pixel bit layout;')
    && fields.PhotometricInterpretation === 'RGB' && Number(fields.BitsAllocated) === 32
    && Number(fields.PixelRepresentation ?? 0) === 0;
}
function isParametricMap(entry){
  const fields=entry.fields||{};
  return (fields.SOPClassUID||fields.MediaStorageSOPClassUID)===PARAMETRIC_MAP_SOP;
}
function needsOriginalDecodeProbe(entry) {
  return hasLutPreviewRejection(entry) || isJpegExtendedCandidate(entry) || isRgb32Candidate(entry) || isParametricMap(entry);
}
function canDisplay(entry) {
  const fields=entry.fields||{},sop=fields.SOPClassUID||entry.navigationFields?.SOPClassUID||fields.MediaStorageSOPClassUID||entry.navigationFields?.MediaStorageSOPClassUID;
  if(sop===RT_DOSE_SOP||sop===RT_PLAN_SOP||sop===SURFACE_SEGMENTATION_SOP)return false;
  if (entry.status === 'rendered' && entry.displayRejected !== true) return true;
  if (manifest?.profile !== 'dicom-images') return false;
  if(!(Number(fields.Rows)>0&&Number(fields.Columns)>0))return false;
  if(isParametricMap(entry))return true;
  // Earlier PDF preview rules require width>=1 even for the non-linear
  // functions. Their unchanged originals can now use a valid fractional
  // window interactively without rewriting that historical rejection.
  // Try the original for this known preview limitation, including enhanced
  // per-frame windows absent from the top-level fields. The worker validates
  // the original and can automatically window images with a single 0/0 pair.
  if(['Invalid source window center/width','Only LINEAR grayscale VOI is currently implemented'].includes(entry.reason))return true;
  if(entry.reason==='Invalid PixelSpacing spacing'&&(fields.PixelSpacing==null||isZeroPixelSpacing(fields.PixelSpacing)))return true;
  if(entry.reason==='Invalid PixelAspectRatio pair')return true;
  if(hasLutPreviewRejection(entry)&&['MONOCHROME1','MONOCHROME2'].includes(fields.PhotometricInterpretation))
    return originalStates.get(entry.attachment)?.display!=='unsupported';
  if(entry.reason==='Direct RGB/YBR currently requires unsigned 8-bit samples'
    && fields.PhotometricInterpretation==='RGB' && Number(fields.BitsAllocated)===16 && Number(fields.PixelRepresentation??0)===0)return true;
  if(isJpegExtendedCandidate(entry) || isRgb32Candidate(entry))return true;
  if(entry.parsing?.transferSyntaxSource==='verified-native-layout')return true;
  if(entry.reason==='Invalid ICC Profile Data'&&fields.PhotometricInterpretation==='RGB')return true;
  return JPEG_LS.has(fields.TransferSyntaxUID)||JPEG2000.has(fields.TransferSyntaxUID);
}
const frameId=(documentGeneration,index,frame)=>`dicom:${documentGeneration}-${index}-${frame}`;
function adjacentFrames(index,frame){
  const entry=entries[index],count=Number(entry?.fields?.NumberOfFrames||1),result=[];
  for(const next of [frame+1,frame+2,frame-1])if(next>=1&&next<=count)result.push({index,frame:next});
  if(count===1){const order=stackIndices(index),at=order.indexOf(index);for(const offset of [1,2,-1])if(order[at+offset]!==undefined)result.push({index:order[at+offset],frame:1});}
  return result;
}
function cancelImageDecodes(keep=new Set()){
  prefetchAbort?.abort();
  for(const [id,job] of decoding)if(!keep.has(id))job.controller.abort();
}
async function decodedFrame(entry,index,frame,{priority='foreground',documentGeneration=generation,bytes=null}={}){
  const id=frameId(documentGeneration,index,frame),existing=files.get(id);if(existing)return existing;
  if(decoding.has(id)&&!decoding.get(id).controller.signal.aborted)return decoding.get(id).promise;
  const controller=new AbortController(),version=manifestVersion;
  const job={controller,promise:null};
  job.promise=(async()=>{
    const data=bytes||(await checkedAttachment(attachment(entry.attachment),entry,'display')).bytes;
    if(controller.signal.aborted||documentGeneration!==generation)throw new DOMException('Image request cancelled.','AbortError');
    const baseline=entry.status==='rendered'&&frame===(entry.sourceFrame||1);
    const worker=priority==='thumbnail'&&data.byteLength<=16*1024*1024?previewDecoder:decoder;
    const decoded=await worker.decode(data,id,version===2&&baseline?entry:null,frame,{key:entry.sha256,signal:controller.signal,priority,sourceParsing:entry.parsing,requireEmptyColorProfile:entry.reason==='Invalid ICC Profile Data'});
    if(entry.sopInstanceUID&&decoded.sopInstanceUID!==entry.sopInstanceUID)throw new Error('DICOM instance identifier does not match the manifest.');
    if(controller.signal.aborted||documentGeneration!==generation)throw new DOMException('Image request cancelled.','AbortError');
    files.set(id,decoded);return decoded;
  })().finally(()=>{if(decoding.get(id)===job)decoding.delete(id);});
  decoding.set(id,job);return job.promise;
}
function prefetchFrames(index,frame){
  prefetchAbort?.abort();const controller=new AbortController();prefetchAbort=controller;
  const documentGeneration=generation,neighbors=adjacentFrames(index,frame);
  setTimeout(async()=>{
    for(const next of neighbors){
      if(controller.signal.aborted||documentGeneration!==generation)return;
      const entry=entries[next.index],syntax=entry?.fields?.TransferSyntaxUID||entry?.parsing?.transferSyntaxUID;
      if(!entry||!canDisplay(entry)||Number(entry.fields?.Rows)*Number(entry.fields?.Columns)>1024*1024
        ||!['1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.2','1.2.840.10008.1.2.5'].includes(syntax))continue;
      try{await decodedFrame(entry,next.index,next.frame,{priority:'thumbnail',documentGeneration});}catch{}
    }
    if(!controller.signal.aborted&&documentGeneration===generation&&!displayLoading)updateInventorySummary();
  },10);
}
function captureDisplay(){
  return activeImageId&&initialWindow?{rotation:viewport.getRotation(),inverted:!!viewport.getProperties().invert!==initialInvert,
    camera:viewport.getCamera(),brightness:$('brightness').value,contrast:$('contrast').value,windowPreset:windowPresetModel?.selected}:null;
}
function showUnavailableSource(entry,index,{failure=null,unsupported=true}={}) {
  const wasDisplayable=canDisplay(entry);
  originalStates.set(entry.attachment,{...originalStates.get(entry.attachment),display:unsupported?'unsupported':'failed'});
  if(unsupported&&wasDisplayable)stackOrder?.clear();
  refreshSourceOption(index);
  const message=unavailableDisplay(entry,{failure});
  emptyState(message.title,message.description,message.technical);
  status(`${entry.sourcePath || entry.attachment} · ${message.description}`);
}

async function openSelected(sourceFrame = null,{playback=false,scrolling=false,scrubbing=false,signal:externalSignal=null,retainedDisplay=null}={}) {
  if(!scrubbing)stackScrubber.cancel();
  if(!playback)cine.stop();
  const selection = ++selectedGeneration, documentGeneration = generation;
  selectionAbort?.abort(); const controller=new AbortController(); selectionAbort=controller;
  const signal = controller.signal;
  const cancel=()=>controller.abort();
  externalSignal?.addEventListener('abort',cancel,{once:true});
  if(externalSignal?.aborted)cancel();
  const selectedIndex = selectedSourceIndex();
  const entry = entries[selectedIndex];
  if(!entry){externalSignal?.removeEventListener('abort',cancel);return false;}
  refreshSourceList(selectedIndex);
  navigation?.updateSelection(selectedIndex);
  const requestedFrame = Number.isInteger(sourceFrame) ? sourceFrame : entry?.sourceFrame || 1;
  const retain=!!activeImageId&&!!initialWindow&&!pdfMode&&!previewVisible&&canDisplay(entry);
  if(!playback){
    if(retain){enableControls(false);viewControls.cancelGesture();if($('download-original'))$('download-original').disabled=true;}
    else {
      clearDisplay();details(entry);
      emptyState(sourceViewKind(selectedIndex)==='surface-segmentation'?'Opening 3D surface…':'Opening image…',entry.sourcePath||entry.attachment);
    }
    if($('export-csv'))$('export-csv').disabled=true;
  }
  displayLoading=!playback;pendingSelection={index:selectedIndex,frame:requestedFrame,playback};
  lastImageSelection={index:selectedIndex,frame:requestedFrame};refreshStackPosition();
  $('viewport').setAttribute('aria-busy','true');
  $('viewport').dataset.loadingAttachment=entry.attachment;
  const keep=new Set([frameId(documentGeneration,selectedIndex,requestedFrame),...adjacentFrames(selectedIndex,requestedFrame).map(next=>frameId(documentGeneration,next.index,next.frame))]);
  cancelImageDecodes(keep);
  if(!playback&&canDisplay(entry))for(const id of ['previous-image','next-image'])if($(id))$(id).disabled=false;
  if (Number.isInteger(entry.referencePage)) { pageNumber = entry.referencePage; setPdfControls(); }
  let openedOriginal=null;
  try {
    if (pdfMode && !previewVisible) await renderPdfPage();
    if (selection !== selectedGeneration || documentGeneration !== generation || signal.aborted) return;
    if(!playback)status(`Reading ${entry.sourcePath || entry.attachment}…`);
    const original = attachment(entry.attachment);
    if (!original) {
      originalStates.set(entry.attachment,{integrity:'missing',display:'failed'});
      throw new Error('This original attachment is missing from the PDF.');
    }
    const {bytes} = await checkedAttachment(original,entry,'display');
    if (selection !== selectedGeneration || documentGeneration !== generation || signal.aborted) return;
    openedOriginal={entry,file:original,bytes};
    if (!canDisplay(entry)) {
      selectedOriginal=openedOriginal;
      if ($('download-original')) $('download-original').disabled = false;
      const kind=sourceViewKind(selectedIndex);
      if (FILE_PREVIEWS.has(kind)) {
        if(!pdfMode && $('attachment-view')) {
          const shown=await previewAttachment(original,entry,kind,signal);
          if(selection!==selectedGeneration||documentGeneration!==generation||signal.aborted)return false;
          if(kind==='surface-segmentation'&&shown===undefined)return false;
          originalStates.set(entry.attachment,{...originalStates.get(entry.attachment),display:shown===false?'failed':'displayed'});
          if(kind==='surface-segmentation')refreshSourceOption(selectedIndex);
          if(shown===false)return false;
        }
        return true;
      }
      showUnavailableSource(entry,selectedIndex);
      if (pdfMode) await renderPdfPage();
      return false;
    }
    const imageId = `dicom:${documentGeneration}-${selectedIndex}-${requestedFrame}`;
    const baseline = entry.status === 'rendered' && requestedFrame === (entry.sourceFrame || 1);
    const decoded = await decodedFrame(entry,selectedIndex,requestedFrame,{bytes,documentGeneration});
    if (selection !== selectedGeneration || documentGeneration !== generation || signal.aborted) return;
    const rendering=displayTail.catch(()=>{}).then(async()=>{
    if(selection!==selectedGeneration||documentGeneration!==generation||signal.aborted)return false;
    const display=retainedDisplay||(playback||scrolling&&retain?captureDisplay():null);
    if(files.peek(imageId)!==decoded)files.set(imageId,decoded);else files.get(imageId);
    const nextRenderer=activeWindowRenderer?.image===decoded.image?activeWindowRenderer:{image:decoded.image,renderer:createWindowRenderer(decoded.image)};
    const sourceOrder=stackIndices(selectedIndex);
    const nativeModel=cornerstoneStack.plan(imageId,sourceOrder)||buildCornerstoneStack({entries,indices:sourceOrder,index:selectedIndex,frame:requestedFrame,generation:documentGeneration});
    try{await cornerstoneStack.show(nativeModel,{signal});}
    catch(error){if(nextRenderer!==activeWindowRenderer)nextRenderer.renderer.destroy();throw error;}
    if (selection !== selectedGeneration || documentGeneration !== generation || signal.aborted) {
      if(nextRenderer!==activeWindowRenderer)nextRenderer.renderer.destroy();return;
    }
    if(activeWindowRenderer!==nextRenderer){activeWindowRenderer?.renderer.destroy();activeWindowRenderer=nextRenderer;}
    activeImageId = imageId;viewedFrame=requestedFrame;
    $('viewport').dataset.cornerstoneStackSize=String(cornerstoneStack.size);$('viewport').dataset.cornerstoneStackScope=cornerstoneStack.scope;
    initialInvert = !!decoded.image.invert;
    viewport.setRotation(display?.rotation||0);viewport.setProperties({invert:display?.inverted?!initialInvert:initialInvert});
    $('viewport').dataset.rotation=String(display?.rotation||0);$('viewport').dataset.inverted=String(!!display?.inverted);
    $('invert')?.setAttribute('aria-pressed',String(!!display?.inverted));
    fitImageToViewport(viewport,decoded.image);
    if(display){
      if(Number.isFinite(display.camera.scale))viewport.setCamera({scale:display.camera.scale});
      else viewport.setCamera({parallelScale:display.camera.parallelScale});
      viewport.setCamera({focalPoint:display.camera.focalPoint});
    }
    windowPresetModel=buildWindowPresets(decoded,{selected:display?.windowPreset??'initial'});
    initialWindow=windowPresetModel.window;refreshWindowPresets();
    $('viewport').dataset.sourceFrame = String(requestedFrame);
    const frameCount = decoded.frameCount || Number(entry.fields?.NumberOfFrames || 1);
    $('viewport').dataset.frameCount=String(frameCount);
    if(!playback){
      cineOverride=null;currentTiming=cineTiming(decoded.frameTiming);
      if($('cine-fps'))$('cine-fps').value=currentTiming.fps.toFixed(2).replace(/\.?0+$/,'');
      if($('cine-status'))$('cine-status').textContent=`${currentTiming.label}${currentTiming.capped?' (limited to 60 fps)':''}`;
    }
    if($('cine-controls'))$('cine-controls').hidden=frameCount<=1;
    if ($('frame-control')) $('frame-control').hidden = frameCount <= 1;
    if ($('frame-number')) { $('frame-number').value = String(requestedFrame); $('frame-number').max = String(frameCount); $('frame-number').disabled = false; }
    if ($('frame-count')) $('frame-count').textContent = String(frameCount);
    $('viewport').dataset.windowCenter = String(initialWindow.center);
    $('viewport').dataset.windowWidth = String(initialWindow.width);
    $('brightness').value = display?.brightness??0; $('contrast').value = display?.contrast??100;
    windowControls();
    viewport.render(); enableControls(true);
    selectedOriginal=openedOriginal;
    if($('download-original'))$('download-original').disabled=false;
    const automaticWindow=decoded.sourceDisplay?.zeroWindowFallback?'Automatic window from pixels (source window width is zero)':null;
    const windowNotes=sourceWindowNotes(decoded.sourceWindowPresets?.diagnostics);
    if(automaticWindow)windowNotes.unshift(automaticWindow);
    originalStates.set(entry.attachment,{...originalStates.get(entry.attachment),display:'displayed',
      geometryWarning:decoded.sourceDisplay?.geometry?.warning,
      windowNotes});
    refreshSourceOption(selectedIndex);
    if(!playback)status(`${entry.sourcePath || entry.attachment}${automaticWindow?` · ${automaticWindow}`:''} · page ${entry.referencePage ?? 'none'} · frame ${requestedFrame}${baseline ? '' : ' (interactive source display; PDF baseline unchanged)'} · SHA-256 verified · unitless reference display`);
    $('viewport').dataset.loadedAttachment = entry.attachment;
    overlayDisplay={id:imageId,entry,index:selectedIndex,frame:requestedFrame,decoded,points:overlayPixelPoints()};
    refreshImageOverlays();refreshStackPosition();
    if (pdfMode) await renderPdfPage();
    if(!pdfMode&&!previewVisible)prefetchFrames(selectedIndex,requestedFrame);
    return true;
    });
    displayTail=rendering.then(()=>{},()=>{});return await rendering;
  } catch (e) { if (selection === selectedGeneration && documentGeneration === generation && e.name !== 'AbortError') {
    clearDisplay();selectedOriginal=openedOriginal;
    if($('download-original'))$('download-original').disabled=!openedOriginal;
    if(openedOriginal){
      showUnavailableSource(entry,selectedIndex,{failure:e,unsupported:e.code==='UNSUPPORTED_LUT'&&hasLutPreviewRejection(entry)});
    }else{
      originalStates.set(entry.attachment,{...originalStates.get(entry.attachment),display:'failed'});
      refreshSourceOption(selectedIndex);fail(e);
    }
    cine.stop();
  }return false;} finally {
    externalSignal?.removeEventListener('abort',cancel);
    if(selection===selectedGeneration&&documentGeneration===generation){
      displayLoading=false;pendingSelection=null;$('viewport').setAttribute('aria-busy','false');$('viewport').dataset.loadingAttachment='';
      if($('export-csv'))$('export-csv').disabled=!entries.length;
      refreshStackPosition();
      if(!playback){details(entry);updateInventorySummary();}
    }
  }
}

async function rejectOrdinaryPdf(fallback) {
  if (fallback) { await fallback(); return false; }
  throw new Error('This PDF does not contain a supported DICOM archive.');
}

async function resetDocument({name,fallback=null}) {
  cornerstoneStack.clear();
  archiveVerification.reset();
  const thisGeneration = ++generation; ++selectedGeneration; ++pageGeneration;
  cine.stop();
  stackScrubber.cancel();lastImageSelection=null;
  cancelImageDecodes();decoding.clear();stackOrder?.clear();stackOrder=null;
  clearTimeout(detailsTimer);detailEntry=null;
  selectionAbort?.abort();zipAbort?.abort();decoder.clear();navigation?.destroy();navigation=null;
  if(previewDecoder!==decoder)previewDecoder.clear();
  attachmentChecks=new WeakMap();originalStates=new Map();
  closeAttachmentPreview();
  ++exportGeneration; metadataCache = new Map(); metadataSidecarPromise = null; exportRecords=[];
  metadataFieldPicker?.destroy();metadataFieldPicker=null;
  $('metadata-export-dialog')?.close();
  $('metadata-section')?.close();
  $('originals-export-dialog')?.close();
  clearDisplay(); $('image-list').replaceChildren();sourceOptions.clear();sourceListStack=null; details(null);
  entries = []; setAttachments(null); manifest = null; manifestBytes = null; pdfSource=null; nativeFallback = fallback; paneInventory=null;
  delete $('viewport').dataset.inputKind;
  xmpInventory=null;xmpFile=null;xmpError=null;xmpPromise=null;
  inputInventory=null;directoryInventory=null;inventoryProblems=[];
  structureInventory=null;
  if ($('export-csv')) $('export-csv').disabled = true;
  if ($('export-originals')) $('export-originals').disabled = true;
  if ($('document-name')) { $('document-name').textContent = name; $('document-name').title = name; }
  if ($('download-manifest')) $('download-manifest').disabled = true;
  if ($('native-pdf')) $('native-pdf').hidden = !fallback;
  status('Opening DICOM PDF…');
  emptyState('Opening DICOM PDF…','Reading the selected PDF locally.');
  const previousPdf = pdf; pdf = null;
  if (pageRender) { pageRender.cancel(); pageRender = null; }
  pageNumber = 1; setPdfControls();
  await showMode('image',{reopenContent:false});
  if (previousPdf) await previousPdf.destroy();
  if (thisGeneration !== generation) return false;
  files.clear();
  if($('files-heading'))$('files-heading').textContent='Metadata';
  return thisGeneration;
}

/** Shared PDF input for the viewer's picker, drop target and explicit toolbar launch. */
export async function loadPdfBytes(data,options={}){
  const request=options.inputToken??beginInputRequest();if(!isInputRequestCurrent(request))return false;
  loading.start(request,`Reading ${options.name||'PDF'}…`);
  try{
    await new Promise(resolve=>setTimeout(resolve,0));if(!isInputRequestCurrent(request))return false;
    return await readPdfInput(data,{...options,inputToken:request});
  }catch(error){
    if(!isInputRequestCurrent(request))return false;
    if(!manifest){
      const rejected = pdf; pdf = null; pdfSource = null;
      setAttachments(null); manifestBytes = null;
      $('document-name').textContent = 'No PDF open'; $('document-name').title = '';
      emptyState('Open a DICOM PDF',error.message);
      if(rejected)await rejected.destroy().catch(()=>{});
    }
    if(!isInputRequestCurrent(request))return false;
    throw error;
  }finally{loading.finish(request);}
}
async function readPdfInput(data, {name = 'DICOM PDF', nativeFallback: fallback = null,inputToken=null} = {}) {
  const trace=phase=>{if(globalThis.DICOM_TRACE_LOADING===true)performance.mark('dicom-load:'+phase);};
  trace('start');
  const local=data instanceof Blob;
  const bytes=local?null:data instanceof Uint8Array?data:new Uint8Array(data);
  const request=inputToken??beginInputRequest();if(!isInputRequestCurrent(request))return false;
  const thisGeneration=await resetDocument({name,fallback});
  if(thisGeneration!==generation||!isInputRequestCurrent(request))return false;
  status('Reading PDF attachments…');
  const source=local?data:new Blob([bytes],{type:'application/pdf'});
  let task;
  const input=local?{range:localPdfRange(pdfjs.PDFDataRangeTransport,data,()=>{void task?.destroy().catch(()=>{});}),length:data.size,rangeChunkSize:256*1024,disableAutoFetch:true,disableStream:true}:{data:bytes};
  task = pdfjs.getDocument({...input,isEvalSupported:false, useSystemFonts:false, disableFontFace:true,...bundledPdfFonts()});
  // The extension hands protected documents to Chrome's password-capable reader.
  // A missing password UI must not leave the automatic opening task pending.
  task.onPassword = () => { void task.destroy().catch(()=>{}); };
  let openedPdf;
  try { openedPdf = await task.promise; }
  catch (error) {
    if (thisGeneration !== generation || !isInputRequestCurrent(request)) return false;
    if (fallback) { await fallback(); return false; }
    throw new Error('Unable to open this PDF. It may be damaged or require a password.');
  }
  if (thisGeneration !== generation || !isInputRequestCurrent(request)) { await openedPdf.destroy(); return false; }
  trace('parsed-pdf');
  loading.update(request,'Reading the attachment index…');
  // Track ownership before requesting the index so a new open cancels its ranges.
  pdf=openedPdf;
  pdfSource=source;
  const openedAttachments = await openPdfAttachments(openedPdf);
  trace('attachments');
  if (thisGeneration !== generation || !isInputRequestCurrent(request)) {
    if(pdf===openedPdf){pdf=null;await openedPdf.destroy();}
    return false;
  }
  setAttachments(openedAttachments);
  const manifestFile = attachment('manifest.json');
  if (!manifestFile) return rejectOrdinaryPdf(fallback);
  const loadedManifest=await attachmentBytes(manifestFile);
  if(thisGeneration!==generation||!isInputRequestCurrent(request))return false;
  manifestBytes=loadedManifest;
  let parsed;
  try { parsed = readJson(manifestBytes,'DICOM manifest'); }
  catch (error) {
    if (!attachment('dicom-xmp.rng')) return rejectOrdinaryPdf(fallback);
    archiveVerification.reject('INVALID_MANIFEST_JSON');throw new Error('DICOM manifest cannot be read as supported UTF-8 JSON.');
  }
  // Other PDF packages may also use the generic name manifest.json.
  const dicom = ['dicom-2d-intraoral','dicom-images'].includes(parsed?.profile)
    || (parsed?.schemaVersion === 1 && typeof parsed.creator === 'string' && parsed.creator.startsWith('dicom-pdf'))
    || !!attachment('dicom-xmp.rng');
  if (!dicom) return rejectOrdinaryPdf(fallback);
  if (![1,2].includes(parsed.schemaVersion) || !Array.isArray(parsed.images)) throw new Error('Unsupported dicom manifest version or image inventory.');
  manifestVersion = parsed.schemaVersion;
  if (manifestVersion === 2) {
    if (!(parsed.profile === 'dicom-2d-intraoral' && parsed.profileVersion === '0.2.0') && !(parsed.profile === 'dicom-images' && ['0.3.0','0.4.0'].includes(parsed.profileVersion))) throw new Error('Unsupported DICOM profile version.');
    if (!['archival-master', 'deidentified-copy'].includes(parsed.sourceRole)) throw new Error('Unknown source role.');
    const profileLabel = `${parsed.profile === 'dicom-images' ? 'DICOM image' : 'intraoral'} profile ${parsed.profileVersion}`;
    $('package-role').textContent = parsed.sourceRole === 'deidentified-copy'
      ? `De-identified copy (caller supplied) · ${profileLabel}`
      : profileLabel;
  } else $('package-role').textContent = 'Legacy package · source role not supplied';
  manifest = parsed; entries = parsed.images.map(entry=>({...entry}));
  $('viewport').dataset.inputKind='pdf-package';
  loadingArchiveGeneration=thisGeneration;
  try{
    loading.update(request,'Opening the first image…');
    const activated=await activateSources(thisGeneration);
    if(thisGeneration!==generation||!isInputRequestCurrent(request))return false;
    trace('first-image');
    setTimeout(()=>{void finishArchiveLoad(thisGeneration,request,trace);},0);
    return activated;
  }finally{if(loadingArchiveGeneration===thisGeneration)loadingArchiveGeneration=0;}
}

async function finishArchiveLoad(documentGeneration,request,trace){
  const current=()=>documentGeneration===generation&&isInputRequestCurrent(request);
  if(!current())return;
  void archiveVerification.run();
  await ensurePdfMetadata(documentGeneration);
  trace('metadata');
  if(!current())return;
  await readSupplementaryInventories(documentGeneration);
  trace('inventories');
  if(!current())return;
  await enrichNavigationFields(documentGeneration);
  if(!current())return;
  trace('navigation-metadata');
  navigation?.refreshFacilities();
  packageDetails();details(entries[selectedSourceIndex()]||null);
}

function ensurePdfMetadata(documentGeneration){
  if(!pdf||!manifest||documentGeneration!==generation)return Promise.resolve();
  return xmpPromise??=readPdfMetadata(documentGeneration);
}

async function readPdfMetadata(documentGeneration){
  try{
    const result=await pdf.getMetadata();
    if(documentGeneration!==generation)return;
    const raw=result.metadata?.getRaw();
    if(typeof raw==='string'&&raw){
      xmpFile={filename:'document-metadata.xmp',content:new TextEncoder().encode(raw),
        contentType:'application/rdf+xml',derivedLabel:'PDF XMP metadata'};
    }
    const metadata=await readXmpInventory(result.metadata,{manifest,manifestBytes,entries,sha256});
    if(documentGeneration!==generation)return;
    xmpInventory=metadata.inventory;
  }catch(error){
    if(documentGeneration!==generation)return;
    xmpError='PDF XMP metadata could not be verified; metadata export is unavailable. Originals can still be saved.';
    inventoryProblems.push(xmpError);
  }
}

function refreshSourceOption(index){
  const entry=entries[index],option=sourceOptions.get(index);if(!entry||!option)return;
  const kind=sourceViewKind(index),canView=canDisplay(entry)||FILE_PREVIEWS.has(kind);
  const presentation=sourceListPresentation(entry,{canView,kind,displayState:originalStates.get(entry.attachment)?.display});
  const label=`${option.dataset.position}. ${presentation.label}`;
  if(option.textContent!==label)option.textContent=label;
  const display=presentation.warning?'unavailable':'candidate';if(option.dataset.display!==display)option.dataset.display=display;
}
function refreshSourceList(index=-1){
  const stack=stackOrder.indices(index);if(stack===sourceListStack)return;
  sourceListStack=stack;
  const list=$('image-list'),selected=list.value;
  const options=orderSourceIndices(paneInventory.dataIndices,stackOrder,index).map((sourceIndex,position)=>{
    const option=sourceOptions.get(sourceIndex);option.dataset.position=String(position+1);refreshSourceOption(sourceIndex);return option;
  });
  if(options.some((option,position)=>list.options[position]!==option))list.replaceChildren(...options);
  list.value=selected;
}
async function activateSources(thisGeneration) {
  for(const entry of entries){
    if(thisGeneration!==generation)return false;
    if(manifest?.profile!=='dicom-images'||!entry.sha256||!/Part 10 file meta information is required/i.test(entry.reason||''))continue;
    const file=attachment(entry.attachment);
    if(!file)continue;
    try{
      const {bytes}=await checkedAttachment(file,entry,'inspect');
      const verified=await decoder.inspectRawCt(bytes,{key:entry.sha256});
      if(thisGeneration!==generation)return false;
      if(verified&&(!entry.sopInstanceUID||entry.sopInstanceUID===verified.sopInstanceUID))Object.assign(entry,verified);
    }catch(error){if(error.name==='AbortError')return false;}
  }
  archiveVerification.refresh();
  paneInventory=buildPaneInventory(entries,attachments);
  stackOrder=createStackOrder(entries,{canDisplay});
  if ($('export-csv')) $('export-csv').disabled = false;
  if ($('export-originals')) $('export-originals').disabled = false;
  for (const index of paneInventory.dataIndices) {
    const option = document.createElement('option'); option.value = index;
    sourceOptions.set(index,option);
    $('image-list').append(option);
  }
  refreshSourceList();
  if (!entries.length) throw new Error('The manifest contains no source images.');
  packageDetails(); setPdfControls();
  if ($('download-manifest')) $('download-manifest').disabled = false;
  await showMode('image',{reopenContent:false});
  const sourceIndices=[...$('image-list').options].map(option=>Number(option.value));
  const knownImage=sourceIndices.find(index=>canDisplay(entries[index])&&!needsOriginalDecodeProbe(entries[index]));
  // Older manifests record PDF preview rejections for images the current
  // decoder may handle. Try known images first.
  const candidates=knownImage===undefined?sourceIndices.filter(index=>canDisplay(entries[index])):[knownImage];
  const previews=sourceIndices.filter(index=>FILE_PREVIEWS.has(sourceViewKind(index)));
  const choices=new Set([...candidates,...(previews.length?previews:sourceIndices.slice(0,1))]);
  if(!choices.size) {
    $('image-list').selectedIndex = -1;
    const originals=paneInventory.otherSuppliedIndices.map(index=>entries[index]).filter(entry=>attachment(entry.attachment));
    const message=unavailableArchiveDisplay(originals);
    emptyState(message.title,message.description,message.technical);
    status(message.description);
    return true;
  }
  for(const index of choices){
    $('image-list').value=String(index);
    const opened=await openSelected();
    if(thisGeneration!==generation)return false;
    if(opened||!needsOriginalDecodeProbe(entries[index])&&!FILE_PREVIEWS.has(sourceViewKind(index)))break;
  }
  activateNavigation(thisGeneration);
  return true;
}
function activateNavigation(thisGeneration){
  if ($('study-navigation')) navigation=createStudyNavigation({container:$('study-navigation'),entries,stackOrder,
    includeEntry:(_entry,index)=>isDataIndex(index),
    isCurrent:()=>thisGeneration===generation,
    onSelect:async index=>{
      $('image-list').value=String(index);
      if(previewVisible) await showMode('image',{reopenContent:false});
      await openSelected();
    },
    getThumbnail:async(entry,index,{signal})=>{
      const {bytes}=await checkedAttachment(attachment(entry.attachment),entry,'thumbnail');
      if(signal.aborted||thisGeneration!==generation)throw new DOMException('Cancelled','AbortError');
      const frame=entry.sourceFrame||1;
      const worker=bytes.byteLength<=16*1024*1024?previewDecoder:decoder;
      const decoded=await worker.decode(bytes,`thumbnail:${thisGeneration}-${index}`,manifestVersion===2&&entry.status==='rendered'?entry:null,frame,
        {key:entry.sha256,signal,priority:'thumbnail',sourceParsing:entry.parsing,requireEmptyColorProfile:entry.reason==='Invalid ICC Profile Data'});
      if(entry.sopInstanceUID&&decoded.sopInstanceUID!==entry.sopInstanceUID)throw new Error('The source identity differs from the manifest.');
      return thumbnailPixels(decoded);
    }});
  navigation?.updateSelection(selectedSourceIndex());
}
$('image-list').addEventListener('change',async()=>{try {if(previewVisible)await showMode('image',{reopenContent:false});await openSelected();}catch(error){fail(error);}});
$('frame-number')?.addEventListener('change',()=>{const value=Number($('frame-number').value);if(Number.isInteger(value) && value>=1 && value<=Number($('frame-number').max))openSelected(value);});
$('stack-position')?.addEventListener('input',()=>{
  cine.stop();stackScrubber.input(Number($('stack-position').value));refreshStackPosition();
});
$('stack-position')?.addEventListener('change',()=>{void stackScrubber.flush();});
$('window-preset')?.addEventListener('change',()=>{
  if(!overlayDisplay||!activeWindowRenderer||displayLoading)return;
  windowPresetModel=buildWindowPresets(overlayDisplay.decoded,{selected:$('window-preset').value});
  initialWindow=windowPresetModel.window;refreshWindowPresets();
  $('brightness').value=0;$('contrast').value=100;windowControls();
});
$('brightness').addEventListener('input', windowControls);
$('contrast').addEventListener('input', windowControls);
$('zoom-in').addEventListener('click', ()=>viewControls.zoom(1.25));
$('zoom-out').addEventListener('click', ()=>viewControls.zoom(0.8));
$('reset').addEventListener('click', ()=>viewControls.reset());
$('cine-play')?.addEventListener('click',()=>cine.toggle());
$('cine-fps')?.addEventListener('change',()=>{
  const value=Number($('cine-fps').value);
  if(!Number.isFinite(value)||value<0.01||value>60){status('Choose a playback rate between 0.01 and 60 frames per second.');return;}
  const playing=cine.playing;cine.stop();cineOverride=value;
  currentTiming=cineTiming(files.get(activeImageId)?.frameTiming,cineOverride);
  if($('cine-status'))$('cine-status').textContent=currentTiming.label;
  if(playing)cine.start();
});
bindCinePlayback({element:$('viewport'),player:cine,
  canPlay:()=>!!initialWindow&&Number($('viewport').dataset.frameCount)>1});
$('rotate-left')?.addEventListener('click',()=>viewControls.rotate(-90));
$('rotate-right')?.addEventListener('click',()=>viewControls.rotate(90));
$('invert')?.addEventListener('click',()=>viewControls.invert());
$('fit-view')?.addEventListener('click',()=>viewControls.fit());
$('toggle-overlays')?.addEventListener('click',()=>{
  overlaysEnabled=!overlaysEnabled;
  $('toggle-overlays').setAttribute('aria-pressed',String(overlaysEnabled));
  refreshImageOverlays();
});
$('previous-image')?.addEventListener('click',()=>stepStack(-1));
$('next-image')?.addEventListener('click',()=>stepStack(1));
$('save-view')?.addEventListener('click',()=>saveViewCopy().catch(error=>status(error.message)));
$('compare-current')?.addEventListener('click',async()=>{
  if(!comparison||!selectedOriginal||!activeImageId)return;
  cine.stop();
  const {entry,bytes}=selectedOriginal;
  await comparison.pin({entry,bytes,frame:viewedFrame,sourceParsing:entry.parsing,
    previewEntry:manifestVersion===2&&entry.status==='rendered'?entry:null,
    display:{brightness:Number($('brightness').value),contrast:Number($('contrast').value),rotation:viewport.getRotation(),
      inverted:!!viewport.getProperties().invert!==initialInvert,camera:viewport.getCamera(),zoom:viewport.getZoom(),pan:viewport.getPan(),
      windowPreset:windowPresetModel?.selected??'initial'}});
});
$('fullscreen')?.addEventListener('click',async()=>{
  try { if(document.fullscreenElement)await document.exitFullscreen();else await ($('image-view')||$('viewer')).requestFullscreen(); }
  catch { status('Fullscreen is unavailable here. You can enlarge the browser window instead.'); }
});
document.addEventListener('fullscreenchange',()=>{
  if($('fullscreen')){$('fullscreen').textContent=document.fullscreenElement?'Exit fullscreen':'Fullscreen';$('fullscreen').setAttribute('aria-pressed',String(!!document.fullscreenElement));}
});
$('show-image')?.addEventListener('click',()=>{
  if(previewVisible&&$('show-image').getAttribute('aria-controls')==='attachment-view')return;
  showMode('image').catch(fail);
});
$('show-pdf')?.addEventListener('click',()=>showMode('pdf').catch(fail));
$('previous-page')?.addEventListener('click',()=>navigatePdfPage(pageNumber-1).catch(fail));
$('next-page')?.addEventListener('click',()=>navigatePdfPage(pageNumber+1).catch(fail));
$('page-number')?.addEventListener('change',()=>navigatePdfPage(Number($('page-number').value)).catch(fail));
function paneVisible(side,visible) {
  const navigation = side === 'navigation';
  const pane = navigation ? document.querySelector('.source-panel') : $('details-panel');
  if (!pane) return;
  const show = $(navigation ? 'show-navigation' : 'show-details');
  const hide = $(navigation ? 'toggle-navigation' : 'toggle-details');
  const focused=document.activeElement;
  const restoreFocus=visible?focused===show:pane.contains(focused);
  pane.hidden = !visible;
  $('workspace')?.classList.toggle(navigation ? 'hide-navigation' : 'hide-details',!visible);
  if (show) { show.hidden = visible; show.setAttribute('aria-expanded',String(visible)); }
  if (hide) hide.setAttribute('aria-expanded',String(visible));
  if(restoreFocus)(visible?hide:show)?.focus({preventScroll:true});
  if (pdfMode && !previewVisible) renderPdfPage().catch(fail);
}
$('toggle-navigation')?.addEventListener('click',()=>paneVisible('navigation',false));
$('show-navigation')?.addEventListener('click',()=>paneVisible('navigation',true));
$('toggle-details')?.addEventListener('click',()=>paneVisible('details',false));
$('show-details')?.addEventListener('click',()=>paneVisible('details',true));
$('close-attachment')?.addEventListener('click',()=>{
  const kind=sourceViewKind(selectedSourceIndex());
  const specialized=SPECIALIZED_PREVIEWS.has(kind);
  showMode(pdfMode?'pdf':'image',{reopenContent:!specialized}).then(()=>{
    if(!pdfMode&&specialized&&!previewVisible)emptyState('File preview closed','Select a source file to open its preview.');
  }).catch(fail);
});
$('export-csv')?.addEventListener('click',()=>openMetadataExport().catch(fail));
$('export-xmp')?.addEventListener('click',()=>{
  if(!xmpFile)return;
  download(xmpFile.content,xmpFile.filename,'application/rdf+xml');
  status('Saved the PDF document XMP metadata.');
});
$('export-originals')?.addEventListener('click',openOriginalsExport);
$('originals-export-scope')?.addEventListener('change',()=>{
  const study=entries[selectedSourceIndex()]?.fields?.StudyInstanceUID;
  $('originals-export-status').textContent=$('originals-export-scope').value==='study'
    ?`${entries.filter(entry=>entry.fields?.StudyInstanceUID===study).length} unchanged original files with this supplied exam ID, plus recovery instructions. Other package metadata is omitted.`
    :'Originals retain their source paths. No metadata or pixels are removed.';
});
$('originals-export-confirm')?.addEventListener('click',saveOriginalsZip);
$('originals-export-cancel')?.addEventListener('click',()=>$('originals-export-dialog').close());
$('originals-export-dialog')?.addEventListener('close',()=>zipAbort?.abort());
$('export-image-scope')?.addEventListener('change',()=>populateExportFields().catch(fail));
$('export-field-scope')?.addEventListener('change',exportFieldMode);
for (const [id,selected] of [['export-fields-all',true],['export-fields-none',false]]) $(id)?.addEventListener('click',()=>{
  $('export-field-scope').value = 'selected';
  if(metadataFieldPicker)metadataFieldPicker.selectAll(selected);
  else for (const option of $('export-metadata-fields').options) option.selected = selected;
  exportFieldMode();
});
$('export-csv-confirm')?.addEventListener('click',event=>{event.preventDefault();saveMetadataCsv();});
$('export-csv-cancel')?.addEventListener('click',()=>{$('metadata-export-dialog').close();});
$('metadata-export-dialog')?.addEventListener('close',()=>{++exportGeneration;});
$('show-metadata')?.addEventListener('click',()=>{
  details(detailEntry,{force:true});
  const dialog=$('metadata-section');dialog.showModal();
  dialog.querySelector('.selected-metadata-content').scrollTop=0;
});
$('close-metadata')?.addEventListener('click',()=>$('metadata-section').close());
$('native-pdf')?.addEventListener('click',()=>{if (nativeFallback) Promise.resolve(nativeFallback()).catch(fail);});
$('download-original')?.addEventListener('click',()=>{
  if (!selectedOriginal) return;
  const name=(selectedOriginal.entry.sourcePath || selectedOriginal.entry.attachment).split(/[\\/]/).pop() || selectedOriginal.entry.attachment;
  download(selectedOriginal.bytes,name,'application/dicom');
});
$('download-manifest')?.addEventListener('click',()=>{if (manifestBytes && manifest) download(manifestBytes,'manifest.json','application/json');});
function stackIndices(index=selectedSourceIndex()) {
  return stackOrder?.indices(index)||[];
}
function stepStack(direction) {
  cine.stop();
  stackScrubber.cancel();
  const index = selectedSourceIndex(), entry = entries[index];
  if (!entry) return;
  const frames = Number(entry.fields?.NumberOfFrames || 1);
  const atFrame=pendingSelection?.index===index&&!pendingSelection.playback?pendingSelection.frame:viewedFrame;
  if (atFrame+direction >= 1 && atFrame+direction <= frames) { void openSelected(atFrame+direction,{scrolling:true}); return; }
  const stack = stackIndices(), at = stack.indexOf(index), next = stack[at+direction];
  if (next === undefined) return;
  $('image-list').value = String(next);
  const sourceFrame = direction < 0 ? Number(entries[next].fields?.NumberOfFrames || 1) : 1;
  void openSelected(sourceFrame,{scrolling:true});
}
let lastWheelStep = -Infinity;
function canUseNativeStackScroll(){
  if(!cornerstoneStack.canScroll())return false;
  const index=selectedSourceIndex(),target=cornerstoneStack.requestedTarget();
  const frame=pendingSelection?.index===index?pendingSelection.frame:overlayDisplay?.index===index?overlayDisplay.frame:entries[index]?.sourceFrame||1;
  return target?.index===index&&target?.frame===frame;
}
$('viewport').addEventListener('wheel',e=>{
  if (!entries.length) return;
  e.preventDefault();
  if (pdfMode||previewVisible||!canDisplay(entries[selectedSourceIndex()]||{})||!e.deltaY) {e.stopImmediatePropagation();return;}
  if (e.ctrlKey) { e.stopImmediatePropagation();viewControls.zoom(e.deltaY<0?1.1:1/1.1);return; }
  if (e.timeStamp-lastWheelStep < 32) {e.stopImmediatePropagation();return;}
  lastWheelStep=e.timeStamp;
  cine.stop();stackScrubber.cancel();
  if(canUseNativeStackScroll()&&!(cornerstoneStack.scope==='original'&&cornerstoneStack.atBoundary(e.deltaY>0?1:-1)))return;
  e.stopImmediatePropagation();
  stepStack(e.deltaY>0?1:-1);
},{capture:true,passive:false});
$('viewport').addEventListener('keydown',event=>{
  if(displayLoading&&event.target===$('viewport')&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey
    &&['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){
    event.preventDefault();stepStack(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1);
  }
});
new ResizeObserver(()=>{if($('viewport').clientWidth && $('viewport').clientHeight){engine.resize(true,true);if(activeImageId)viewport.render();}}).observe($('viewport'));
enableControls(false); setPdfControls();
bindLocalInputs({loadPdf:loadPdfBytes,onError:status});
bindPaneResizing({onCommit:()=>{if(pdfMode&&!previewVisible)renderPdfPage().catch(fail);}});
const narrowLayout=matchMedia('(max-width:850px)');
const collapseMetadataOnNarrow=()=>{if(narrowLayout.matches)paneVisible('details',false);};
narrowLayout.addEventListener('change',collapseMetadataOnNarrow);
collapseMetadataOnNarrow();
