import {MAX_FRAME_PIXELS} from './working-memory.mjs';

const STORAGE='1.2.840.10008.5.1.4.1.1.';
const OBJECTS={
  [STORAGE+'11.1']:['Grayscale softcopy presentation state','The viewer could not apply the saved settings to a referenced image in this archive.'],
  [STORAGE+'4.2']:['MR spectroscopy','The viewer could not verify the spectroscopy layout or the plot axes.'],
  [STORAGE+'66']:['Raw acquisition data','This file contains acquisition or processing data that requires software that understands the scanner’s format.'],
  [STORAGE+'66.4']:['Segmentation data','This file stores a voxel mask. Viewing it requires segmentation support.'],
  [STORAGE+'481.2']:['Dose data','The viewer could not open the stored radiotherapy dose data.'],
  [STORAGE+'481.3']:['RT structure set','This file stores contours linked to source images. Viewing them together requires a contour overlay.'],
  [STORAGE+'481.5']:['RT plan','The viewer could not read the stored treatment planning data.'],
  [STORAGE+'6.2']:['Enhanced ultrasound volume','This file stores ultrasound volume data. Viewing it requires an ultrasound volume renderer.'],
  '1.2.840.113543.6.6.1.3.10002':['Philips 4D ultrasound','This file stores a time series of 3D ultrasound volumes in Philips’ private layout. Viewing it requires support for that layout.'],
  '1.2.840.10008.1.3.10':['DICOM directory','This file is an index of the images and records on the original media.'],
};
const RECOVERY={
  selected:'The original source file is available under Save → Original file.',
  row:'The original source file is available using the download button.',
  metadata:'The original source file is available under Metadata → Other supplied files.',
};

const recordedReason=entry=>typeof entry.reason==='string'?entry.reason.trim():'';
const NOT_DICOM=/^Not a DICOM Stream\.?$/i;

function displayReason(entry,failure,fields){
  const sop=String(fields.SOPClassUID||fields.MediaStorageSOPClassUID||'');
  const modality=String(fields.Modality||'');
  const syntax=String(fields.TransferSyntaxUID||entry.parsing?.transferSyntaxUID||'');
  const reason=recordedReason(entry);
  const code=failure?.code;
  const pixels=Number(fields.Rows)*Number(fields.Columns);
  if(code==='RESOURCE_LIMIT'){
    return ['Image',Number.isSafeInteger(pixels)&&pixels>MAX_FRAME_PIXELS
      ? `This frame has ${pixels.toLocaleString('en-US')} pixels. The maximum is ${MAX_FRAME_PIXELS.toLocaleString('en-US')} pixels per frame.`
      : `Displaying this image${Number.isSafeInteger(pixels)&&pixels>0?` (${pixels.toLocaleString('en-US')} pixels)`:''} exceeds the viewer’s working memory, canvas dimensions, or pending decode limit.`];
  }
  if(code==='INVALID_FRAME')return ['Image','The requested frame is unavailable in the original image.'];
  if(code==='PREVIEW_MISMATCH')return ['Image','The saved PDF display settings do not match the original image.'];
  if(code==='UNSUPPORTED_LUT'||/LUT sequences are not implemented/i.test(reason))
    return ['Image','This image requires a grayscale lookup table. The viewer cannot apply the lookup table used here.'];
  if(/Part 10 file meta information is required/i.test(reason))
    return ['DICOM file header missing','This file starts with the DICOM data. The viewer could not verify a supported encoding from this headerless file.'];
  if(/^1\.2\.840\.10008\.1\.2\.4\.20[123]$/.test(syntax))
    return ['HTJ2K image','This image uses High-Throughput JPEG 2000 compression. The viewer could not decode its codestream or verify its pixel layout.'];
  if(syntax==='1.3.46.670589.33.1.4.1')
    return ['Philips private CT image','This CT image uses Philips Private ELE. The viewer cannot read the private pixel data layout.'];
  if(Object.hasOwn(OBJECTS,sop))return OBJECTS[sop];
  if(modality==='RTDOSE')return OBJECTS[STORAGE+'481.2'];
  if(sop.startsWith(STORAGE+'481.')||modality.startsWith('RT'))
    return ['Radiotherapy data','Viewing this file requires support for its radiotherapy object type.'];
  if(modality==='SEG')return ['Segmentation data','Viewing this file requires support for its segmentation format.'];
  if(/ICC Profile Data/i.test(reason))
    return ['Image color profile','The converter could not read the image’s ICC color profile, so it left the color preview unavailable.'];
  if(/Unsupported pixel bit layout/i.test(reason)){
    const stored=Number(fields.BitsStored),high=Number(fields.HighBit);
    const layout=Number.isInteger(stored)&&stored>0&&Number.isInteger(high)&&high>=0&&high<stored-1
      ? `The file declares ${stored} stored bits and a High Bit of ${high}. Those values do not identify a valid pixel layout.`
      : 'The viewer cannot use the pixel bit layout declared by this image.';
    return ['Image pixel layout',layout];
  }
  if(/Invalid .*Spacing|Invalid .*aspect/i.test(reason))
    return ['Image','The viewer cannot use the image’s pixel-spacing or aspect-ratio information.',' — display metadata issue'];
  if(/Pixel data is referenced externally/i.test(reason))
    return ['External pixel data','The image pixels are stored at an external location. The viewer only reads pixels present in the archive.'];
  if(/EOFException|truncated|invalid pixel.data length/i.test(reason))
    return ['Incomplete image data','The image data ends before all of the expected data can be read.'];
  if(NOT_DICOM.test(reason))
    return ['Unreadable DICOM file','The converter could not read this original as a DICOM file.'];
  if(code==='MISSING_PIXEL_DATA')return ['Image','The original has no pixel data the viewer can read.'];
  if(code==='DECODER_UNAVAILABLE'||code==='DECODER_FAILED')
    return ['Image','The browser could not run the local image decoder. Reopen the PDF to retry.'];
  if(code==='UNSUPPORTED_ENCODING'||/No bundled pure-Java decoder|Unsupported JPEG data precision|missing SOS marker/i.test(reason))
    return ['Image encoding','The viewer cannot decode the compression or sample precision used by this image.'];
  if(failure)return ['Image','The viewer could not decode the original image data.'];
  if(/SOP class|object type|non-raster/i.test(reason))
    return ['DICOM data','Viewing this file requires support for its DICOM object type.'];
  return ['Image','The viewer cannot display the image format recorded in this archive.'];
}

