package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.apache.pdfbox.Loader;

/** Desktop-only process bridge; uses the existing signing and verification engines. */
public final class DesktopSigningMain {
    private DesktopSigningMain(){}
    public static void main(String[] args){
        Main.applyCompressionDefault();
        int code=run(args,System.in,System.out,System.err);
        if(code!=0)System.exit(code);
    }
    static int run(String[] args,InputStream passwordInput,PrintStream out,PrintStream err){
        char[] password=null;
        try{
            if(args.length<1)throw new IllegalArgumentException("Missing desktop operation.");
            String operation=args[0];Map<String,String> options=new LinkedHashMap<>();
            for(int i=1;i<args.length;i+=2){
                if(i+1>=args.length||!Set.of("--input","--output","--sources","--verapdf","--certificate","--report","--import-provenance","--c2pa").contains(args[i])||options.put(args[i],args[i+1])!=null)
                    throw new IllegalArgumentException("Invalid desktop signing options.");
            }
            Path input=Path.of(required(options,"--input"));
            String validator=options.getOrDefault("--verapdf",SecurityConfiguration.defaultValidator());
            if(operation.equals("verify")){
                boolean signed;
                try(var pdf=Loader.loadPDF(input.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
                    var names=pdf.getDocumentCatalog().getNames();var tree=names==null?null:names.getEmbeddedFiles();
                    signed=!pdf.getSignatureDictionaries().isEmpty()||hasManifestSignature(tree);
                }
                if(!signed)return Main.run(args,out,err);
                Path sources=options.containsKey("--sources")?Path.of(options.get("--sources")):null;
                var result=ArchiveSecurity.verify(input,sources,CertificatePolicy.untrusted(Instant.now()),validator,ArchiveSecurity.Protection.CMS_AND_PDF);
                out.print(result.json());Files.writeString(Path.of(required(options,"--output")),result.json(),StandardOpenOption.CREATE_NEW);
                // Match the ordinary desktop verifier: source diagnostics stay visible
                // but are separate from the archive/security operation outcome.
                boolean failed=result.checks().entrySet().stream().anyMatch(e->!e.getKey().startsWith("source.")&&e.getValue().status()==SecurityReport.Status.FAIL);
                return failed?1:result.checks().values().stream().anyMatch(c->c.status()==SecurityReport.Status.UNKNOWN)?2:0;
            }
            if(!operation.equals("create"))throw new IllegalArgumentException("Invalid desktop signing operation.");
            Path certificate=Path.of(required(options,"--certificate")).toRealPath(),root=input.toRealPath();
            if(certificate.startsWith(root))throw new IOException("Keep the signing certificate outside the source inputs.");
            password=DesktopPassword.read(passwordInput);Instant now=Instant.now();
            try(var identity=SigningIdentity.load(certificate,password,null,now)){
                Arrays.fill(password,'\0');
                Manifest manifest=ArchiveSecurity.create(root,Path.of(required(options,"--output")),"archival-master",
                        new ArchiveSecurity.Options(identity,CertificatePolicy.untrusted(now),validator,ArchiveSecurity.Protection.CMS_AND_PDF,Clock.systemUTC()),
                        options.containsKey("--import-provenance")?ImportProvenance.read(Path.of(options.get("--import-provenance"))):null,Main.c2paOption(options),Main.creationProgress(err));
                long displayed=manifest.images().stream().filter(i->i.status().equals("rendered")).count();
                out.printf("Created %s: %d supplied and embedded; %d displayed; %d rejected for display.%n",options.get("--output"),manifest.images().size(),displayed,manifest.images().size()-displayed);
                for(var image:manifest.images())if(!image.status().equals("rendered"))err.println("REJECTED FOR DISPLAY "+image.sourcePath()+": "+image.reason());
                out.println("Manifest and PDF signed. Certificate trust is assessed separately; no trusted timestamp was requested.");
                if(Main.c2paOption(options))out.println("C2PA export credentials embedded using the configured certificate; C2PA trust is assessed separately.");
            }
            return 0;
        }catch(Exception error){err.println("Signing or verification failed: "+error.getMessage());return 1;}
        finally{if(password!=null)Arrays.fill(password,'\0');}
    }
    private static boolean hasManifestSignature(org.apache.pdfbox.pdmodel.PDEmbeddedFilesNameTreeNode root)throws IOException{
        if(root==null)return false;
        var queue=new ArrayDeque<org.apache.pdfbox.pdmodel.common.PDNameTreeNode<org.apache.pdfbox.pdmodel.common.filespecification.PDComplexFileSpecification>>();queue.add(root);
        Set<org.apache.pdfbox.cos.COSDictionary> seen=Collections.newSetFromMap(new IdentityHashMap<>());int count=0;
        while(!queue.isEmpty()){
            var tree=queue.removeFirst();if(!seen.add(tree.getCOSObject())||++count>10_000)throw new IOException("Invalid or excessive attachment tree.");
            if(tree.getNames()!=null&&tree.getNames().containsKey("manifest.p7s"))return true;
            if(tree.getKids()!=null){if(queue.size()+tree.getKids().size()>10_000)throw new IOException("Excessive attachment tree.");queue.addAll(tree.getKids());}
        }
        return false;
    }
    private static String required(Map<String,String> values,String key){String value=values.get(key);if(value==null||value.isBlank())throw new IllegalArgumentException("Missing "+key);return value;}
}
