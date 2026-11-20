const modes={
  CMS_AND_PDF:'Manifest and PDF signatures',
  CMS_AND_PDF_TIMESTAMPED:'Manifest and PDF signatures with timestamps',
  PADES_B_LTA:'PAdES B-LTA archival signing'
};

/** Archive declarations and attachment presence, never cryptographic validation. */
export function archiveSigningDetails(manifest,attachments){
  const security=manifest?.security;
  const supported=security?.schemaVersion===1;
  const mode=supported&&Object.hasOwn(modes,security.protection)?security.protection:null;
  const files=new Map(Object.values(attachments||{}).map(file=>[file.filename,file]));
  const signature=supported&&security.manifestSignature==='manifest.p7s'?'manifest.p7s':null;
  const signatureFile=files.get(signature);
  const present=signature&&(signatureFile?.byteLength??signatureFile?.content?.byteLength??signatureFile?.embedded);
  const fingerprint=supported&&/^[a-f\d]{64}$/i.test(security.issuerCertificateSha256||'')?security.issuerCertificateSha256.toLowerCase():null;
  const timestamped=mode==='CMS_AND_PDF_TIMESTAMPED'||mode==='PADES_B_LTA';
  return {
    basis:'UNVERIFIED_ARCHIVE_DECLARATION_AND_ATTACHMENT_PRESENCE',
    verification:'UNKNOWN',declaredProtection:mode,
    protection:mode?modes[mode]:security?'Unrecognized signing declaration':'No export signing declared',
    manifestSignature:signature,manifestSignaturePresent:!!present,
    issuerCertificateSha256:fingerprint,
    pdfSignature:mode?'Requested by archive':'Not established by this report',
    padesBLta:mode==='PADES_B_LTA'?'Archival protection requested':mode?'B-LTA was not requested':'Not declared',
    timestamps:timestamped?mode==='PADES_B_LTA'?'Signature and archival timestamps requested':'Signature timestamp requested':mode?'Trusted timestamps were not requested':'Not declared',
    trustedTime:timestamped?'Timestamp requested by export policy; verify its signature and TSA trust with the desktop validator':mode?'No trusted timestamp requested by this export':'Not established; no timestamped export declared',
    trustedTimeVerification:'UNKNOWN',
    verificationHelp:'The security report lists supported offline verification checks. The desktop validator supports broader evidence and trust configurations.'
  };
}
