import test from 'node:test';
import assert from 'node:assert/strict';
import {xmpInstanceId} from '../pdf-security-input.mjs';

const ns='http://ns.adobe.com/xap/1.0/mm/';
const packet=content=>`<xmp xmlns:m="${ns}">${content}</xmp>`;
test('large XMP identifies one namespace-qualified instance without building a second XML tree',async()=>{
  const packetBody='<inventory>'+'x'.repeat(17*1024*1024)+'</inventory><m:InstanceID>uuid:123</m:InstanceID>';
  assert.equal(await xmpInstanceId(packet(packetBody)),'uuid:123');
});
test('XMP lookup handles namespace changes and rejects duplicate or malformed identifiers',async()=>{
  const id='<m:InstanceID>uuid:123</m:InstanceID>';
  assert.equal(await xmpInstanceId(packet('<box xmlns:m="other">'+id+'</box>'+id)),'uuid:123');
  assert.equal(await xmpInstanceId(packet('<InstanceID xmlns="'+ns+'"><![CDATA[uuid:123]]></InstanceID>')),'uuid:123');
  for(const raw of [packet(id+id),packet(id+'</bad>'),packet('<m:InstanceID><b/></m:InstanceID>'),
    '<!DOCTYPE xmp>'+packet(id),packet('<m:InstanceID>'+'x'.repeat(1025)+'</m:InstanceID>')]){
    assert.equal(await xmpInstanceId(raw),undefined);
  }
});
