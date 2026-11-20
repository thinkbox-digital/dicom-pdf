package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.cms.*;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.operator.jcajce.*;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.cms.*;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.tsp.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

class ArchiveSecurityTest {
    @TempDir Path temporary;
    @Test void detachedCmsChecksActualBytesAndLocalTrustSeparately()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);byte[] content="canonical manifest evidence".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try(var identity=institution.identity()){
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(content),identity,institution.now());
            var checked=CmsVerification.verify(new ByteArrayInputStream(content),cms,institution.policy(false));
            for(String key:List.of("cryptographicSignature","certificateValidity","certificateTrust","keyPolicy","revocation"))assertEquals(PASS,checked.get(key).status(),key);
            assertEquals(UNKNOWN,checked.get("timestamp").status());
            var untrusted=CmsVerification.verify(new ByteArrayInputStream(content),cms,CertificatePolicy.untrusted(institution.now()));
            assertEquals(PASS,untrusted.get("cryptographicSignature").status());assertEquals(UNKNOWN,untrusted.get("certificateTrust").status());
            content[0]^=1;assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(content),cms,institution.policy(false)).get("cryptographicSignature").status());
        }
    }
    @Test void invalidCmsSignatureCannotPassBecauseHashesAreCorrect()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);byte[] content={1,2,3};
        try(var identity=institution.identity()){
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(content),identity,institution.now());
            byte[] signature=new CMSSignedData(cms).getSignerInfos().getSigners().iterator().next().getSignature();
            int offset=-1;for(int i=0;i<=cms.length-signature.length;i++)if(Arrays.equals(Arrays.copyOfRange(cms,i,i+signature.length),signature)){offset=i;break;}
            assertTrue(offset>=0);cms[offset+signature.length/2]^=1;
            assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(content),cms,institution.policy(false)).get("cryptographicSignature").status());
        }
    }
    @Test void revocationFailureIsNotHiddenByAValidSignature()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);byte[] content={1,2,3};
        try(var identity=institution.identity()){
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(content),identity,institution.now());
            var result=CmsVerification.verify(new ByteArrayInputStream(content),cms,institution.policy(true));
            assertEquals(PASS,result.get("cryptographicSignature").status());assertEquals(FAIL,result.get("revocation").status());
        }
    }
    @Test void staleForgedRevocationAndUntrustedRootsAreNotAccepted()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("one"),false);
        var other=SecurityFixtures.institution(temporary.resolve("other"),false);byte[] content={1,2,3};
        try(var identity=institution.identity()){
            byte[] cms=CmsSigning.sign(new ByteArrayInputStream(content),identity,institution.now());
            var stale=new CertificatePolicy(institution.policy(false).anchors(),institution.policy(false).crls(),institution.now().plusSeconds(2*86400));
            assertEquals(UNKNOWN,CmsVerification.verify(new ByteArrayInputStream(content),cms,stale).get("revocation").status());
            var forged=new CertificatePolicy(institution.policy(false).anchors(),other.policy(false).crls(),institution.now());
            assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(content),cms,forged).get("revocation").status());
            var wrongRoot=new CertificatePolicy(other.policy(false).anchors(),institution.policy(false).crls(),institution.now());
            assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(content),cms,wrongRoot).get("certificateTrust").status());
        }
    }
    @Test void expiredCertificateIsRejectedAndHistoricalSignatureDoesNotBecomeTrustedTime()throws Exception{
        var institution=SecurityFixtures.institution(temporary,true);
        assertThrows(Exception.class,institution::identity);
        Instant earlier=institution.now().minusSeconds(2*86400);
        try(var identity=SigningIdentity.load(institution.pkcs12(),SecurityFixtures.PASSWORD,null,earlier)){
            byte[] content={1,2,3};byte[] cms=CmsSigning.sign(new ByteArrayInputStream(content),identity,earlier);
            var checked=CmsVerification.verify(new ByteArrayInputStream(content),cms,institution.policy(false));
            assertEquals(PASS,checked.get("cryptographicSignature").status());assertEquals(FAIL,checked.get("certificateValidity").status());assertEquals(UNKNOWN,checked.get("timestamp").status());
        }
    }
    @Test void pdfSignatureCoversCompletedFileAndRejectsUnsignedRevisions()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path input=temporary.resolve("inputs"),base=temporary.resolve("base.pdf"),signed=temporary.resolve("signed.pdf"),changed=temporary.resolve("changed.pdf");
        SyntheticFixtures.writeDeidentifiedCopy(input);DicomPdf.create(input,base,"archival-master",false);
        try(var identity=institution.identity()){PdfCmsSigning.sign(base,signed,identity,institution.now());}
        var checked=PdfCmsVerification.verify(signed,institution.policy(false));
        assertEquals(PASS,checked.get("coverage").status(),checked.toString());assertEquals(PASS,checked.get("cryptographicSignature").status(),checked.toString());
        assertEquals("PASS",PackageTools.verify(signed,input,null).sourceBytes().status());
        try(var document=Loader.loadPDF(signed.toFile());var output=Files.newOutputStream(changed)){
            document.getDocumentInformation().setTitle("Changed after signing");document.saveIncremental(output);
        }
        assertEquals(FAIL,PdfCmsVerification.verify(changed,institution.policy(false)).get("coverage").status());
        byte[] before=Files.readAllBytes(signed);
        try(var identity=institution.identity()){assertThrows(Exception.class,()->PdfCmsSigning.sign(base,signed,identity,institution.now()));}
        assertArrayEquals(before,Files.readAllBytes(signed));
    }
    @Test void credentialCopiesCannotBeEmbeddedAndUnsupportedLtaNeverDowngrades()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path input=temporary.resolve("inputs"),output=temporary.resolve("out.pdf");SyntheticFixtures.writeDeidentifiedCopy(input);
        Files.copy(institution.pkcs12(),input.resolve("innocent.bin"));
        try(var identity=institution.identity()){
            var options=new ArchiveSecurity.Options(identity,institution.policy(false),"not-used-before-input-check",ArchiveSecurity.Protection.CMS_AND_PDF,Clock.systemUTC());
            assertThrows(Exception.class,()->ArchiveSecurity.create(input,output,options));assertFalse(Files.exists(output));
            var lta=new ArchiveSecurity.Options(identity,institution.policy(false),"not-used",ArchiveSecurity.Protection.PADES_B_LTA,Clock.systemUTC());
            var failure=assertThrows(IOException.class,()->ArchiveSecurity.create(input,output,lta));assertTrue(failure.getMessage().contains("no downgrade"));assertFalse(Files.exists(output));
        }
    }
    @Test void missingSignaturesNeverBecomeAuthenticated()throws Exception{
        Path input=temporary.resolve("input"),pdf=temporary.resolve("unsigned.pdf");SyntheticFixtures.writeDeidentifiedCopy(input);DicomPdf.create(input,pdf);
        var result=ArchiveSecurity.verify(pdf,input,CertificatePolicy.untrusted(Instant.now()),null,ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals("INTEGRITY_ONLY",result.assurance());assertEquals(FAIL,result.checks().get("securityStructure").status());
        assertEquals(1,result.exitCode());assertEquals(UNKNOWN,result.checks().get("clinicalCompleteness").status());
    }
    @Test void rfc3161TimestampChecksImprintSignatureTrustAndRevocation()throws Exception{
        var institution=SecurityFixtures.institution(temporary,false);byte[] content={1,2,3};
        try(var identity=institution.identity()){
            byte[] signature=CmsSigning.sign(new ByteArrayInputStream(content),identity,institution.now());
            var good=timestamp(signature,institution,false);
            var checked=CmsVerification.verify(new ByteArrayInputStream(content),good,institution.policy(false));
            assertEquals(PASS,checked.get("cryptographicSignature").status(),checked.toString());assertEquals(PASS,checked.get("timestamp").status(),checked.toString());
            var untrusted=CmsVerification.verify(new ByteArrayInputStream(content),good,CertificatePolicy.untrusted(institution.now()));
            assertEquals(UNKNOWN,untrusted.get("timestamp").status());
            var bad=CmsVerification.verify(new ByteArrayInputStream(content),timestamp(signature,institution,true),institution.policy(false));
            assertEquals(PASS,bad.get("cryptographicSignature").status());assertEquals(FAIL,bad.get("timestamp").status());
            var earlier=new CertificatePolicy(institution.policy(false).anchors(),institution.policy(false).crls(),institution.now().minusSeconds(3600));
            assertEquals(FAIL,CmsVerification.verify(new ByteArrayInputStream(content),good,earlier).get("timestamp").status());
        }
    }
    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void existingSourceSignatureBytesArePreservedWithoutInventingAcquisitionAuthentication()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path input=temporary.resolve("inputs"),output=temporary.resolve("signed-source.pdf");SyntheticFixtures.writeDeidentifiedCopy(input);
        Path source;try(var files=Files.list(input)){source=files.filter(p->p.toString().endsWith(".dcm")).findFirst().orElseThrow();}
        org.dcm4che3.data.Attributes meta,dataset;
        try(var stream=new org.dcm4che3.io.DicomInputStream(source.toFile())){meta=stream.readFileMetaInformation();dataset=stream.readDataset(-1,-1);}
        var signature=new org.dcm4che3.data.Attributes();
        signature.setString(org.dcm4che3.data.Tag.DigitalSignatureUID,org.dcm4che3.data.VR.UI,"2.25.314159.999");
        signature.setBytes(org.dcm4che3.data.Tag.Signature,org.dcm4che3.data.VR.OB,new byte[]{7,8,9,10});
        dataset.newSequence(org.dcm4che3.data.Tag.DigitalSignaturesSequence,1).add(signature);
        try(var stream=new org.dcm4che3.io.DicomOutputStream(source.toFile())){stream.writeDataset(meta,dataset);}
        byte[] original=Files.readAllBytes(source);
        try(var identity=institution.identity()){
            ArchiveSecurity.create(input,output,new ArchiveSecurity.Options(identity,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF,Clock.systemUTC()));
        }
        Path recovery=temporary.resolve("recovered");PackageTools.extract(output,recovery);
        assertArrayEquals(original,Files.readAllBytes(recovery.resolve("originals").resolve(source.getFileName())));
        var checked=ArchiveSecurity.verify(output,input,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals("EXPORT_AUTHENTICATED",checked.assurance());assertEquals(UNKNOWN,checked.checks().get("dicomSignatures").status());
        assertNotEquals("SOURCE_AUTHENTICATED",checked.assurance());
    }
    private byte[] timestamp(byte[] encoded,SecurityFixtures.Institution institution,boolean wrongImprint)throws Exception{
        var cms=new CMSSignedData(encoded);var signer=cms.getSignerInfos().getSigners().iterator().next();
        var tsa=SecurityFixtures.timestampIdentity(institution);
        var digestProvider=new JcaDigestCalculatorProviderBuilder().build();
        var signerInfo=new JcaSignerInfoGeneratorBuilder(digestProvider).build(new JcaContentSignerBuilder("SHA256withRSA").build(tsa.key().getPrivate()),tsa.certificate());
        var generator=new TimeStampTokenGenerator(signerInfo,digestProvider.get(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256)),new ASN1ObjectIdentifier("1.2.3.4.5"));
        generator.addCertificates(new JcaCertStore(List.of(tsa.certificate(),institution.root())));
        var requestGenerator=new TimeStampRequestGenerator();requestGenerator.setCertReq(true);
        byte[] imprint=java.security.MessageDigest.getInstance("SHA-256").digest(wrongImprint?new byte[]{9,9,9}:signer.getSignature());
        var request=requestGenerator.generate(TSPAlgorithms.SHA256,imprint,java.math.BigInteger.valueOf(42));
        var token=generator.generate(request,java.math.BigInteger.valueOf(123),Date.from(institution.now()));
        var attribute=new Attribute(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken,new DERSet(token.toCMSSignedData().toASN1Structure()));
        var updated=SignerInformation.replaceUnsignedAttributes(signer,new AttributeTable(attribute));
        return CMSSignedData.replaceSigners(cms,new SignerInformationStore(updated)).getEncoded();
    }
    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void completeSecureArchiveKeepsDuplicatesAndPassesRealPdfaValidation()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path input=temporary.resolve("inputs"),output=temporary.resolve("archive.pdf");SyntheticFixtures.writeReferences(input);
        try(var identity=institution.identity()){
            var options=new ArchiveSecurity.Options(identity,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF,Clock.systemUTC());
            var created=ArchiveSecurity.create(input,output,options);assertEquals(5,created.images().size());
        }
        var result=ArchiveSecurity.verify(output,input,new CertificatePolicy(institution.policy(false).anchors(),List.of(),Instant.now()),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals("EXPORT_AUTHENTICATED",result.assurance(),result.json());
        assertEquals(PASS,result.checks().get("pdfa4f").status());assertEquals(PASS,result.checks().get("manifest.revocation").status());
        assertEquals(PASS,result.checks().get("capturedInventory").status());assertEquals(UNKNOWN,result.checks().get("acquisitionProvenance").status());
        assertEquals(UNKNOWN,result.checks().get("trustedTimestamp").status());
        try(var files=Files.list(input)){Files.delete(files.findFirst().orElseThrow());}
        assertEquals(FAIL,ArchiveSecurity.verify(output,input,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF).checks().get("inventoryReconciliation").status());
    }
}
