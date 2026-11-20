package digital.thinkbox.pdfsecurity;

import java.io.IOException;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.function.Consumer;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Coordinates PDF signing and renewal, including the required C2PA/B-LTA revision order. */
public final class PdfSecurity {
    public enum Protection {CMS_AND_PDF,CMS_AND_PDF_TIMESTAMPED,PADES_B_LTA}
    /** Identity is borrowed and caller-owned. A null identity is permitted only for renewal without C2PA. */
    public record Options(SigningIdentity identity,CertificatePolicy policy,Rfc3161Client timestamp,Clock clock,C2paProfile profile,String reason){
        public Options(SigningIdentity identity,CertificatePolicy policy,Rfc3161Client timestamp,Clock clock,C2paProfile profile){this(identity,policy,timestamp,clock,profile,"Archive export integrity; source authenticity and completeness are not asserted");}
        public Options{Objects.requireNonNull(policy);Objects.requireNonNull(clock);reason=reason==null?"":reason;}
        public SigningIdentity getIdentity(){return identity;}
    }
    public record Result(Map<String,SecurityReport.Check> checks,Instant bestSignatureTime,boolean lta){
        public Result{checks=Collections.unmodifiableMap(new LinkedHashMap<>(checks));}
        public boolean valid(){return checks.values().stream().noneMatch(check->check.status()==FAIL)
            &&checks.get("pdf.cryptographicSignature")!=null&&checks.get("pdf.cryptographicSignature").status()==PASS
            &&checks.get("requestedProtection")!=null&&checks.get("requestedProtection").status()==PASS;}
    }
    private PdfSecurity(){}

    public static Result sign(Path input,Path output,Protection protection,Options options)throws Exception{
        return sign(input,output,protection,options,message->{});
    }
    /** Progress describes completed/active steps; it does not imply a validation result. */
    public static Result sign(Path input,Path output,Protection protection,Options options,Consumer<String> progress)throws Exception{
        preflight(protection,options,false);
        return publish(input,output,(staged,work)->{
            try(var document=org.apache.pdfbox.Loader.loadPDF(input.toFile())){
                if(options.profile()==null&&C2pa.hasCredentials(document))throw new IOException("An explicit C2PA profile is required; no Content Credentials downgrade");
                if(options.profile()!=null)C2pa.checkPreparation(document,options.profile());
            }
            if(protection==Protection.PADES_B_LTA){
                Path baseline=work.resolve("baseline-t.pdf"),augmented=options.profile()==null?staged:work.resolve("archival-evidence.pdf");
                progress.accept("Signing the PDF and obtaining its trusted signature timestamp…");
                PdfCmsSigning.sign(input,baseline,options.getIdentity(),options.clock().instant(),options.timestamp(),options.profile(),options.profile()==null,options.reason());
                progress.accept("Adding long-term validation evidence and an archival timestamp…");
                DssPades.extend(baseline,augmented,currentPolicy(options),options.timestamp(),options.profile());
                if(options.profile()!=null){
                    progress.accept("Completing Content Credentials and the covering archival timestamp…");
                    C2paPades.finish(augmented,staged,options.getIdentity(),options.timestamp(),options.clock().instant(),options.profile());
                }
            }else{
                progress.accept(options.timestamp()==null?"Signing the PDF…":"Signing the PDF and obtaining its trusted timestamp…");
                PdfCmsSigning.sign(input,staged,options.getIdentity(),options.clock().instant(),options.timestamp(),options.profile(),true,options.reason());
            }
            progress.accept("Verifying PDF signatures, timestamps and requested protection…");
            return verified(staged,protection,options,options.getIdentity().certificateSha256());
        });
    }

    public static Result renew(Path input,Path output,Options options)throws Exception{
        preflight(Protection.PADES_B_LTA,options,true);
        var before=verify(input,Protection.PADES_B_LTA,options.policy(),options.profile(),null);
        if(!before.valid()||!before.lta())throw new IOException("The existing PAdES B-LTA archive must verify before renewal");
        return publish(input,output,(staged,work)->{
            Path augmented=options.profile()==null?staged:work.resolve("archival-evidence.pdf");
            DssPades.extend(input,augmented,currentPolicy(options),options.timestamp(),options.profile());
            if(options.profile()!=null)C2paPades.finish(augmented,staged,options.getIdentity(),options.timestamp(),options.clock().instant(),options.profile());
            return verified(staged,Protection.PADES_B_LTA,options,null);
        });
    }

