package digital.thinkbox.pdfsecurity;

import com.upokecenter.cbor.CBORObject;
import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;
import digital.thinkbox.pdfsecurity.testing.TestTimestampService;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class PdfSecurityTest {
    @TempDir Path directory;
    static final C2paProfile PROFILE=new C2paProfile(){
        public String credentialsFile(){return "example-provenance.c2pa";}
        public String policyFile(){return "example-policy.json";}
        public byte[] policyBytes(){return "{\"profile\":\"independent-library-test\"}\n".getBytes(StandardCharsets.UTF_8);}
        public String assertionLabel(){return "org.example.receipt";}
        public String generatorName(){return "independent-library-test";}
        public String generatorVersion(){return "1.0";}
        public CBORObject createAssertion(PDDocument document,boolean local)throws Exception{
            return CBORObject.NewMap().Add("receiptSha256",C2pa.attachmentDigest(document,"receipt.json")).Add("purpose","GENERIC_PDF");
        }
        public void verifyAssertion(PDDocument document,CBORObject assertion)throws Exception{
            if(!"GENERIC_PDF".equals(assertion.get("purpose").AsString())||!MessageDigest.isEqual(assertion.get("receiptSha256").GetByteString(),C2pa.attachmentDigest(document,"receipt.json")))throw new IOException("Receipt binding mismatch");
        }
    };

    static void prepared(Path file,C2paProfile profile)throws Exception{
        try(var document=new PDDocument()){
            document.addPage(new PDPage());
            var metadata=new PDMetadata(document);
            metadata.importXMPMetadata(("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"><xmpMM:InstanceID>urn:uuid:"+UUID.randomUUID()+"</xmpMM:InstanceID></rdf:Description></rdf:RDF></x:xmpmeta>").getBytes(StandardCharsets.UTF_8));
            document.getDocumentCatalog().setMetadata(metadata);
            var bytes="{\"record\":\"SYNTHETIC LIBRARY TEST\"}\n".getBytes(StandardCharsets.UTF_8);
            var embedded=new PDEmbeddedFile(document,new ByteArrayInputStream(bytes));embedded.setSubtype("application/json");embedded.setSize(bytes.length);
            var specification=new PDComplexFileSpecification();specification.setFile("receipt.json");specification.setFileUnicode("receipt.json");specification.setEmbeddedFile(embedded);specification.setEmbeddedFileUnicode(embedded);specification.getCOSObject().setName(COSName.getPDFName("AFRelationship"),"Data");
            var tree=new PDEmbeddedFilesNameTreeNode();tree.setNames(new TreeMap<>(Map.of("receipt.json",specification)));
            var names=new PDDocumentNameDictionary(document.getDocumentCatalog());names.setEmbeddedFiles(tree);document.getDocumentCatalog().setNames(names);
            if(profile!=null)C2pa.prepare(document,profile);
            document.save(file.toFile());
        }
    }

    @Test void aDifferentProfileSignsVerifiesAndRenewsWithoutTheDicomApplication()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false,true);
        var policy=institution.policy(false);var timestamp=TestTimestampService.client(institution,TestTimestampService.service(institution,""));
        var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        try(var identity=institution.identity()){
            for(var protection:PdfSecurity.Protection.values()){
                Path input=directory.resolve(protection+"-input.pdf"),output=directory.resolve(protection+"-output.pdf");prepared(input,PROFILE);byte[] before=Files.readAllBytes(input);
                var options=new PdfSecurity.Options(identity,policy,protection==PdfSecurity.Protection.CMS_AND_PDF?null:timestamp,clock,PROFILE);
                var result=PdfSecurity.sign(input,output,protection,options);
                assertTrue(result.valid(),result.toString());assertEquals(PASS,result.checks().get("c2pa.signature").status());assertEquals(PASS,result.checks().get("c2pa.binding").status());assertEquals(UNKNOWN,result.checks().get("c2pa.trust").status());
                assertArrayEquals(before,Files.readAllBytes(input));identity.check(institution.now());
                if(protection==PdfSecurity.Protection.PADES_B_LTA){
                    Path renewed=directory.resolve("renewed.pdf");byte[] signed=Files.readAllBytes(output);
                    var renewal=PdfSecurity.renew(output,renewed,options);assertTrue(renewal.valid(),renewal.toString());assertTrue(renewal.lta());assertArrayEquals(signed,Arrays.copyOf(Files.readAllBytes(renewed),signed.length));
                }
            }
        }
    }
    @Test void plainPdfSigningAndRenewalNeedNoApplicationProfile()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false);
        var timestamp=TestTimestampService.client(institution,TestTimestampService.service(institution,""));var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        Path input=directory.resolve("plain.pdf"),output=directory.resolve("plain-signed.pdf"),renewed=directory.resolve("plain-renewed.pdf");prepared(input,null);
        try(var identity=institution.identity()){
            assertTrue(PdfSecurity.sign(input,output,PdfSecurity.Protection.PADES_B_LTA,new PdfSecurity.Options(identity,institution.policy(false),timestamp,clock,null)).valid());
        }
        assertTrue(PdfSecurity.renew(output,renewed,new PdfSecurity.Options(null,institution.policy(false),timestamp,clock,null)).valid());
    }
    @Test void signingUsesTheCompletionClockAfterAnEarlierPolicySetup()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false);
        var policy=institution.policy(false);var setup=policy.withTime(institution.now().minusSeconds(600));
        var timestamp=TestTimestampService.client(institution,TestTimestampService.service(institution,""));
        Path input=directory.resolve("plain.pdf"),output=directory.resolve("timestamped.pdf");prepared(input,null);
        var steps=new ArrayList<String>();
        try(var identity=institution.identity()){
            var result=PdfSecurity.sign(input,output,PdfSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,
                new PdfSecurity.Options(identity,setup,timestamp,Clock.fixed(institution.now(),ZoneOffset.UTC),null),steps::add);
            assertTrue(result.valid(),result.toString());assertEquals(PASS,result.checks().get("pdf.timestamp").status());
        }
        assertTrue(steps.stream().anyMatch(step->step.contains("trusted timestamp")),steps.toString());
        assertEquals(FAIL,PdfSecurity.verify(output,PdfSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,setup,null,null).checks().get("pdf.timestamp").status());
    }
    @Test void timestampRefusalNeverPublishesOutput()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false,true);var calls=new AtomicInteger();
        var rejected=TestTimestampService.client(institution,request->{calls.incrementAndGet();throw new IOException("Synthetic TSA refusal");});
        Path input=directory.resolve("prepared.pdf"),output=directory.resolve("refused.pdf");prepared(input,PROFILE);byte[] before=Files.readAllBytes(input);
        try(var identity=institution.identity()){
            var options=new PdfSecurity.Options(identity,institution.policy(false),rejected,Clock.fixed(institution.now(),ZoneOffset.UTC),PROFILE);
            assertThrows(Exception.class,()->PdfSecurity.sign(input,output,PdfSecurity.Protection.PADES_B_LTA,options));assertFalse(Files.exists(output));assertTrue(calls.get()>0);assertArrayEquals(before,Files.readAllBytes(input));
        }
    }
    @Test void missingOrDifferentProfilesCannotSilentlyDiscardCredentials()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false,true);Path input=directory.resolve("prepared.pdf"),signed=directory.resolve("signed.pdf");prepared(input,PROFILE);
        var wrong=new C2paProfile(){
            public String credentialsFile(){return PROFILE.credentialsFile();}
            public String policyFile(){return PROFILE.policyFile();}
            public byte[] policyBytes(){return "{\"different\":true}".getBytes(StandardCharsets.UTF_8);}
            public String assertionLabel(){return PROFILE.assertionLabel();}
            public String generatorName(){return PROFILE.generatorName();}
            public String generatorVersion(){return PROFILE.generatorVersion();}
            public CBORObject createAssertion(PDDocument document,boolean local)throws Exception{return PROFILE.createAssertion(document,local);}
            public void verifyAssertion(PDDocument document,CBORObject assertion)throws Exception{PROFILE.verifyAssertion(document,assertion);}
        };
        var calls=new AtomicInteger();var tsa=TestTimestampService.client(institution,request->{calls.incrementAndGet();throw new IOException("Must not contact the TSA for an unprepared profile");});
        var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        try(var identity=institution.identity()){
            for(var profile:Arrays.asList(null,wrong)){
                Path refused=directory.resolve("profile-refused.pdf");
                assertThrows(IOException.class,()->PdfSecurity.sign(input,refused,PdfSecurity.Protection.PADES_B_LTA,new PdfSecurity.Options(identity,institution.policy(false),tsa,clock,profile)));
                assertFalse(Files.exists(refused));
            }
            assertEquals(0,calls.get());
            PdfSecurity.sign(input,signed,PdfSecurity.Protection.CMS_AND_PDF,new PdfSecurity.Options(identity,institution.policy(false),null,clock,PROFILE));
            for(var profile:Arrays.asList(null,wrong))assertFalse(PdfSecurity.verify(signed,PdfSecurity.Protection.CMS_AND_PDF,institution.policy(false),profile,null).valid());
        }
    }
    @Test void changedReceiptOrPageFailsVerificationAndExistingDestinationsArePreserved()throws Exception{
        var institution=SecurityFixtures.institution(directory.resolve("credentials"),false,true);Path input=directory.resolve("prepared.pdf"),output=directory.resolve("signed.pdf");prepared(input,PROFILE);
        try(var identity=institution.identity()){
            var options=new PdfSecurity.Options(identity,institution.policy(false),null,Clock.fixed(institution.now(),ZoneOffset.UTC),PROFILE);
            PdfSecurity.sign(input,output,PdfSecurity.Protection.CMS_AND_PDF,options);byte[] signed=Files.readAllBytes(output);
            assertThrows(IOException.class,()->PdfSecurity.sign(input,output,PdfSecurity.Protection.CMS_AND_PDF,options));assertArrayEquals(signed,Files.readAllBytes(output));
            Path changed=directory.resolve("changed.pdf");
            try(var document=Loader.loadPDF(output.toFile())){document.addPage(new PDPage());document.save(changed.toFile());}
            assertFalse(PdfSecurity.verify(changed,PdfSecurity.Protection.CMS_AND_PDF,institution.policy(false),PROFILE,null).valid());
        }
    }
}
