import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {readPdfPageText} from './pdf-page-text.mjs';
import {createRasterPreview} from './raster-preview.mjs';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_PDF_PIXELS = 16 * 1024 * 1024;
const RASTER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const RASTER_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-ms-bmp', 'image/avif']);
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'json', 'jsonl', 'ndjson', 'xml', 'xmp', 'rng', 'csv', 'tsv',
  'html', 'htm', 'xhtml', 'css', 'js', 'mjs', 'cjs', 'md', 'markdown', 'log', 'sha256', 'sha512', 'sha1',
  'yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'sql', 'svg']);
const TEXT_MIME = new Set(['application/json', 'application/ld+json', 'application/xml', 'application/xhtml+xml',
  'application/javascript', 'application/ecmascript', 'application/yaml', 'application/x-yaml', 'application/relax-ng-compact-syntax']);

/** Safe display category. HTML, SVG and source code are always inert text. */
export function attachmentKind(name, mime = '') {
  const extension = String(name || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase();
  const basename = String(name || '').split(/[\\/]/).pop().toLowerCase();
  if (extension === 'svg' || type === 'image/svg+xml') return 'text';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (RASTER_MIME.has(type) || RASTER_EXTENSIONS.has(extension)) return 'image';
  if (type.startsWith('text/') || TEXT_MIME.has(type) || TEXT_EXTENSIONS.has(extension)
      || ['readme', 'license', 'licence', 'notice', 'copying'].includes(basename)
      || /\+xml$|\+json$/.test(type)) return 'text';
  return null;
}

function sourceBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Attachment bytes must be an ArrayBuffer or typed array.');
}
function imageType(name) {
  const extension = String(name || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
  return ({png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
    bmp:'image/bmp', avif:'image/avif'})[extension] || 'application/octet-stream';
}
function textDecoder(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be');
  return new TextDecoder('utf-8');
}

/**
 * Render a child attachment without using the parent PDF's worker or transport.
 * createPdfWorker() supplies {worker: PDFWorker, port: Worker}; both are owned
 * exclusively by this preview. Returned cleanup is safe to call repeatedly.
 */
export async function renderAttachmentPreview({bytes, name, kind, container, createPdfWorker, isCurrent = () => true,onStatus=()=>{},onSaveCopyChange=()=>{}}) {
  if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('A preview container is required.');
  const data = sourceBytes(bytes);
  let closed = false, objectUrl = null, child = null, loadingTask = null, workerResources = null,raster=null;
  let activeRender = null, renderSequence = 0, passwordRequired = false;
  const surface = document.createElement('section');
  surface.className = 'attachment-preview';
  surface.setAttribute('aria-label', `Preview of ${name || 'attachment'}`);
  const current = () => {
    if (closed) return false;
    try { return Boolean(isCurrent()); } catch { return false; }
  };
  let workerReleased = false;
  function releaseWorker() {
    if (workerReleased) return;
    workerReleased = true;
    try { workerResources?.worker?.destroy(); } catch { /* A destroyed worker needs no further cleanup. */ }
    try { workerResources?.port?.terminate(); } catch { /* A terminated port needs no further cleanup. */ }
  }
  function cleanup() {
    if (closed) return;
    closed = true; ++renderSequence;
    raster?.destroy();
    try { activeRender?.cancel(); } catch { /* Rendering may already have finished. */ }
    surface.remove();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    let disposal;
    try { disposal = child ? child.destroy() : loadingTask?.destroy(); } catch { releaseWorker(); }
    if (disposal) Promise.resolve(disposal).catch(() => {}).finally(releaseWorker);
    else releaseWorker();
  }
  if (!current()) { cleanup(); return cleanup; }
  container.replaceChildren(surface);
  try {
    // Even an incorrect caller category cannot turn SVG/HTML source into an active document.
    const extension = String(name || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
    if (['svg', 'html', 'htm', 'xhtml'].includes(extension)) kind = 'text';
    if (kind === 'text') {
      const visible = data.subarray(0, Math.min(data.byteLength, MAX_TEXT_BYTES));
      if (data.byteLength > MAX_TEXT_BYTES) {
        const notice = document.createElement('p'); notice.className = 'attachment-preview-note';
        notice.textContent = `Text preview truncated to the first 1 MiB of ${data.byteLength.toLocaleString()} bytes. Save the original attachment to recover the complete file.`;
        surface.append(notice);
      }
      const pre = document.createElement('pre'); pre.className = 'attachment-preview-text';
      pre.textContent = textDecoder(visible).decode(visible);
      surface.append(pre);
      return cleanup;
    }
    if (kind === 'image') {
      surface.classList.add('attachment-preview-raster');
      const image = document.createElement('img'); image.className = 'attachment-preview-image';
      image.alt = name || 'Attached image'; image.decoding = 'async';
      objectUrl = URL.createObjectURL(new Blob([data], {type:imageType(name)}));
      image.addEventListener('error', () => {
        if (!current()) { cleanup(); return; }
        const error = document.createElement('p'); error.className = 'attachment-preview-note';
        error.textContent = 'This image could not be decoded. The original attachment is still available to save.';
        surface.append(error);
      }, {once:true});
      image.addEventListener('load', () => { if (!current()) cleanup(); }, {once:true});
      raster=createRasterPreview({surface,image,name,onStatus,onSaveCopyChange});
      image.src = objectUrl;
      return cleanup;
    }
    if (kind !== 'pdf') throw new Error('This attachment type has no inline preview. Save the original file to open it.');
    if (typeof createPdfWorker !== 'function') throw new Error('A dedicated PDF preview worker is required.');
    workerResources = await createPdfWorker();
    if (!current()) { cleanup(); return cleanup; }
    if (!workerResources?.worker) throw new Error('The PDF preview worker could not be created.');
    const toolbar = document.createElement('nav'); toolbar.className = 'attachment-preview-pdf-controls';
    toolbar.setAttribute('aria-label', 'Attachment PDF page controls');
    const previous = document.createElement('button'), next = document.createElement('button'), position = document.createElement('span');
    const textToggle=document.createElement('button');textToggle.type='button';textToggle.textContent='Page text';textToggle.disabled=true;
    textToggle.setAttribute('aria-pressed','false');
    previous.type = next.type = 'button'; previous.textContent = 'Previous page'; next.textContent = 'Next page';
    previous.disabled = next.disabled = true;
    position.setAttribute('role', 'status'); position.textContent = 'Opening attached PDF…';
    toolbar.append(previous, position, next,textToggle);
    const canvas = document.createElement('canvas'); canvas.className = 'attachment-preview-pdf-canvas';
    canvas.setAttribute('aria-label', `PDF attachment ${name || ''}`);
    const problem = document.createElement('p'); problem.className = 'attachment-preview-note'; problem.hidden = true;
    const textOutput=document.createElement('pre');textOutput.className='attachment-preview-text attachment-preview-page-text';
    textOutput.hidden=true;textOutput.tabIndex=0;textOutput.setAttribute('aria-label','Extracted text from current PDF page');
    const textNotice=document.createElement('p');textNotice.className='attachment-preview-note';textNotice.hidden=true;
    surface.append(toolbar, canvas,textNotice,textOutput,problem);
    // Copy before sending data to PDF.js: transferring this buffer must not detach
    // the unchanged original retained by the parent viewer for hashes/downloads.
    loadingTask = pdfjs.getDocument({data:data.slice(), worker:workerResources.worker, isEvalSupported:false,
      useSystemFonts:false, disableFontFace:true, enableXfa:false, disableAutoFetch:true,...bundledPdfFonts()});
    loadingTask.onPassword = () => {
      passwordRequired = true;
      if (current()) { problem.textContent = 'This attached PDF requires a password. Save it to open in a PDF reader.'; problem.hidden = false; }
      void loadingTask.destroy();
    };
    child = await loadingTask.promise;
    if (!current()) { cleanup(); return cleanup; }
    let pageNumber = 1,textMode=false;
    const controls = busy => {
      previous.disabled = busy || pageNumber <= 1;
      next.disabled = busy || pageNumber >= child.numPages;
      textToggle.disabled=busy;
      position.textContent = `Page ${pageNumber} of ${child.numPages}`;
    };
    async function renderPage() {
      const sequence = ++renderSequence;
      if (!current()) { cleanup(); return; }
      controls(true); problem.hidden = true;surface.setAttribute('aria-busy','true');
      canvas.hidden=textMode;textOutput.hidden=!textMode;textNotice.hidden=!textMode;
      if(textMode){textOutput.textContent='Opening page text…';textNotice.textContent='Extracted text; layout and reading order may differ from the page image.';}
      if (activeRender) { activeRender.cancel(); try { await activeRender.promise; } catch { /* Cancelled old page. */ } }
      const page = await child.getPage(pageNumber);
      if (!current() || sequence !== renderSequence) return;
      if(textMode){
        const result=await readPdfPageText(page,{isCurrent:()=>current()&&sequence===renderSequence});
        if(!current()||sequence!==renderSequence)return;
        textOutput.textContent=result.text||(result.truncated
          ?'No selectable text within the preview limit. Use the page image or save the original.'
          :'No selectable text on this page. Use the page image.');
        if(result.truncated)textNotice.textContent+=' Text preview truncated; save the original for the complete report.';
        controls(false);surface.setAttribute('aria-busy','false');return;
      }
      const natural = page.getViewport({scale:1});
      if (!(natural.width > 0 && natural.height > 0 && Number.isFinite(natural.width) && Number.isFinite(natural.height))) throw new Error('Invalid PDF page dimensions.');
      const available = Math.max(240, Math.min(1400, container.clientWidth || 800) - 24);
      const scale = Math.min(2, available / natural.width, 8192 / natural.width, 8192 / natural.height,
        Math.sqrt(MAX_PDF_PIXELS / (natural.width * natural.height)));
      const viewport = page.getViewport({scale});
      canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
      activeRender = page.render({canvasContext:canvas.getContext('2d'), viewport});
      try { await activeRender.promise; }
      catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
      if (current() && sequence === renderSequence) {controls(false);surface.setAttribute('aria-busy','false');}
    }
    const navigate = delta => {
      if (!current()) { cleanup(); return; }
      const focusTarget=[previous,next,textToggle].find(node=>node===document.activeElement);
      pageNumber = Math.max(1, Math.min(child.numPages, pageNumber + delta));
      void renderPage().catch(error => {
        if (!current()) { cleanup(); return; }
        canvas.hidden=textOutput.hidden=textNotice.hidden=true;
        problem.textContent = 'This PDF page could not be displayed. The original remains available to save.'; problem.hidden = false; controls(false);surface.setAttribute('aria-busy','false');
      }).finally(()=>{
        if(current()&&focusTarget&&document.activeElement===document.body){
          const target=focusTarget.disabled?textToggle:focusTarget;
          if(!target.disabled)target.focus({preventScroll:true});
        }
      });
    };
    previous.addEventListener('click', () => navigate(-1)); next.addEventListener('click', () => navigate(1));
    textToggle.addEventListener('click',()=>{textMode=!textMode;textToggle.setAttribute('aria-pressed',String(textMode));navigate(0);});
    await renderPage();
    if (!current()) cleanup();
    return cleanup;
  } catch (error) {
    cleanup();
    let stillSelected = false;
    try { stillSelected = Boolean(isCurrent()); } catch { /* Stale or unavailable caller state. */ }
    if (!stillSelected) return cleanup;
    if (passwordRequired) throw new Error('This attached PDF requires a password. Save it to open in a PDF reader.');
    throw error;
  }
}
import {bundledPdfFonts} from './pdf-fonts.mjs';
