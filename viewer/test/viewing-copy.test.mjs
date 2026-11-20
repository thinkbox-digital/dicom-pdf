import test from 'node:test';
import assert from 'node:assert/strict';
import {drawViewingOverlays} from '../viewing-copy.mjs';
function harness(){const calls=[];return {calls,save(){calls.push(['save']);},restore(){calls.push(['restore']);},beginPath(){},rect(...v){calls.push(['rect',...v]);},clip(){},scale(...v){calls.push(['scale',...v]);},measureText:text=>({width:text.length*6}),fillText(...v){calls.push(['text',...v]);}};}
const block={text:'Series one\nImage 2 of 3',x:12,y:10,width:150,height:40,font:'12px sans-serif',size:12,lineHeight:18};
test('visible text is drawn inertly, clipped to the image above the copy footer',()=>{
  const c=harness();drawViewingOverlays(c,[block],{width:300,height:200});
  assert.deepEqual(c.calls.filter(v=>v[0]==='text').map(v=>v[1]),['Series one','Image 2 of 3']);
  assert.deepEqual(c.calls.find(v=>v[0]==='rect'),['rect',0,0,300,200]);
  assert.equal(c.calls.filter(v=>v[0]==='save').length,c.calls.filter(v=>v[0]==='restore').length);
});
test('Info-off exports add no text; right-aligned and scaled blocks keep their positions',()=>{
  const c=harness();drawViewingOverlays(c,[],{width:300,height:200});assert.equal(c.calls.some(v=>v[0]==='text'),false);
  drawViewingOverlays(c,[{...block,text:'WW 0.5',align:'right'}],{width:600,height:400,scaleX:2,scaleY:2});
  assert.deepEqual(c.calls.find(v=>v[0]==='text'),['text','WW 0.5',162,19]);
});
test('long text wraps within bounded edge blocks without filling the center',()=>{
  const c=harness();drawViewingOverlays(c,[{...block,text:'<script>untrusted-text</script>'.repeat(100),width:48,height:36}],{width:300,height:200});
  const text=c.calls.filter(v=>v[0]==='text');assert.equal(text.length,2);assert.ok(text.every(v=>v[1].length<=8));
  assert.throws(()=>drawViewingOverlays(c,[block],{width:0,height:100}),/dimensions/);
});
