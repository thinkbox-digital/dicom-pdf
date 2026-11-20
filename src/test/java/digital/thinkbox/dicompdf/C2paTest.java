package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;

import java.nio.file.*;

import org.apache.pdfbox.Loader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

class C2paTest {
    @TempDir
    Path temporary;

    @Test
    void defaultCreationEmbedsValidLocallySignedCredentials() throws Exception {
        Path input = Files.createDirectory(temporary.resolve("input"));
        Files.writeString(input.resolve("unsupported.bin"), "synthetic preserved input");
        Path pdf = temporary.resolve("c2pa.pdf");
        var manifest = DicomPdf.create(input, pdf);
        assertEquals(ArchiveC2pa.PROFILE, manifest.profileVersion());
        var checks = ArchiveC2pa.verify(pdf);
        assertEquals(SecurityReport.Status.PASS, checks.get("c2pa.signature").status(), checks.toString());
        assertEquals(SecurityReport.Status.PASS, checks.get("c2pa.binding").status(), checks.toString());
        assertEquals(SecurityReport.Status.UNKNOWN, checks.get("c2pa.trust").status());
        assertEquals("PASS", PackageTools.verify(pdf, input, null).metadataAccuracy().status());
        Path report = Path.of("target/c2pa-verification");
        Files.createDirectories(report);
        Files.copy(pdf, report.resolve("local.pdf"), StandardCopyOption.REPLACE_EXISTING);
        // An unsigned incremental rewrite of an otherwise readable PDF must invalidate the binding.
        Path modified = temporary.resolve("changed.pdf");
        try (var doc = Loader.loadPDF(pdf.toFile())) {
            doc.getDocumentInformation().setTitle("changed after export");
            doc.save(modified.toFile());
        }
        assertTrue(ArchiveC2pa.verify(modified).values().stream().anyMatch(c -> c.status() == SecurityReport.Status.FAIL));
        // Tamper inside the hash-excluded store: the claim signature must still detect it.
        byte[] raw = Files.readAllBytes(pdf), label = "c2pa.signature\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        int position = -1;
        for (int i = 0; i < raw.length - label.length; i++)
            if (java.util.Arrays.equals(raw, i, i + label.length, label, 0, label.length)) {
                position = i + label.length;
                break;
            }
        assertTrue(position > 0);
        int length = java.nio.ByteBuffer.wrap(raw, position, 4).getInt();
        var cose = com.upokecenter.cbor.CBORObject.DecodeFromBytes(java.util.Arrays.copyOfRange(raw, position + 8, position + length));
        byte[] signature = cose.get(3).GetByteString();
        int signatureAt = -1;
        for (int i = position + 8; i <= position + length - signature.length; i++)
            if (java.util.Arrays.equals(raw, i, i + signature.length, signature, 0, signature.length)) {
                signatureAt = i;
                break;
            }
        assertTrue(signatureAt > 0);
        raw[signatureAt] ^= 1;
        Path forged = temporary.resolve("forged.pdf");
        Files.write(forged, raw);
        assertEquals(SecurityReport.Status.FAIL, ArchiveC2pa.verify(forged).get("c2pa.validation").status());
    }

