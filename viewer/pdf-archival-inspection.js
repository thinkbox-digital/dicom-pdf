/* Copyright 2026 EA-PDF contributors
 * Licensed under the Apache License, Version 2.0.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Imported into the pinned PDF.js worker by build-pdf-worker.mjs.
function makeDicomArchivalInspector({BaseStream, Dict, Name, Ref, MissingDataException, Stream, XRef}) {
const yieldInspection = () => new Promise(resolve => setTimeout(resolve, 0));
class InvalidArchive extends Error {}
class UnsupportedArchive extends Error {}
const invalid = (condition, message) => { if (!condition) throw new InvalidArchive(message); };
const supported = (condition, message) => { if (!condition) throw new UnsupportedArchive(message); };
const refId = value => value instanceof Ref ? `${value.num}:${value.gen}` : '';
const name = value => value instanceof Name ? value.name : '';
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const stringBytes = value => Uint8Array.from(value, character => character.charCodeAt(0));

// Keep every fetch inside the revision, including substreams made by Parser.
class RevisionStream extends Stream {
  constructor(source, start, end, dict = null) {
    super(new Uint8Array()); this.source = source; this.start = this.pos = start; this.end = end; this.dict = dict;
    this.cached = new Uint8Array(); this.cachedStart = -1;
  }
  getByte() {
    if (this.pos >= this.end) return -1;
    if (this.pos < this.cachedStart || this.pos >= this.cachedStart + this.cached.length) {
      this.cachedStart = this.pos;
      this.cached = this.source.getByteRange(this.pos, Math.min(this.end, this.pos + 4096));
    }
    return this.cached[this.pos++ - this.cachedStart];
  }
  getBytes(length) {
    const end = length ? Math.min(this.pos + length, this.end) : this.end;
    const bytes = this.source.getByteRange(this.pos, end); this.pos = end; return bytes;
  }
  getByteRange(begin, end) { return this.source.getByteRange(Math.max(this.start, begin), Math.min(this.end, end)); }
  makeSubStream(start, length, dict = null) {
    const end = length === undefined ? this.end : start + length;
    invalid(Number.isSafeInteger(start) && start >= this.start && end >= start && end <= this.end, 'A PDF object reaches outside its saved revision.');
    return new RevisionStream(this.source, start, end, dict);
  }
  clone() { return new RevisionStream(this.source, this.start, this.end, this.dict); }
  ensureRange() { this.source.getByteRange(this.start, this.end); }
  getBaseStreams() { return [this]; }
}
class RevisionXRef extends XRef {
  fetch(ref, suppressEncryption = false) {
    const entry = this.getEntry(ref.num);
    invalid(!!entry, 'A saved revision contains an unresolved object reference.');
    const physical = entry.uncompressed ? entry : this.getEntry(entry.offset);
    invalid(physical?.uncompressed && Number.isSafeInteger(physical.offset) && physical.offset >= 0 && physical.offset < this.stream.end, 'An object reference points beyond its saved revision.');
    return super.fetch(ref, suppressEncryption);
  }
}

/** Facts only: trust and cryptographic decisions stay in the security worker. */
return async function inspectDicomArchival(current, signatureEnds, inspectSecurity, credentialFiles, hasCredentials) {
  const started = Date.now(), source = current.stream, manager = current.pdfManager;
  let visits = 0, payloadBytes = 0;
  const step = async () => {
    supported(++visits <= 1000000 && Date.now() - started < 45000, 'DICOM archive inspection exceeded its work allowance.');
    if (visits % 128 === 0) await yieldInspection();
  };
  const read = async operation => {
    while (true) {
      await step();
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof MissingDataException)) throw error;
        invalid(error.begin >= 0 && error.end <= source.end, 'Revision data is outside this file.');
        await manager.requestRange(error.begin, error.end);
      }
    }
  };
  const fetch = async (xref, value) => value instanceof Ref ? read(() => xref.fetch(value)) : value;
  const bytes = async (stream, limit) => {
    invalid(stream instanceof BaseStream, 'Expected an embedded archival stream.');
    const result = await read(() => { stream.reset(); return stream.getBytes(limit + 1); });
    supported(result.length <= limit, 'Embedded archival stream exceeds its byte allowance.');
    return result.slice();
  };
  const footer = async end => {
    const tail = await read(() => source.getByteRange(Math.max(0, end - 4096), end));
    const match = /startxref\s+(\d+)\s+%%EOF[\t\r\n ]*$/.exec(String.fromCharCode(...tail));
    invalid(!!match, 'Saved revision has no unambiguous PDF footer.');
    const offset = Number(match[1]); invalid(Number.isSafeInteger(offset) && offset >= 0 && offset < end, 'Invalid saved cross-reference offset.');
    return offset;
  };
  const revisionEnd = async (offset, ceiling) => {
    const length = Math.min(262144, ceiling - offset);
    supported(length > 0, 'Unsupported archival cross-reference ordering.');
    const data = await read(() => source.getByteRange(offset, offset + length));
    const text = new TextDecoder('latin1').decode(data), pattern = /startxref\s+(\d+)\s+%%EOF(?:\r\n|\r|\n)?/g;
    let match, found;
    while ((match = pattern.exec(text))) if (Number(match[1]) === offset) {
      invalid(found === undefined, 'Ambiguous saved revision footer.'); found = offset + match.index + match[0].length;
    }
    supported(found !== undefined, 'Archival cross-reference section is too large or unsupported.'); return found;
  };
  try {
    supported(source.start === 0 && Array.isArray(signatureEnds) && signatureEnds.length >= 2 && signatureEnds.length <= 64, 'Unsupported creator archive signature layout.');
    invalid(signatureEnds.every((end, index) => Number.isSafeInteger(end) && end > (signatureEnds[index - 1] ?? 0) && end <= source.end) && signatureEnds.at(-1) === source.end, 'Invalid signed revision boundaries.');
    const firstOffset = await footer(signatureEnds[0]), signedOffsets = new Map();
    for (const end of signatureEnds) signedOffsets.set(await footer(end), end);
    const reverse = [], seen = new Set(); let end = source.end, offset = await footer(end);
    while (true) {
      await step(); invalid(!seen.has(offset), 'Cyclic revision history.'); seen.add(offset);
      supported(reverse.length < 128, 'Too many saved archival revisions.');
      const xref = new RevisionXRef(new RevisionStream(source, 0, end), manager); xref.setStartXRef(offset); await read(() => xref.parse(false));
      invalid(!xref.dicomInvalidXRef && !xref.encrypt && !xref.trailer.dicomDuplicateKeys && xref.lastXRefStreamPos === null, 'Saved cross-reference sections are incomplete, repaired or encrypted.');
      const root = await read(() => xref.trailer.get('Root')), previous = xref.trailer.getRaw('Prev');
      invalid(root instanceof Dict && !root.dicomDuplicateKeys, 'Missing or ambiguous saved document catalog.');
      const security = await read(() => inspectSecurity(xref, root, false));
      payloadBytes += 32768 + security.signatures.reduce((total, signature) => total + signature.contents.length, 0) + ['certificates', 'crls', 'ocsps'].reduce((total, kind) => total + security.evidence[kind].reduce((n, bytes) => n + bytes.length, 0), 0);
      supported(payloadBytes <= 33554432, 'Saved security facts exceed their total byte allowance.');
      invalid(!xref.trailer.dicomDuplicateKeys, 'Ambiguous saved trailer dictionary.');
      reverse.push({xref, root, end, offset, previous, security});
      if (offset === firstOffset) break;
      invalid(Number.isSafeInteger(previous) && previous >= firstOffset && previous < offset, 'Saved revisions do not lead back to the export signature.');
      end = signedOffsets.get(previous) ?? await revisionEnd(previous, offset); offset = previous;
    }
    const revisions = [];
    for (const revision of reverse.reverse()) {
      const {xref, root, security} = revision; await step();
      const form = await read(() => root.get('AcroForm'));
      supported(form instanceof Dict && !form.dicomDuplicateKeys && [...form.getKeys()].every(key => ['Fields', 'SigFlags'].includes(key)) && form.get('SigFlags') === 3, 'Unsupported creator signature form.');
      const fields = await read(() => form.get('Fields'));
      invalid(Array.isArray(fields) && fields.length === security.signatures.length && fields.length <= 64, 'Signature field inventory is inconsistent.');
      const timestampFields = new Set(), fieldNames = [], signatureRefs = [], orderedSignatures = [], widgetUses = new Map();
      let firstPage;
      for (const [index, raw] of fields.entries()) {
        invalid(raw instanceof Ref, 'Signature field is not an indirect object.');
        const field = await fetch(xref, raw); invalid(field instanceof Dict && !field.dicomDuplicateKeys, 'Invalid signature field.');
        const value = await read(() => field.get('V')); invalid(value instanceof Dict && !value.dicomDuplicateKeys && field.getRaw('V') instanceof Ref, 'Invalid signature dictionary.');
        const type=name(value.get('Type')), subFilter=name(value.get('SubFilter')), contents=value.get('Contents'), range=value.getArray('ByteRange');
        invalid(type===(index===0?'Sig':'DocTimeStamp') && subFilter===(index===0?'ETSI.CAdES.detached':'ETSI.RFC3161') && name(value.get('Filter'))==='Adobe.PPKLite', 'Unexpected creator signature type.');
        supported([...value.getKeys()].every(key=>(index===0?['Type','Filter','SubFilter','Contents','ByteRange','M','Reason','Name','Location','ContactInfo']:['Type','Filter','SubFilter','Contents','ByteRange']).includes(key)), 'Unsupported signature dictionary setting.');
        invalid(typeof contents==='string' && contents.length<=1048576 && Array.isArray(range) && range.length===4 && range.every(Number.isSafeInteger), 'Invalid signature payload.');
        orderedSignatures.push({type,subFilter,contents:stringBytes(contents),byteRange:range});
        const signatureRef=refId(field.getRaw('V'));invalid(!signatureRefs.includes(signatureRef),'Duplicate signature dictionary.');signatureRefs.push(signatureRef);fieldNames.push(field.get('TU')??'');
        if(index>0)timestampFields.add(refId(raw));
        supported(field instanceof Dict && [...field.getKeys()].every(key => ['Type', 'Subtype', 'FT', 'Rect', 'P', 'AP', 'F', 'T', 'TU', 'V'].includes(key)), 'Unsupported signature field settings.');
        invalid(name(field.get('Type')) === 'Annot' && name(field.get('Subtype')) === 'Widget' && name(field.get('FT')) === 'Sig' && field.get('F') === 132 && field.get('T') === `Signature${index + 1}`, 'Unexpected creator signature field.');
        const rectangle = field.getArray('Rect'); invalid(Array.isArray(rectangle) && rectangle.length === 4 && rectangle.every(v => v === 0), 'A timestamp field has a visible rectangle.');
        const page = refId(field.getRaw('P')); invalid(!!page && (!firstPage || firstPage === page), 'Signature widget is attached to an unexpected page.'); firstPage ??= page;
        widgetUses.set(refId(raw),0);
        const appearance = await read(() => field.get('AP'));
        supported(appearance instanceof Dict && !appearance.dicomDuplicateKeys && [...appearance.getKeys()].length === 1 && appearance.has('N'), 'Unsupported signature appearance.');
        const normal = await read(() => appearance.get('N')); invalid((await bytes(normal, 0)).length === 0 && !normal.dict.dicomDuplicateKeys && name(normal.dict.get('Type')) === 'XObject' && name(normal.dict.get('Subtype')) === 'Form', 'Signature appearance changes visible content.');
        const box = normal.dict.getArray('BBox'); invalid(Array.isArray(box) && box.length === 4 && box.every(v => v === 0), 'Signature appearance has visible bounds.');
        supported([...normal.dict.getKeys()].every(key => ['Type', 'Subtype', 'BBox', 'Length'].includes(key)), 'Unsupported signature appearance settings.');
        invalid(index!==0||field.get('TU')==='Archive export signature', 'Unsupported export signature field label.');
      }
      const {credentials, policy, credentialRef, credentialOffset} = hasCredentials
        ? await read(() => credentialFiles(xref, root)) : {};
      invalid(!hasCredentials || credentials?.length === 32768 && !!policy, 'DICOM security files are missing or incomplete.');
      const manifestStreamRef = refId(credentialRef);
      const dss = await read(() => root.get('DSS'));
      supported(dss === undefined || dss instanceof Dict && !dss.dicomDuplicateKeys && [...dss.getKeys()].every(key => ['Type', 'Certs', 'CRLs', 'OCSPs'].includes(key)), 'Unsupported validation-evidence dictionary.');
      const records = new Map(), contexts = new Map(), queue = []; let encodedBytes = 0;
      const encode = async (value, depth = 0, context = '') => {
        await step(); supported(depth <= 64, 'Protected document nesting limit.');
        if (value instanceof Ref) {
          const key = refId(value); if (!records.has(key)) { records.set(key, null); queue.push(value); supported(records.size <= 200000, 'Protected document object limit.'); }
          if (context) contexts.set(key, context); return ['ref', key];
        }
        if (value instanceof BaseStream) {
          supported(context !== 'stream-dictionary', 'Unsupported nested stream.');
          const id = value.dict.objId, match = /^(\d+)R(\d+)?$/.exec(id ?? '');
          // Streams must stay at their signed physical offsets; their bytes are
          // protected by the verified prefix signature, without decoding images.
          supported(!!match, 'Protected stream lacks an indirect object identity.');
          const entry = xref.getEntry(Number(match[1])); invalid(entry?.uncompressed, 'Invalid protected stream location.');
          const descriptor = await encode(value.dict, depth + 1, 'stream-dictionary');
          return refId(Ref.get(Number(match[1]), Number(match[2] ?? 0))) === manifestStreamRef ? ['authenticated-c2pa-manifest', descriptor] : ['stream-at', entry.offset, descriptor];
        }
        if (value instanceof Dict) {
          invalid(!value.dicomDuplicateKeys, 'Duplicate dictionary keys make the saved revision ambiguous.');
          const result = [];
          for (const key of [...value.getKeys()].sort()) {
            if (context === 'root' && key === 'DSS') continue;
            let child = value.getRaw(key);
            if (context === 'form' && key === 'Fields') child = fields.filter(raw => !timestampFields.has(refId(raw)));
            if (name(value.get('Type')) === 'Page' && key === 'Annots') {
              const annotations = await fetch(xref, child); invalid(Array.isArray(annotations), 'Invalid page annotations.');
              for (const raw of annotations) if (widgetUses.has(refId(raw))) widgetUses.set(refId(raw), widgetUses.get(refId(raw)) + 1);
              child = annotations.filter(raw => !timestampFields.has(refId(raw)));
            }
            result.push([key, await encode(child, depth + 1, context === 'root' && key === 'AcroForm' ? 'form' : '')]);
          }
          return ['dict', result];
        }
        if (Array.isArray(value)) { const array = []; for (const child of value) array.push(await encode(child, depth + 1)); return ['array', array]; }
        if (value instanceof Name) return ['name', value.name];
        if (typeof value === 'string') { supported(value.length <= 1048576, 'Protected string byte limit.'); return ['string', hex(stringBytes(value))]; }
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
        throw new UnsupportedArchive('Unsupported protected PDF value.');
      };
      const rootRef = xref.trailer.getRaw('Root'); invalid(rootRef instanceof Ref, 'Catalog must be an indirect object.');
      const heads = [await encode(rootRef, 0, 'root')];
      if (xref.trailer.has('Info')) heads.push(await encode(xref.trailer.getRaw('Info')));
      for (let index = 0; index < queue.length; index++) {
        const ref = queue[index], value = await fetch(xref, ref), canonical = await encode(value, 0, contexts.get(refId(ref)) ?? '');
        const text = JSON.stringify(canonical); encodedBytes += text.length; supported(encodedBytes <= 33554432, 'Protected document description byte limit.'); records.set(refId(ref), canonical);
      }
      invalid([...widgetUses.values()].every(count => count === 1), 'A signature widget is missing from its page or appears more than once.');
      const canonical = JSON.stringify([heads, [...records].sort((a,b) => a[0].localeCompare(b[0], 'en'))]);
      revisions.push({end:revision.end,startXRef:revision.offset,previousXRef:revision.previous,protectedSha256:await hash(new TextEncoder().encode(canonical)),signatures:orderedSignatures,signatureRefs,fieldNames,credentials,credentialOffset,policy,evidence:security.evidence});
    }
    return {files:[],schemaVersion:1,status:'COMPLETE',revisions};
  } catch (error) {
    if (error instanceof MissingDataException) throw error;
    return {files:[],schemaVersion:1,status:error instanceof InvalidArchive?'INVALID':'UNAVAILABLE',detail:error.message || 'DICOM archive inspection could not complete.'};
  }
};
}
