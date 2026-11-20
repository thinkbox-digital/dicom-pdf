import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {selectivePdfAttachments} from '../build-pdf-worker.mjs';
import {viewerTrustRoots} from '../build-trust-policy.mjs';
import {certificateNetwork,digicertTimestampFallback} from '../build-certificate-network.mjs';

export async function buildExtension(version) {
  const trustRoots=viewerTrustRoots();
  const network=certificateNetwork();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewer = path.dirname(here);
  const root = path.dirname(viewer);
  const output = path.join(root,'target/chrome-extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(here,'manifest.json'),'utf8'));
  if(manifest.version!==version)
    throw new Error('The extension and viewer application versions must match.');
  const archive = path.join(root,`target/dicom-pdf-chrome-${manifest.version}.zip`);
  const fontDirectory=path.join(viewer,'node_modules/pdfjs-dist/standard_fonts');
  const fontData=Object.fromEntries(fs.readdirSync(fontDirectory).filter(name=>/\.(pfb|ttf)$/.test(name)).map(name=>[name,fs.readFileSync(path.join(fontDirectory,name)).toString('base64')]));
  fs.rmSync(output,{recursive:true,force:true});
  fs.mkdirSync(output,{recursive:true});
  const noticePath = path.join(viewer,'THIRD_PARTY_NOTICES.txt');
  if (!fs.existsSync(noticePath)) throw new Error('Run npm run build in viewer/ first to generate dependency notices.');
  const notices = fs.readFileSync(noticePath,'utf8');
  const escape = value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  for (const name of ['viewer.html','viewer.css']) {
    let value = fs.readFileSync(path.join(here,name),'utf8');
    if (name.endsWith('.html')) value = value.replaceAll('__NOTICES__',escape(notices)).replaceAll('__VIEWER_VERSION__',version);
    fs.writeFileSync(path.join(output,name),value);
  }
  manifest.optional_host_permissions.push(...network.optionalHosts);
  manifest.content_security_policy.extension_pages=manifest.content_security_policy.extension_pages
    .replace(/connect-src ([^;]+);/,`connect-src $1 ${network.connectOrigins};`);
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.cpSync(path.join(here,'icons'),path.join(output,'icons'),{recursive:true});
  fs.copyFileSync(path.join(viewer,'dicom-dictionary.json'),path.join(output,'dicom-dictionary.json'));
  await esbuild.build({
    absWorkingDir:viewer,entryPoints:['extension/entry.js'],outfile:path.join(output,'viewer.js'),
    bundle:true,minify:true,format:'iife',target:['chrome120'],legalComments:'inline',external:['fs','path'],
    define:{PDF_WORKER_URL:JSON.stringify('pdf.worker.mjs'),PDF_WORKER_SOURCE:JSON.stringify(''),DICOM_WORKER_URL:JSON.stringify('dicom.worker.mjs'),DICOM_WORKER_SOURCE:JSON.stringify(''),ARCHIVE_CHECK_WORKER_URL:JSON.stringify('archive-check.worker.mjs'),PDF_STANDARD_FONTS:JSON.stringify(fontData),DICOM_SIGNING_CA_ORIGINS:JSON.stringify(network.signingCaOrigins),DICOM_DIGICERT_TIMESTAMP_FALLBACK:JSON.stringify(digicertTimestampFallback())},loader:{'.wasm':'binary'}
  });
  await esbuild.build({absWorkingDir:viewer,entryPoints:['archive-verification-worker.mjs'],outfile:path.join(output,'archive-check.worker.mjs'),bundle:true,minify:true,format:'esm',target:['chrome120'],legalComments:'inline',define:{DICOM_TRUST_ROOTS:trustRoots}});
  await esbuild.build({
    absWorkingDir:viewer,entryPoints:['dicom-worker.mjs'],outfile:path.join(output,'dicom.worker.mjs'),
    bundle:true,minify:true,format:'esm',target:['chrome120'],legalComments:'inline',external:['fs','path'],loader:{'.wasm':'binary'}
  });
  await esbuild.build({
    absWorkingDir:viewer,entryPoints:['extension/background.js'],outfile:path.join(output,'background.js'),
    bundle:true,minify:true,format:'esm',target:['chrome120'],legalComments:'inline'
  });
  await esbuild.build({absWorkingDir:viewer,entryPoints:['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
    plugins:[selectivePdfAttachments(viewer)],outfile:path.join(output,'pdf.worker.mjs'),format:'esm',legalComments:'inline'});
  for (const [source,name] of [[noticePath,'THIRD_PARTY_NOTICES.txt'],[path.join(root,'LICENSE'),'LICENSE'],[path.join(root,'NOTICE'),'NOTICE'],[path.join(here,'README.md'),'INSTALL.md']]) fs.copyFileSync(source,path.join(output,name));
  // Keep the distributable dependency-free and portable; Python is already used by verification tooling.
  execFileSync('python3',['-c',`import pathlib,zipfile,sys
source=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for item in sorted(source.rglob('*')):
  if item.is_file():
   metadata=zipfile.ZipInfo(item.relative_to(source).as_posix(),(2026,11,14,0,0,0)); metadata.compress_type=zipfile.ZIP_DEFLATED; metadata.external_attr=0o644 << 16
   archive.writestr(metadata,item.read_bytes())
`,output,archive]);
  console.log(`Built unpacked Chrome extension: ${output}\nZIP: ${archive}`);
}
