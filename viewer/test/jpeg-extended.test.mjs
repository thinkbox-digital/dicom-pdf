import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import dicomParser from 'dicom-parser';
import {decodeDicomAsync} from '../native-dicom.mjs';

const fixture = new URL('../../fixtures/expanded/sc-jpeg-lossless-sv1-gray12.dcm', import.meta.url);
const segment = (marker, body) => [0xff, marker, 0, body.length + 2, ...body];
const codes = (...symbols) => [1, symbols.length - 1, ...Array(14).fill(0), ...symbols];

function jpegFrame(spectralEnd) {
  const bitStream = '10' + (2047 - 1048).toString(2).padStart(11, '0') + '0'
    + '10' + (2000).toString(2).padStart(11, '0') + '0';
  const padded = bitStream.padEnd(Math.ceil(bitStream.length / 8) * 8, '1');
  const scan = padded.match(/.{8}/g).map(bits => parseInt(bits, 2))
    .flatMap(byte => byte === 0xff ? [0xff, 0] : [byte]);
  // Two 8x8 blocks. With a DC quantization value of 8, the signed DC
  // coefficients -1048 and +952 reconstruct constant samples 1000 and 3000.
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xdb, [0, 8, ...Array(63).fill(1)]),
    ...segment(0xc1, [12, 0, 8, 0, 16, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...codes(0, 11), 0x10, ...codes(0)]),
    ...segment(0xda, [1, 1, 0, 0, spectralEnd, 0]),
    ...scan, 0xff, 0xd9,
  ]);
}

function dicomWithFrame(spectralEnd, {columns = 16, truncated = false} = {}) {
  const base = readFileSync(fixture);
  const ds = dicomParser.parseDicom(base);
  const pixelData = ds.elements.x7fe00010;
  const header = base.subarray(0, pixelData.fragments[0].position - 8);
  const syntax = base.indexOf('1.2.840.10008.1.2.4.70');
  header.write('1.2.840.10008.1.2.4.51', syntax, 'ascii');
  header.writeUInt16LE(8, ds.elements.x00280010.dataOffset);
  header.writeUInt16LE(columns, ds.elements.x00280011.dataOffset);
  const encoded = Buffer.from(jpegFrame(spectralEnd));
  const payload = truncated ? encoded.subarray(0, encoded.length - 2) : encoded;
  const fragment = Buffer.alloc(8 + payload.length + (payload.length & 1));
  fragment.writeUInt16LE(0xfffe, 0);
  fragment.writeUInt16LE(0xe000, 2);
  fragment.writeUInt32LE(fragment.length - 8, 4);
  payload.copy(fragment, 8);
  return Buffer.concat([header, fragment, Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0])]);
}

for (const end of [63, 0]) {
  test(`JPEG Extended retains 12-bit samples and source bytes with spectral end ${end}`, async () => {
    const source = dicomWithFrame(end);
    const before = Buffer.from(source);
    const {image} = await decodeDicomAsync(source, 'fixture:jpeg-extended');
    assert.deepEqual(image.getPixelData(), Uint16Array.from({length: 128}, (_, i) => i % 16 < 8 ? 1000 : 3000));
    assert.deepEqual(source, before);
  });
}

test('JPEG Extended rejects mismatched dimensions and damaged data', async () => {
  await assert.rejects(decodeDicomAsync(dicomWithFrame(63, {columns: 17}), 'fixture:dimensions'), /dimensions differ/);
  await assert.rejects(decodeDicomAsync(dicomWithFrame(63, {truncated: true}), 'fixture:truncated'), /damaged/);
});
