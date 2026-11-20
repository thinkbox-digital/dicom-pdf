import test from 'node:test';
import assert from 'node:assert/strict';
import {paneResizeLimits,resizedPaneWidth} from '../pane-resize.mjs';

test('desktop bounds retain room for the opposite pane and reader',()=>{
  const bounds=paneResizeLimits({side:'navigation',width:1200,other:360});
  assert.deepEqual(bounds,{min:180,max:512});
  assert.equal(resizedPaneWidth(300,1000,'navigation',bounds),512);
  assert.equal(resizedPaneWidth(300,-1000,'navigation',bounds),180);
  assert.equal(paneResizeLimits({side:'navigation',width:1200,other:0}).max,640);
});
test('metadata divider moves in the opposite direction, with bounded overlay width',()=>{
  const bounds=paneResizeLimits({side:'details',width:480,narrow:true});
  assert.deepEqual(bounds,{min:200,max:456});
  assert.equal(resizedPaneWidth(290,-50,'details',bounds),340);
  assert.equal(resizedPaneWidth(290,50,'details',bounds),240);
  assert.equal(resizedPaneWidth(290,-1000,'details',bounds),456);
});
test('narrow layouts and undersized windows never produce negative bounds',()=>{
  for(const width of [0,100,320,480,850])for(const side of ['navigation','details']){
    const bounds=paneResizeLimits({side,width,narrow:true});
    assert.ok(bounds.min>=0&&bounds.max>=bounds.min);
    assert.ok(resizedPaneWidth(300,500,side,bounds)<=width);
  }
});
