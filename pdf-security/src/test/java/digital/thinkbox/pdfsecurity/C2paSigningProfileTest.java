package digital.thinkbox.pdfsecurity;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;


import java.math.BigInteger;
import java.nio.file.Path;
import java.security.*;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class C2paSigningProfileTest {
    @TempDir Path work;
    @Test void diagnosesEachProfileViolationAndAcceptsSupportedSigningPurposes()throws Exception{
        var institution=SecurityFixtures.institution(work,false,true);
        for(var entry:Map.of("aki","Authority Key Identifier","eku","Extended Key Usage","ca","non-CA","usage","digitalSignature","tsa","timestamping").entrySet()){
            var issues=C2pa.signingProfileIssues(certificate(institution,institution.leafKey().getPublic(),entry.getKey(),"1.3.6.1.5.5.7.3.36"));
            assertEquals(1,issues.size(),issues.toString());assertTrue(issues.getFirst().contains(entry.getValue()),issues.toString());
        }
        var ec=KeyPairGenerator.getInstance("EC");ec.initialize(new ECGenParameterSpec("secp384r1"));
        var unsupported=C2pa.signingProfileIssues(certificate(institution,ec.generateKeyPair().getPublic(),"","1.3.6.1.5.5.7.3.36"));
        assertEquals(1,unsupported.size());assertTrue(unsupported.getFirst().contains("P-256"));
        ec.initialize(new ECGenParameterSpec("secp256r1"));
        for(var key:List.of(institution.leafKey().getPublic(),ec.generateKeyPair().getPublic()))for(var purpose:List.of("1.3.6.1.5.5.7.3.36","1.3.6.1.4.1.62558.2.1","1.3.6.1.5.5.7.3.4"))
            assertEquals(List.of(),C2pa.signingProfileIssues(certificate(institution,key,"",purpose)));
    }
    private static X509Certificate certificate(SecurityFixtures.Institution institution,PublicKey key,String defect,String purpose)throws Exception{
        var builder=new JcaX509v3CertificateBuilder(new X500Name(institution.root().getSubjectX500Principal().getName()),BigInteger.valueOf(25),Date.from(institution.now().minusSeconds(60)),Date.from(institution.now().plusSeconds(3600)),new X500Name("CN=SYNTHETIC PROFILE FIXTURE"),key);
        builder.addExtension(Extension.basicConstraints,true,new BasicConstraints(defect.equals("ca")));
        builder.addExtension(Extension.keyUsage,true,new KeyUsage(defect.equals("usage")?KeyUsage.nonRepudiation:KeyUsage.digitalSignature));
        if(!defect.equals("aki"))builder.addExtension(Extension.authorityKeyIdentifier,false,new JcaX509ExtensionUtils().createAuthorityKeyIdentifier(institution.root()));
        if(!defect.equals("eku")){
            var allowed=KeyPurposeId.getInstance(new org.bouncycastle.asn1.ASN1ObjectIdentifier(purpose));
            builder.addExtension(Extension.extendedKeyUsage,false,new ExtendedKeyUsage(defect.equals("tsa")?new KeyPurposeId[]{allowed,KeyPurposeId.id_kp_timeStamping}:new KeyPurposeId[]{allowed}));
        }
        return new JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
    }
}
