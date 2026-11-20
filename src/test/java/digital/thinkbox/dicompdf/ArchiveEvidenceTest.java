package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import com.google.gson.*;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class ArchiveEvidenceTest {
    @TempDir Path temporary;
    private ArchiveSecurity.Options options(SecurityFixtures.Institution institution,SigningIdentity identity)throws Exception{
        var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),institution.policy(false),clock,"1.2.3.4.5");
        return new ArchiveSecurity.Options(identity,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,clock,client);
    }
    /** Synthetic proof fixture independent of creator orchestration; no source metadata is invented. */
    private Path proof(Path pdf,SecurityFixtures.Institution institution)throws Exception{
        var binding=new JsonObject();binding.addProperty("schemaVersion",1);binding.addProperty("purpose","DICOM_PDF_EXTERNAL_EVIDENCE");
        binding.addProperty("pdfSha256",hash(Files.readAllBytes(pdf)));binding.addProperty("pdfSize",Files.size(pdf));binding.add("previousEntrySha256",JsonNull.INSTANCE);
        binding.addProperty("observedAt",institution.now().toString());var crls=new JsonArray();crls.add(Base64.getEncoder().encodeToString(SecurityFixtures.crl(institution,false).getEncoded()));binding.add("crls",crls);
        try(var identity=institution.identity()){
            binding.addProperty("issuerCertificateSha256",identity.certificateSha256());
            var client=options(institution,identity).timestampClient();
            var entry=new JsonObject();entry.add("binding",binding);entry.addProperty("cms",Base64.getEncoder().encodeToString(CmsSigning.sign(new ByteArrayInputStream(ManifestEncoding.canonicalize(binding.toString())),identity,institution.now(),client)));
            var entries=new JsonArray();entries.add(entry);var envelope=new JsonObject();envelope.addProperty("schemaVersion",1);envelope.addProperty("purpose","DICOM_PDF_EXTERNAL_EVIDENCE");envelope.add("entries",entries);
            Path evidence=temporary.resolve("evidence.json");Files.write(evidence,ManifestEncoding.canonicalize(envelope.toString()));return evidence;
        }
    }
    private static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));}
    @Test void verifiesHistoricalEvidenceOnlyWithTrustedTimestamp()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);Path pdf=temporary.resolve("record.pdf");
        Files.writeString(pdf,"Synthetic byte-binding fixture, not a PDF/A claim");Path evidence=proof(pdf,institution);
        var future=new CertificatePolicy(institution.policy(false).anchors(),List.of(),institution.now().plusSeconds(90*86400));
        var result=ArchiveEvidence.verify(pdf,evidence,future);
        assertEquals("TIMESTAMPED_ARCHIVE_EVIDENCE",result.assurance(),result.json());
        assertEquals(PASS,result.checks().get("entry.1.timestamp").status());
        assertEquals(PASS,result.checks().get("entry.1.certificateValidity").status());
        var untrusted=ArchiveEvidence.verify(pdf,evidence,CertificatePolicy.untrusted(institution.now()));
        assertEquals(UNKNOWN,untrusted.checks().get("evidenceChain").status());assertEquals("INTEGRITY_ONLY",untrusted.assurance());
    }
    @Test void changedPdfBindingSignatureAndMissingEvidenceFail()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);Path pdf=temporary.resolve("record.pdf");Files.writeString(pdf,"Original bytes");Path evidence=proof(pdf,institution);
        byte[] before=Files.readAllBytes(pdf);Files.writeString(pdf,"Different bytes");
        assertEquals(FAIL,ArchiveEvidence.verify(pdf,evidence,institution.policy(false)).checks().get("evidenceChain").status());Files.write(pdf,before);
        var envelope=JsonParser.parseString(Files.readString(evidence)).getAsJsonObject();
        envelope.getAsJsonArray("entries").get(0).getAsJsonObject().getAsJsonObject("binding").addProperty("observedAt","2000-01-01T00:00:00Z");
        Files.write(evidence,ManifestEncoding.canonicalize(envelope.toString()));
        assertEquals(FAIL,ArchiveEvidence.verify(pdf,evidence,institution.policy(false)).checks().get("evidenceChain").status());
        assertEquals(FAIL,ArchiveEvidence.verify(pdf,temporary.resolve("missing.json"),institution.policy(false)).checks().get("evidenceChain").status());
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void renewsEvidenceChainWithoutChangingPdfOrPreviousEvidence()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);Path input=temporary.resolve("inputs"),pdf=temporary.resolve("archive.pdf");
        SyntheticFixtures.writeDeidentifiedCopy(input);DicomPdf.create(input,pdf);byte[] original=Files.readAllBytes(pdf);
        Path first=temporary.resolve("first.json"),second=temporary.resolve("second.json");
        try(var identity=institution.identity()){
            var options=options(institution,identity);
            var earlierPolicy = options.policy().withTime(institution.now().minusSeconds(120));
            var longRunning = new ArchiveSecurity.Options(identity, earlierPolicy, options.verapdf(),
                    options.protection(), options.clock(), options.timestampClient());
            assertEquals("TIMESTAMPED_ARCHIVE_EVIDENCE",ArchiveEvidence.renew(pdf,null,first,longRunning).assurance());
            byte[] prior=Files.readAllBytes(first);
            var report=ArchiveEvidence.renew(pdf,first,second,options);
            assertEquals("TIMESTAMPED_ARCHIVE_EVIDENCE",report.assurance(),report.json());
            assertEquals(PASS,report.checks().get("entry.2.timestamp").status());assertArrayEquals(original,Files.readAllBytes(pdf));assertArrayEquals(prior,Files.readAllBytes(first));
            assertThrows(IOException.class,()->ArchiveEvidence.renew(pdf,first,second,options));assertArrayEquals(prior,Files.readAllBytes(first));
            var chain=JsonParser.parseString(Files.readString(second)).getAsJsonObject();
            chain.getAsJsonArray("entries").remove(0);Files.write(second,ManifestEncoding.canonicalize(chain.toString()));
            assertEquals(FAIL,ArchiveEvidence.verify(pdf,second,institution.policy(false)).checks().get("evidenceChain").status());
            assertThrows(IOException.class,()->ArchiveEvidence.renew(pdf,second,temporary.resolve("bad-renewal.json"),options));
            assertFalse(Files.exists(temporary.resolve("bad-renewal.json")));assertArrayEquals(original,Files.readAllBytes(pdf));
        }
    }
}
