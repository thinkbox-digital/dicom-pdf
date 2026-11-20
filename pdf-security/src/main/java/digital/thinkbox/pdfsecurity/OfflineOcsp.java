package digital.thinkbox.pdfsecurity;

import java.io.IOException;
import java.security.cert.*;
import java.time.Instant;
import java.util.*;
import org.bouncycastle.cert.jcajce.JcaX509CertificateHolder;
import org.bouncycastle.cert.ocsp.*;
import org.bouncycastle.operator.jcajce.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Bounded, offline RFC 6960 evidence. Never follows responder URLs. */
final class OfflineOcsp {
    static final int MAX_RESPONSE=1024*1024;
    private OfflineOcsp(){}
    static BasicOCSPResp parse(byte[] encoded)throws Exception{
        if(encoded.length==0||encoded.length>MAX_RESPONSE)throw new IOException("OCSP response size limit");
        var response=new OCSPResp(encoded);
        if(response.getStatus()!=OCSPResp.SUCCESSFUL||!(response.getResponseObject() instanceof BasicOCSPResp basic))
            throw new IOException("Successful basic OCSP response required");
        if(!Arrays.equals(encoded,response.getEncoded()))throw new IOException("Trailing or noncanonical OCSP response data");
        return basic;
    }
    static SecurityReport.Check check(X509Certificate certificate,X509Certificate issuer,List<byte[]> evidence,Instant at){
        var outcome=new SecurityReport.Check(UNKNOWN,"FRESH_SUPPORTED_OCSP_EVIDENCE_MISSING");
        try{
            var digests=new JcaDigestCalculatorProviderBuilder().setProvider(SigningIdentity.BC).build();
            var issuerHolder=new JcaX509CertificateHolder(issuer);
            for(byte[] encoded:evidence){
                var response=parse(encoded);
                var matches=new ArrayList<SingleResp>();
                for(var item:response.getResponses())if(item.getCertID().getSerialNumber().equals(certificate.getSerialNumber())&&item.getCertID().matchesIssuer(issuerHolder,digests))matches.add(item);
                if(matches.isEmpty())continue;
                if(matches.size()!=1)return new SecurityReport.Check(FAIL,"AMBIGUOUS_OCSP_CERTIFICATE_STATUS");
                if(!response.getCriticalExtensionOIDs().isEmpty()||!matches.getFirst().getCriticalExtensionOIDs().isEmpty())
                    continue; // Unsupported critical response extensions never establish GOOD.
                X509Certificate responder=null;
                var candidates=new ArrayList<X509Certificate>();candidates.add(issuer);
                var converter=new org.bouncycastle.cert.jcajce.JcaX509CertificateConverter().setProvider(SigningIdentity.BC);
                for(var holder:response.getCerts())candidates.add(converter.getCertificate(holder));
                for(var candidate:candidates){
                    var holder=new JcaX509CertificateHolder(candidate);
                    boolean id=response.getResponderId().equals(new RespID(holder.getSubject()))||response.getResponderId().equals(new RespID(holder.getSubjectPublicKeyInfo(),digests.get(CertificateID.HASH_SHA1)));
                    if(!id)continue;
                    if(!candidate.equals(issuer)){
                        // Delegation without nocheck needs a separate responder-revocation path.
                        var eku=candidate.getExtendedKeyUsage();boolean[] usage=candidate.getKeyUsage();
                        if(!candidate.getIssuerX500Principal().equals(issuer.getSubjectX500Principal())||eku==null||!eku.contains("1.3.6.1.5.5.7.3.9")||usage!=null&&!usage[0]||candidate.getBasicConstraints()>=0||candidate.getExtensionValue("1.3.6.1.5.5.7.48.1.5")==null)continue;
                        var key=candidate.getPublicKey();
                        if(!(key instanceof java.security.interfaces.RSAKey rsa&&rsa.getModulus().bitLength()>=2048||key instanceof java.security.interfaces.ECKey ec&&ec.getParams().getOrder().bitLength()>=256)||candidate.hasUnsupportedCriticalExtension())continue;
                        byte[] nocheck=org.bouncycastle.asn1.ASN1OctetString.getInstance(candidate.getExtensionValue("1.3.6.1.5.5.7.48.1.5")).getOctets();
                        if(!(org.bouncycastle.asn1.ASN1Primitive.fromByteArray(nocheck) instanceof org.bouncycastle.asn1.ASN1Null))continue;
                        try{candidate.verify(issuer.getPublicKey());candidate.checkValidity(Date.from(at));}
                        catch(Exception invalid){continue;}
                    }
                    responder=candidate;break;
                }
                if(responder==null)return new SecurityReport.Check(UNKNOWN,"OCSP_RESPONDER_AUTHORIZATION_NOT_ESTABLISHED");
                // SHA-1 issuer/responder identifiers are lookups; response signatures must be strong.
                if(!Set.of("1.2.840.113549.1.1.11","1.2.840.113549.1.1.12","1.2.840.113549.1.1.13","1.2.840.10045.4.3.2","1.2.840.10045.4.3.3","1.2.840.10045.4.3.4").contains(response.getSignatureAlgOID().getId())||!response.isSignatureValid(new JcaContentVerifierProviderBuilder().setProvider(SigningIdentity.BC).build(responder.getPublicKey())))
                    return new SecurityReport.Check(FAIL,"INVALID_OR_UNSUPPORTED_OCSP_SIGNATURE");
                var single=matches.getFirst();Date date=Date.from(at);
                if(single.getThisUpdate().after(date)||single.getNextUpdate()==null||single.getNextUpdate().before(date)||single.getNextUpdate().before(single.getThisUpdate())||response.getProducedAt().after(date)||response.getProducedAt().before(single.getThisUpdate()))continue;
                var status=single.getCertStatus();
                if(status instanceof RevokedStatus revoked&&!revoked.getRevocationTime().after(date))return new SecurityReport.Check(FAIL,"CERTIFICATE_REVOKED_OCSP");
                if(status==CertificateStatus.GOOD)outcome=new SecurityReport.Check(PASS,"FRESH_AUTHORIZED_SIGNED_OFFLINE_OCSP_GOOD");
            }
        }catch(Exception invalid){return new SecurityReport.Check(FAIL,"INVALID_OFFLINE_OCSP_EVIDENCE");}
        return outcome;
    }
}
