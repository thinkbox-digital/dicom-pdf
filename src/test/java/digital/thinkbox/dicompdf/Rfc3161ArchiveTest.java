package digital.thinkbox.dicompdf;

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

class Rfc3161ArchiveTest {
    @TempDir Path temporary;
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void creationChecksUseCompletionTimeInsteadOfSetupTime()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false,true);
        var current=institution.policy(false);
        var setup=new CertificatePolicy(current.anchors(),current.crls(),institution.now().minusSeconds(600),current.ocsps(),current.supportingCertificates());
        Path inputs=Files.createDirectory(temporary.resolve("inputs"));Files.writeString(inputs.resolve("original.bin"),"synthetic preserved original");
        var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
        var timestamp=client(institution,service(institution,""));String validator=System.getProperty("dicompdf.test.verapdf");
        try(var identity=institution.identity()){
            for(var protection:List.of(ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,ArchiveSecurity.Protection.PADES_B_LTA)){
                Path pdf=temporary.resolve(protection+".pdf");
                ArchiveSecurity.create(inputs,pdf,"archival-master",new ArchiveSecurity.Options(identity,setup,validator,protection,clock,timestamp),true);
                var checked=ArchiveSecurity.verify(pdf,inputs,current,validator,protection);
                assertEquals(PASS,checked.checks().get("trustedTimestamp").status(),checked.json());
                assertEquals(PASS,checked.checks().get("requestedProtection").status(),checked.json());
                // Explicit historical verification keeps its requested reference time.
                var historical=ArchiveSecurity.verify(pdf,inputs,setup,validator,protection);
                assertEquals(FAIL,historical.checks().get("trustedTimestamp").status(),historical.json());
            }
        }
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void timestampedArchiveRemainsPdfaAndRecoversOriginals()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),pdf=temporary.resolve("timestamped.pdf");SyntheticFixtures.writeDeidentifiedCopy(inputs);
        var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);String verapdf=System.getProperty("dicompdf.test.verapdf");
        try(var identity=institution.identity()){
            var options=new ArchiveSecurity.Options(identity,institution.policy(false),verapdf,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,clock,client(institution,service(institution,"")));
            ArchiveSecurity.create(inputs,pdf,options);
        }
        var checked=ArchiveSecurity.verify(pdf,inputs,institution.policy(false),verapdf,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED);
        assertEquals(PASS,checked.checks().get("trustedTimestamp").status(),checked.json());
        assertEquals(PASS,checked.checks().get("requestedProtection").status(),checked.json());
        assertEquals(PASS,checked.checks().get("pdfa4f").status(),checked.json());
        assertEquals("EXPORT_AUTHENTICATED",checked.assurance());
        Path recovered=temporary.resolve("recovered");PackageTools.extract(pdf,recovered);
        try(var files=Files.list(inputs)){
            for(Path source:files.toList())assertArrayEquals(Files.readAllBytes(source),Files.readAllBytes(recovered.resolve("originals").resolve(source.getFileName())));
        }
        // CMS unsigned attributes can be removed without changing the signer's
        // mathematical signature. Required timestamp protection must still fail.
        int[] ranges;byte[] stripped;
        try(var document=org.apache.pdfbox.Loader.loadPDF(pdf.toFile())){
            var signature=document.getSignatureDictionaries().getFirst();ranges=signature.getByteRange();
            try(var encoded=new org.bouncycastle.asn1.ASN1InputStream(signature.getContents())){
                var cms=new org.bouncycastle.cms.CMSSignedData(encoded.readObject().getEncoded());
                var signer=cms.getSignerInfos().getSigners().iterator().next();
                var unsignedRemoved=org.bouncycastle.cms.SignerInformation.replaceUnsignedAttributes(signer,null);
                stripped=org.bouncycastle.cms.CMSSignedData.replaceSigners(cms,new org.bouncycastle.cms.SignerInformationStore(unsignedRemoved)).getEncoded();
            }
        }
        byte[] bytes=Files.readAllBytes(pdf),padded=Arrays.copyOf(stripped,(ranges[2]-ranges[1]-2)/2);
        byte[] hexadecimal=HexFormat.of().formatHex(padded).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        System.arraycopy(hexadecimal,0,bytes,ranges[1]+1,hexadecimal.length);
        Path downgraded=temporary.resolve("timestamp-stripped.pdf");Files.write(downgraded,bytes);
        var rejected=ArchiveSecurity.verify(downgraded,inputs,institution.policy(false),verapdf,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED);
        assertEquals(PASS,rejected.checks().get("pdf.cryptographicSignature").status(),rejected.json());
        assertEquals(FAIL,rejected.checks().get("requestedProtection").status(),rejected.json());
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void failureDuringPdfTimestampDoesNotPublishPartialArchive()throws Exception{
        var institution=SecurityFixtures.institution(temporary.resolve("keys"),false);
        Path inputs=temporary.resolve("inputs"),pdf=temporary.resolve("must-not-exist.pdf");SyntheticFixtures.writeDeidentifiedCopy(inputs);
        var service=service(institution,"");var calls=new AtomicInteger();
        var client=client(institution,request->{if(calls.incrementAndGet()==2)throw new IOException("Synthetic second-request failure");return service.request(request);});
        try(var identity=institution.identity()){
            var options=new ArchiveSecurity.Options(identity,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,Clock.fixed(institution.now(),ZoneOffset.UTC),client);
            assertThrows(Exception.class,()->ArchiveSecurity.create(inputs,pdf,options));
        }
        assertEquals(2,calls.get());assertFalse(Files.exists(pdf));
    }
}
