import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoadingDialog} from '../loading-dialog.mjs';

test('an old input cannot dismiss or overwrite the loading dialog for its replacement',()=>{
  const message={textContent:''},dialog=new EventTarget();dialog.open=false;
  dialog.querySelector=()=>message;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  const loading=createLoadingDialog(dialog);
  loading.start(1,'First file');loading.start(2,'Replacement file');
  loading.update(1,'Old progress');loading.finish(1);
  assert.equal(dialog.open,true);assert.equal(message.textContent,'Replacement file');
  const cancel=new Event('cancel',{cancelable:true});dialog.dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);
  loading.update(2,'Opening image');assert.equal(message.textContent,'Opening image');
  loading.finish(2);assert.equal(dialog.open,false);
});
