/** Expand 16-bit DICOM palette segments (PS3.3 C.7.9.2) into display bytes. */
export function expandSegmentedPalette(words, count, littleEndian) {
  const invalid = () => { throw new Error('Invalid segmented palette LUT.'); };
  if (words.byteLength % 2 || words.byteLength > count * 8) invalid();
  const word = offset => words.getUint16(offset, littleEndian);
  const segments = [];
  const offsets = new Map();
  for (let offset = 0; offset < words.byteLength;) {
    if (offset + 4 > words.byteLength || segments.length >= count) invalid();
    const opcode = word(offset), length = word(offset + 2);
    if (!length || opcode > 2) invalid();
    const data = offset + 4;
    const next = data + (opcode === 0 ? length : opcode) * 2;
    if (next > words.byteLength) invalid();
    offsets.set(offset, segments.length);
    segments.push({opcode, length, data});
    offset = next;
  }

  const output = new Uint8Array(count);
  let written = 0, last;
  function append({opcode, length, data}) {
    if (opcode === 2 || written + length > count) invalid();
    if (opcode === 0) {
      for (let index = 0; index < length; index++) {
        last = word(data + index * 2);
        output[written++] = last >>> 8;
      }
    } else {
      if (last === undefined) invalid();
      const start = last, end = word(data);
      for (let index = 1; index <= length; index++) {
        output[written++] = Math.round(start + (end - start) * index / length) >>> 8;
      }
      last = end;
    }
  }

  for (const segment of segments) {
    if (segment.opcode !== 2) {
      append(segment);
      continue;
    }
    // The offset always stores the low 16-bit word first, even in Big Endian.
    const start = offsets.get(word(segment.data) + word(segment.data + 2) * 65536);
    if (start === undefined || start + segment.length > segments.length) invalid();
    for (let index = start; index < start + segment.length; index++) append(segments[index]);
  }
  if (written !== count) invalid();
  return output;
}
