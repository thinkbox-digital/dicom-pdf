package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.nio.file.*;
import java.util.*;

/** Validated desktop choices translated to the existing, independently usable CLI. */
record DesktopRequest(boolean creating,String input,String output,String sources,
                      String securityConfig,boolean timestamping,String importProvenance,boolean c2pa,String passphraseFile) {
    DesktopRequest(boolean creating,String input,String output,String sources,String securityConfig,boolean timestamping,String importProvenance,boolean c2pa){this(creating,input,output,sources,securityConfig,timestamping,importProvenance,c2pa,"");}
    DesktopRequest(boolean creating,String input,String output,String sources,String securityConfig,boolean timestamping){this(creating,input,output,sources,securityConfig,timestamping,"",true);}
    DesktopRequest(boolean creating,String input,String output,String sources,String securityConfig,boolean timestamping,String importProvenance){this(creating,input,output,sources,securityConfig,timestamping,importProvenance,true);}
    void checkSigning(String certificate,char[] password)throws Exception{
        if(!creating)return;
        if(!securityConfig.isBlank()){
            var config=SecurityConfiguration.forDesktop(requiredPath(securityConfig,"Signing configuration"),timestamping,passphraseFile);
            try(var identity=config.identityForEvidence()){
                ArchiveSecurity.preflight(new ArchiveSecurity.Options(identity,config.policy,config.verapdf,config.protection,java.time.Clock.systemUTC(),config.timestampClient()),c2pa);
            }
        }else if(!certificate.isBlank()){
            var now=java.time.Instant.now();
            try(var identity=passphraseFile.isBlank()?digital.thinkbox.pdfsecurity.SigningIdentity.load(Path.of(certificate),password,null,now):digital.thinkbox.pdfsecurity.SigningIdentity.loadWithPassphraseFile(Path.of(certificate),Path.of(passphraseFile),null,now)){
                ArchiveSecurity.preflight(new ArchiveSecurity.Options(identity,digital.thinkbox.pdfsecurity.CertificatePolicy.untrusted(now),SecurityConfiguration.defaultValidator(),ArchiveSecurity.Protection.CMS_AND_PDF,java.time.Clock.systemUTC()),c2pa);
            }
        }
    }
    DesktopRequest prepare(Path work,java.util.function.BooleanSupplier stopped)throws Exception{
        return prepare(work,stopped,"");
    }
    DesktopRequest prepare(Path work,java.util.function.BooleanSupplier stopped,String certificate)throws Exception{
        return prepare(work,stopped,certificate,message->{});
    }
    DesktopRequest prepare(Path work,java.util.function.BooleanSupplier stopped,String certificate,java.util.function.Consumer<String> progress)throws Exception{
        if(creating&&securityConfig.isBlank()&&!certificate.isBlank()&&!passphraseFile.isBlank()){
            var json=new com.google.gson.JsonObject();json.addProperty("protection","CMS_AND_PDF");
            json.addProperty("pkcs12",Path.of(certificate).toAbsolutePath().normalize().toString());json.addProperty("passphraseFile",Path.of(passphraseFile).toAbsolutePath().normalize().toString());
            Path config=work.resolve("certificate-signing.json");Files.writeString(config,json.toString(),StandardOpenOption.CREATE_NEW);
            return new DesktopRequest(true,input,output,sources,config.toString(),timestamping,importProvenance,c2pa,passphraseFile).prepare(work,stopped,"",progress);
        }
        if(creating&&securityConfig.isBlank()&&!passphraseFile.isBlank())throw new IllegalArgumentException("Select a signing certificate or JSON for the passphrase file.");
        if(creating&&timestamping&&securityConfig.isBlank())throw new IllegalArgumentException("Timestamping is on. Select a signing JSON with tsaUrl and TSA trust settings.");
        String preparedInput=input,preparedSources=sources,preparedConfig=securityConfig,receipt=importProvenance;
        if(creating)creationDestination(requiredPath(input,"Source input"));
        if(creating){
            Path importReceipt=work.resolve("import-source.json");
            preparedInput=DesktopInputs.prepare(requiredPath(input,"Source input"),work.resolve("inputs"),stopped,importReceipt,progress).toString();
            if(Files.isRegularFile(importReceipt))receipt=importReceipt.toString();
        }
        else if(!sources.isBlank())preparedSources=DesktopInputs.prepare(requiredPath(sources,"Original source input"),work.resolve("originals"),stopped).toString();
        if(!securityConfig.isBlank()){
            Path config=requiredPath(securityConfig,"Security configuration");
            if(!Files.isRegularFile(config)||Files.size(config)>1024*1024)throw new IllegalArgumentException("Choose a local security configuration JSON file (maximum 1 MiB).");
            var json=JsonParser.parseString(Files.readString(config)).getAsJsonObject();Path parent=config.toRealPath().getParent();
            if(creating&&!passphraseFile.isBlank())json.addProperty("passphraseFile",Path.of(passphraseFile).toAbsolutePath().normalize().toString());
            if(creating){
                String protection=json.has("protection")?json.get("protection").getAsString():"";
                if(!Set.of("CMS_AND_PDF","CMS_AND_PDF_TIMESTAMPED","PADES_B_LTA").contains(protection))throw new IllegalArgumentException("Signing configuration must select a supported protection setting.");
                if(timestamping){
                    if(!json.has("tsaUrl")||json.get("tsaUrl").getAsString().isBlank())throw new IllegalArgumentException("Timestamping is on, but the signing JSON has no tsaUrl. Configure a timestamp service and trusted TSA certificates.");
                    json.addProperty("protection",protection.equals("PADES_B_LTA")?"PADES_B_LTA":"CMS_AND_PDF_TIMESTAMPED");
                }else if(!protection.equals("CMS_AND_PDF"))throw new IllegalArgumentException("This policy requires timestamps. Check Add trusted timestamps to proceed; no protection was downgraded.");
                else{json.remove("tsaUrl");json.remove("tsaPolicyOid");}
            }
            if(creating)for(String name:List.of("pkcs12","passphraseFile"))if(json.has(name)){
                Path secret=parent.resolve(json.get(name).getAsString()).normalize();
                if(Files.isRegularFile(secret))for(Path candidate:InputFiles.collect(Path.of(preparedInput)))
                    if(Files.isSameFile(candidate,secret)||Files.size(candidate)==Files.size(secret)&&Files.mismatch(candidate,secret)==-1)
                        throw new IllegalArgumentException("Signing credentials and passphrase material must not be supplied as originals.");
            }
            for(String name:List.of("pkcs12","passphraseFile"))if(json.has(name))json.addProperty(name,parent.resolve(json.get(name).getAsString()).normalize().toString());
            for(String name:List.of("trustCertificates","supportingCertificates","crls","ocsps"))if(json.has(name)){
                var paths=new com.google.gson.JsonArray();for(var item:json.getAsJsonArray(name))paths.add(parent.resolve(item.getAsString()).normalize().toString());json.add(name,paths);
            }
            if(json.has("verapdf")){
                String validator=json.get("verapdf").getAsString();
                if(validator.isBlank())throw new IllegalArgumentException("Choose a nonempty veraPDF executable path.");
                json.addProperty("verapdf",parent.resolve(validator).normalize().toString());
            }
            Path copy=work.resolve("security.json");Files.writeString(copy,json.toString(),StandardOpenOption.CREATE_NEW);preparedConfig=copy.toString();
        }
        return new DesktopRequest(creating,preparedInput,output,preparedSources,preparedConfig,timestamping,receipt,c2pa,passphraseFile);
    }
    List<String> arguments(Path report)throws Exception {
        Path source=requiredPath(input,creating?"Source input":"Archive PDF");
        if(creating?!Files.isDirectory(source):!Files.isRegularFile(source))
            throw new IllegalArgumentException(creating?"Choose an existing source folder.":"Choose an existing archive PDF.");
        List<String> args=new ArrayList<>(List.of(creating?"create":"verify","--input",source.toString()));
        if(creating){
            Path destination=creationDestination(source);
            args.addAll(List.of("--output",destination.toString()));
            args.addAll(List.of("--c2pa",c2pa?"on":"off"));
            if(!importProvenance.isBlank())args.addAll(List.of("--import-provenance",importProvenance));
        }else{
            args.addAll(List.of("--output",report.toAbsolutePath().toString()));
            if(!sources.isBlank()){
                Path original=requiredPath(sources,"Original source folder");
                if(!Files.isDirectory(original))throw new IllegalArgumentException("Choose an existing original source folder, or leave it blank.");
                args.addAll(List.of("--sources",original.toString()));
            }
            if(!securityConfig.isBlank())args.set(0,"verify-security");
            else args.addAll(List.of("--verapdf",SecurityConfiguration.defaultValidator()));
        }
        if(!securityConfig.isBlank()){
            Path config=requiredPath(securityConfig,"Security configuration");
            if(!Files.isRegularFile(config)||Files.size(config)>1024*1024)throw new IllegalArgumentException("Choose a local security configuration JSON file (maximum 1 MiB).");
            if(creating){
                String protection;
                try{protection=JsonParser.parseString(Files.readString(config)).getAsJsonObject().get("protection").getAsString();}
                catch(RuntimeException error){throw new IllegalArgumentException("Signing configuration must be a JSON object with a protection setting.");}
                if(Set.of("CMS_AND_PDF_TIMESTAMPED","PADES_B_LTA").contains(protection)&&!timestamping)
                    throw new IllegalArgumentException("This configuration requires timestamps. Check Add trusted timestamps to proceed.");
                if(protection.equals("CMS_AND_PDF")&&timestamping)
                    throw new IllegalArgumentException("Timestamping is on but the policy has not been prepared for timestamped signing.");
            }
            args.addAll(List.of("--security-config",config.toString()));
        }
        return List.copyOf(args);
    }
    private Path creationDestination(Path source)throws Exception{
        Path destination=requiredPath(output,"Output PDF");
        if(destination.getFileName()==null||!destination.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".pdf"))throw new IllegalArgumentException("Output PDF must have a .pdf extension.");
        if(Files.exists(destination,LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("Output PDF already exists. Choose a different filename; existing files are not replaced.");
        if(!Files.isDirectory(source)&&!Files.isRegularFile(source))throw new IllegalArgumentException("Choose an existing file, directory or ZIP.");
        if(destination.startsWith(source.toRealPath()))throw new IllegalArgumentException("Output PDF must be outside the source folder.");
        return destination;
    }
    static void checkReportDestination(Path destination,List<Path> sourceRoots)throws Exception{
        Path absolute=destination.toAbsolutePath().normalize(),ancestor=absolute;
        while(!Files.exists(ancestor,LinkOption.NOFOLLOW_LINKS))ancestor=ancestor.getParent();
        Path canonical=ancestor.toRealPath().resolve(ancestor.relativize(absolute)).normalize();
        Path out=Path.of("out").toAbsolutePath().normalize();
        if(Files.exists(out))out=out.toRealPath();
        if(canonical.startsWith(out))throw new IllegalArgumentException("Save reports outside out/; that folder is reserved for converted PDFs.");
        for(Path root:sourceRoots)if(canonical.startsWith(root.toRealPath()))throw new IllegalArgumentException("Save reports outside the original source folder to preserve archival masters.");
        if(Files.exists(absolute,LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("Choose a new report file; existing files are not replaced.");
    }
    private static Path requiredPath(String value,String label){
        if(value==null||value.isBlank())throw new IllegalArgumentException(label+" is required.");
        return Path.of(value.strip()).toAbsolutePath().normalize();
    }
}
