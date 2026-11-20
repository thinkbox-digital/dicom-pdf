package digital.thinkbox.pdfsecurity.testing;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.security.cert.*;
import java.time.*;
import java.util.*;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.cert.ocsp.*;
import org.bouncycastle.cert.ocsp.jcajce.JcaBasicOCSPRespBuilder;
import org.bouncycastle.operator.jcajce.*;


public final class TestOcspService {
    public static byte[] response(SecurityFixtures.Institution institution,String defect)throws Exception{
        var digests=new JcaDigestCalculatorProviderBuilder().build();
        var responder=institution.root();var signingKey=institution.rootKey().getPrivate();
        if(defect.contains("delegate")){
            var generator=java.security.KeyPairGenerator.getInstance("RSA");generator.initialize(2048);var key=generator.generateKeyPair();
            var certificate=new JcaX509v3CertificateBuilder(new org.bouncycastle.asn1.x500.X500Name(institution.root().getSubjectX500Principal().getName()),java.math.BigInteger.valueOf(4),Date.from(institution.now().minusSeconds(7200)),Date.from(institution.now().plusSeconds(7200)),new org.bouncycastle.asn1.x500.X500Name("CN=SYNTHETIC OCSP ONLY"),key.getPublic());
            certificate.addExtension(org.bouncycastle.asn1.x509.Extension.basicConstraints,true,new org.bouncycastle.asn1.x509.BasicConstraints(false));
            certificate.addExtension(org.bouncycastle.asn1.x509.Extension.keyUsage,true,new org.bouncycastle.asn1.x509.KeyUsage(org.bouncycastle.asn1.x509.KeyUsage.digitalSignature));
            certificate.addExtension(org.bouncycastle.asn1.x509.Extension.extendedKeyUsage,true,new org.bouncycastle.asn1.x509.ExtendedKeyUsage("unauthorized-delegate".equals(defect)?org.bouncycastle.asn1.x509.KeyPurposeId.id_kp_serverAuth:org.bouncycastle.asn1.x509.KeyPurposeId.id_kp_OCSPSigning));
            if(!"delegate-no-nocheck".equals(defect))certificate.addExtension(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.3.6.1.5.5.7.48.1.5"),false,org.bouncycastle.asn1.DERNull.INSTANCE);
            responder=new JcaX509CertificateConverter().getCertificate(certificate.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));signingKey=key.getPrivate();
        }
        var builder=new JcaBasicOCSPRespBuilder(responder.getPublicKey(),digests.get(CertificateID.HASH_SHA1));
        var id=new CertificateID(digests.get(CertificateID.HASH_SHA1),new JcaX509CertificateHolder(institution.root()),institution.leaf().getSerialNumber());
        CertificateStatus status="revoked".equals(defect)?new RevokedStatus(Date.from(institution.now().minusSeconds(60)),1):"unknown".equals(defect)?new UnknownStatus():CertificateStatus.GOOD;
        var updated=Date.from(institution.now().plusSeconds("future".equals(defect)?3600:-3600));
        var next="no-next-update".equals(defect)?null:Date.from(institution.now().plusSeconds(3600));
        builder.addResponse(id,status,updated,next,null);
        if("duplicate".equals(defect))builder.addResponse(id,status,updated,next,null);
        var key="forged".equals(defect)?institution.leafKey().getPrivate():signingKey;
        var basic=builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(key),new org.bouncycastle.cert.X509CertificateHolder[]{new JcaX509CertificateHolder(responder)},Date.from(institution.now()));
        return new OCSPRespBuilder().build(OCSPRespBuilder.SUCCESSFUL,basic).getEncoded();
    }
    public static CertificatePolicy policy(SecurityFixtures.Institution i,List<byte[]> evidence,Instant at){return new CertificatePolicy(Set.of(new TrustAnchor(i.root(),null)),List.of(),at,evidence);}
}
