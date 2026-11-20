import fs from 'node:fs';
import path from 'node:path';

/** Advance the application minor version, leaving dependency versions unchanged. */
export function advanceViewerVersion(directory){
  const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  const pkg=read('package.json'),lock=read('package-lock.json'),manifest=read('extension/manifest.json');
  if(lock.version!==pkg.version||lock.packages[''].version!==pkg.version||manifest.version!==pkg.version)
    throw new Error('Viewer package, lockfile and extension versions must match before rebuilding.');
  const parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
  if(!parts||Number(parts[2])>=65535)throw new Error('Viewer version cannot be advanced as a Chrome-compatible minor version.');
  const version=`${parts[1]}.${Number(parts[2])+1}.0`;
  pkg.version=lock.version=lock.packages[''].version=manifest.version=version;
  for(const [name,value] of [['package.json',pkg],['package-lock.json',lock],['extension/manifest.json',manifest]])
    fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
  for(const name of ['README.md','extension/README.md','THIRD_PARTY_NOTICES.txt','../docs/GUIDE.md']){
    const filename=path.join(directory,name);if(!fs.existsSync(filename))continue;
    const text=fs.readFileSync(filename,'utf8')
      .replace(/dicom-pdf-chrome-\d+\.\d+\.\d+\.zip/g,`dicom-pdf-chrome-${version}.zip`)
      .replace(/^(# Offline attachment viewer — |# DICOM PDF Viewer — Chrome extension |DICOM offline viewer )\d+\.\d+\.\d+/m,(_,prefix)=>prefix+version);
    fs.writeFileSync(filename,text);
  }
  return version;
}

