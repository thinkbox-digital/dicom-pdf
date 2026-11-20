import fs from 'node:fs/promises';
import path from 'node:path';

// PDF.js 4.10.38 exposes only an eager getAttachments(). Keep its own parser,
// xref, range retries and stream filters and add a small, viewer-private API.
// Exact anchors make a PDF.js upgrade fail at build time if its internals change.
export function selectivePdfAttachments(viewerDirectory) {
  const workerPath=path.join(viewerDirectory,'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
  function insertBefore(source,anchor,code) {
    const at=source.indexOf(anchor);
    if(at<0||source.indexOf(anchor,at+anchor.length)>=0)
      throw new Error('PDF.js attachment API changed. Update the selective attachment adapter.');
    return source.slice(0,at)+code+source.slice(at);
  }
  return {name:'selective-pdf-attachments',setup(build){
    build.onLoad({filter:/pdf\.worker\.mjs$/},async({path:filename})=>{
      if(filename!==workerPath)return;
      let source='import {readNativeFlate} from "./pdf-attachment-stream.mjs";\n'+await fs.readFile(filename,'utf8');
      source=insertBefore(source,'            dict.set(key, this.getObj(cipherTransform));\n',
        '            if (dict.has(key)) dict.dicomDuplicateKeys = true;\n');
      source=insertBefore(source,'        info("(while reading XRef): " + e);\n',
        '        this.dicomInvalidXRef = true;\n');
      const inspections=await Promise.all(['pdf-security-inspection.js','pdf-archival-inspection.js']
        .map(name=>fs.readFile(path.join(viewerDirectory,name),'utf8')));
      source=insertBefore(source,'class WorkerMessageHandler {\n',inspections.join('\n')+`
const inspectDicomArchival = makeDicomArchivalInspector({BaseStream, Dict, Name, Ref, MissingDataException, Stream, XRef});
`);
      source=insertBefore(source,'  get attachments() {\n',`  get dicomSecurityFacts() {
    const facts = inspectDicomSecurity(this.xref, this._catDict);
    if (facts.files) delete facts.files.credentialRef;
    return facts;
  }
`);
      source=insertBefore(source,'  get attachments() {\n',`  get dicomAttachmentSpecs() {
    const names = this._catDict.get("Names");
    const files = new Map();
    if (names instanceof Dict && names.has("EmbeddedFiles")) {
      const tree = new NameTree(names.getRaw("EmbeddedFiles"), this.xref);
      for (const [key, value] of tree.getAll()) {
        files.set(stringToPDFString(key), new FileSpec(value, this.xref, true));
      }
    }
    return shadow(this, "dicomAttachmentSpecs", files);
  }
  get dicomAttachmentIndex() {
    return Array.from(this.dicomAttachmentSpecs, ([key, spec]) => ({
      key, filename: stripPath(spec.filename), rawFilename: spec.filename,
      description: spec.description, embedded: spec.root?.has("EF") === true
    }));
  }
  getDicomAttachmentStream(key) {
    const spec = this.dicomAttachmentSpecs.get(key);
    const ref = pickPlatformItem(spec?.root?.get("EF"));
    const stream = ref && this.xref.fetchIfRef(ref);
    if (!(stream instanceof BaseStream)) return null;
    // Fetch the encoded stream's range before starting inflation.
    for (const base of stream.getBaseStreams() || []) {
      if (base instanceof ChunkedStream) base.ensureRange(base.start, base.end);
    }
    return stream;
  }
`);
      source=insertBefore(source,'    handler.on("GetAttachments", function (data) {\n',`    handler.on("DicomAttachmentIndex", () => pdfManager.ensureCatalog("dicomAttachmentIndex"));
    handler.on("DicomSecurityFacts", () => pdfManager.ensureCatalog("dicomSecurityFacts"));
    handler.on("DicomArchivalRevisions", ({ ends, hasCredentials }) =>
      inspectDicomArchival(pdfManager.pdfDocument.xref, ends, inspectDicomSecurity, dicomCredentialFiles, hasCredentials));
    handler.on("DicomReadAttachment", async ({ key, limit, digestOnly }) => {
      if (typeof key !== "string" || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error("Invalid embedded file request.");
      const stream = await pdfManager.ensureCatalog("getDicomAttachmentStream", [key]);
      if (!stream) return null;
      return readDicomAttachment(stream, limit, digestOnly);
    });
    async function readDicomAttachment(stream, limit, digestOnly) {
      const tooLarge = () => new Error("Embedded file exceeds available browser memory.");
      if (stream instanceof FlateStream && stream.str instanceof Stream && typeof DecompressionStream === "function") {
        // Exactly one zlib filter and no predictors or decryption. PDF.js
        // resolved and loaded its encoded byte range before this async work.
        const raw = stream.str;
        const position = raw.pos;
        raw.reset();
        const encoded = raw.getBytes();
        raw.pos = position;
        const result = await readNativeFlate(encoded, limit, digestOnly);
        if (result !== null) return result;
        // Some older PDFs omit a valid zlib trailer. Keep PDF.js's decoder.
      }
      stream.reset();
      if (stream instanceof DecodeStream) {
        // getBytes(n) would allocate n bytes immediately.
        while (!stream.eof && stream.bufferLength <= limit) stream.readBlock();
        if (stream.bufferLength > limit) throw tooLarge();
      }
      const bytes = stream.getBytes();
      if (bytes.length > limit) throw tooLarge();
      if (digestOnly) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return {size: bytes.length, digest: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")};
      }
      // Raw stream bytes may share the entire PDF backing buffer.
      return bytes.slice();
    }
`);
      return {contents:source,loader:'js',resolveDir:viewerDirectory};
    });
  }};
}
