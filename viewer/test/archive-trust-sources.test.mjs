import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {certificateNetwork,digicertTimestampFallback} from '../build-certificate-network.mjs';
import {createTimestampSourceLoader,digicertTimestampFingerprint,fetchCaBytes,signingCertificateUrl} from '../archive-trust-sources.mjs';

test('certificate URLs require a concrete approved HTTPS origin',()=>{
  const policy=certificateNetwork('https://pki.example.test');
  assert.equal(signingCertificateUrl('https://pki.example.test/root.cer',policy.signingCaOrigins).hostname,'pki.example.test');
  assert.ok(policy.optionalHosts.includes('https://pki.example.test/*'));
  assert.ok(policy.connectOrigins.split(' ').includes('https://raw.githubusercontent.com'));
  assert.throws(()=>signingCertificateUrl('https://pki.example.test.evil/root.cer',policy.signingCaOrigins),/approved sites/);
  assert.throws(()=>signingCertificateUrl('http://pki.example.test/root.cer',policy.signingCaOrigins),/HTTPS/);
  assert.throws(()=>signingCertificateUrl('https://user:pass@pki.example.test/root.cer',policy.signingCaOrigins),/username/);
  assert.throws(()=>certificateNetwork('https://*.example.test'),/exact HTTPS origins/);
});

test('download reads public bytes with bounded unauthenticated requests',async()=>{
  const url='https://pki.example.test/root.cer';
  const bytes=await fetchCaBytes(url,{fetcher:async (destination,options)=>{
    assert.equal(destination,url);
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');
    assert.equal(options.referrerPolicy,'no-referrer');
    assert.equal(options.body,undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new Uint8Array([1,2,3]));
  }});
  assert.deepEqual(bytes,new Uint8Array([1,2,3]));
  await assert.rejects(fetchCaBytes(url,{fetcher:async()=>new Response(new Uint8Array(1024*1024+1))}),/exceeds 1 MiB/);
});

test('automatic timestamp sources are fixed, cached per tab and skipped offline',async()=>{
  let online=false,now=0;
  const requested=[];
  const load=createTimestampSourceLoader({online:()=>online,clock:()=>now,read:async url=>{
    requested.push(url);
    if(url.includes('digicert'))throw Error('Unreachable');
    return new Uint8Array([1]);
  }});
  assert.deepEqual(await load(),[]);
  assert.deepEqual(requested,[]);
  online=true;
  const [first,shared]=await Promise.all([load(),load()]);
  assert.equal(first,shared);
  assert.equal(requested.length,2);
  assert.equal(first.filter(source=>source.bytes).length,1);
  assert.equal(first.find(source=>source.error).name,'DigiCert public timestamp CA');
  now=61_000;online=false;
  assert.deepEqual(await load(),[]);
  assert.equal(requested.length,2);
});

test('offline fallback is limited to the pinned DigiCert timestamp CA',async()=>{
  const backup=new Uint8Array(Buffer.from(digicertTimestampFallback(),'base64'));
  const load=createTimestampSourceLoader({online:()=>false,read:assert.fail,fallback:backup});
  const [source,...rest]=await load();
  assert.equal(source.name,'DigiCert public timestamp CA (bundled)');
  assert.equal(source.bundled,true);
  assert.deepEqual(source.bytes,backup);
  assert.deepEqual(rest,[]);
});

test('timestamp CA reporting records a single pass when the approved bundled certificate is used',async()=>{
  const entry=fileURLToPath(new URL('../security-trust-selection.ts',import.meta.url));
  const {outputFiles}=await build({entryPoints:[entry],bundle:true,format:'esm',write:false});
  const {publicTimestampAnchors}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
  const backup=new Uint8Array(Buffer.from(digicertTimestampFallback(),'base64'));
  const source={
    name:'DigiCert public timestamp CA',
    url:'https://knowledge.digicert.com/content/dam/kb/attachments/time-stamp/DigiCertTrustedRootG4.cer',
    sha256:digicertTimestampFingerprint,
    backup
  };
  for(const attempt of [{error:'The online certificate download was unavailable.'},{bytes:new Uint8Array([1])}]){
    const {anchors,checks}=await publicTimestampAnchors([{...source,...attempt}]);
    assert.equal(anchors.length,1);
    assert.equal(checks.length,1);
    assert.equal(checks[0].status,'PASS');
    assert.match(checks[0].name,/bundled/);
    assert.match(checks[0].detail,attempt.error?/online certificate download was unavailable/:/did not match/);
  }
  const failed=await publicTimestampAnchors([{...source,backup:undefined,error:'The online certificate download was unavailable.'}]);
  assert.deepEqual(failed.anchors,[]);
  assert.equal(failed.checks[0].status,'UNKNOWN');
});
