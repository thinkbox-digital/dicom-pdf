import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BundledStandardFontDataFactory,bundledPdfFonts} from '../pdf-fonts.mjs';

test('local standard fonts return exact fresh byte views without network access',async()=>{
  const bytes=await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url));
  const factory=new BundledStandardFontDataFactory({fontData:{'LiberationSans-Regular.ttf':bytes.toString('base64')}});
  const first=await factory.fetch({filename:'LiberationSans-Regular.ttf'});assert.deepEqual(first,new Uint8Array(bytes));
  first[0]^=255;const second=await factory.fetch({filename:'LiberationSans-Regular.ttf'});assert.deepEqual(second,new Uint8Array(bytes));
  const configuration=bundledPdfFonts();assert.equal(configuration.useWorkerFetch,false);assert.equal(configuration.StandardFontDataFactory,BundledStandardFontDataFactory);
});
test('unknown or inherited font names fail without echoing a file-derived value',async()=>{
  const factory=new BundledStandardFontDataFactory({fontData:{}}),privateName='SYNTHETIC^PRIVATE';
  for(const filename of ['__proto__',privateName])await assert.rejects(factory.fetch({filename}),error=>!error.message.includes(filename));
});