/** Patient-facing descriptions. Converter and decoder diagnostics stay in technical details. */
export function unavailableDisplay(entry={}, {failure=null,recovery='selected'}={}) {
  const fields={...entry.navigationFields,...entry.fields};
  if((fields.SOPClassUID||fields.MediaStorageSOPClassUID)===STORAGE+'66.5'){
    const guidance=RECOVERY[recovery];
    const description=failure?.code==='SURFACE_RENDER_UNAVAILABLE'?'This browser could not start the 3D surface renderer.':'The viewer could not open the stored 3D surface mesh.';
    return {label:'Surface segmentation — viewing unavailable',title:'Surface segmentation: viewing unavailable',
      description:guidance?`${description} ${guidance}`:description,technical:failure?.message||recordedReason(entry)||null};
  }
  const [kind,reason,labelSuffix=' — viewing unsupported']=displayReason(entry,failure,fields);
  const guidance=RECOVERY[recovery];
  return {
    label:kind+labelSuffix,
    title:labelSuffix===' — display metadata issue'?'Image display unavailable':`${kind}: viewing unsupported`,
    description:guidance?`${reason} ${guidance}`:reason,
    technical:failure?.code==='UNSUPPORTED_RT_OBJECT'?failure.message:recordedReason(entry)||failure?.message||null,
  };
}

/** Normal supporting files can be downloadable without a viewing error. */
export function supportingSourceDisplay(entry,{recovery='row'}={}){
  const reason=recordedReason(entry);
  const sop=entry.fields?.SOPClassUID||entry.fields?.MediaStorageSOPClassUID||entry.navigationFields?.SOPClassUID;
  const dicomSource=sop||/\.(dcm|dicom|ima)$/i.test(entry.sourcePath||'');
  return dicomSource||reason&&!NOT_DICOM.test(reason)?unavailableDisplay(entry,{recovery}):null;
}

export function unavailableArchiveDisplay(originals){
  const first=originals[0];
  if(first){
    const message=supportingSourceDisplay(first,{recovery:originals.length===1?'metadata':null});
    if(message&&originals.length===1)return message;
    if(message&&originals.every(entry=>supportingSourceDisplay(entry,{recovery:null})?.description===message.description)){
      return {...message,description:`${message.description} The original source files are available under Metadata → Other supplied files.`};
    }
    return {title:'Interactive viewing unavailable',
      description:'The original source files and their viewing limitations are listed under Metadata → Other supplied files.',
      technical:null};
  }
  return {title:'Interactive viewing unavailable',description:'The PDF lists original files whose attachments are missing.',technical:null};
}

/** A missing PDF derivative is independent of interactive viewing success. */
export function sourceListPresentation(entry,{canView=false,kind=null,displayState=null}={}) {
  let suffix='',warning=false;
  if(displayState==='failed'){suffix=' — could not display';warning=true;}
  else if(kind==='surface-segmentation')suffix=' — 3D surface';
  else if(displayState==='displayed'){}
  else if(!canView){suffix=` — ${unavailableDisplay(entry).label}`;warning=true;}
  else if(kind==='dicom-document')suffix=' — report';
  else if(kind==='presentation-state')suffix=' — presentation state';
  else if(kind==='spectroscopy')suffix=' — spectroscopy';
  else if(kind==='rt-dose')suffix=' — RT Dose';
  else if(kind==='rt-plan')suffix=' — RT Plan';
  return {label:`${entry.sourcePath||entry.attachment||'Original file'}${suffix}`,warning};
}

/** Geometry warnings remain visible independently of the image info overlays. */
export function showGeometryWarning(element, decoded) {
  const message = decoded?.sourceDisplay?.geometry?.warning || '';
  if (element.textContent !== message) element.textContent = message;
  element.hidden = !message;
}

const ZERO_DS = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i;

/** The display fallback is for a pair of zero DICOM decimal strings. */
export function isZeroPixelSpacing(value) {
  if (typeof value !== 'string') return false;
  const spacing = value.split('\\');
  return spacing.length === 2 && spacing.every(component => ZERO_DS.test(component.trim()));
}