    public static Result verify(Path pdf,Protection protection,CertificatePolicy policy,C2paProfile profile,String expectedCertificate){
        var checks=new LinkedHashMap<String,SecurityReport.Check>();Instant best=null;boolean lta=false;
        if(profile==null){
            try(var document=org.apache.pdfbox.Loader.loadPDF(pdf.toFile())){
                if(C2pa.hasCredentials(document))checks.put("c2pa.profile",new SecurityReport.Check(FAIL,"EXPLICIT_C2PA_PROFILE_REQUIRED"));
            }catch(IOException failure){checks.put("pdf.structure",new SecurityReport.Check(FAIL,"PDF_STRUCTURE_UNAVAILABLE"));}
        }
        if(profile!=null){
            checks.putAll(C2pa.verify(pdf,profile));
            if(!checks.containsKey("c2pa.signature")||!checks.containsKey("c2pa.binding"))
                checks.put("c2pa.validation",new SecurityReport.Check(FAIL,"CONFIGURED_C2PA_PROFILE_MISSING_OR_INVALID"));
        }
        if(protection==Protection.PADES_B_LTA){
            var result=DssPades.verify(pdf,policy,expectedCertificate,profile);best=result.bestSignatureTime();lta=result.lta();
            result.checks().forEach((key,value)->checks.put("pdf."+key,value));
            checks.put("requestedProtection",new SecurityReport.Check(result.valid()&&lta?PASS:FAIL,"REQUESTED_PADES_B_LTA_REQUIRED"));
        }else{
            PdfCmsVerification.verify(pdf,policy,expectedCertificate).forEach((key,value)->checks.put("pdf."+key,value));
            boolean time=protection==Protection.CMS_AND_PDF||checks.get("pdf.timestamp")!=null&&checks.get("pdf.timestamp").status()==PASS;
            checks.put("requestedProtection",new SecurityReport.Check(time?PASS:FAIL,"REQUESTED_PDF_SIGNATURE_AND_TIMESTAMP_LEVEL"));
        }
        return new Result(checks,best,lta);
    }

    private static Result verified(Path staged,Protection protection,Options options,String expectedCertificate)throws IOException{
        var result=verify(staged,protection,currentPolicy(options),options.profile(),expectedCertificate);
        if(!result.valid()||protection==Protection.PADES_B_LTA&&!result.lta())throw new IOException("PDF security verification failed; no output published or protection downgrade: "+result.checks());
        return result;
    }
    private static void preflight(Protection protection,Options options,boolean renewal)throws Exception{
        boolean required=protection!=Protection.CMS_AND_PDF,configured=options.timestamp()!=null;
        if(required!=configured)throw new IOException("Timestamp settings do not match requested protection; no downgrade");
        if(!renewal||options.profile()!=null){
            if(options.getIdentity()==null)throw new IOException("A signing identity is required");
            options.getIdentity().check(options.clock().instant());
            if(options.profile()!=null)C2pa.requireSigningCredential(options.getIdentity());
            var certificates=options.getIdentity().certificates();
            var checks=currentPolicy(options).check(certificates.getFirst(),certificates);
            if(checks.get("certificateTrust").status()==FAIL||checks.get("revocation").status()==FAIL)
                throw new IOException("Signing certificate trust or revocation policy failed");
            if(protection==Protection.PADES_B_LTA&&(checks.get("certificateTrust").status()!=PASS
                ||checks.get("revocation").status()!=PASS&&checks.get("revocation").status()!=NOT_APPLICABLE))
                throw new IOException("B-LTA requires verified signer trust and fresh revocation evidence");
        }
        if(protection==Protection.PADES_B_LTA&&options.policy().anchors().isEmpty())throw new IOException("B-LTA requires independently selected trust anchors");
    }
    private static CertificatePolicy currentPolicy(Options options){return options.policy().withTime(options.clock().instant());}
    @FunctionalInterface private interface Operation{Result run(Path staged,Path work)throws Exception;}
    private static Result publish(Path input,Path output,Operation operation)throws Exception{
        Path destination=output.toAbsolutePath().normalize();
        if(Files.exists(destination,LinkOption.NOFOLLOW_LINKS)||input.toRealPath().equals(destination))throw new IOException("PDF security operations require a new destination");
        Files.createDirectories(destination.getParent());
        Path work=Files.createTempDirectory(destination.getParent(),".pdf-security-"),staged=work.resolve("protected.pdf");
        try{
            var result=operation.run(staged,work);Files.createLink(destination,staged);return result;
        }finally{try(var files=Files.walk(work)){for(Path path:files.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
    }
}
