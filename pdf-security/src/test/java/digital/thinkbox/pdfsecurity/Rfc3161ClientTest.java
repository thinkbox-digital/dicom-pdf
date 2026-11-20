package digital.thinkbox.pdfsecurity;

import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.math.BigInteger;
import java.net.URI;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.operator.jcajce.*;
import org.bouncycastle.tsp.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;


import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;
import static digital.thinkbox.pdfsecurity.testing.TestTimestampService.*;
class Rfc3161ClientTest {
    @TempDir Path temporary;
    private static final String POLICY="1.2.3.4.5";
    private static final byte[] CONTENT={1,2,3,4};

    @Test void obtainsTimestampForActualSignatureWithoutSendingContent()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);
        var exchange=service(institution,"");
        try(var identity=institution.identity()){
            var client=client(institution,bytes->{
                var request=new TimeStampRequest(bytes);assertEquals(32,request.getMessageImprintDigest().length);
                assertTrue(bytes.length<512);return exchange.request(bytes);
            });
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client);
            var result=CmsVerification.verify(new ByteArrayInputStream(CONTENT),cms,institution.policy(false));
            assertEquals(PASS,result.get("cryptographicSignature").status(),result.toString());
            assertEquals(PASS,result.get("timestamp").status(),result.toString());
            assertThrows(IOException.class,()->client.timestampCms(cms));
            var parsed=new org.bouncycastle.cms.CMSSignedData(cms);var signer=parsed.getSignerInfos().getSigners().iterator().next();
            var attributes=signer.getUnsignedAttributes().toASN1EncodableVector();attributes.add(attributes.get(0));
            var ambiguous=org.bouncycastle.cms.SignerInformation.replaceUnsignedAttributes(signer,new org.bouncycastle.asn1.cms.AttributeTable(attributes));
            byte[] duplicates=org.bouncycastle.cms.CMSSignedData.replaceSigners(parsed,new org.bouncycastle.cms.SignerInformationStore(ambiguous)).getEncoded();
            assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(CONTENT),duplicates,institution.policy(false)).get("timestamp").status());
        }
    }
    @Test void mismatchedNonceImprintAndPolicyAreRefused()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);
        try(var identity=institution.identity()){
            for(String defect:List.of("nonce","imprint","policy")){
                var client=client(institution,service(institution,defect));
                assertThrows(Exception.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client),defect);
            }
        }
    }
    @Test void untrustedAndRevokedTsaCannotProduceSuccessfulTimestamp()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        var untrusted=new Rfc3161Client(service(institution,""),CertificatePolicy.untrusted(institution.now()),clock,POLICY);
        var crl=new org.bouncycastle.cert.X509v2CRLBuilder(new org.bouncycastle.asn1.x500.X500Name(institution.root().getSubjectX500Principal().getName()),Date.from(institution.now().minusSeconds(60)));
        crl.setNextUpdate(Date.from(institution.now().plusSeconds(3600)));crl.addCRLEntry(BigInteger.valueOf(3),Date.from(institution.now().minusSeconds(30)),1);
        var revoked=new org.bouncycastle.cert.jcajce.JcaX509CRLConverter().getCRL(crl.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
        var policy=new CertificatePolicy(institution.policy(false).anchors(),List.of(revoked),institution.now());
        var revokedClient=new Rfc3161Client(service(institution,""),policy,clock,POLICY);
        try(var identity=institution.identity()){
            for(var client:List.of(untrusted,revokedClient))assertThrows(IOException.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client));
        }
    }
    @Test void missingRevocationEvidenceIsIdentifiedInTheFailure()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);
        var policy=new CertificatePolicy(institution.policy(false).anchors(),List.of(),institution.now());
        var timestamp=new Rfc3161Client(service(institution,""),policy,Clock.fixed(institution.now(),ZoneOffset.UTC),POLICY);
        var failure=assertThrows(IOException.class,()->timestamp.timestampDigest(new byte[32]));
        assertTrue(failure.getMessage().contains("timestamp.revocation=UNKNOWN"),failure.toString());
        assertTrue(failure.getMessage().contains("FRESH_SUPPORTED_REVOCATION_EVIDENCE_MISSING"),failure.toString());
    }
    @Test void rejectedMalformedOversizedAndUntimelyResponsesFailExplicitly()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);
        try(var identity=institution.identity()){
            for(String defect:List.of("reject","future","old")){
                var client=client(institution,service(institution,defect));
                assertThrows(Exception.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client),defect);
            }
            for(byte[] response:List.of(new byte[]{1,2,3},new byte[Rfc3161Client.MAX_RESPONSE+1])){
                var client=client(institution,request->response);
                assertThrows(Exception.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client));
            }
            var client=client(institution,request->{throw new IOException("Synthetic unavailable service");});
            assertThrows(IOException.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client));
        }
    }
    @Test void httpsTransportIsExplicitAndRejectsUnsafeEndpointForms(){
        var policy=CertificatePolicy.untrusted(Instant.now());
        for(String endpoint:List.of("http://example.test/tsa","https://user:password@example.test/tsa","https://example.test/tsa?token=secret","https://example.test/tsa#fragment"))
            assertThrows(IllegalArgumentException.class,()->Rfc3161Client.https(URI.create(endpoint),policy,Clock.systemUTC(),null));
        assertNotNull(Rfc3161Client.https(URI.create("https://example.test/tsa"),policy,Clock.systemUTC(),null));
        assertNotNull(Rfc3161Client.endpoint(URI.create("http://example.test/tsa"),policy,Clock.systemUTC(),null));
        for(String endpoint:List.of("file:///tmp/tsa","ftp://example.test/tsa","http://user:password@example.test/tsa","http://example.test/tsa?token=secret","http://example.test/tsa#fragment"))
            assertThrows(IllegalArgumentException.class,()->Rfc3161Client.endpoint(URI.create(endpoint),policy,Clock.systemUTC(),null));
    }
    @Test void connectionFailuresNameTheServerAndPortWithoutChangingProtocol()throws Exception{
        int port;
        try(var reserved=new java.net.ServerSocket(0,1,java.net.InetAddress.getLoopbackAddress())){port=reserved.getLocalPort();}
        var endpoint=URI.create("https://127.0.0.1:"+port+"/private-service-path");
        var client=Rfc3161Client.endpoint(endpoint,CertificatePolicy.untrusted(Instant.now()),Clock.systemUTC(),null);
        var failure=assertThrows(IOException.class,()->client.timestampDigest(new byte[32]));
        assertTrue(failure.getMessage().contains("https://127.0.0.1:"+port),failure.toString());
        assertTrue(failure.getMessage().contains("Connection refused"),failure.toString());
        assertTrue(failure.getCause() instanceof java.net.ConnectException);assertFalse(failure.getMessage().contains("private-service-path"));
    }
    @Test void httpsExchangeChecksTlsMediaTypeRedirectsAndResponseBounds()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);
        var keyGenerator=java.security.KeyPairGenerator.getInstance("RSA");keyGenerator.initialize(2048);var serverKey=keyGenerator.generateKeyPair();
        var name=new org.bouncycastle.asn1.x500.X500Name("CN=localhost");
        var builder=new org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder(new org.bouncycastle.asn1.x500.X500Name(institution.root().getSubjectX500Principal().getName()),BigInteger.valueOf(4),Date.from(institution.now().minusSeconds(60)),Date.from(institution.now().plusSeconds(3600)),name,serverKey.getPublic());
        builder.addExtension(org.bouncycastle.asn1.x509.Extension.subjectAlternativeName,false,new org.bouncycastle.asn1.x509.GeneralNames(new org.bouncycastle.asn1.x509.GeneralName(org.bouncycastle.asn1.x509.GeneralName.iPAddress,"127.0.0.1")));
        var certificate=new org.bouncycastle.cert.jcajce.JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withRSA").build(institution.rootKey().getPrivate())));
        var keys=java.security.KeyStore.getInstance("PKCS12");keys.load(null,SecurityFixtures.PASSWORD);keys.setKeyEntry("tls",serverKey.getPrivate(),SecurityFixtures.PASSWORD,new java.security.cert.Certificate[]{certificate,institution.root()});
        var keyManager=javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());keyManager.init(keys,SecurityFixtures.PASSWORD);
        var trusted=java.security.KeyStore.getInstance("PKCS12");trusted.load(null,null);trusted.setCertificateEntry("root",institution.root());
        var trustManager=javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());trustManager.init(trusted);
        var tls=javax.net.ssl.SSLContext.getInstance("TLS");tls.init(keyManager.getKeyManagers(),trustManager.getTrustManagers(),null);
        var server=com.sun.net.httpserver.HttpsServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        server.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));
        var exchange=service(institution,"");var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
        server.createContext("/tsa",http->{
            try{
                assertEquals("POST",http.getRequestMethod());assertEquals("application/timestamp-query",http.getRequestHeaders().getFirst("Content-Type"));
                byte[] response=exchange.request(http.getRequestBody().readAllBytes());
                http.getResponseHeaders().set("Content-Type","application/timestamp-reply");http.sendResponseHeaders(200,response.length);http.getResponseBody().write(response);
            }catch(Throwable problem){failure.set(problem);}finally{http.close();}
        });
        var redirected=new AtomicInteger();
        server.createContext("/redirect",http->{redirected.incrementAndGet();http.getResponseHeaders().set("Location","/tsa");http.sendResponseHeaders(302,-1);http.close();});
        server.createContext("/wrong-type",http->{http.getResponseHeaders().set("Content-Type","text/html");http.sendResponseHeaders(200,4);http.getResponseBody().write(new byte[4]);http.close();});
        server.createContext("/too-large",http->{http.getResponseHeaders().set("Content-Type","application/timestamp-reply");http.sendResponseHeaders(200,Rfc3161Client.MAX_RESPONSE+1);http.close();});
        var original=javax.net.ssl.HttpsURLConnection.getDefaultSSLSocketFactory();server.start();
        try(var identity=institution.identity()){
            javax.net.ssl.HttpsURLConnection.setDefaultSSLSocketFactory(tls.getSocketFactory());
            String address="https://127.0.0.1:"+server.getAddress().getPort();
            var client=Rfc3161Client.https(URI.create(address+"/tsa"),institution.policy(false),Clock.fixed(institution.now(),ZoneOffset.UTC),POLICY);
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),client);
            assertNull(failure.get());assertEquals(PASS,CmsVerification.verify(new ByteArrayInputStream(CONTENT),cms,institution.policy(false)).get("timestamp").status());
            for(String path:List.of("/redirect","/wrong-type","/too-large")){
                var rejected=Rfc3161Client.https(URI.create(address+path),institution.policy(false),Clock.fixed(institution.now(),ZoneOffset.UTC),POLICY);
                var problem=assertThrows(IOException.class,()->CmsSigning.sign(new ByteArrayInputStream(CONTENT),identity,institution.now(),rejected));
                assertTrue(problem.getMessage().contains(path.equals("/redirect")?"HTTP 302":path.equals("/wrong-type")?"Content-Type: text/html":"exceeds size limit"),problem.toString());
            }
            assertEquals(1,redirected.get());
        }finally{javax.net.ssl.HttpsURLConnection.setDefaultSSLSocketFactory(original);server.stop(0);}
    }
}
