import {buildArchiveVerificationPlan} from './archive-verification.mjs';
import {createArchiveVerifier} from './archive-verification-client.mjs';
import {archiveSigningDetails} from './archive-signing-details.mjs';
import {attachmentBytes} from './pdf-attachments.mjs';
import {readPdfSecurity,readArchivalRevisions} from './pdf-security-input.mjs';
import {createTimestampSourceLoader,fetchCaBytes,signingCertificateUrl,supportsCertificateSitePermission,withCertificateSitePermission} from './archive-trust-sources.mjs';

const labels={PASS:'Passed',FAIL:'Failed',UNKNOWN:'Incomplete',NOT_APPLICABLE:'Not applicable',CHECKING:'Checking'};
const summaryLabels={PASS:'Integrity and certificate trust checks passed',FAIL:'Security checks failed',UNKNOWN:'Security checks incomplete',CHECKING:'Checking'};
const trustLabels={PASS:'Certificate trust passed',FAIL:'Certificate trust failed',UNKNOWN:'Certificate trust incomplete'};
const sections=['C2PA','PAdES','C2PA + PAdES','CMS','Certificate trust','Other checks'];
const localC2paOnly=security=>security?.c2paSignerIdentity==='LOCAL_EPHEMERAL_UNTRUSTED'&&
  !security.checks.some(check=>check.name==='Offline trust policy');

