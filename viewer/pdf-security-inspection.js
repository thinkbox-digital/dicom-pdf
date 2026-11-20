/* Adapted from EA-PDF Generator (Copyright 2026 ThinkBox Digital), Apache-2.0. */
// Injected into the PDF.js worker. Return bounded facts, never trust decisions.
function readSecurityStream(stream, limit) {
  if (!(stream instanceof BaseStream)) throw new Error("Expected a security evidence stream.");
  const inflate = stream instanceof FlateStream && stream.str instanceof Stream;
  if (!(stream instanceof Stream) && !inflate) throw new Error("Unsupported security stream filter.");
  for (const base of stream.getBaseStreams() || []) {
    if (base.length > 2 * 1024 * 1024) throw new Error("Encoded security stream exceeds its byte limit.");
    base.ensureRange?.(base.start, base.end);
  }
  stream.reset();
  if (inflate) {
    const ensureBuffer = stream.ensureBuffer;
    stream.ensureBuffer = function (size) {
      if (size > limit) throw new Error("Expanded security stream exceeds its byte limit.");
      return ensureBuffer.call(this, size);
    };
  }
  try {
    const bytes = stream.getBytes(inflate ? undefined : limit + 1);
    if (bytes.length > limit) throw new Error("Security stream exceeds its byte limit.");
    return bytes.slice();
  } finally {
    if (inflate) delete stream.ensureBuffer;
    stream.reset();
  }
}

function securityFileSpecs(xref, root) {
  const expected = new Set(["manifest.json", "content-credentials.c2pa", "c2pa-policy.json"]);
  const pending = root ? [root] : [], seen = new Set(), files = new Map();
  let entries = 0;
  while (pending.length) {
    const node = xref.fetchIfRef(pending.pop());
    if (!(node instanceof Dict) || node.dicomDuplicateKeys || seen.has(node) || seen.size >= 4096)
      throw new Error("Invalid embedded-file name tree.");
    seen.add(node);
    if (node.has("Kids")) {
      const children = node.get("Kids");
      if (node.has("Names") || !Array.isArray(children) || children.length + pending.length + seen.size > 4096)
        throw new Error("Invalid embedded-file name tree children.");
      pending.push(...children);
      continue;
    }
    const names = node.get("Names");
    if (!Array.isArray(names) || names.length % 2 || (entries += names.length / 2) > 65536)
      throw new Error("Invalid embedded-file name tree entries.");
    for (let index = 0; index < names.length; index += 2) {
      const value = xref.fetchIfRef(names[index]);
      const filename = typeof value === "string" && stringToPDFString(value);
      if (!expected.has(filename)) continue;
      if (files.has(filename)) throw new Error("Ambiguous archive security attachment.");
      files.set(filename, xref.fetchIfRef(names[index + 1]));
    }
  }
  return files;
}

function dicomCredentialFiles(xref, root) {
  const names = root.get("Names");
  if (names !== undefined && (!(names instanceof Dict) || names.dicomDuplicateKeys))
    throw new Error("Invalid embedded-file name dictionary.");
  const attached = securityFileSpecs(xref, names?.getRaw("EmbeddedFiles"));
  if (!attached.has("content-credentials.c2pa") && !attached.has("c2pa-policy.json")) return {};
  const associated = root.get("AF");
  if (associated !== undefined && (!Array.isArray(associated) || associated.length > 16384))
    throw new Error("Invalid associated-file inventory.");
  const specs = (associated || []).map(raw => xref.fetchIfRef(raw));
  const result = {};
  for (const [key, filename, relationship, limit] of [
    ["credentials", "content-credentials.c2pa", "C2PA_Manifest", 32768],
    ["policy", "c2pa-policy.json", "Supplement", 1024]
  ]) {
    const spec = attached.get(filename);
    if (!spec) continue;
    const matches = specs
      .filter(value => value instanceof Dict && (value.get("UF") ?? value.get("F")) === filename);
    if (!(spec instanceof Dict) || spec.dicomDuplicateKeys || matches.length !== 1 || matches[0] !== spec ||
        spec.get("Type")?.name !== "Filespec" || spec.get("F") !== filename || spec.get("UF") !== filename ||
        spec.get("AFRelationship")?.name !== relationship)
      throw new Error("Missing or ambiguous C2PA associated file.");
    const ef = spec.get("EF");
    const ref = ef?.getRaw("F");
    if (!(ef instanceof Dict) || ef.dicomDuplicateKeys || !(ref instanceof Ref) || ef.getRaw("UF") !== ref)
      throw new Error("C2PA stream aliases differ.");
    const stream = xref.fetch(ref);
    if (key === "credentials") {
      if (!(stream instanceof Stream) || stream.dict.dicomDuplicateKeys || stream.dict.has("Filter") ||
          stream.dict.get("Length") !== limit || stream.length !== limit || !xref.getEntry(ref.num)?.uncompressed)
        throw new Error("Expected an unfiltered fixed-size C2PA stream.");
      result.credentialOffset = stream.start;
      result.credentialRef = ref;
    }
    result[key] = readSecurityStream(stream, limit);
  }
  if (result.credentials || result.policy) {
    const other = specs
      .filter(value => value instanceof Dict && value.get("AFRelationship")?.name === "C2PA_Manifest");
    if (other.length !== (result.credentials ? 1 : 0))
      throw new Error("Ambiguous C2PA credential inventory.");
  }
  return result;
}

