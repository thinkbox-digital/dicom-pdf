import test from 'node:test';
import assert from 'node:assert/strict';
import {bindLocalInputs} from '../local-inputs.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
class Element extends EventTarget{files=[];clicks=0;click(){this.clicks++;}}
class Root extends EventTarget{
  elements=new Map(['pdf-file','open-pdf'].map(id=>[id,new Element()]));
  getElementById(id){return this.elements.get(id);}
}
function drop(root,files,items=[]){
  const event=new Event('drop',{cancelable:true});
  Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],items,files}});
  root.dispatchEvent(event);
  return event;
}
function pick(root,file){
  const input=root.getElementById('pdf-file');
  input.files=[file];
  input.dispatchEvent(new Event('change'));
}
function file(name,body){return new File([body],name);}
async function until(predicate){for(let index=0;index<50&&!predicate();index++)await tick();assert.ok(predicate());}

test('Open PDF activates the native picker and accepts a selected PDF',async()=>{
  const root=new Root(),opened=[];
  const bindings=bindLocalInputs({root,loadPdf:(blob,options)=>opened.push({blob,options}),onError:assert.fail});
  try{
    root.getElementById('open-pdf').dispatchEvent(new Event('click'));
    assert.equal(root.getElementById('pdf-file').clicks,1);
    const pdf=file('exam.pdf','%PDF-1.4\n');
    pick(root,pdf);await until(()=>opened.length);
    assert.deepEqual(opened,[{blob:pdf,options:{name:'exam.pdf'}}]);
    assert.equal(root.getElementById('pdf-file').value,'');
  }finally{bindings.destroy();}
  root.getElementById('open-pdf').dispatchEvent(new Event('click'));
  assert.equal(root.getElementById('pdf-file').clicks,1);
});

test('a delayed PDF drop cannot replace a later PDF selection',async()=>{
  const root=new Root(),calls=[],gate=deferred();let reading=false;
  const pdf=file('old.pdf','%PDF-1.4\n'),next=file('new.pdf','%PDF-1.4\n');
  Object.defineProperty(pdf,'slice',{value:()=>({text:()=>{reading=true;return gate.promise;}})});
  const bindings=bindLocalInputs({root,loadPdf:blob=>calls.push(blob.name),onError:assert.fail});
  try{
    assert.equal(drop(root,[pdf]).defaultPrevented,true);await until(()=>reading);
    pick(root,next);await until(()=>calls.length);
    gate.resolve('%PDF-');await tick();
    assert.deepEqual(calls,['new.pdf']);
  }finally{bindings.destroy();}
});

test('large PDF drops forward a Blob without allocating complete PDF bytes',async()=>{
  const root=new Root(),opened=[];let reads=0;
  const pdf=file('SYNTHETIC-PRIVATE.pdf','%PDF-1.4\n');
  Object.defineProperties(pdf,{size:{value:385*1024*1024},arrayBuffer:{value:()=>{reads++;throw new Error();}}});
  const bindings=bindLocalInputs({root,loadPdf:blob=>opened.push(blob),onError:assert.fail});
  try{drop(root,[pdf]);await until(()=>opened.length);assert.equal(reads,0);assert.equal(opened[0],pdf);}
  finally{bindings.destroy();}
});

test('only a single PDF can enter the viewer from a picker or drop',async()=>{
  const root=new Root(),errors=[];
  const bindings=bindLocalInputs({root,loadPdf:()=>assert.fail('Unsupported input reached the PDF reader'),onError:message=>errors.push(message)});
  const dicom=file('image.dcm','DICOM'),zip=file('images.pdf','PK'),pdf=file('exam.pdf','%PDF-1.4\n');
  const directory={kind:'file',webkitGetAsEntry:()=>({isDirectory:true})};
  try{
    for(const [index,[files,items]] of [[[dicom],[]],[[zip],[]],[[pdf,pdf],[]],[[pdf],[directory]]].entries()){
      assert.equal(drop(root,files,items).defaultPrevented,true);
      await until(()=>errors.length>index);
    }
    pick(root,zip);await until(()=>errors.length===5);
    assert.ok(errors.every(message=>message==='Choose one converted DICOM PDF.'));
  }finally{bindings.destroy();}
});

test('errors from the PDF reader reach the viewer',async()=>{
  const root=new Root(),errors=[];
  const bindings=bindLocalInputs({root,loadPdf:async()=>{throw new Error('This PDF does not contain a supported DICOM archive.');},onError:message=>errors.push(message)});
  try{
    drop(root,[file('ordinary.pdf','%PDF-1.4\n')]);await until(()=>errors.length);
    assert.deepEqual(errors,['This PDF does not contain a supported DICOM archive.']);
  }finally{bindings.destroy();}
});
