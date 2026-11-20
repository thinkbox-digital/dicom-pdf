import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveSigningDetails} from '../archive-signing-details.mjs';

const signature={filename:'manifest.p7s',content:new TextEncoder().encode('deliberately invalid CMS')};
const manifest=protection=>({security:{schemaVersion:1,protection,manifestSignature:'manifest.p7s',issuerCertificateSha256:'AB'.repeat(32)}});
test('signature presence and declared PAdES level never become a cryptographic validation result',()=>{
  const value=archiveSigningDetails(manifest('PADES_B_LTA'),{signature});
  assert.equal(value.manifestSignaturePresent,true);assert.equal(value.verification,'UNKNOWN');
  assert.equal(value.declaredProtection,'PADES_B_LTA');assert.match(value.padesBLta,/requested/);
  assert.match(value.timestamps,/archival timestamps requested/);assert.equal(value.issuerCertificateSha256,'ab'.repeat(32));
  assert.match(value.trustedTime,/Timestamp requested by export policy/);assert.match(value.trustedTime,/desktop validator/);assert.equal(value.trustedTimeVerification,'UNKNOWN');
});
test('a simple certificate signature does not imply B-LTA or trusted timestamps',()=>{
  const value=archiveSigningDetails(manifest('CMS_AND_PDF'),{signature});
  assert.match(value.padesBLta,/not requested/);assert.match(value.timestamps,/not requested/);
  assert.match(value.trustedTime,/No trusted timestamp requested/);assert.equal(value.trustedTimeVerification,'UNKNOWN');
  const timestamped=archiveSigningDetails(manifest('CMS_AND_PDF_TIMESTAMPED'),{signature});
  assert.match(timestamped.timestamps,/Signature timestamp requested/);assert.doesNotMatch(timestamped.timestamps,/archival/);
});
test('unsigned archives and missing, empty or unsupported signature evidence remain explicit',()=>{
  assert.equal(archiveSigningDetails({},{}).declaredProtection,null);
  assert.match(archiveSigningDetails({},{}).trustedTime,/Not established/);
  assert.equal(archiveSigningDetails(manifest('PADES_B_LTA'),{}).manifestSignaturePresent,false);
  assert.equal(archiveSigningDetails(manifest('PADES_B_LTA'),{signature:{...signature,content:new Uint8Array()}}).manifestSignaturePresent,false);
  const unrecognized=manifest('invented');unrecognized.security.issuerCertificateSha256='<script>';
  const value=archiveSigningDetails(unrecognized,{signature});
  assert.equal(value.declaredProtection,null);assert.equal(value.issuerCertificateSha256,null);assert.equal(value.verification,'UNKNOWN');
});
