package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

/** Packaged-JAR smoke fixture. Generates synthetic source data and credentials only. */
public final class EuDssFixtureMain {
    public static void main(String[] args)throws Exception{
        boolean c2pa=args.length==4&&args[3].equals("--c2pa");
        if(args.length!=3&&!c2pa)throw new IllegalArgumentException("work-directory new-pdf renewed-pdf [--c2pa]");
        Path work=Path.of(args[0]),pdf=Path.of(args[1]),renewed=Path.of(args[2]);Files.createDirectory(work);
        Path inputs=work.resolve("originals");SyntheticFixtures.writeDeidentifiedCopy(inputs);
        Files.copy(inputs.resolve("derived-copy.dcm"),inputs.resolve("duplicate.dcm"));
        var institution=SecurityFixtures.institution(work.resolve("credentials"),false,c2pa);var policy=institution.policy(false);
        String vera=System.getProperty("dicompdf.test.verapdf");
        Files.writeString(work.resolve("root.pem"),SecurityFixtures.pem(institution.root()));
        var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),policy,Clock.fixed(institution.now(),ZoneOffset.UTC),"1.2.3.4.5");
        try(var identity=institution.identity()){
            ArchiveSecurity.create(inputs,pdf,"archival-master",new ArchiveSecurity.Options(identity,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA,Clock.fixed(institution.now(),ZoneOffset.UTC),client),c2pa);
            Files.writeString(work.resolve("java-renewed.json"),ArchivePades.renew(pdf,renewed,policy,vera,client,c2pa?identity:null).json());
        }
        Files.writeString(work.resolve("java-created.json"),ArchiveSecurity.verify(pdf,inputs,policy,vera,ArchiveSecurity.Protection.PADES_B_LTA).json());
        System.out.println("Created, verified and renewed synthetic PAdES B-LTA archives through EU DSS.");
    }
}
