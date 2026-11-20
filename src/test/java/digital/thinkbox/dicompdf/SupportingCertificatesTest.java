package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import java.math.BigInteger;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class SupportingCertificatesTest {
    @TempDir Path work;
    @Test void supportingCertificatesCompleteAChainWithoutBecomingTrustAnchors()throws Exception{
        var institution=SecurityFixtures.institution(work,false);var generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);
        var intermediateKey=generator.generateKeyPair();var leafKey=generator.generateKeyPair();
        var rootName=new X500Name(institution.root().getSubjectX500Principal().getName());var intermediateName=new X500Name("CN=SYNTHETIC INTERMEDIATE");
        var start=Date.from(institution.now().minusSeconds(3600));var end=Date.from(institution.now().plusSeconds(86400));
        var intermediateBuilder=new JcaX509v3CertificateBuilder(rootName,BigInteger.TEN,start,end,intermediateName,intermediateKey.getPublic());
        intermediateBuilder.addExtension(org.bouncycastle.asn1.x509.Extension.basicConstraints,true,new BasicConstraints(true));
        intermediateBuilder.addExtension(org.bouncycastle.asn1.x509.Extension.keyUsage,true,new KeyUsage(KeyUsage.keyCertSign|KeyUsage.cRLSign));
        var converter=new JcaX509CertificateConverter();var intermediate=converter.getCertificate(intermediateBuilder.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
        var leafBuilder=new JcaX509v3CertificateBuilder(intermediateName,BigInteger.valueOf(11),start,end,new X500Name("CN=SYNTHETIC LEAF"),leafKey.getPublic());
        leafBuilder.addExtension(org.bouncycastle.asn1.x509.Extension.basicConstraints,true,new BasicConstraints(false));
        leafBuilder.addExtension(org.bouncycastle.asn1.x509.Extension.keyUsage,true,new KeyUsage(KeyUsage.digitalSignature));
        var leaf=converter.getCertificate(leafBuilder.build(new JcaContentSignerBuilder("SHA256withRSA").build(intermediateKey.getPrivate())));
        var anchors=Set.of(new TrustAnchor(institution.root(),null));
        assertEquals(FAIL,new CertificatePolicy(anchors,List.of(),institution.now()).check(leaf,List.of(leaf)).get("certificateTrust").status());
        var policy=new CertificatePolicy(anchors,List.of(),institution.now(),List.of(),List.of(intermediate));
        assertEquals(PASS,policy.check(leaf,List.of(leaf)).get("certificateTrust").status());
        assertEquals(UNKNOWN,policy.check(leaf,List.of(leaf)).get("revocation").status());
        var untrusted=new CertificatePolicy(Set.of(),List.of(),institution.now(),List.of(),List.of(institution.root(),intermediate,leaf));
        assertEquals(UNKNOWN,untrusted.check(leaf,List.of(leaf)).get("certificateTrust").status());
        Path root=work.resolve("root.pem"),support=work.resolve("intermediate.pem");Files.writeString(root,SecurityFixtures.pem(institution.root()));Files.writeString(support,SecurityFixtures.pem(intermediate));
        Path config=work.resolve("configuration.json");Files.writeString(config,"{\"protection\":\"CMS_AND_PDF_TIMESTAMPED\",\"verapdf\":\"/unused/verapdf\",\"trustCertificates\":[\"root.pem\"],\"supportingCertificates\":[\"intermediate.pem\"],\"tsaUrl\":\"http://timestamp.example.test\"}");
        var loaded=new SecurityConfiguration(config);assertEquals(1,loaded.policy.anchors().size());assertEquals(List.of(intermediate),loaded.policy.supportingCertificates());
        assertNotNull(loaded.timestampClient());
        Files.writeString(config,Files.readString(config).replace("CMS_AND_PDF_TIMESTAMPED","CMS_AND_PDF"));
        assertEquals(ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,new SecurityConfiguration(config).protection,"A configured TSA enables timestamping without separate permission");
    }
}
