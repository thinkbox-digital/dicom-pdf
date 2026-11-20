package digital.thinkbox.pdfsecurity.testing;

import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.math.BigInteger;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.time.*;
import java.util.*;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.cert.X509v2CRLBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/** Synthetic institutional credentials only; never production trust material. */
public final class SecurityFixtures {
    public static final char[] PASSWORD="synthetic-test-only".toCharArray();
    public record Institution(KeyPair rootKey,X509Certificate root,KeyPair leafKey,X509Certificate leaf,Path pkcs12,Instant now){
        public SigningIdentity identity()throws Exception{return SigningIdentity.load(pkcs12,PASSWORD,null,now);}
        public CertificatePolicy policy(boolean revoked)throws Exception{return new CertificatePolicy(Set.of(new TrustAnchor(root,null)),List.of(crl(this,revoked)),now);}
    }
    public static Institution institution(Path directory,boolean expired)throws Exception{
        return institution(directory,expired,false);
    }
    public static Institution institution(Path directory,boolean expired,boolean c2pa)throws Exception{
        Files.createDirectories(directory);Instant now=Instant.now();
        KeyPairGenerator generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);
        KeyPair rootKey=generator.generateKeyPair(),leafKey=generator.generateKeyPair();
        X500Name rootName=new X500Name("CN=SYNTHETIC ARCHIVE ROOT ONLY"),leafName=new X500Name("CN=SYNTHETIC INSTITUTION ONLY");
        var rootBuilder=new JcaX509v3CertificateBuilder(rootName,BigInteger.ONE,Date.from(now.minusSeconds(30*86400)),Date.from(now.plusSeconds(365*86400)),rootName,rootKey.getPublic());
        rootBuilder.addExtension(Extension.basicConstraints,true,new BasicConstraints(true));
        rootBuilder.addExtension(Extension.keyUsage,true,new KeyUsage(KeyUsage.keyCertSign|KeyUsage.cRLSign));
        var converter=new JcaX509CertificateConverter();
        var root=converter.getCertificate(rootBuilder.build(new JcaContentSignerBuilder("SHA256withRSA").build(rootKey.getPrivate())));
        var leafBuilder=new JcaX509v3CertificateBuilder(rootName,BigInteger.TWO,Date.from(now.minusSeconds(20*86400)),Date.from(now.plusSeconds(expired?-86400:30*86400)),leafName,leafKey.getPublic());
        leafBuilder.addExtension(Extension.basicConstraints,true,new BasicConstraints(false));
        leafBuilder.addExtension(Extension.keyUsage,true,new KeyUsage(KeyUsage.digitalSignature|KeyUsage.nonRepudiation));
        if(c2pa){
            leafBuilder.addExtension(Extension.extendedKeyUsage,false,new ExtendedKeyUsage(KeyPurposeId.getInstance(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.3.6.1.5.5.7.3.36"))));
            leafBuilder.addExtension(Extension.authorityKeyIdentifier,false,new JcaX509ExtensionUtils().createAuthorityKeyIdentifier(root));
        }
        var leaf=converter.getCertificate(leafBuilder.build(new JcaContentSignerBuilder("SHA256withRSA").build(rootKey.getPrivate())));
        KeyStore store=KeyStore.getInstance("PKCS12");store.load(null,PASSWORD);
        store.setKeyEntry("institution",leafKey.getPrivate(),PASSWORD,new java.security.cert.Certificate[]{leaf,root});
        Path file=directory.resolve("institution.p12");try(var output=Files.newOutputStream(file)){store.store(output,PASSWORD);}
        return new Institution(rootKey,root,leafKey,leaf,file,now);
    }
    public static X509CRL crl(Institution institution,boolean revoked)throws Exception{
        var builder=new X509v2CRLBuilder(new X500Name(institution.root().getSubjectX500Principal().getName()),Date.from(institution.now().minusSeconds(3600)));
        builder.setNextUpdate(Date.from(institution.now().plusSeconds(86400)));
        if(revoked)builder.addCRLEntry(institution.leaf().getSerialNumber(),Date.from(institution.now().minusSeconds(1800)),1);
        return new JcaX509CRLConverter().getCRL(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
    }
    public record TimestampIdentity(KeyPair key,X509Certificate certificate) {}
    public static TimestampIdentity timestampIdentity(Institution institution)throws Exception{
        var generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);var key=generator.generateKeyPair();
        var builder=new JcaX509v3CertificateBuilder(new X500Name(institution.root().getSubjectX500Principal().getName()),java.math.BigInteger.valueOf(3),
            Date.from(institution.now().minusSeconds(86400)),Date.from(institution.now().plusSeconds(86400)),new X500Name("CN=SYNTHETIC TSA ONLY"),key.getPublic());
        builder.addExtension(Extension.basicConstraints,true,new BasicConstraints(false));
        builder.addExtension(Extension.keyUsage,true,new KeyUsage(KeyUsage.digitalSignature));
        builder.addExtension(Extension.extendedKeyUsage,true,new ExtendedKeyUsage(KeyPurposeId.id_kp_timeStamping));
        var certificate=new JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
        return new TimestampIdentity(key,certificate);
    }
    public static String pem(java.security.cert.Certificate certificate)throws Exception{
        return "-----BEGIN CERTIFICATE-----\n"+Base64.getMimeEncoder(64,new byte[]{10}).encodeToString(certificate.getEncoded())+"\n-----END CERTIFICATE-----\n";
    }
}
