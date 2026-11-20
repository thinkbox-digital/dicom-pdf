import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createPdfRangeHasher} from '../security-hash.mjs';

test('incremental PDF hashes share checkpoints without including signature or credential gaps',async()=>{
  const bytes=Buffer.alloc(18*1024*1024);
  for(let index=0;index<bytes.length;index++)bytes[index]=(index%251)^(index>>7);
  const blob=new Blob([bytes]);
  const hash=createPdfRangeHasher(blob);
  const cases=[
    [blob.size-51,[[blob.size-500,blob.size-99]]],
    [blob.size,[[blob.size-48,blob.size-2]]],
    [blob.size,[[blob.size-1200,blob.size-900],[blob.size-48,blob.size-2]]],
    [1000,[[50,100],[110,155]]]
  ];
  for(const [end,gaps] of cases){
    const expected=createHash('sha256');
    let position=0;
    for(const [start,stop] of gaps){
      expected.update(bytes.subarray(position,start));
      position=stop;
    }
    expected.update(bytes.subarray(position,end));
    const progress=[];
    assert.equal(await hash(end,gaps,(processed,total)=>progress.push([processed,total])),expected.digest('hex'));
    const total=end-gaps.reduce((sum,[start,stop])=>sum+stop-start,0);
    assert.deepEqual(progress.at(-1),[total,total]);
    for(let index=1;index<progress.length;index++){
      assert.ok(progress[index][0]>progress[index-1][0]);
      assert.ok(progress[index][0]-progress[index-1][0]<=8*1024*1024);
      assert.equal(progress[index][1],total);
    }
    if(end===blob.size&&gaps.length===1)assert.equal(progress[0][0],blob.size-500);
  }
  await assert.rejects(hash(100,[[50,90],[80,100]]),/Invalid covered PDF byte ranges/);
});
