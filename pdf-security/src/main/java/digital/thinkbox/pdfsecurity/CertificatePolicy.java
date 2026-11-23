package digital.thinkbox.pdfsecurity;

import java.security.cert.*;
import java.time.Instant;
import java.util.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Explicit local trust and revocation evidence. No AIA/OCSP/CRL network fetching. */
public record CertificatePolicy(Set<TrustAnchor> anchors,List<X509CRL> crls,Instant at,List<byte[]> ocsps,List<X509Certificate> supportingCertificates,Set<TrustAnchor> timestampAnchors) {
    public CertificatePolicy(Set<TrustAnchor> anchors,List<X509CRL> crls,Instant at,List<byte[]> ocsps,List<X509Certificate> supportingCertificates){
        this(anchors,crls,at,ocsps,supportingCertificates,Set.of());
    }
    public CertificatePolicy(Set<TrustAnchor> anchors,List<X509CRL> crls,Instant at){this(anchors,crls,at,List.of());}
    public CertificatePolicy(Set<TrustAnchor> anchors,List<X509CRL> crls,Instant at,List<byte[]> ocsps){this(anchors,crls,at,ocsps,List.of());}
    public CertificatePolicy {
        anchors=Set.copyOf(anchors);timestampAnchors=Set.copyOf(timestampAnchors);crls=List.copyOf(crls);Objects.requireNonNull(at);
        supportingCertificates=List.copyOf(new LinkedHashSet<>(supportingCertificates));
        if(supportingCertificates.size()>256)throw new IllegalArgumentException("Supporting certificate count limit");
        if(ocsps.size()>1024)throw new IllegalArgumentException("OCSP evidence count limit");
        var unique=new ArrayList<byte[]>();var seen=new HashSet<java.nio.ByteBuffer>();long total=0;
        for(var value:ocsps){
            if(value.length>OfflineOcsp.MAX_RESPONSE)throw new IllegalArgumentException("OCSP size limit");
            if(seen.add(java.nio.ByteBuffer.wrap(value))){
                total+=value.length;if(unique.size()>=256||total>16L*1024*1024)throw new IllegalArgumentException("OCSP evidence total/count limit");
                unique.add(value.clone());
            }
        }
        ocsps=List.copyOf(unique);
    }
    @Override public List<byte[]> ocsps(){return ocsps.stream().map(byte[]::clone).toList();}
    public static CertificatePolicy untrusted(Instant at){return new CertificatePolicy(Set.of(),List.of(),at);}
    /** Retain the selected trust and evidence while changing the verification reference time. */
    public CertificatePolicy withTime(Instant time){return new CertificatePolicy(anchors,crls,time,ocsps,supportingCertificates,timestampAnchors);}
    Set<TrustAnchor> allTimestampAnchors(){
        var combined=new LinkedHashSet<>(anchors);combined.addAll(timestampAnchors);return combined;
    }
    public Map<String,SecurityReport.Check> check(X509Certificate leaf,List<X509Certificate> certificates){
        var result=new LinkedHashMap<String,SecurityReport.Check>();
        try{leaf.checkValidity(Date.from(at));result.put("certificateValidity",new SecurityReport.Check(PASS,"CERTIFICATE_VALID_AT_VERIFICATION_TIME"));}
        catch(CertificateException failure){result.put("certificateValidity",new SecurityReport.Check(FAIL,"CERTIFICATE_EXPIRED_OR_NOT_YET_VALID"));}
        var key=leaf.getPublicKey();boolean[] usage=leaf.getKeyUsage();
        boolean keyOk=key instanceof java.security.interfaces.RSAKey rsa&&rsa.getModulus().bitLength()>=2048
            ||key instanceof java.security.interfaces.ECKey ec&&ec.getParams().getOrder().bitLength()>=256;
        boolean usageOk=usage==null||usage[0]||usage.length>1&&usage[1];
        result.put("keyPolicy",new SecurityReport.Check(keyOk&&usageOk?PASS:FAIL,keyOk&&usageOk?"SUPPORTED_SIGNING_KEY_AND_USAGE":"WEAK_UNSUPPORTED_OR_DISALLOWED_KEY"));
        if(anchors.isEmpty()){
            result.put("certificateTrust",new SecurityReport.Check(UNKNOWN,"NO_EXPLICIT_TRUST_ANCHORS"));
            result.put("revocation",new SecurityReport.Check(UNKNOWN,"NO_VALIDATED_CERTIFICATE_PATH"));return result;
        }
        try{
            var selector=new X509CertSelector();selector.setCertificate(leaf);
            var parameters=new PKIXBuilderParameters(anchors,selector);parameters.setDate(Date.from(at));parameters.setRevocationEnabled(false);
            var candidates=new ArrayList<>(certificates);candidates.addAll(supportingCertificates);
            parameters.addCertStore(CertStore.getInstance("Collection",new CollectionCertStoreParameters(candidates)));
            var path=(PKIXCertPathBuilderResult)CertPathBuilder.getInstance("PKIX").build(parameters);
            result.put("certificateTrust",new SecurityReport.Check(PASS,"EXPLICIT_LOCAL_TRUST_ANCHOR"));
            var chain=new ArrayList<X509Certificate>();
            for(var certificate:path.getCertPath().getCertificates())chain.add((X509Certificate)certificate);
            chain.add(path.getTrustAnchor().getTrustedCert());
            SecurityReport.Check revocation=new SecurityReport.Check(chain.size()==1?NOT_APPLICABLE:PASS,chain.size()==1?"NO_REVOCABLE_CERTIFICATES_BELOW_EXPLICIT_ANCHOR":"FRESH_SIGNED_OFFLINE_REVOCATION_EVIDENCE_FOR_PATH");
            for(int i=0;i+1<chain.size();i++){
                X509Certificate certificate=chain.get(i),issuer=chain.get(i+1);boolean found=false;
                for(X509CRL crl:crls){
                    if(!crl.getIssuerX500Principal().equals(issuer.getSubjectX500Principal()))continue;
                    boolean[] issuerUsage=issuer.getKeyUsage();
                    if(issuerUsage!=null&&(issuerUsage.length<7||!issuerUsage[6])){revocation=new SecurityReport.Check(FAIL,"CRL_ISSUER_NOT_AUTHORIZED");break;}
                    // Delta/indirect/critical-extension CRLs require a fuller policy engine.
                    if(crl.hasUnsupportedCriticalExtension()||crl.getExtensionValue("2.5.29.27")!=null||crl.getExtensionValue("2.5.29.28")!=null)continue;
                    try{crl.verify(issuer.getPublicKey());}catch(Exception invalid){revocation=new SecurityReport.Check(FAIL,"INVALID_REVOCATION_SIGNATURE");break;}
                    if(crl.getThisUpdate().after(Date.from(at))||crl.getNextUpdate()==null||crl.getNextUpdate().before(Date.from(at)))continue;
                    found=true;X509CRLEntry entry=crl.getRevokedCertificate(certificate.getSerialNumber());
                    if(entry!=null&&!entry.getRevocationDate().after(Date.from(at))){revocation=new SecurityReport.Check(FAIL,"CERTIFICATE_REVOKED");break;}
                }
                if(revocation.status()==FAIL)break;
                var ocsp=OfflineOcsp.check(certificate,issuer,ocsps,at);
                if(ocsp.status()==FAIL){revocation=ocsp;break;}
                if(!found&&ocsp.status()!=PASS)revocation=new SecurityReport.Check(UNKNOWN,"FRESH_SUPPORTED_REVOCATION_EVIDENCE_MISSING");
            }
            result.put("revocation",revocation);
        }catch(Exception failure){
            result.put("certificateTrust",new SecurityReport.Check(FAIL,"CERTIFICATE_PATH_VALIDATION_FAILED"));
            result.put("revocation",new SecurityReport.Check(UNKNOWN,"NO_VALIDATED_CERTIFICATE_PATH"));
        }
        return result;
    }
}
