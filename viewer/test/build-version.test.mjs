import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {advanceViewerVersion} from '../build-version.mjs';

test('each rebuild increments minor, resets patch, and keeps dependencies and packaging versions aligned',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dicom-viewer-version-'));
  try{
    fs.mkdirSync(path.join(directory,'extension'));
    const write=(name,data)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(data));
    write('package.json',{version:'0.5.9',dependencies:{example:'2.3.4'}});
    write('package-lock.json',{version:'0.5.9',packages:{'':{version:'0.5.9'},'node_modules/example':{version:'2.3.4'}}});
    write('extension/manifest.json',{manifest_version:3,version:'0.5.9'});
    fs.writeFileSync(path.join(directory,'README.md'),'# Offline attachment viewer — 0.5.9\n`dicom-pdf-chrome-0.5.9.zip`');
    fs.writeFileSync(path.join(directory,'extension/README.md'),'# DICOM PDF Viewer — Chrome extension 0.1.0\n`dicom-pdf-chrome-0.1.0.zip`');
    assert.equal(advanceViewerVersion(directory),'0.6.0');
    assert.equal(advanceViewerVersion(directory),'0.7.0');
    for(const file of ['package.json','package-lock.json','extension/manifest.json'])
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory,file))).version,'0.7.0');
    const lock=JSON.parse(fs.readFileSync(path.join(directory,'package-lock.json')));
    assert.equal(lock.packages[''].version,'0.7.0');assert.equal(lock.packages['node_modules/example'].version,'2.3.4');
    assert.match(fs.readFileSync(path.join(directory,'README.md'),'utf8'),/dicom-pdf-chrome-0\.7\.0\.zip/);
    assert.match(fs.readFileSync(path.join(directory,'extension/README.md'),'utf8'),/Chrome extension 0\.7\.0\n`dicom-pdf-chrome-0\.7\.0\.zip`/);
    write('extension/manifest.json',{version:'0.1.0'});
    assert.throws(()=>advanceViewerVersion(directory),/must match/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'package.json'))).version,'0.7.0');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
