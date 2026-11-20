package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

/** Manual cross-implementation fixture; only synthetic credentials and image values. */
public final class PadesDssFixtureMain {
    public static void main(String[] args)throws Exception{
        if(args.length!=3)throw new IllegalArgumentException("work-directory new-timestamped-pdf new-ocsp-pdf");
        Path work=Path.of(args[0]),inputs=work.resolve("originals");
        Files.createDirectory(work);SyntheticFixtures.writeReferences(inputs);
        var institution=SecurityFixtures.institution(work.resolve("credentials"),false);
        String vera=System.getProperty("dicompdf.test.verapdf");
        Files.writeString(work.resolve("root.pem"),SecurityFixtures.pem(institution.root()));
        var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),institution.policy(false),Clock.fixed(institution.now(),ZoneOffset.UTC),"1.2.3.4.5");
        try(var identity=institution.identity()){
            ArchiveSecurity.create(inputs,Path.of(args[1]),new ArchiveSecurity.Options(identity,institution.policy(false),vera,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,Clock.fixed(institution.now(),ZoneOffset.UTC),client));
            var ocsp=new CertificatePolicy(institution.policy(false).anchors(),List.of(),institution.now(),List.of(digital.thinkbox.pdfsecurity.testing.TestOcspService.response(institution,"")));
            ArchiveSecurity.create(inputs,Path.of(args[2]),new ArchiveSecurity.Options(identity,ocsp,vera,ArchiveSecurity.Protection.CMS_AND_PDF,Clock.fixed(institution.now(),ZoneOffset.UTC)));
            var timestamped=ArchiveSecurity.verify(Path.of(args[1]),inputs,new CertificatePolicy(institution.policy(false).anchors(),List.of(),institution.now()),vera,ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED);
            var ocspReport=ArchiveSecurity.verify(Path.of(args[2]),inputs,new CertificatePolicy(institution.policy(false).anchors(),List.of(),institution.now()),vera,ArchiveSecurity.Protection.CMS_AND_PDF);
            if(!timestamped.assurance().equals("EXPORT_AUTHENTICATED")||!ocspReport.assurance().equals("EXPORT_AUTHENTICATED"))throw new IllegalStateException("Synthetic archive verification did not authenticate the exporter");
            Files.writeString(work.resolve("java-timestamped.json"),timestamped.json());Files.writeString(work.resolve("java-ocsp.json"),ocspReport.json());
        }
        System.out.println("Created and verified two synthetic DSS archives; no external timestamp service used.");
    }
}