    @Test
    void disabledCreationKeepsThePreviousProfile() throws Exception {
        Path input = Files.createDirectory(temporary.resolve("input"));
        Files.writeString(input.resolve("file.bin"), "synthetic");
        Path pdf = temporary.resolve("off.pdf");
        assertEquals("0.3.0", DicomPdf.create(input, pdf, "archival-master", false).profileVersion());
        assertEquals(SecurityReport.Status.NOT_APPLICABLE, ArchiveC2pa.verify(pdf).get("c2pa.presence").status());
    }

    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void institutionalC2paAndPdfSignaturesCoverTheSameArchive() throws Exception {
        Path input = Files.createDirectory(temporary.resolve("input"));
        Files.writeString(input.resolve("file.bin"), "synthetic");
        var institution = SecurityFixtures.institution(temporary.resolve("credentials"), false, true);
        Path pdf = temporary.resolve("signed.pdf");
        try (var identity = institution.identity()) {
            ArchiveSecurity.create(input, pdf, "archival-master", new ArchiveSecurity.Options(identity, institution.policy(false), System.getProperty("dicompdf.test.verapdf"), ArchiveSecurity.Protection.CMS_AND_PDF, java.time.Clock.systemUTC()), null, true);
        }
        var checks = ArchiveSecurity.verify(pdf, input, institution.policy(false), System.getProperty("dicompdf.test.verapdf"), ArchiveSecurity.Protection.CMS_AND_PDF).checks();
        assertEquals(SecurityReport.Status.PASS, checks.get("c2pa.binding").status(), checks.toString());
        assertEquals(SecurityReport.Status.PASS, checks.get("pdf.cryptographicSignature").status(), checks.toString());
        Files.createDirectories(Path.of("target/c2pa-verification"));
        Files.copy(pdf, Path.of("target/c2pa-verification/institutional.pdf"), StandardCopyOption.REPLACE_EXISTING);
    }