export function createArchiveVerificationPanel({document:doc=document,getArchive,onComplete=()=>{},getDigest,rememberDigest,verifier=createArchiveVerifier()}={}){
  const $=id=>doc.getElementById(id),panel=$('archive-check-panel'),name=$('document-name'),dialog=$('archive-integrity-dialog'),close=$('close-archive-check'),save=$('save-archive-check'),status=$('archive-check-status'),fields=$('archive-check-fields'),signingFields=$('archive-signing-fields');
  const groups=$('archive-security-groups'),badge=$('archive-security-state'),trustBadge=$('archive-signer-trust-state'),filename=$('archive-security-filename');
  const trustPanel=$('archive-trust-panel'),choose=$('archive-trust-choose'),clear=$('archive-trust-clear'),
    picker=$('archive-trust-files'),trustCount=$('archive-trust-count'),trustMessage=$('archive-trust-message'),
    trustCertificates=$('archive-trust-certificates');
  const certificateUrl=$('archive-trust-url'),urlForm=$('archive-trust-url-form'),
    urlLoad=$('archive-trust-url-load'),urlAccess=$('archive-trust-url-access'),online=$('archive-trust-online');
  const timestampSources=createTimestampSourceLoader();
  let result=null,revision=0,running=false,trustRefreshPending=false,lastProgress=0,shownSecurity=null;
  let sessionTrust={roots:[],certificates:[]},selectionPending=false,shownAnchors=null,securityCache=null,destroyed=false;
  function row(label,value,target=fields){const term=doc.createElement('dt'),description=doc.createElement('dd');term.textContent=label;description.textContent=value;target.append(term,description);}
  function refreshTrust(usable){
    trustPanel.hidden=!usable;
    choose.disabled=selectionPending;
    certificateUrl.disabled=selectionPending;
    urlLoad.disabled=selectionPending;
    urlAccess.disabled=selectionPending;
    clear.disabled=selectionPending||!sessionTrust.roots.length;
    const selected=sessionTrust.roots.length>0;
    const security=result?.pdfSecurity;
    const configured=security?.trustSource==='BUILD';
    const anchors=selected?sessionTrust.certificates:configured?security.selectedCertificates:null;
    trustCount.textContent=selected?`${anchors.length} selected`:configured?`${anchors.length} configured`:'No CA certificates selected';
    if(anchors===shownAnchors)return;
    shownAnchors=anchors;
    trustCertificates.replaceChildren();
    for(const anchor of anchors??[]){
      const details=doc.createElement('details'),heading=doc.createElement('summary'),fields=doc.createElement('dl');
      heading.textContent=anchor.subject||'CA certificate';fields.className='metadata-fields';
      row('Issuer',anchor.issuer,fields);
      row('SHA-256',anchor.sha256,fields);
      row('Valid from',anchor.notBefore,fields);
      row('Valid until',anchor.notAfter,fields);
      details.append(heading,fields);trustCertificates.append(details);
    }
  }
  function refresh(){
    const archive=getArchive(),usable=!!archive?.manifest;
    panel.hidden=!usable&&!result;name.disabled=!usable&&!result;save.disabled=!result||running;filename.textContent=name.textContent;
    fields.replaceChildren();signingFields.replaceChildren();
    refreshTrust(usable&&!!archive.pdf);
    if(!usable&&!result)return;
    row('Original files',result?`${result.matchedOriginals} of ${result.originals} match recorded checksums`:'Not fully checked');
    row('Package files',result?result.checks.generatedArtifacts.status==='PASS'?`${result.checks.generatedArtifacts.checked} checksums match`:result.checks.generatedArtifacts.status==='FAIL'?'Checksum mismatch or missing file':'Not fully checked':'Not checked');
    const evidence=archive?.manifest?.security?.manifestSignature;
    const attached=evidence&&Object.values(archive.attachments||{}).some(file=>file.filename===evidence);
    const signing=archiveSigningDetails(archive?.manifest,archive?.attachments);
    const signature=result?.checks.manifestSignature,binding=result?.checks.signerCertificateBinding,validity=result?.checks.signerCertificateValidity;
    const manifestStatus=signature?.status==='PASS'?'Verified against the included certificate':signature?.status==='FAIL'?'FAILED: manifest signature is invalid':signature?'Verification incomplete':attached?'Attached, verification pending':'No manifest signature declared';
    row('Manifest signature',manifestStatus);
    if(binding)row('Signer certificate binding',binding.status==='PASS'?'Matches the signed certificate reference and recorded fingerprint':binding.status==='FAIL'?'FAILED: signer certificate reference or fingerprint differs':'Not verified');
    if(validity)row('Signer certificate dates',validity.status==='PASS'?'Within validity dates according to this browser’s clock':result.manifestSigning?.certificate?'Outside current validity dates; use the desktop validator to check historical signing time':'Not verified');
    renderSecurity(result?.pdfSecurity??null);
    row('Acquisition authenticity','Not established');
    row('Declared protection',signing.protection,signingFields);
    row('Manifest signature',manifestStatus,signingFields);
    const certificate=result?.manifestSigning?.certificate;
    if(certificate){
      row('Included signer certificate SHA-256',certificate.sha256,signingFields);
      row('Certificate valid from',certificate.notBefore,signingFields);
      row('Certificate valid until',certificate.notAfter,signingFields);
      row('Date check basis',`${result.manifestSigning.verificationTime} · browser clock`,signingFields);
    }
    row('PDF signature',signing.pdfSignature,signingFields);
    row('PAdES B-LTA',signing.padesBLta,signingFields);
    row('Timestamps',signing.timestamps,signingFields);
    if(signing.issuerCertificateSha256)row('Declared signer certificate SHA-256',signing.issuerCertificateSha256,signingFields);
  }
  function renderSecurity(security){
    if(security===shownSecurity)return;
    shownSecurity=security;groups.replaceChildren();
    if(!security)return;
    const checks=[...security.checks];
    for(const cert of security.certificates??[])checks.push({category:'Certificate trust',name:cert.subject||'Signing certificate',
      detail:['Included signing certificate',`SHA-256: ${cert.sha256}`,`Valid from ${cert.notBefore} to ${cert.notAfter}`].join('\n')});
    for(const category of sections){
      const rows=checks.filter(check=>check.category===category);
      if(!rows.length)continue;
      const section=doc.createElement('section'),heading=doc.createElement('div'),title=doc.createElement('h3'),count=doc.createElement('span'),list=doc.createElement('div');
      heading.className='security-group-heading';title.textContent=category;
      const assessed=rows.filter(row=>row.status).length;
      count.textContent=assessed?`${assessed} ${assessed===1?'check':'checks'}`:'';
      heading.append(title,count);list.className='security-group-list';
      for(const check of rows){
        const details=doc.createElement('details'),summary=doc.createElement('summary'),label=doc.createElement('span'),detail=doc.createElement('p');
        details.className='security-check';label.className='security-check-name';label.textContent=check.name;
        summary.append(label);
        if(check.status){
          const state=doc.createElement('span');state.className='security-result';
          state.dataset.status=check.status;state.textContent=labels[check.status];summary.append(state);
        }
        detail.textContent=check.detail;details.append(summary,detail);list.append(details);
      }
      section.append(heading,list);groups.append(section);
    }
  }
  function appearance(state){
    name.dataset.integrity=state;
    badge.dataset.status=state;
    const security=result?.pdfSecurity,trust=security?.trustStatus;
    const checksumsOnly=state==='UNKNOWN'&&result?.integrity==='PASS'&&
      (!security||security.status==='NOT_APPLICABLE')&&!result.checks.manifestSignature;
    const description=checksumsOnly?'Archive checksums match · no verified signature':summaryLabels[state]??'';
    badge.textContent=description;
    const trustLabel=trust==='UNKNOWN'&&localC2paOnly(security)?'Exporter identity unverified':trustLabels[trust]??'';
    trustBadge.hidden=!trustLabel;
    trustBadge.dataset.status=trust??'NOT_APPLICABLE';
    trustBadge.textContent=trustLabel;
    name.title=[name.textContent,description,trustLabel,description?'Click to view the security report':''].filter(Boolean).join(' · ');
    name.setAttribute('aria-label',[name.textContent,description,trustLabel].filter(Boolean).join(' · '));
  }
  function reset(){++revision;verifier.cancel();running=false;trustRefreshPending=false;result=null;securityCache=null;dialog?.close();appearance('UNCHECKED');status.textContent='';trustMessage.textContent='';panel.hidden=true;name.disabled=true;save.disabled=true;fields.replaceChildren();signingFields.replaceChildren();renderSecurity(null);}
  function restartWithTrust(){
    if(!securityCache||securityCache.pdf!==getArchive()?.pdf){refresh();return;}
    if(running){trustRefreshPending=true;return;}
    void run(true);
  }
  const openPicker=()=>picker.click();
  const clearTrust=()=>{
    sessionTrust={roots:[],certificates:[]};trustMessage.textContent='';urlAccess.hidden=true;
    restartWithTrust();
  };
  function announceTrustError(message){
    trustMessage.dataset.error='';trustMessage.textContent=message;
  }
  async function applyTrustSelection(read,progress){
    selectionPending=true;
    delete trustMessage.dataset.error;
    trustMessage.textContent=progress;
    refreshTrust(true);
    try{
      const selection=await read();
      if(destroyed)return;
      sessionTrust=selection;trustMessage.textContent='';
      restartWithTrust();
    }catch(error){
      if(destroyed)return;
      announceTrustError(error.message);
    }finally{
      selectionPending=false;
      if(!destroyed){const archive=getArchive();refreshTrust(!!archive?.manifest&&!!archive.pdf);}
    }
  }
  function chooseTrust(){
    const files=Array.from(picker.files??[]);
    picker.value='';
    if(!files.length||selectionPending)return;
    urlAccess.hidden=true;
    void applyTrustSelection(async()=>({
      ...await verifier.chooseTrust(files,sessionTrust.roots),origin:sessionTrust.origin
    }),'Reading CA certificates…');
  }
  function loadSigningCa(allowSite=false){
    if(selectionPending)return;
    urlAccess.hidden=true;
    let url;
    try{url=signingCertificateUrl(certificateUrl.value);}
    catch(error){announceTrustError(error.message);return;}
    void applyTrustSelection(async()=>{
      let bytes;
      try{
        const read=()=>fetchCaBytes(url.href);
        bytes=allowSite?await withCertificateSitePermission(url,read):await read();
      }catch(error){
        if(error instanceof TypeError){
          if(!allowSite&&supportsCertificateSitePermission()){
            urlAccess.hidden=false;
            throw Error('Allow the extension to download from this certificate site, or use a certificate file.',{cause:error});
          }
          throw Error('The certificate download was blocked. Use a site that allows browser downloads, or select the certificate file.',{cause:error});
        }
        throw error;
      }
      const file=new File([bytes],'signing-ca.cer');
      return {...await verifier.chooseTrust([file],[],{single:true}),origin:url.origin};
    },'Downloading the signing CA certificate…');
  }
  const submitCertificateUrl=event=>{event.preventDefault();loadSigningCa();};
  const allowCertificateSite=()=>loadSigningCa(true);
  const hideCertificateAccess=()=>{urlAccess.hidden=true;};
  async function run(recheck=false){
    const current=getArchive();if(!current?.manifest||running)return;
    const token=++revision;if(!recheck)result=null;
    running=true;lastProgress=0;appearance('CHECKING');refresh();
    status.textContent=recheck?'Rechecking certificate trust…':'Checking embedded file checksums and available manifest signature…';
    const cache=securityCache??={pdf:current.pdf};
    const {roots,origin}=sessionTrust;
    const onlineEnabled=online.checked;
    try{
      const pdfSecurity=current.pdf&&current.blob?{
        sessionRoots:roots,signerCertificateOrigin:origin,
        getInput:async()=>{
          const input=cache.input??await readPdfSecurity(current);
          if(!input.discoveryError)cache.input=input;
          return input;
        },
        loadTimestampSources:()=>onlineEnabled?timestampSources():[],
        readRevisions:async(ends,hasCredentials)=>{
          const key=`${hasCredentials}:${ends.join(',')}`;
          if(cache.revisions?.key===key)return cache.revisions.value;
          const value=await readArchivalRevisions(current.pdf,ends,hasCredentials);
          if(value.status==='COMPLETE')cache.revisions={key,value};
          return value;
        },
        onChecksums:checked=>{
          if(token!==revision)return;
          result=checked;
          status.textContent=checked.integrity==='PASS'?'Recorded file checksums match. Checking PDF security…':'File checks found a problem. Checking PDF security…';
          refresh();onComplete(checked);
        },
        onProgress:detail=>{if(token===revision)status.textContent=detail;}
      }:undefined;
      let pending=recheck&&pdfSecurity?verifier.recheckTrust(pdfSecurity):null;
      if(!pending){
        const filesByName=new Map(Object.values(current.attachments||{}).map(file=>[file.filename,file]));
        const sidecar=filesByName.get('manifest.sha256');
        const sidecarBytes=sidecar?await attachmentBytes(sidecar):null;
        if(token!==revision)return;
        const plan=buildArchiveVerificationPlan(current.manifest,current.attachments,sidecarBytes);
        pending=verifier.verify(plan,name=>filesByName.get(name)||null,{getDigest,rememberDigest,pdfSecurity,canRun:()=>!getArchive()?.busy,onProgress:progress=>{
          if(token!==revision)return;
          const now=performance.now();if(now-lastProgress<100&&progress.checked!==progress.total)return;
          lastProgress=now;status.textContent=`Checking files: ${progress.checked} of ${progress.total}.`;
        }});
      }
      const checked=await pending;
      if(token!==revision)return;
      const security=checked.pdfSecurity;
      const outerStatus=security?.status,trust=security?.trustStatus;
      const manifestSignature=checked.checks.manifestSignature?.status;
      const states=[checked.integrity,outerStatus,manifestSignature,trust];
      const verifiedSignature=outerStatus==='PASS'||manifestSignature==='PASS';
      const state=states.includes('FAIL')?'FAIL':
        states.includes('UNKNOWN')||!verifiedSignature||trust!=='PASS'?'UNKNOWN':'PASS';
      result={...checked,reportStatus:state};appearance(state);
      const checksumText=checked.integrity==='PASS'?'Recorded file checksums match.':checked.integrity==='FAIL'?'File integrity check failed.':'File checks completed with gaps.';
      const securityText=outerStatus==='PASS'?'PDF integrity checks passed.':outerStatus==='FAIL'?'PDF security checks failed.':outerStatus==='UNKNOWN'?'PDF security checks are incomplete.':outerStatus==='NOT_APPLICABLE'?'No PDF signature or C2PA export credentials were found.':!outerStatus?'PDF signature and C2PA checks were unavailable.':'';
      const signatures=security?.pdfSignaturesChecked;
      const signatureText=signatures===1?'Checked 1 PDF signature.':signatures?`Checked ${signatures} PDF signatures.`:'';
      const policy=security?.checks.find(check=>check.name==='Offline trust policy');
      const trustText=trust==='PASS'?'Offline certificate trust checks passed.':trust==='UNKNOWN'
        ?localC2paOnly(security)?'A one-time certificate signed this archive. The exporter’s identity is unverified.'
          :policy?.status==='UNKNOWN'?policy.detail:'Certificate trust is incomplete.'
        :trust==='FAIL'?'Certificate trust checks failed.':'';
      status.textContent=[checksumText,securityText,signatureText,trustText].filter(Boolean).join(' ');
      if(!pdfSecurity)onComplete(checked);
    }catch(error){
      if(token!==revision)return;
      if(error?.name==='AbortError')return;
      reject(error?.code==='INVALID_ARCHIVE_INVENTORY'?'INVALID_ARCHIVE_INVENTORY':'BACKGROUND_CHECK_UNAVAILABLE',error?.code==='INVALID_ARCHIVE_INVENTORY');
    }finally{
      if(token===revision){
        running=false;
        if(trustRefreshPending){trustRefreshPending=false;void run(true);}
        else refresh();
      }
    }
  }
  function reject(code,failed=true){
    result={schemaVersion:1,implementation:'offline-viewer-checks-2',assurance:'CHECKSUMS_ONLY',integrity:failed?'FAIL':'UNKNOWN',originals:0,matchedOriginals:0,files:[],checks:{generatedArtifacts:{status:'UNKNOWN'},processing:{status:failed?'FAIL':'UNKNOWN',code}}};
    appearance(result.integrity);status.textContent=failed?'File integrity check failed. Save the report for details.':'The background check could not finish. Use the independent verifier for details.';refresh();
  }
  const download=()=>{
    if(!result)return;
    const archive=getArchive();
    const report={...result,signingEvidence:archiveSigningDetails(archive?.manifest,archive?.attachments)};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}));
    const link=doc.createElement('a');link.href=url;link.download='dicom-file-checks.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const show=()=>{
    if(name.disabled||dialog.open)return;
    dialog.showModal();
    dialog.scrollTop=0;panel.scrollTop=0;
    close.focus({preventScroll:true});
  },hide=()=>dialog.close();
  name.addEventListener('click',show);close.addEventListener('click',hide);save.addEventListener('click',download);
  choose.addEventListener('click',openPicker);clear.addEventListener('click',clearTrust);picker.addEventListener('change',chooseTrust);reset();
  urlForm.addEventListener('submit',submitCertificateUrl);
  urlAccess.addEventListener('click',allowCertificateSite);
  certificateUrl.addEventListener('input',hideCertificateAccess);
  online.addEventListener('change',restartWithTrust);
  return {reset,refresh,run,reject,destroy(){
    destroyed=true;reset();verifier.destroy();
    name.removeEventListener('click',show);close.removeEventListener('click',hide);save.removeEventListener('click',download);
    choose.removeEventListener('click',openPicker);clear.removeEventListener('click',clearTrust);picker.removeEventListener('change',chooseTrust);
    urlForm.removeEventListener('submit',submitCertificateUrl);urlAccess.removeEventListener('click',allowCertificateSite);
    certificateUrl.removeEventListener('input',hideCertificateAccess);online.removeEventListener('change',restartWithTrust);
  }};
}
