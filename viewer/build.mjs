import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {advanceViewerVersion} from './build-version.mjs';
import {selectivePdfAttachments} from './build-pdf-worker.mjs';
import {viewerTrustRoots} from './build-trust-policy.mjs';
import {certificateNetwork,digicertTimestampFallback} from './build-certificate-network.mjs';
import {buildExtension} from './extension/package.mjs';
const trustRoots=viewerTrustRoots();
const network=certificateNetwork();
const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
const version=advanceViewerVersion(here);
const fontData=Object.fromEntries(fs.readdirSync('node_modules/pdfjs-dist/standard_fonts').filter(name=>/\.(pfb|ttf)$/.test(name)).map(name=>[name,fs.readFileSync(`node_modules/pdfjs-dist/standard_fonts/${name}`).toString('base64')]));
// Self-contained classic workers also run from disk in Chromium versions that
// reject module Blob workers for file: origins. The extension keeps ESM files.
const worker = (await esbuild.build({absWorkingDir:here,entryPoints:['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],plugins:[selectivePdfAttachments(here)],bundle:true,write:false,minify:true,format:'iife',globalName:'pdfjsWorker',target:['chrome120','firefox120'],legalComments:'inline'})).outputFiles[0].text;
const dicomWorker = await esbuild.build({absWorkingDir:here,entryPoints:['dicom-worker.mjs'],bundle:true,write:false,minify:true,format:'iife',target:['chrome120','firefox120'],legalComments:'inline',external:['fs','path'],loader:{'.wasm':'binary'}});
const archiveWorker = await esbuild.build({absWorkingDir:here,entryPoints:['archive-verification-worker.mjs'],bundle:true,write:false,minify:true,format:'iife',target:['chrome120','firefox120'],legalComments:'inline',define:{DICOM_TRUST_ROOTS:trustRoots}});
const result = await esbuild.build({absWorkingDir:here, entryPoints:['app.js'], bundle:true, write:false, minify:true, format:'iife', target:['chrome120','firefox120'], define:{PDF_WORKER_SOURCE: JSON.stringify(worker),DICOM_WORKER_SOURCE:JSON.stringify(dicomWorker.outputFiles[0].text),ARCHIVE_CHECK_WORKER_SOURCE:JSON.stringify(archiveWorker.outputFiles[0].text),PDF_STANDARD_FONTS:JSON.stringify(fontData),DICOM_SIGNING_CA_ORIGINS:JSON.stringify(network.signingCaOrigins),DICOM_DIGICERT_TIMESTAMP_FALLBACK:JSON.stringify(digicertTimestampFallback())}, legalComments:'inline', external:['fs','path'], loader:{'.wasm':'binary'}});
// Include installed dependency license texts in the artifact itself. Runtime and build-only
// licenses are included conservatively so downstream redistributors retain every notice.
const lock = JSON.parse(fs.readFileSync('package-lock.json'));
const notices = [`DICOM offline viewer ${lock.version}\n\nCornerstone3D (MIT), dicom-parser (MIT), PDF.js (Apache-2.0).\nDWV Simplistic was evaluated and not redistributed because GPL-3.0 was not selected for this pilot.\n\nBundled dependency licenses:\n`];
notices.push('Browser security verification includes code adapted from EA-PDF Generator. Copyright 2026 ThinkBox Digital. Apache-2.0.\n');
notices.push('The bundled public DigiCert Trusted Root G4 timestamp certificate comes from https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server .\n');
for (const [dir,pkg] of Object.entries(lock.packages)) {
  if (!dir) continue;
  if (!fs.existsSync(dir)) continue;
  const candidates = fs.readdirSync(dir).filter(name=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  for (const name of candidates) {
    if (!fs.statSync(`${dir}/${name}`).isFile()) continue;
    notices.push(`\n===== ${dir.replace(/^node_modules\//,'')} ${pkg.version} (${name}) =====\n${fs.readFileSync(`${dir}/${name}`,'utf8')}\n`);
  }
}
for (const name of ['Cornerstone-Codecs-MIT.txt','OpenJPEG-BSD-2-Clause.txt','CharLS-BSD-3-Clause.txt','libjpeg-turbo-LICENSE.md','libjpeg-turbo-README.ijg','Emscripten-LICENSE.txt','Codec-SOURCES.txt','EA-PDF-ICONS-NOTICE.txt','dcm4che-MPL-1.1.txt']) notices.push(`\n===== ${name} =====\n${fs.readFileSync(`../third_party_licenses/${name}`,'utf8')}\n`);
notices.push('\n===== DICOM dictionary source (MPL-1.1) =====\nGenerated from unmodified dcm4che 5.33.1 Tag and ElementDictionary; initial developer Agfa Healthcare. Upstream corresponding source and build instructions: https://github.com/dcm4che/dcm4che/tree/5.33.1 and https://github.com/dcm4che/dcm4che/archive/refs/tags/5.33.1.tar.gz . Complete generated dictionary source follows, also supplied as dicom-dictionary.json in the extension.\n'+fs.readFileSync('dicom-dictionary.json','utf8')+'\n');
for(const name of ['LICENSE_FOXIT','LICENSE_LIBERATION'])notices.push(`\n===== PDF.js standard fonts (${name}) =====\n${fs.readFileSync(`node_modules/pdfjs-dist/standard_fonts/${name}`,'utf8')}\n`);
const noticeText = notices.join('');
fs.writeFileSync('THIRD_PARTY_NOTICES.txt',noticeText);
const escapeHtml = text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const script = result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const favicon = `data:image/svg+xml;base64,${fs.readFileSync('extension/icons/dicom-pdf.svg').toString('base64')}`;
const pngIcon = `data:image/png;base64,${fs.readFileSync('extension/icons/icon-32.png').toString('base64')}`;
// One UI source keeps the extension and the saved offline viewer consistent.
const policy=`default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src blob:; connect-src blob: ${network.connectOrigins}; object-src 'none'; base-uri 'none'; form-action 'none'`;
const html = fs.readFileSync('extension/viewer.html','utf8')
  .replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
  .replace('<link rel="stylesheet" href="viewer.css">',()=>`<style>${fs.readFileSync('extension/viewer.css','utf8')}</style>`)
  .replace('<script type="module" src="viewer.js"></script>','')
  .replaceAll('__VIEWER_VERSION__',version)
  .replaceAll('icons/dicom-pdf.svg',favicon).replaceAll('icons/icon-32.png',pngIcon)
  .replace('__NOTICES__',()=>escapeHtml(noticeText)).replace('</body>',()=>`<script>${script}</script></body>`);
fs.mkdirSync('../src/main/resources', {recursive:true});
fs.writeFileSync('../src/main/resources/viewer.html',html);
console.log(`Built single-file viewer (${Buffer.byteLength(html)} bytes), all runtime code and notices inline.`);
await buildExtension(version);
