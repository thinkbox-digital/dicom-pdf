package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import com.google.gson.*;
import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

/** Local synthetic demonstration. Not part of the runnable product JAR. */
public final class SecurityFixtureMain {
    public static void main(String[] args)throws Exception{
        if(args.length<3||args.length>5)throw new IllegalArgumentException("Expected target working directory, new output PDF and veraPDF executable, optionally --timestamped and/or --c2pa");
        var flags=new HashSet<>(Arrays.asList(args).subList(3,args.length));
        if(flags.size()!=args.length-3||!Set.of("--timestamped","--c2pa").containsAll(flags))throw new IllegalArgumentException("Unknown or duplicate synthetic fixture option");
        boolean timestamped=flags.contains("--timestamped"),c2pa=flags.contains("--c2pa");
        Path work=Path.of(args[0]).toAbsolutePath().normalize(),target=Path.of("target").toRealPath();
        if(!work.startsWith(target)||Files.exists(work))throw new IllegalArgumentException("Choose a new synthetic working directory under target");
        Files.createDirectories(work);
        var institution=SecurityFixtures.institution(work.resolve("keys"),false,c2pa);
        Files.writeString(work.resolve("keys/root.pem"),SecurityFixtures.pem(institution.root()));
        Files.write(work.resolve("keys/current.crl"),SecurityFixtures.crl(institution,false).getEncoded());
        Files.writeString(work.resolve("keys/password.txt"),new String(SecurityFixtures.PASSWORD)+"\n");
        try{Files.setPosixFilePermissions(work.resolve("keys/password.txt"),java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));Files.setPosixFilePermissions(institution.pkcs12(),java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));}
        catch(UnsupportedOperationException ignored){}
        Path inputs=work.resolve("inputs");SyntheticFixtures.writeReferences(inputs);
        Files.write(inputs.resolve("unsupported.bin"),new byte[]{1,2,3,4});
        var config=new JsonObject();config.addProperty("protection","CMS_AND_PDF");config.addProperty("pkcs12","keys/institution.p12");
        if(timestamped)config.addProperty("protection","CMS_AND_PDF_TIMESTAMPED");
        config.addProperty("passphraseFile","keys/password.txt");config.addProperty("verapdf",Path.of(args[2]).toAbsolutePath().toString());
        var roots=new JsonArray();roots.add("keys/root.pem");config.add("trustCertificates",roots);
        var crls=new JsonArray();crls.add("keys/current.crl");config.add("crls",crls);
        Path configuration=work.resolve("security-config.json");Files.writeString(configuration,new GsonBuilder().setPrettyPrinting().create().toJson(config));
        int created;
        if(timestamped){
            var clock=Clock.fixed(institution.now(),ZoneOffset.UTC);
            var client=new Rfc3161Client(digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,""),institution.policy(false),clock,"1.2.3.4.5");
            try(var identity=institution.identity()){
                var options=new ArchiveSecurity.Options(identity,institution.policy(false),args[2],ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED,clock,client);
                ArchiveSecurity.create(inputs,Path.of(args[1]),"archival-master",options,c2pa);
                ArchiveEvidence.renew(Path.of(args[1]),null,work.resolve("evidence-1.json"),options);
                ArchiveEvidence.renew(Path.of(args[1]),work.resolve("evidence-1.json"),work.resolve("evidence-2.json"),options);
            }
            created=0;
        }else created=Main.run(new String[]{"create","--input",inputs.toString(),"--output",args[1],"--security-config",configuration.toString(),"--c2pa",c2pa?"on":"off"},System.out,System.err);
        if(created!=0)throw new IllegalStateException("Synthetic secure creation failed");
        var result=ArchiveSecurity.verify(Path.of(args[1]),inputs,new CertificatePolicy(institution.policy(false).anchors(),List.of(),Instant.now()),args[2],ArchiveSecurity.Protection.CMS_AND_PDF);
        Files.writeString(work.resolve("security-report.json"),result.json());
        if(!result.assurance().equals("EXPORT_AUTHENTICATED"))throw new IllegalStateException("Synthetic issuer authentication failed");
        if(timestamped){
            if(result.checks().get("trustedTimestamp").status()!=SecurityReport.Status.PASS)throw new IllegalStateException("Synthetic timestamp verification failed");
            var evidence=ArchiveEvidence.verify(Path.of(args[1]),work.resolve("evidence-2.json"),institution.policy(false));
            if(!evidence.assurance().equals("TIMESTAMPED_ARCHIVE_EVIDENCE"))throw new IllegalStateException("Synthetic renewal verification failed");
            Files.writeString(work.resolve("evidence-report.json"),evidence.json());
        }
        System.out.println("Synthetic archive: six originals preserved; export authenticated; acquisition and clinical completeness remain unknown.");
    }
}
