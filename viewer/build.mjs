import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planViewerVersion} from './build-version.mjs';
import {publishViewerBuild} from './build-publication.mjs';
import {buildExtension} from './extension/package.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
const {version,files}=planViewerVersion(here);
// Include installed dependency license texts in the artifact itself. Runtime and build-only
// licenses are included conservatively so downstream redistributors retain every notice.
const lock = JSON.parse(fs.readFileSync('package-lock.json'));
const notices = [`DICOM offline viewer ${version}\n\nCornerstone3D (MIT), dicom-parser (MIT), PDF.js (Apache-2.0).\nDWV Simplistic was evaluated and not redistributed because GPL-3.0 was not selected for this pilot.\n\nBundled dependency licenses:\n`];
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
const target=path.resolve('../target');
fs.mkdirSync(target,{recursive:true});
const staging=fs.mkdtempSync(path.join(target,'viewer-build-'));
const extension=path.join(target,'chrome-extension');
const zipName=`dicom-pdf-chrome-${version}.zip`;
const archive=path.join(target,zipName);
try {
  const stageExtension=path.join(staging,'chrome-extension');
  const stageArchive=path.join(staging,zipName);
  await buildExtension({
    manifest:JSON.parse(files.get(path.resolve('extension/manifest.json'))),
    notices:noticeText,
    installation:files.get(path.resolve('extension/README.md')),
    output:stageExtension,
    archive:stageArchive
  });
  files.set(path.resolve('THIRD_PARTY_NOTICES.txt'),noticeText);
  const artifacts=[[stageExtension,extension],[stageArchive,archive]];
  for (const [destination,content] of files) {
    const source=path.join(staging,`file-${artifacts.length}`);
    fs.writeFileSync(source,content);
    artifacts.push([source,destination]);
  }
  const lock=path.join(target,'.viewer-publication');
  fs.mkdirSync(lock);
  try {
    if(planViewerVersion(here).version!==version)
      throw new Error('Another build advanced the viewer version. Run this build again.');
    publishViewerBuild(staging,artifacts);
  } finally {
    fs.rmdirSync(lock);
  }
} finally {
  fs.rmSync(staging,{recursive:true,force:true});
}
console.log(`Built unpacked Chrome extension: ${extension}\nZIP: ${archive}`);
