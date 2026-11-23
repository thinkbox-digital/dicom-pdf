package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.io.*;
import java.time.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class DssPadesTest {
    @TempDir Path temporary;

    record Fixture(SecurityFixtures.Institution institution,CertificatePolicy policy,Rfc3161Client client,Path signed,Path archival){}
    private Fixture fixture()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        var policy=institution.policy(false);
        var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),policy,Clock.fixed(institution.now(),ZoneOffset.UTC),"1.2.3.4.5");
        Path base=temporary.resolve("base.pdf"),signed=temporary.resolve("signed.pdf"),archival=temporary.resolve("archival.pdf");
        try(var doc=new PDDocument()){
            doc.addPage(new PDPage());
            PdfValidationStore.retain(doc,List.of(institution.leaf(),institution.root()),policy);doc.save(base.toFile());
        }
        try(var identity=institution.identity()){PdfCmsSigning.sign(base,signed,identity,institution.now(),client);}
        DssPades.extend(signed,archival,policy,client);
        return new Fixture(institution,policy,client,signed,archival);
    }
    @Test void extendsAndRenewsWithoutChangingSignedPrefix()throws Exception{
        var f=fixture();var policy=f.policy();var archival=f.archival();
        var result=DssPades.verify(archival,policy,null);
        assertTrue(result.valid(),result.toString());assertTrue(result.lta(),result.toString());
        assertNotNull(result.bestSignatureTime());
        assertArrayEquals(Files.readAllBytes(f.signed()),Arrays.copyOf(Files.readAllBytes(archival),(int)Files.size(f.signed())));
        Path renewed=temporary.resolve("renewed.pdf");DssPades.extend(archival,renewed,policy,f.client());
        assertTrue(DssPades.verify(renewed,policy,null).valid());
        assertArrayEquals(Files.readAllBytes(archival),Arrays.copyOf(Files.readAllBytes(renewed),(int)Files.size(archival)));
        // An earlier good archival timestamp cannot excuse an invalid newest one.
        byte[] damaged=Files.readAllBytes(renewed);
        try(var doc=Loader.loadPDF(renewed.toFile())){
            var timestamp=doc.getSignatureDictionaries().getLast();byte[] cms=timestamp.getContents();
            try(var encoded=new org.bouncycastle.asn1.ASN1InputStream(cms)){cms=encoded.readObject().getEncoded();}
            byte[] value=new org.bouncycastle.cms.CMSSignedData(cms).getSignerInfos().getSigners().iterator().next().getSignature();
            int found=-1;
            for(int i=0;i<=cms.length-value.length;i++)if(Arrays.equals(Arrays.copyOfRange(cms,i,i+value.length),value)){found=i;break;}
            assertTrue(found>=0);int offset=timestamp.getByteRange()[1]+1+2*(found+value.length/2);
            damaged[offset]=(byte)(damaged[offset]=='0'?'1':'0');
        }
        Path invalid=temporary.resolve("invalid-latest-timestamp.pdf");Files.write(invalid,damaged);
        assertFalse(DssPades.verify(invalid,policy,null).valid());
    }
    @Test void rejectsUnsignedChangesEvenAfterAnAttackerAddsATrustedTimestamp()throws Exception{
        var f=fixture();Path changed=temporary.resolve("changed.pdf"),resigned=temporary.resolve("attacker-timestamped.pdf");
        try(var document=Loader.loadPDF(f.archival().toFile());var out=Files.newOutputStream(changed)){
            document.getDocumentInformation().setTitle("SYNTHETIC ALTERED TITLE");document.saveIncremental(out);
        }
        assertEquals(FAIL,DssPades.verify(changed,f.policy(),null).checks().get("coverage").status());
        assertThrows(IOException.class,()->DssPades.extend(changed,resigned,f.policy(),f.client()));
        assertFalse(Files.exists(resigned));
        byte[] bytes=Files.readAllBytes(f.archival());bytes[20]^=1;Path corrupted=temporary.resolve("corrupted.pdf");Files.write(corrupted,bytes);
        assertFalse(DssPades.verify(corrupted,f.policy(),null).valid());
    }
    @Test void trustSignerBindingAndRevocationAreNotTakenFromTheArchive()throws Exception{
        var f=fixture();
        assertFalse(DssPades.verify(f.archival(),CertificatePolicy.untrusted(f.institution().now()),null).valid());
        var tsaOnly=new CertificatePolicy(Set.of(),f.policy().crls(),f.institution().now(),
                List.of(),List.of(),f.policy().anchors());
        var scoped=DssPades.verify(f.archival(),tsaOnly,null);
        assertEquals(PASS,scoped.checks().get("timestamp").status(),scoped.toString());
        assertEquals(UNKNOWN,scoped.checks().get("certificateTrust").status(),scoped.toString());
        assertFalse(scoped.valid(),scoped.toString());
        var other=SecurityFixtures.institution(temporary.resolve("other"),false);
        assertFalse(DssPades.verify(f.archival(),other.policy(false),null).valid());
        assertEquals(FAIL,DssPades.verify(f.archival(),f.policy(),"00".repeat(32)).checks().get("issuerBinding").status());
        assertFalse(DssPades.verify(f.archival(),f.institution().policy(true),null).valid());
    }
    @Test void timestampFailureCannotPublishOrOverwrite()throws Exception{
        var f=fixture();var before=Files.readAllBytes(f.archival());
        assertThrows(IOException.class,()->DssPades.extend(f.signed(),f.archival(),f.policy(),f.client()));assertArrayEquals(before,Files.readAllBytes(f.archival()));
        var refused=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(f.institution(),"reject"),f.policy(),Clock.fixed(f.institution().now(),ZoneOffset.UTC),"1.2.3.4.5");
        Path output=temporary.resolve("refused.pdf");assertThrows(IOException.class,()->DssPades.extend(f.signed(),output,f.policy(),refused));assertFalse(Files.exists(output));
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void createsPdfaArchiveWithDuplicatesAndRecoversAllOriginals()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);var policy=institution.policy(false);
        var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),policy,Clock.fixed(institution.now(),ZoneOffset.UTC),"1.2.3.4.5");
        Path input=temporary.resolve("inputs"),pdf=temporary.resolve("archive.pdf"),recovery=temporary.resolve("recovery");SyntheticFixtures.writeDeidentifiedCopy(input);
        try(var paths=Files.list(input)){Files.copy(paths.filter(p->p.toString().endsWith(".dcm")).findFirst().orElseThrow(),input.resolve("duplicate.dcm"));}
        String vera=System.getProperty("dicompdf.test.verapdf");
        try(var identity=institution.identity()){
            ArchiveSecurity.create(input,pdf,new ArchiveSecurity.Options(identity,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA,Clock.fixed(institution.now(),ZoneOffset.UTC),client));
        }
        var checked=ArchiveSecurity.verify(pdf,input,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA);
        assertEquals(PASS,checked.checks().get("padesBLta").status(),checked.json());assertEquals(PASS,checked.checks().get("pdfa4f").status(),checked.json());
        assertEquals("EXPORT_AUTHENTICATED",checked.assurance(),checked.json());assertEquals(UNKNOWN,checked.checks().get("clinicalCompleteness").status());
        PackageTools.extract(pdf,recovery);
        try(var paths=Files.list(input)){for(var path:paths.toList())assertEquals(-1,Files.mismatch(path,recovery.resolve("originals").resolve(path.getFileName())));}
        Path renewed=temporary.resolve("archive-renewed.pdf");
        var renewal=ArchivePades.renew(pdf,renewed,policy,vera,client);
        assertEquals(PASS,renewal.checks().get("padesBLta").status(),renewal.json());
        assertEquals(PASS,renewal.checks().get("pdfa4f").status(),renewal.json());
        assertArrayEquals(Files.readAllBytes(pdf),Arrays.copyOf(Files.readAllBytes(renewed),(int)Files.size(pdf)));
        Files.delete(input.resolve("duplicate.dcm"));
        assertEquals(FAIL,ArchiveSecurity.verify(pdf,input,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA).checks().get("inventoryReconciliation").status());
        var later=new CertificatePolicy(policy.anchors(),List.of(),institution.now().plusSeconds(40L*86400));
        var historical=ArchiveSecurity.verify(pdf,input,later,vera,ArchiveSecurity.Protection.PADES_B_LTA);
        assertEquals(UNKNOWN,historical.checks().get("padesBLta").status(),historical.json());
        assertNotEquals("EXPORT_AUTHENTICATED",historical.assurance(),historical.json());
    }
}
