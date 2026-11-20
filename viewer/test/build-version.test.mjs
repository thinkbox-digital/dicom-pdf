import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planViewerVersion} from '../build-version.mjs';
import {publishViewerBuild} from '../build-publication.mjs';

test('each rebuild increments minor, resets patch, and keeps dependencies and packaging versions aligned',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dicom-viewer-version-'));
  const directory=path.join(root,'viewer');
  try{
    fs.mkdirSync(path.join(directory,'extension'),{recursive:true});
    const write=(name,data)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(data));
    write('package.json',{version:'0.5.9',dependencies:{example:'2.3.4'}});
    write('package-lock.json',{version:'0.5.9',packages:{'':{version:'0.5.9'},'node_modules/example':{version:'2.3.4'}}});
    write('extension/manifest.json',{manifest_version:3,version:'0.5.9'});
    fs.writeFileSync(path.join(directory,'README.md'),'# Offline attachment viewer — 0.5.9\n`dicom-pdf-chrome-0.5.9.zip`');
    fs.writeFileSync(path.join(directory,'extension/README.md'),'# DICOM PDF Viewer — Chrome extension 0.1.0\n`dicom-pdf-chrome-0.1.0.zip`');
    fs.writeFileSync(path.join(root,'README.md'),'(`0.5.9`) embeds viewer `0.5.9` in new archives.\n');
    const first=planViewerVersion(directory);
    assert.equal(first.version,'0.6.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'package.json'))).version,'0.5.9');
    for(const [filename,content] of first.files)fs.writeFileSync(filename,content);
    const second=planViewerVersion(directory);
    assert.equal(second.version,'0.7.0');
    for(const [filename,content] of second.files)fs.writeFileSync(filename,content);
    for(const file of ['package.json','package-lock.json','extension/manifest.json'])
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory,file))).version,'0.7.0');
    const lock=JSON.parse(fs.readFileSync(path.join(directory,'package-lock.json')));
    assert.equal(lock.packages[''].version,'0.7.0');assert.equal(lock.packages['node_modules/example'].version,'2.3.4');
    assert.match(fs.readFileSync(path.join(directory,'README.md'),'utf8'),/dicom-pdf-chrome-0\.7\.0\.zip/);
    assert.match(fs.readFileSync(path.join(directory,'extension/README.md'),'utf8'),/Chrome extension 0\.7\.0\n`dicom-pdf-chrome-0\.7\.0\.zip`/);
    assert.equal(fs.readFileSync(path.join(root,'README.md'),'utf8'),'(`0.5.9`) embeds viewer `0.7.0` in new archives.\n');
    write('extension/manifest.json',{version:'0.1.0'});
    assert.throws(()=>planViewerVersion(directory),/must match/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'package.json'))).version,'0.7.0');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('publication restores the previous artifact when a later output cannot be installed',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dicom-viewer-publication-'));
  try{
    const current=path.join(root,'viewer.html');
    const next=path.join(root,'new.html');
    fs.writeFileSync(current,'working viewer');
    fs.writeFileSync(next,'new viewer');
    assert.throws(()=>publishViewerBuild(root,[[next,current],[path.join(root,'missing'),path.join(root,'extension')]]));
    assert.equal(fs.readFileSync(current,'utf8'),'working viewer');
    assert.equal(fs.existsSync(path.join(root,'extension')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