    @Test
    void unsupportedC2paCredentialNeverPublishesAnOutput() throws Exception {
        Path input=temporary.resolve("input-must-not-be-read");
        var institution = SecurityFixtures.institution(temporary.resolve("credentials"), false);
        var requests=new java.util.concurrent.atomic.AtomicInteger();
        var timestamp=new Rfc3161Client(request->{requests.incrementAndGet();throw new AssertionError("TSA must not be contacted for an incompatible certificate");},institution.policy(false),java.time.Clock.systemUTC(),null);
        try (var identity = institution.identity()) {
            for(var protection:ArchiveSecurity.Protection.values()){
                Path pdf=temporary.resolve(protection.name()).resolve("must-not-exist.pdf");
                var options=new ArchiveSecurity.Options(identity,institution.policy(false),"/validator-must-not-run",protection,java.time.Clock.systemUTC(),protection==ArchiveSecurity.Protection.CMS_AND_PDF?null:timestamp);
                var failure=assertThrows(java.io.IOException.class,()->ArchiveSecurity.create(input,pdf,"archival-master",options,null,true));
                assertTrue(failure.getMessage().contains("Authority Key Identifier"),failure.toString());
                assertTrue(failure.getMessage().contains("Extended Key Usage"),failure.toString());
                assertTrue(failure.getMessage().contains("before creation"),failure.toString());
                assertFalse(Files.exists(pdf.getParent()),"Even the output directory must not be created");
            }
            assertEquals(0,requests.get());assertFalse(Files.exists(input));
        }
    }

    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void c2paAndBLtaCoverTheCurrentFileAfterCreationAndRenewal()throws Exception{
        Path input=Files.createDirectory(temporary.resolve("input"));Files.writeString(input.resolve("file.bin"),"synthetic original preserved through archival revisions");
        var institution=SecurityFixtures.institution(temporary.resolve("credentials"),false,true);
        var policy=institution.policy(false);var clock=java.time.Clock.fixed(institution.now(),java.time.ZoneOffset.UTC);
        var timestamp=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),policy,clock,null);
        String vera=System.getProperty("dicompdf.test.verapdf");Path pdf=temporary.resolve("lta.pdf"),renewed=temporary.resolve("renewed.pdf");
        try(var identity=institution.identity()){
            ArchiveSecurity.create(input,pdf,"archival-master",new ArchiveSecurity.Options(identity,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA,clock,timestamp),true);
            var first=ArchiveSecurity.verify(pdf,input,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA);
            assertEquals("EXPORT_AUTHENTICATED",first.assurance(),first.json());assertEquals(SecurityReport.Status.PASS,first.checks().get("padesBLta").status(),first.json());
            assertEquals(SecurityReport.Status.PASS,first.checks().get("c2pa.binding").status(),first.json());
            assertEquals(SecurityReport.Status.PASS,first.checks().get("trustedTimestamp").status(),first.json());
            assertEquals(SecurityReport.Status.PASS,first.checks().get("pdfa4f").status(),first.json());
            assertThrows(Exception.class,()->ArchivePades.renew(pdf,renewed,policy,vera,timestamp));assertFalse(Files.exists(renewed));
            var second=ArchivePades.renew(pdf,renewed,policy,vera,timestamp,identity);
            assertEquals(SecurityReport.Status.PASS,second.checks().get("padesBLta").status(),second.json());
            assertEquals(SecurityReport.Status.PASS,second.checks().get("c2pa.binding").status(),second.json());
            assertArrayEquals(Files.readAllBytes(pdf),java.util.Arrays.copyOf(Files.readAllBytes(renewed),(int)Files.size(pdf)));
            Path reports=Path.of("target/c2pa-verification");Files.createDirectories(reports);
            Files.copy(pdf,reports.resolve("blta.pdf"),StandardCopyOption.REPLACE_EXISTING);Files.copy(renewed,reports.resolve("blta-renewed.pdf"),StandardCopyOption.REPLACE_EXISTING);
            Files.writeString(reports.resolve("synthetic-root.pem"),SecurityFixtures.pem(institution.root()));
            Files.writeString(reports.resolve("blta-java.json"),first.json());Files.writeString(reports.resolve("blta-renewed-java.json"),second.json());
            assertDefaultDssLta(pdf,policy);assertDefaultDssLta(renewed,policy);
            // A fresh valid C2PA claim and trusted timestamp must not hide document changes.
            for(String change:java.util.List.of("title","page","original")){
                Path altered=temporary.resolve(change+".pdf"),stamped=temporary.resolve(change+"-stamped.pdf");
                try(var document=Loader.loadPDF(pdf.toFile());var output=Files.newOutputStream(altered)){
                    if(change.equals("title"))document.getDocumentInformation().setTitle("altered after export");
                    else if(change.equals("page")){var page=document.getPage(0);page.setRotation(90);page.getCOSObject().setNeedToBeUpdated(true);}
                    else{
                        var names=document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
                        var file=names.entrySet().stream().filter(entry->entry.getKey().startsWith("original-")).findFirst().orElseThrow().getValue();
                        var stream=file.getEmbeddedFile().getCOSObject();
                        try(var outputStream=stream.createOutputStream()){outputStream.write("changed original".getBytes(java.nio.charset.StandardCharsets.UTF_8));}stream.setNeedToBeUpdated(true);
                    }
                    document.saveIncremental(output);
                }
                C2paPades.finish(altered,stamped,identity,timestamp,institution.now(),ArchiveC2pa.FORMAT);
                assertEquals(SecurityReport.Status.PASS,ArchiveC2pa.verify(stamped).get("c2pa.binding").status());
                var invalid=DssPades.verify(stamped,policy,null);
                assertEquals(SecurityReport.Status.FAIL,invalid.checks().get("allowedChanges").status(),change+": "+invalid);
                if(change.equals("page"))Files.copy(stamped,reports.resolve("invalid-revision-page.pdf"),StandardCopyOption.REPLACE_EXISTING);
            }
            byte[] damaged=Files.readAllBytes(renewed);
            try(var document=Loader.loadPDF(renewed.toFile())){
                int index=document.getSignatureDictionaries().getFirst().getByteRange()[1]+100;damaged[index]=(byte)(damaged[index]=='0'?'1':'0');
            }
            Path corrupted=temporary.resolve("earlier-signature-tampered.pdf");Files.write(corrupted,damaged);
            assertTrue(ArchiveC2pa.verify(corrupted).values().stream().anyMatch(check->check.status()==SecurityReport.Status.FAIL),"Earlier signature contents must remain in the C2PA binding");
            damaged=Files.readAllBytes(renewed);
            try(var document=Loader.loadPDF(renewed.toFile())){
                var timestampSignature=document.getSignatureDictionaries().stream().max(java.util.Comparator.comparingInt(signature->signature.getByteRange()[2]+signature.getByteRange()[3])).orElseThrow();
                byte[] cms=timestampSignature.getContents();
                try(var encoded=new org.bouncycastle.asn1.ASN1InputStream(cms)){cms=encoded.readObject().getEncoded();}
                byte[] signature=new org.bouncycastle.cms.CMSSignedData(cms).getSignerInfos().getSigners().iterator().next().getSignature();int found=-1;
                for(int i=0;i<=cms.length-signature.length;i++)if(java.util.Arrays.equals(java.util.Arrays.copyOfRange(cms,i,i+signature.length),signature)){found=i;break;}
                assertTrue(found>=0);int index=timestampSignature.getByteRange()[1]+1+2*(found+signature.length/2);damaged[index]=(byte)(damaged[index]=='0'?'1':'0');
            }
            Path invalidTimestamp=temporary.resolve("latest-timestamp-tampered.pdf");Files.write(invalidTimestamp,damaged);
            assertEquals(SecurityReport.Status.PASS,ArchiveC2pa.verify(invalidTimestamp).get("c2pa.binding").status());
            assertFalse(DssPades.verify(invalidTimestamp,policy,null,ArchiveC2pa.FORMAT).valid(),"The excluded timestamp must be validated independently");
            var rejected=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,"reject"),policy,clock,null);
            Path refused=temporary.resolve("refused.pdf");byte[] before=Files.readAllBytes(renewed);
            assertThrows(Exception.class,()->C2paPades.finish(renewed,refused,identity,rejected,institution.now(),ArchiveC2pa.FORMAT));assertFalse(Files.exists(refused));assertArrayEquals(before,Files.readAllBytes(renewed));
        }
    }

    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void failureOfTheFinalC2paTimestampPublishesNothing()throws Exception{
        Path input=Files.createDirectory(temporary.resolve("input"));Files.writeString(input.resolve("file.bin"),"synthetic");
        var institution=SecurityFixtures.institution(temporary.resolve("credentials"),false,true);var policy=institution.policy(false);
        var clock=java.time.Clock.fixed(institution.now(),java.time.ZoneOffset.UTC);var calls=new java.util.concurrent.atomic.AtomicInteger();
        var service=digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,"");
        var timestamp=new Rfc3161Client(request->{if(calls.incrementAndGet()==4)throw new java.io.IOException("Final timestamp refused");return service.request(request);},policy,clock,null);
        Path output=temporary.resolve("must-not-exist.pdf");
        try(var identity=institution.identity()){
            assertThrows(Exception.class,()->ArchiveSecurity.create(input,output,"archival-master",new ArchiveSecurity.Options(identity,policy,System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.PADES_B_LTA,clock,timestamp),true));
        }
        assertEquals(4,calls.get());assertFalse(Files.exists(output));assertEquals("synthetic",Files.readString(input.resolve("file.bin")));
    }

    private static void assertDefaultDssLta(Path pdf,CertificatePolicy policy)throws Exception{
        var verifier=new eu.europa.esig.dss.spi.validation.CommonCertificateVerifier();
        var trusted=new eu.europa.esig.dss.spi.x509.CommonTrustedCertificateSource();
        for(var anchor:policy.anchors())trusted.addCertificate(new eu.europa.esig.dss.model.x509.CertificateToken(anchor.getTrustedCert()));
        verifier.setTrustedCertSources(trusted);verifier.setAIASource(new eu.europa.esig.dss.spi.x509.aia.DefaultAIASource(new eu.europa.esig.dss.spi.client.http.IgnoreDataLoader()));
        var crls=new java.util.ArrayList<eu.europa.esig.dss.model.DSSDocument>();
        for(var crl:policy.crls())crls.add(new eu.europa.esig.dss.model.InMemoryDocument(crl.getEncoded()));
        verifier.setCrlSource(new eu.europa.esig.dss.spi.x509.revocation.crl.ExternalResourcesCRLSource(crls.toArray(eu.europa.esig.dss.model.DSSDocument[]::new)));
        var validator=new eu.europa.esig.dss.pades.validation.PDFDocumentValidator(new eu.europa.esig.dss.model.FileDocument(pdf.toFile()));
        validator.setCertificateVerifier(verifier);validator.setPdfObjFactory(new eu.europa.esig.dss.pdf.pdfbox.PdfBoxNativeObjectFactory());validator.setValidationTime(java.util.Date.from(policy.at()));
        var report=validator.validateDocument().getSimpleReport();String id=report.getFirstSignatureId();
        assertEquals(eu.europa.esig.dss.enumerations.Indication.TOTAL_PASSED,report.getIndication(id));
        assertEquals(eu.europa.esig.dss.enumerations.SignatureLevel.PAdES_BASELINE_LTA,report.getSignatureFormat(id));
    }

    @Test
    @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void timestampedPdfSigningKeepsC2paValidAndItsOwnTimeUnverified()throws Exception{
        Path input=Files.createDirectory(temporary.resolve("input"));Files.writeString(input.resolve("file.bin"),"synthetic");
        var institution=SecurityFixtures.institution(temporary.resolve("credentials"),false,true);
        var clock=java.time.Clock.fixed(institution.now(),java.time.ZoneOffset.UTC);
        var timestamp=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),institution.policy(false),clock,null);
        Path pdf=temporary.resolve("timestamped.pdf");String validator=System.getProperty("dicompdf.test.verapdf");
        try(var identity=institution.identity()){
            ArchiveSecurity.create(input,pdf,"archival-master",new ArchiveSecurity.Options(identity,institution.policy(false),validator,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,clock,timestamp),true);
        }
        var checks=ArchiveSecurity.verify(pdf,input,institution.policy(false),validator,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED).checks();
        assertEquals(SecurityReport.Status.PASS,checks.get("c2pa.binding").status(),checks.toString());
        assertEquals(SecurityReport.Status.PASS,checks.get("trustedTimestamp").status(),checks.toString());
        assertEquals(SecurityReport.Status.UNKNOWN,checks.get("c2pa.timestamp").status());
        Files.createDirectories(Path.of("target/c2pa-verification"));Files.copy(pdf,Path.of("target/c2pa-verification/timestamped.pdf"),StandardCopyOption.REPLACE_EXISTING);
    }

    @Test
    void cliDefaultsOnAcceptsOffAndRejectsUnknownValues() throws Exception {
        Path input = Files.createDirectory(temporary.resolve("input"));
        Files.writeString(input.resolve("file.bin"), "synthetic");
        var bytes = new java.io.ByteArrayOutputStream();
        var out = new java.io.PrintStream(bytes);
        Path pdf = temporary.resolve("cli.pdf");
        assertEquals(0, Main.run(new String[]{"create", "--input", input.toString(), "--output", pdf.toString()}, out, out), bytes.toString());
        assertEquals(SecurityReport.Status.PASS, ArchiveC2pa.verify(pdf).get("c2pa.binding").status());
        Path off = temporary.resolve("off.pdf");
        assertEquals(0, Main.run(new String[]{"create", "--input", input.toString(), "--output", off.toString(), "--c2pa", "off"}, out, out));
        assertEquals(SecurityReport.Status.NOT_APPLICABLE, ArchiveC2pa.verify(off).get("c2pa.presence").status());
        assertEquals(1, Main.run(new String[]{"create", "--input", input.toString(), "--output", temporary.resolve("invalid.pdf").toString(), "--c2pa", "invalid"}, out, out));
    }
}