function inspectDicomSecurity(xref, root, includeCredentials = true) {
  const signatures = [], seen = new Set(), fields = new Set(), pending = [];
  let totalContents = 0;
  const add = value => {
    if (value == null || seen.has(value)) return;
    if (!(value instanceof Dict) || value.dicomDuplicateKeys)
      throw new Error("Invalid PDF signature dictionary.");
    seen.add(value);
    const contents = value.get("Contents"), range = value.getArray("ByteRange");
    if (signatures.length >= 64 || typeof contents !== "string" || contents.length > 1048576 ||
        (totalContents += contents.length) > 16 * 1024 * 1024 ||
        !Array.isArray(range) || range.length !== 4 || !range.every(Number.isSafeInteger))
      throw new Error("Invalid or oversized PDF signature.");
    signatures.push({ contents: Uint8Array.from(contents, character => character.charCodeAt(0)),
      byteRange: range, type: value.get("Type")?.name || "Sig", subFilter: value.get("SubFilter")?.name || "" });
  };
  const form = root.get("AcroForm");
  if (root.dicomDuplicateKeys || form !== undefined && (!(form instanceof Dict) || form.dicomDuplicateKeys))
    throw new Error("Ambiguous PDF catalog or AcroForm.");
  const initial = form?.get("Fields");
  if (initial !== undefined && (!Array.isArray(initial) || initial.length > 4096))
    throw new Error("Invalid form fields.");
  for (const raw of initial || []) pending.push([raw, "", 0]);
  while (pending.length) {
    const [raw, inherited, depth] = pending.pop(), field = xref.fetchIfRef(raw);
    if (depth > 32 || !(field instanceof Dict) || field.dicomDuplicateKeys || fields.has(field))
      throw new Error("Invalid or cyclic PDF form fields.");
    fields.add(field);
    const kind = field.get("FT")?.name || inherited;
    if (kind === "Sig") add(field.get("V"));
    const kids = field.get("Kids");
    if (kids !== undefined && (!Array.isArray(kids) || fields.size + pending.length + kids.length > 4096))
      throw new Error("Invalid form children.");
    for (const child of kids || []) pending.push([child, kind, depth + 1]);
  }
  const perms = root.get("Perms");
  if (perms instanceof Dict) {
    if (perms.dicomDuplicateKeys) throw new Error("Ambiguous PDF permissions.");
    add(perms.get("DocMDP"));
    add(perms.get("UR3"));
  }
  const evidence = { certificates: [], crls: [], ocsps: [] };
  try {
    const dss = root.get("DSS");
    if (dss !== undefined && (!(dss instanceof Dict) || dss.dicomDuplicateKeys))
      throw new Error("Invalid DSS evidence dictionary.");
    let total = 0;
    for (const [key, category] of [["Certs", "certificates"], ["CRLs", "crls"], ["OCSPs", "ocsps"]]) {
      const values = dss?.get(key);
      if (values !== undefined && (!Array.isArray(values) || values.length > 32))
        throw new Error("DSS evidence count limit.");
      for (const raw of values || []) {
        const bytes = readSecurityStream(xref.fetchIfRef(raw), 1048576);
        total += bytes.length;
        if (total > 4194304) throw new Error("DSS evidence byte limit.");
        evidence[category].push(bytes);
      }
    }
  } catch (error) {
    if (error instanceof MissingDataException) throw error;
    evidence.error = error.message;
  }
  let files, credentialError;
  if (includeCredentials) {
    try {
      files = dicomCredentialFiles(xref, root);
    } catch (error) {
      if (error instanceof MissingDataException) throw error;
      credentialError = error.message;
    }
  }
  return { signatures, encrypted: !!xref.encrypt, evidence, files, credentialError };
}
