package digital.thinkbox.pdfsecurity;

import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.*;
import org.bouncycastle.asn1.cms.ContentInfo;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cms.SignerInformation;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.tsp.TimeStampToken;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Offline signature-timestamp verification; signer-reported signingTime is not a timestamp. */
final class Rfc3161Verification {
    private Rfc3161Verification() {}
    static Map<String,SecurityReport.Check> verify(SignerInformation signer,CertificatePolicy policy){
        var result=new LinkedHashMap<String,SecurityReport.Check>();
        var unsigned=signer.getUnsignedAttributes();
        var attribute=unsigned==null?null:unsigned.get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken);
        if(attribute==null){result.put("timestamp",new SecurityReport.Check(UNKNOWN,"NO_RFC3161_SIGNATURE_TIMESTAMP"));return result;}
        try{
            if(unsigned.getAll(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken).size()!=1||attribute.getAttrValues().size()!=1)throw new IllegalArgumentException("Timestamp cardinality");
            var token=new TimeStampToken(ContentInfo.getInstance(attribute.getAttrValues().getObjectAt(0)));
            return verifyToken(token,MessageDigest.getInstance("SHA-256").digest(signer.getSignature()),policy);
        }catch(Exception failure){result.put("timestamp",new SecurityReport.Check(FAIL,"INVALID_OR_UNSUPPORTED_RFC3161_TIMESTAMP"));}
        return result;
    }
    static Map<String,SecurityReport.Check> verifyToken(TimeStampToken token,byte[] imprint,CertificatePolicy policy){
        var result=new LinkedHashMap<String,SecurityReport.Check>();
        try{
            var info=token.getTimeStampInfo();
            if(!"2.16.840.1.101.3.4.2.1".equals(info.getMessageImprintAlgOID().getId())||!MessageDigest.isEqual(info.getMessageImprintDigest(),imprint))throw new IllegalArgumentException("Timestamp imprint mismatch");
            if(info.getGenTime().toInstant().isAfter(policy.at().plusSeconds(60)))throw new IllegalArgumentException("Timestamp is in the future");
            var matches=token.getCertificates().getMatches(token.getSID());
            if(matches.size()!=1)throw new IllegalArgumentException("Timestamp signer certificate");
            var certificate=(X509CertificateHolder)matches.iterator().next();
            token.validate(new JcaSimpleSignerInfoVerifierBuilder().setProvider(SigningIdentity.BC).build(certificate));
            var converter=new JcaX509CertificateConverter().setProvider(SigningIdentity.BC);
            var chain=new ArrayList<X509Certificate>();for(Object item:token.getCertificates().getMatches(null))chain.add(converter.getCertificate((X509CertificateHolder)item));
            var tsaPolicy=new CertificatePolicy(policy.allTimestampAnchors(),policy.crls(),info.getGenTime().toInstant(),policy.ocsps(),policy.supportingCertificates());
            var checks=tsaPolicy.check(converter.getCertificate(certificate),chain);
            var status=checks.values().stream().anyMatch(c->c.status()==FAIL)?FAIL:checks.values().stream().anyMatch(c->c.status()==UNKNOWN)?UNKNOWN:PASS;
            result.put("timestamp",new SecurityReport.Check(status,status==PASS?"RFC3161_IMPRINT_SIGNATURE_TRUST_AND_REVOCATION_VERIFIED":"RFC3161_TRUST_OR_REVOCATION_NOT_ESTABLISHED"));
            for(var entry:checks.entrySet())result.put("timestamp."+entry.getKey(),entry.getValue());
        }catch(Exception failure){result.put("timestamp",new SecurityReport.Check(FAIL,"INVALID_OR_UNSUPPORTED_RFC3161_TIMESTAMP"));}
        return result;
    }
}
