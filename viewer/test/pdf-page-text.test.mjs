import test from 'node:test';
import assert from 'node:assert/strict';
import {pdfPageText,readPdfPageText} from '../pdf-page-text.mjs';

test('page text keeps literal markup and line breaks without interpreting content',()=>{
  assert.deepEqual(pdfPageText([{str:'Synthetic report',hasEOL:true},{type:'beginMarkedContent'},
    {str:'<script>literal</script>'},{str:'second line',hasEOL:true}]),
    {text:'Synthetic report\n<script>literal</script> second line',truncated:false});
  assert.deepEqual(pdfPageText([]),{text:'',truncated:false});
});

test('character and item bounds signal truncation and do not split Unicode surrogate pairs',()=>{
  assert.deepEqual(pdfPageText([{str:'abcdef'}],{maxCharacters:3}),{text:'abc',truncated:true});
  assert.deepEqual(pdfPageText([{str:'a😀b'}],{maxCharacters:2}),{text:'a',truncated:true});
  assert.deepEqual(pdfPageText([{str:'first'},{str:'second'}],{maxItems:1}),{text:'first',truncated:true});
  const huge=pdfPageText([{str:'x'.repeat(1024*1024)}]);assert.equal(huge.text.length,128*1024);assert.equal(huge.truncated,true);
});

test('invalid limits and non-text records cannot become unbounded or fabricated report text',()=>{
  for(const maxCharacters of [0,-1,NaN,Infinity,128*1024+1])assert.throws(()=>pdfPageText([],{maxCharacters}),TypeError);
  assert.throws(()=>pdfPageText(null),TypeError);
  assert.throws(()=>pdfPageText([],{maxItems:10001}),TypeError);
  assert.deepEqual(pdfPageText([null,{str:17},{str:{toString(){throw Error('must not execute');}}}]),{text:'',truncated:false});
});

test('worker text is consumed incrementally and cancelled at the visible budget',async()=>{
  let reads=0,cancelled=0,released=0;
  const reader={read:async()=>{reads++;return {done:false,value:{items:[{str:'x'.repeat(1024*1024)}]}};},
    cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}};
  const result=await readPdfPageText({streamTextContent:()=>({getReader:()=>reader})});
  assert.equal(result.text.length,128*1024);assert.equal(result.truncated,true);
  assert.equal(reads,1);assert.equal(cancelled,1);assert.equal(released,1);
});

test('stale report selection cancels worker text before publishing it',async()=>{
  let current=true,cancelled=0;
  const reader={read:async()=>{current=false;return {done:false,value:{items:[{str:'Prior report'}]}};},
    cancel:async()=>{cancelled++;},releaseLock(){}};
  await assert.rejects(readPdfPageText({streamTextContent:()=>({getReader:()=>reader})},{isCurrent:()=>current}),{name:'AbortError'});
  assert.equal(cancelled,1);
});

test('non-text records also consume the streamed item budget',async()=>{
  let cancelled=0,reads=0;
  const reader={read:async()=>{reads++;return {done:false,value:{items:Array(10001).fill(null)}};},
    cancel:async()=>{cancelled++;},releaseLock(){}};
  assert.deepEqual(await readPdfPageText({streamTextContent:()=>({getReader:()=>reader})}),{text:'',truncated:true});
  assert.equal(reads,1);assert.equal(cancelled,1);
});
