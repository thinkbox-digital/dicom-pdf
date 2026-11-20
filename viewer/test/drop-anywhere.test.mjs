import test from 'node:test';
import assert from 'node:assert/strict';
import {bindLocalInputs} from '../local-inputs.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
class Root extends EventTarget{
  registrations=[];getElementById(){return null;}
  addEventListener(type,handler,options){this.registrations.push({type,options});super.addEventListener(type,handler,options);}
}
function event(type,data){const value=new Event(type,{cancelable:true});Object.defineProperty(value,'dataTransfer',{value:data});return value;}
test('captures PDF drops before descendant controls and removes capture listeners on teardown',async()=>{
  const root=new Root(),calls=[],file=new File(['%PDF-1.7'],'exam.pdf');
  const bindings=bindLocalInputs({root,loadPdf:pdf=>calls.push(pdf.name),onError:assert.fail});
  assert.equal(root.registrations.find(r=>r.type==='drop').options.capture,true);
  assert.equal(root.registrations.find(r=>r.type==='dragover').options.capture,true);
  const drop=event('drop',{types:['Files'],files:[file],items:[]});root.dispatchEvent(drop);await tick();
  assert.equal(drop.defaultPrevented,true);assert.deepEqual(calls,['exam.pdf']);
  bindings.destroy();root.dispatchEvent(event('drop',{types:['Files'],files:[file],items:[]}));await tick();assert.equal(calls.length,1);
});
test('accepts a PDF provided through DataTransfer items when FileList/types are empty',async()=>{
  const root=new Root(),calls=[],pdf=new File(['%PDF-1.7'],'exam.pdf',{type:'application/pdf'});
  const bindings=bindLocalInputs({root,loadPdf:file=>calls.push(file),onError:assert.fail});
  const drop=event('drop',{types:[],files:[],items:[{kind:'file',getAsFile:()=>pdf}]});root.dispatchEvent(drop);await tick();
  assert.equal(drop.defaultPrevented,true);assert.deepEqual(calls,[pdf]);bindings.destroy();
});
test('text and remote URL drops do not trigger file reads or network loading',async()=>{
  const root=new Root();let opened=0;
  const bindings=bindLocalInputs({root,loadPdf:()=>opened++,onError:assert.fail});
  const drop=event('drop',{types:['text/uri-list'],files:[],items:[{kind:'string',type:'text/uri-list'}]});root.dispatchEvent(drop);await tick();
  assert.equal(drop.defaultPrevented,false);assert.equal(opened,0);bindings.destroy();
});
