import fs from 'node:fs';
import path from 'node:path';

/** Plan a minor-version update before building the extension. */
export function planViewerVersion(directory){
  const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  const pkg=read('package.json'),lock=read('package-lock.json'),manifest=read('extension/manifest.json');
  if(lock.version!==pkg.version||lock.packages[''].version!==pkg.version||manifest.version!==pkg.version)
    throw new Error('Viewer package, lockfile and extension versions must match before rebuilding.');
  const parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
  if(!parts||Number(parts[2])>=65535)throw new Error('Viewer version cannot be advanced as a Chrome-compatible minor version.');
  const version=`${parts[1]}.${Number(parts[2])+1}.0`;
  pkg.version=lock.version=lock.packages[''].version=manifest.version=version;
  const files=new Map();
  for(const [name,value] of [['package.json',pkg],['package-lock.json',lock],['extension/manifest.json',manifest]])
    files.set(path.resolve(directory,name),JSON.stringify(value,null,2)+'\n');
  for(const name of ['README.md','extension/README.md','THIRD_PARTY_NOTICES.txt','../docs/GUIDE.md','../README.md']){
    const filename=path.resolve(directory,name);if(!fs.existsSync(filename))continue;
    const text=fs.readFileSync(filename,'utf8')
      .replace(/dicom-pdf-chrome-\d+\.\d+\.\d+\.zip/g,`dicom-pdf-chrome-${version}.zip`)
      .replace(/^(# Chrome extension viewer — |# DICOM PDF Viewer — Chrome extension |DICOM offline viewer )\d+\.\d+\.\d+/m,(_,prefix)=>prefix+version);
    files.set(filename,text);
  }
  return {version,files};
}
