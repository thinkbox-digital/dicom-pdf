import createJpeg12 from '@cornerstonejs/codec-libjpeg-turbo-12bit';

let codec;
let warned = false;

function scanHeader(bytes, columns, rows) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Missing JPEG start of image.');
  let offset = 2;
  let frameComponent;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const length = bytes[offset] * 256 + bytes[offset + 1];
    const end = offset + length;
    if (!(length >= 2 && end <= bytes.length)) break;
    const start = offset + 2;
    if (marker === 0xc1) {
      if (frameComponent !== undefined || length !== 11 || bytes[start] !== 12 || bytes[start + 5] !== 1)
        throw new Error('Expected a single-component 12-bit JPEG Extended frame.');
      if (bytes[start + 1] * 256 + bytes[start + 2] !== rows
        || bytes[start + 3] * 256 + bytes[start + 4] !== columns)
        throw new Error('JPEG dimensions differ from DICOM metadata.');
      frameComponent = bytes[start + 6];
    } else if (marker === 0xda) {
      const spectralEnd = bytes[start + 4];
      if (frameComponent === undefined || length !== 8 || bytes[start] !== 1 || bytes[start + 1] !== frameComponent
        || bytes[start + 3] !== 0 || (spectralEnd !== 63 && spectralEnd !== 0) || bytes[start + 5] !== 0)
        throw new Error('Invalid 12-bit JPEG Extended scan header.');
      return spectralEnd === 0 ? start + 4 : null;
    } else if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd9)
      || (marker <= 0xcf && marker !== 0xc4)) {
      throw new Error('Unexpected marker in 12-bit JPEG Extended header.');
    }
    offset = end;
  }
  throw new Error('Missing or truncated JPEG Extended scan header.');
}

export async function decodeJpegExtended12(encoded, columns, rows) {
  const spectralEndOffset = scanHeader(encoded, columns, rows);
  codec ??= createJpeg12({printErr: () => { warned = true; }});
  let samples;
  try {
    const module = await codec;
    warned = false;
    const decoder = new module.JPEGDecoder();
    try {
      const input = decoder.getEncodedBuffer(encoded.length);
      input.set(encoded);
      // Some legacy sequential encoders wrote Se=0. The scan still contains
      // all 64 coefficients. Correct the decoder's copy and retain the source.
      if (spectralEndOffset !== null) input[spectralEndOffset] = 63;
      decoder.decode();
      const info = decoder.getFrameInfo();
      samples = decoder.getDecodedBuffer();
      if (info.width !== columns || info.height !== rows || info.bitsPerSample !== 12
        || info.componentCount !== 1 || !(samples instanceof Uint16Array) || samples.length !== columns * rows)
        throw new Error('Unexpected JPEG Extended decoder output.');
    } finally {
      decoder.delete();
    }
  } catch (cause) {
    codec = null;
    throw new Error('12-bit JPEG Extended decoding failed.', {cause});
  }
  if (warned) throw new Error('12-bit JPEG Extended stream is damaged.');
  return samples;
}
