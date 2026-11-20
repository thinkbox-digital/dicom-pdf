package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.cms.CMSAttributes;
import org.bouncycastle.cms.CMSSignedData;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class PdfValidationStoreTest {
    @TempDir Path temporary;
    @Test void publicEvidenceRoundTripsDeduplicatedWithoutBecomingTrust()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);
        var policy=new CertificatePolicy(i.policy(false).anchors(),i.policy(false).crls(),i.now(),List.of(digital.thinkbox.pdfsecurity.testing.TestOcspService.response(i,"")));
        try(var document=new PDDocument()){
            PdfValidationStore.retain(document,List.of(i.leaf(),i.root(),i.leaf()),policy);
            var evidence=PdfValidationStore.read(document);assertEquals(2,evidence.certificates().size());assertEquals(1,evidence.crls().size());assertEquals(1,evidence.ocsps().size());
            var untrusted=evidence.augment(CertificatePolicy.untrusted(i.now())).check(i.leaf(),evidence.certificates());
            assertEquals(UNKNOWN,untrusted.get("certificateTrust").status());
            var trusted=evidence.augment(new CertificatePolicy(i.policy(false).anchors(),List.of(),i.now())).check(i.leaf(),evidence.certificates());
            assertEquals(PASS,trusted.get("revocation").status());
            assertThrows(IOException.class,()->PdfValidationStore.retain(document,List.of(i.leaf()),policy));
        }
    }
    @Test void nonstandardMalformedAndOversizedDssAreExplicitFailures()throws Exception{
        try(var document=new PDDocument()){
            var dss=new COSDictionary();document.getDocumentCatalog().getCOSObject().setItem(COSName.getPDFName("DSS"),dss);
            assertThrows(IOException.class,()->PdfValidationStore.read(document));
            dss.setItem(COSName.getPDFName("Certs"),new COSString("not a stream array"));
            assertThrows(IOException.class,()->PdfValidationStore.read(document));
            var array=new COSArray();dss.setItem(COSName.getPDFName("Certs"),array);
            var stream=document.getDocument().createCOSStream();array.add(stream);
            try(var out=stream.createOutputStream(COSName.FLATE_DECODE)){out.write(new byte[16*1024*1024+1]);}
            assertThrows(IOException.class,()->PdfValidationStore.read(document));
            dss.setItem(COSName.getPDFName("UnrecognizedEvidence"),COSBoolean.TRUE);
            assertThrows(IOException.class,()->PdfValidationStore.read(document));
        }
    }
    @Test void pdfCmsIsDerAndOmitsCmsSigningTimeWhileManifestBehaviorIsPreserved()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);byte[] content={1,2,3};
        try(var identity=i.identity()){
            byte[] pdf=CmsSigning.signPdf(new ByteArrayInputStream(content),identity,i.now(),null);
            assertArrayEquals(pdf,ASN1Primitive.fromByteArray(pdf).getEncoded(ASN1Encoding.DER));
            assertEquals(2,PdfValidationStore.cmsCertificates(Arrays.copyOf(pdf,128*1024)).size());
            var signer=new CMSSignedData(pdf).getSignerInfos().getSigners().iterator().next();
            assertNull(signer.getSignedAttributes().get(CMSAttributes.signingTime));
            byte[] manifest=CmsSigning.sign(new ByteArrayInputStream(content),identity,i.now());
            assertNotNull(new CMSSignedData(manifest).getSignerInfos().getSigners().iterator().next().getSignedAttributes().get(CMSAttributes.signingTime));
            assertEquals(PASS,CmsVerification.verify(new ByteArrayInputStream(content),pdf,i.policy(false)).get("cryptographicSignature").status());
        }
    }
    @Test void missingRetainedCertificateCannotHideBehindAValidPdfSignature()throws Exception{
        var i=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),base=temporary.resolve("base.pdf"),prepared=temporary.resolve("prepared.pdf"),signed=temporary.resolve("signed.pdf");
        SyntheticFixtures.writeReferences(inputs);DicomPdf.create(inputs,base,"archival-master",false);
        try(var document=Loader.loadPDF(base.toFile())){
            PdfValidationStore.retain(document,List.of(i.leaf()),i.policy(false));document.save(prepared.toFile());
        }
        try(var identity=i.identity()){PdfCmsSigning.sign(prepared,signed,identity,i.now());}
        var checked=PdfCmsVerification.verify(signed,i.policy(false));
        assertEquals(PASS,checked.get("coverage").status());assertEquals(PASS,checked.get("cryptographicSignature").status());
        assertEquals(FAIL,checked.get("retainedCertificates").status());
    }
    @Test void signedMalformedDssReportsEvidenceFailureSeparatelyFromSignatureCoverage()throws Exception{
        var i=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),base=temporary.resolve("base.pdf"),prepared=temporary.resolve("prepared.pdf"),signed=temporary.resolve("signed.pdf");
        SyntheticFixtures.writeReferences(inputs);DicomPdf.create(inputs,base,"archival-master",false);
        try(var document=Loader.loadPDF(base.toFile())){
            document.getDocumentCatalog().getCOSObject().setItem(COSName.getPDFName("DSS"),new COSString("invalid dictionary"));document.save(prepared.toFile());
        }
        try(var identity=i.identity()){PdfCmsSigning.sign(prepared,signed,identity,i.now());}
        var checked=PdfCmsVerification.verify(signed,i.policy(false));
        assertEquals(PASS,checked.get("coverage").status());assertEquals(PASS,checked.get("cryptographicSignature").status());
        assertEquals(FAIL,checked.get("validationStore").status());
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void ocspOnlyArchivePreservesBytesAndPassesPdfaWithoutTrustingEmbeddedRoot()throws Exception{
        var i=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),pdf=temporary.resolve("signed.pdf");SyntheticFixtures.writeReferences(inputs);
        var policy=new CertificatePolicy(i.policy(false).anchors(),List.of(),i.now(),List.of(digital.thinkbox.pdfsecurity.testing.TestOcspService.response(i,"")));
        String vera=System.getProperty("dicompdf.test.verapdf");
        try(var identity=i.identity()){
            ArchiveSecurity.create(inputs,pdf,new ArchiveSecurity.Options(identity,policy,vera,ArchiveSecurity.Protection.CMS_AND_PDF,Clock.fixed(i.now(),ZoneOffset.UTC)));
        }
        var emptyLocalEvidence=new CertificatePolicy(policy.anchors(),List.of(),i.now());
        var verified=ArchiveSecurity.verify(pdf,inputs,emptyLocalEvidence,vera,ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals("EXPORT_AUTHENTICATED",verified.assurance(),verified.json());
        for(String key:List.of("pdfa4f","originalBytes","metadataAgreement","pdf.validationStore","pdf.retainedCertificates","pdf.revocation","manifest.revocation"))assertEquals(PASS,verified.checks().get(key).status(),key+verified.json());
        try(var document=Loader.loadPDF(pdf.toFile())){
            var evidence=PdfValidationStore.read(document);assertEquals(0,evidence.crls().size());assertEquals(1,evidence.ocsps().size());
            assertTrue(PdfValidationStore.containsCertificates(evidence,List.of(i.leaf(),i.root())));
        }
        var untrusted=ArchiveSecurity.verify(pdf,inputs,CertificatePolicy.untrusted(i.now()),vera,ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals("INTEGRITY_ONLY",untrusted.assurance());assertEquals(UNKNOWN,untrusted.checks().get("pdf.certificateTrust").status());
        var changed=temporary.resolve("changed-dss.pdf");
        try(var document=Loader.loadPDF(pdf.toFile());var out=Files.newOutputStream(changed)){
            document.getDocumentCatalog().getCOSObject().removeItem(COSName.getPDFName("DSS"));document.saveIncremental(out);
        }
        assertEquals(FAIL,PdfCmsVerification.verify(changed,emptyLocalEvidence).get("coverage").status());
        var revoked=new CertificatePolicy(policy.anchors(),List.of(),i.now(),List.of(digital.thinkbox.pdfsecurity.testing.TestOcspService.response(i,"revoked")));
        Path refused=temporary.resolve("revoked-must-not-publish.pdf");
        try(var identity=i.identity()){
            assertThrows(IOException.class,()->ArchiveSecurity.create(inputs,refused,new ArchiveSecurity.Options(identity,revoked,vera,ArchiveSecurity.Protection.CMS_AND_PDF,Clock.fixed(i.now(),ZoneOffset.UTC))));
        }
        assertFalse(Files.exists(refused));
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void tsaCertificateRotationCannotSilentlyOmitValidationMaterial()throws Exception{
        var i=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),refused=temporary.resolve("missing-tsa-chain.pdf");SyntheticFixtures.writeReferences(inputs);
        var first=digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(i,"");var second=digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(i,"");var calls=new java.util.concurrent.atomic.AtomicInteger();
        var client=new Rfc3161Client(request->calls.incrementAndGet()==1?first.request(request):second.request(request),i.policy(false),Clock.fixed(i.now(),ZoneOffset.UTC),"1.2.3.4.5");
        try(var identity=i.identity()){
            var failure=assertThrows(IOException.class,()->ArchiveSecurity.create(inputs,refused,new ArchiveSecurity.Options(identity,i.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,Clock.fixed(i.now(),ZoneOffset.UTC),client)));
            assertTrue(failure.getMessage().contains("pdf.retainedCertificates"),failure.getMessage());
        }
        assertEquals(2,calls.get());assertFalse(Files.exists(refused));
    }
}
