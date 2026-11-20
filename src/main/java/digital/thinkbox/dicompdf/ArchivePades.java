package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.*;
import java.io.IOException;
import java.nio.file.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS;

/** Publication checks around archival renewal; C2PA also needs a fresh claim signature. */
public final class ArchivePades {
    private ArchivePades(){}
    public static SecurityReport renew(Path input,Path output,CertificatePolicy policy,String verapdf,Rfc3161Client timestamp)throws Exception{
        return renew(input,output,policy,verapdf,timestamp,null);
    }
    public static SecurityReport renew(Path input,Path output,CertificatePolicy policy,String verapdf,Rfc3161Client timestamp,SigningIdentity c2paIdentity)throws Exception{
        if(verapdf==null||verapdf.isBlank())throw new IOException("Archival renewal requires PDF/A-4f validation");
        boolean c2pa=ArchiveC2pa.present(input);
        if(c2pa&&c2paIdentity==null)throw new IOException("Renewing C2PA with B-LTA requires a C2PA signing identity for the new claim");
        if(c2pa)ArchiveC2pa.requireSigningCredential(c2paIdentity);
        requireArchive(ArchiveSecurity.verify(input,null,policy,verapdf,ArchiveSecurity.Protection.PADES_B_LTA));
        Path destination=output.toAbsolutePath().normalize();
        if(!destination.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")||Files.exists(destination,LinkOption.NOFOLLOW_LINKS))throw new IOException("Archival renewal requires a new PDF destination");
        Files.createDirectories(destination.getParent());
        Path staged=Files.createTempFile(destination.getParent(),".dicom-renewal-",".pdf");Files.delete(staged);
        try{
            PdfSecurity.renew(input,staged,new PdfSecurity.Options(c2paIdentity,policy,timestamp,
                java.time.Clock.fixed(policy.at(),java.time.ZoneOffset.UTC),c2pa?ArchiveC2pa.FORMAT:null));
            var result=ArchiveSecurity.verify(staged,null,policy,verapdf,ArchiveSecurity.Protection.PADES_B_LTA);requireArchive(result);
            Files.createLink(destination,staged);return result;
        }finally{Files.deleteIfExists(staged);}
    }
    private static void requireArchive(SecurityReport report)throws IOException{
        if(report.checks().entrySet().stream().anyMatch(e->e.getKey().startsWith("c2pa.")&&e.getValue().status()==SecurityReport.Status.FAIL)||!"EXPORT_AUTHENTICATED".equals(report.assurance())||java.util.List.of("padesBLta","originalBytes","metadataAgreement","pdfa4f","capturedInventory","requestedProtection").stream()
            .anyMatch(key->report.checks().get(key)==null||report.checks().get(key).status()!=PASS))
            throw new IOException("Archive authenticity, preservation, metadata and PDF/A-4f must pass before archival renewal; no downgrade");
    }
}
