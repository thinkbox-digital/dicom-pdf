import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecodedImageCache} from '../decoded-image-cache.mjs';

function image(bytes,fill=7){const pixels=new Uint8Array(bytes).fill(fill);return {image:{getPixelData:()=>pixels},metadata:{synthetic:true}};}
const malformed=byteLength=>({image:{getPixelData:()=>({byteLength})}});

test('LRU stays within its actual decoded-pixel byte budget and protects the newest frame',()=>{
  const removed=[],cache=createDecodedImageCache({maxBytes:8,onEvict:(id,decoded)=>removed.push([id,decoded])});
  const a=image(4),b=image(4),c=image(4);
  assert.equal(cache.set('a',a),cache);cache.set('b',b).set('c',c);
  assert.equal(cache.size,2);assert.equal(cache.byteLength,8);assert.deepEqual([...cache.keys()],['b','c']);
  assert.deepEqual(removed,[['a',a]]);assert.equal(cache.has('a'),false);assert.equal(cache.get('missing'),undefined);
});

test('get revisits protect frames while peek and has leave recency unchanged',()=>{
  const cache=createDecodedImageCache({maxBytes:8}),a=image(4),b=image(4),c=image(4);
  cache.set('a',a).set('b',b);assert.equal(cache.get('a'),a);assert.deepEqual([...cache.keys()],['b','a']);
  cache.set('c',c);assert.equal(cache.has('b'),false);assert.deepEqual([...cache.keys()],['a','c']);
  assert.equal(cache.peek('a'),a);assert.equal(cache.has('a'),true);assert.deepEqual([...cache.keys()],['a','c']);
  cache.set('b',b);assert.equal(cache.has('a'),false);assert.deepEqual([...cache.keys()],['c','b']);
});

test('replacement accounts for the prior buffer and evicts only enough older frames',()=>{
  const removed=[],cache=createDecodedImageCache({maxBytes:10,onEvict:(id,value)=>removed.push([id,value])});
  const a=image(4),b=image(3),replacement=image(6),larger=image(8);
  cache.set('a',a).set('b',b).set('a',replacement);
  assert.equal(cache.byteLength,9);assert.equal(cache.size,2);assert.deepEqual([...cache.keys()],['b','a']);assert.deepEqual(removed,[['a',a]]);
  cache.set('a',larger);assert.equal(cache.byteLength,8);assert.equal(cache.size,1);assert.deepEqual([...cache.entries()],[['a',larger]]);
  assert.deepEqual(removed,[['a',a],['a',replacement],['b',b]]);
});

test('actual typed-array byte lengths are counted and decoded objects/pixels are never copied or changed',()=>{
  const pixels=new Uint16Array([1,300,4095]),decoded={image:{getPixelData:()=>pixels},metadata:{unchanged:true}},before=pixels.slice();
  const cache=createDecodedImageCache({maxBytes:6});cache.set('frame',decoded);
  assert.equal(cache.byteLength,6);assert.equal(cache.get('frame'),decoded);assert.equal(cache.peek('frame').image.getPixelData(),pixels);
  assert.equal(cache.peek('frame').image.getPixelData().buffer,pixels.buffer);assert.deepEqual(pixels,before);
  pixels[0]=19;assert.equal(cache.get('frame').image.getPixelData()[0],19);assert.equal(cache.get('frame').metadata,decoded.metadata);
});

test('invalid or oversized insertion leaves previous content, accounting and recency unchanged',()=>{
  const removed=[],cache=createDecodedImageCache({maxBytes:8,onEvict:(id,value)=>removed.push([id,value])}),a=image(4),b=image(3);
  cache.set('a',a).set('b',b);
  for(const bad of [image(9),malformed(Infinity),malformed(NaN),malformed(-1),malformed(1.5),malformed(undefined),null,{},
    {image:{getPixelData:()=>{throw new Error('PRIVATE-SYNTHETIC-FILE');}}}]){
    assert.throws(()=>cache.set('a',bad),error=>{
      assert.ok(error instanceof RangeError||error instanceof TypeError);assert.ok(!error.message.includes('PRIVATE'));return true;
    });
    assert.deepEqual([...cache.keys()],['a','b']);assert.equal(cache.byteLength,7);assert.equal(cache.peek('a'),a);assert.equal(cache.size,2);
  }
  assert.deepEqual(removed,[]);
});

test('delete and clear notify every removed frame exactly once and keep empty operations inert',()=>{
  const removed=[],cache=createDecodedImageCache({maxBytes:9,onEvict:(id,decoded)=>removed.push([id,decoded])}),a=image(2),b=image(3),c=image(4);
  cache.set('a',a).set('b',b).set('c',c);
  assert.equal(cache.delete('missing'),false);assert.equal(cache.delete('b'),true);assert.equal(cache.delete('b'),false);assert.equal(cache.byteLength,6);
  cache.clear();cache.clear();assert.equal(cache.size,0);assert.equal(cache.byteLength,0);assert.deepEqual([...cache.entries()],[]);
  assert.deepEqual(removed,[['b',b],['a',a],['c',c]]);
});

test('eviction callback failures do not corrupt cache accounting or interrupt later notifications',()=>{
  const removed=[],cache=createDecodedImageCache({maxBytes:4,onEvict:id=>{removed.push(id);throw new Error('External cache unavailable.');}});
  assert.doesNotThrow(()=>cache.set('a',image(2)).set('b',image(2)).set('c',image(4)));
  assert.deepEqual(removed,['a','b']);assert.equal(cache.byteLength,4);assert.deepEqual([...cache.keys()],['c']);
  assert.doesNotThrow(()=>cache.clear());assert.deepEqual(removed,['a','b','c']);assert.equal(cache.byteLength,0);
});

test('callbacks see a coherent bounded cache and reentrant removals are safely delivered',()=>{
  const removed=[],states=[];let cache;
  cache=createDecodedImageCache({maxBytes:8,onEvict:id=>{
    removed.push(id);states.push({bytes:cache.byteLength,keys:[...cache.keys()]});
    if(id==='a'){assert.ok(cache.get('c'));cache.delete('b');}
  }});
  cache.set('a',image(4)).set('b',image(4)).set('c',image(4));
  assert.deepEqual(removed,['a','b']);assert.deepEqual(states,[{bytes:8,keys:['b','c']},{bytes:4,keys:['c']}]);
  assert.equal(cache.byteLength,4);assert.equal(cache.size,1);assert.deepEqual([...cache.keys()],['c']);
});

test('budget and callback configuration is validated; a zero-byte budget remains usable',()=>{
  for(const maxBytes of [-1,Infinity,NaN,1.5,'8'])assert.throws(()=>createDecodedImageCache({maxBytes}),RangeError);
  assert.throws(()=>createDecodedImageCache({onEvict:'not a function'}),TypeError);
  const cache=createDecodedImageCache({maxBytes:0});assert.throws(()=>cache.set('nonempty',image(1)),RangeError);
  const empty=image(0);cache.set('empty',empty);assert.equal(cache.byteLength,0);assert.equal(cache.size,1);assert.equal(cache.get('empty'),empty);cache.clear();
});
