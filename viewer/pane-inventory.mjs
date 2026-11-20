import {attachmentKind} from './attachment-preview.mjs';
import {PARAMETRIC_MAP_SOP} from './parametric-map.mjs';

import {GSPS_SOP} from './presentation-state.mjs';
import {MR_SPECTROSCOPY_SOP} from './mr-spectroscopy.mjs';
import {RT_DOSE_SOP} from './rt-dose.mjs';
import {RT_PLAN_SOP} from './rt-plan.mjs';
import {SURFACE_SEGMENTATION_SOP} from './surface-segmentation.mjs';

const DIRECTORY_SOP='1.2.840.10008.1.3.10';
const PDF_SOP='1.2.840.10008.5.1.4.1.1.104.1';
const STORAGE='1.2.840.10008.5.1.4.1.1.';
const IMAGE_SOPS=new Set(['1','1.1','1.1.1','1.2','1.2.1','1.3','1.3.1','2','2.1','2.2','3','3.1','4','4.1','4.3','4.4',
  '6','6.1','6.2','7','7.1','7.2','7.3','7.4','12.1','12.1.1','12.2','12.2.1','20','128','128.1','128.1.1',
  '77.1.1','77.1.2','77.1.3','77.1.4','77.1.5.1','77.1.5.4'].map(suffix=>STORAGE+suffix));
IMAGE_SOPS.add(PARAMETRIC_MAP_SOP);
const NON_STANDALONE=new Set(['66.4','77.1.6'].map(suffix=>STORAGE+suffix));
const ARCHIVE_TYPES=new Set(['application/zip','application/x-zip-compressed','application/x-7z-compressed',
  'application/x-rar-compressed','application/vnd.rar','application/x-tar','application/gzip','application/x-gzip']);
const scalar=value=>typeof value==='string'?value.trim():'';
const fieldsOf=entry=>({...entry?.navigationFields,...entry?.fields});
const support=(viewKind=null)=>({pane:'metadata',kind:'support',viewKind});
const data=(kind,viewKind)=>({pane:'data',kind,viewKind});

// Prefer previously rendered images, then retry older rejections supported by
// newer decoders, followed by the attachment previews. Any candidate can fail.
export function initialDisplayCandidates(indices,canDisplay,needsProbe,hasPreview){
  const images=indices.filter(canDisplay);
  const choices=new Set([...images.filter(index=>!needsProbe(index)),...images,...indices.filter(hasPreview)]);
  if(!choices.size&&indices.length)choices.add(indices[0]);
  return choices;
}

/**
 * Pure pane routing; this is not a claim that a decoder supports an object.
 * Actual DICOM/archive evidence overrides generic filename/MIME categories.
 * Unsupported raster sources remain data placeholders, while recognized
 * non-standalone objects remain supporting metadata. No clinical labels or
 * identities are inferred from filenames.
 */
export function classifyPaneEntry(entry,attachment=null){
  const fields=fieldsOf(entry),sop=scalar(fields.SOPClassUID)||scalar(fields.MediaStorageSOPClassUID);
  const mime=scalar(attachment?.contentType||entry?.contentType||entry?.mimeType).split(';',1)[0].trim().toLowerCase();
  if(entry?.kind==='zip-archive'||entry?.kind==='archive'||entry?.archiveStatus||ARCHIVE_TYPES.has(mime))return support();
  if(entry?.kind==='dicom-directory'||sop===DIRECTORY_SOP)return support();
  if(sop===GSPS_SOP)return data('presentation-state','presentation-state');
  if(sop===MR_SPECTROSCOPY_SOP)return data('spectroscopy','spectroscopy');
  if(sop===RT_DOSE_SOP)return data('rt-dose','rt-dose');
  if(sop===RT_PLAN_SOP)return data('rt-plan','rt-plan');
  if(sop===SURFACE_SEGMENTATION_SOP)return data('surface-segmentation','surface-segmentation');
  if(sop===PDF_SOP)return data('dicom-pdf','dicom-document');
  if(sop.startsWith(STORAGE+'88.'))return data('dicom-sr','dicom-document');
  const rows=Number(fields.Rows),columns=Number(fields.Columns),raster=Number.isFinite(rows)&&rows>0&&Number.isFinite(columns)&&columns>0;
  const standaloneUnsupported=entry?.displayEligibility?.status==='unsupported'
    &&Array.isArray(entry.displayEligibility.codes)&&entry.displayEligibility.codes.includes('UNSUPPORTED_OBJECT_TYPE');
  if(sop.startsWith(STORAGE+'11.')
    ||(NON_STANDALONE.has(sop)||sop.startsWith(STORAGE+'481.'))&&(!raster||standaloneUnsupported||entry?.kind==='dicom-object'))return support();
  if(raster||entry?.kind==='dicom-image'||entry?.status==='rendered'||IMAGE_SOPS.has(sop))return data('dicom-image','dicom');
  // Older creator packages label every original application/dicom, including
  // ordinary PDF/raster/text sources. Only actual object evidence overrides the
  // existing generic preview categories, not that broad attachment MIME alone.
  if(sop||entry?.kind==='dicom-object')return support();
  const kind=attachmentKind(entry?.sourcePath||attachment?.filename||entry?.attachment,mime);
  return kind==='pdf'?data('pdf','pdf'):kind==='image'?data('image','image'):support(kind==='text'?'text':null);
}

/**
 * Classify originals without filtering or renumbering their source array.
 * Generated metadata files are attachments not mapped by any original's exact
 * attachment ID. Same basenames and duplicate SOP IDs never merge records.
 */
export function buildPaneInventory(entries,attachments={}){
  if(!Array.isArray(entries))throw new TypeError('An original source array is required.');
  const files=Object.values(attachments||{}),byName=new Map(),sourceIds=new Set(entries.map(entry=>entry?.attachment));
  for(const file of files)if(file&&typeof file.filename==='string'&&!byName.has(file.filename))byName.set(file.filename,file);
  const byIndex=new Map(),dataIndices=[],otherSuppliedIndices=[];
  for(const [index,entry] of entries.entries()){
    const classification=Object.freeze({index,attachment:entry?.attachment,...classifyPaneEntry(entry,byName.get(entry?.attachment))});
    byIndex.set(index,classification);(classification.pane==='data'?dataIndices:otherSuppliedIndices).push(index);
  }
  return {dataIndices:Object.freeze(dataIndices),otherSuppliedIndices:Object.freeze(otherSuppliedIndices),
    generatedFiles:Object.freeze(files.filter(file=>file&&typeof file.filename==='string'&&!sourceIds.has(file.filename))),byIndex};
}
