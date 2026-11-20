package digital.thinkbox.dicompdf;

import com.google.gson.*;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.time.*;
import java.util.*;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.tsp.TimeStampToken;
import org.bouncycastle.asn1.cms.ContentInfo;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Optional external evidence chain. Never modifies the PDF; this is not PAdES renewal. */
public final class ArchiveEvidence {
    private static final int MAX_BYTES=16*1024*1024,MAX_ENTRIES=32;
    private static final String PURPOSE="DICOM_PDF_EXTERNAL_EVIDENCE";
    private ArchiveEvidence(){}

    public static SecurityReport renew(Path pdf,Path previous,Path output,ArchiveSecurity.Options options)throws Exception{
        if(options.protection()!=ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED||options.timestampClient()==null)
            throw new IOException("External renewal requires timestamped protection; no downgrade was performed");
        Path destination=output.toAbsolutePath().normalize();
        if(Files.exists(destination,LinkOption.NOFOLLOW_LINKS))throw new IOException("Evidence destination must be new");
        if(destination.equals(pdf.toAbsolutePath().normalize())||previous!=null&&destination.equals(previous.toAbsolutePath().normalize()))throw new IOException("Evidence must not replace its source");
        var preserved=PackageTools.verify(pdf,null,options.verapdf());
        if(!"PASS".equals(preserved.sourceBytes().status())||!"PASS".equals(preserved.metadataAccuracy().status())||!"PASS".equals(preserved.pdfa4f().status()))
            throw new IOException("External renewal requires verified archive bytes, metadata and PDF/A-4f");
        var chain=new JsonArray();
        if(previous!=null){
            var checked=verify(pdf,previous,options.policy());
            if(checked.checks().values().stream().anyMatch(c->c.status()==FAIL)||!checked.assurance().equals("TIMESTAMPED_ARCHIVE_EVIDENCE"))
                throw new IOException("Previous evidence chain could not be verified; renewal refused");
            chain=read(previous).getAsJsonArray("entries");
        }
        if(chain.size()>=MAX_ENTRIES)throw new IOException("External evidence chain entry limit reached");
        var binding=new JsonObject();binding.addProperty("schemaVersion",1);binding.addProperty("purpose",PURPOSE);
        binding.addProperty("pdfSha256",pdfHash(pdf));binding.addProperty("pdfSize",Files.size(pdf));
        if(chain.isEmpty())binding.add("previousEntrySha256",JsonNull.INSTANCE);
        else binding.addProperty("previousEntrySha256",hash(canonical(chain.get(chain.size()-1))));
        binding.addProperty("issuerCertificateSha256",options.getIdentity().certificateSha256());
        binding.addProperty("observedAt",options.clock().instant().toString());
        var crls=new JsonArray();for(var crl:options.policy().crls())crls.add(Base64.getEncoder().encodeToString(crl.getEncoded()));binding.add("crls",crls);
        byte[] cms=CmsSigning.sign(new ByteArrayInputStream(canonical(binding)),options.getIdentity(),options.clock().instant(),options.timestampClient());
        var entry=new JsonObject();entry.add("binding",binding);entry.addProperty("cms",Base64.getEncoder().encodeToString(cms));chain.add(entry);
        var envelope=new JsonObject();envelope.addProperty("schemaVersion",1);envelope.addProperty("purpose",PURPOSE);envelope.add("entries",chain);
        byte[] bytes=canonical(envelope);if(bytes.length>MAX_BYTES)throw new IOException("External evidence exceeds size limit");
        Files.createDirectories(destination.getParent());
        Path staged=Files.createTempFile(destination.getParent(),".dicom-evidence-",".json");
        try{
            Files.write(staged,bytes);
            var report=verify(pdf,staged,options.policy().withTime(options.clock().instant()));
            if(!report.assurance().equals("TIMESTAMPED_ARCHIVE_EVIDENCE"))throw new IOException("New evidence failed verification; no output published");
            Files.createLink(destination,staged);return report;
        }finally{Files.deleteIfExists(staged);}
    }

    public static SecurityReport verify(Path pdf,Path evidence,CertificatePolicy policy){
        var checks=new LinkedHashMap<String,SecurityReport.Check>();
        checks.put("acquisitionProvenance",new SecurityReport.Check(UNKNOWN,"EXTERNAL_EVIDENCE_DOES_NOT_AUTHENTICATE_ACQUISITION"));
        checks.put("clinicalCompleteness",new SecurityReport.Check(UNKNOWN,"CLINICAL_COMPLETENESS_NOT_ASSESSED"));
        boolean valid=false;
        try{
            var envelope=read(evidence);var chain=envelope.getAsJsonArray("entries");
            if(!envelope.keySet().equals(Set.of("schemaVersion","purpose","entries"))||envelope.get("schemaVersion").getAsBigDecimal().intValueExact()!=1||!PURPOSE.equals(envelope.get("purpose").getAsString())||chain.isEmpty()||chain.size()>MAX_ENTRIES)throw new IOException("Invalid evidence schema");
            String pdfHash=pdfHash(pdf),previousHash=null;long size=Files.size(pdf);Instant previousTime=null;
            for(int i=0;i<chain.size();i++){
                String prefix="entry."+(i+1)+".";
                var entry=chain.get(i).getAsJsonObject();var binding=entry.getAsJsonObject("binding");
                if(!entry.keySet().equals(Set.of("binding","cms"))||!binding.keySet().equals(Set.of("schemaVersion","purpose","pdfSha256","pdfSize","previousEntrySha256","issuerCertificateSha256","observedAt","crls")))throw new IOException("Unsupported evidence properties");
                var predecessor=binding.get("previousEntrySha256");String claimed=predecessor.isJsonNull()?null:predecessor.getAsString();
                if(binding.get("schemaVersion").getAsBigDecimal().intValueExact()!=1||!PURPOSE.equals(binding.get("purpose").getAsString())||!pdfHash.equals(binding.get("pdfSha256").getAsString())||binding.get("pdfSize").getAsBigDecimal().longValueExact()!=size||!Objects.equals(previousHash,claimed))throw new IOException("Evidence PDF or predecessor binding mismatch");
                Instant.parse(binding.get("observedAt").getAsString());
                checks.put(prefix+"binding",new SecurityReport.Check(PASS,"UNCHANGED_PDF_AND_PREDECESSOR_HASH_MATCH"));
                byte[] cms=Base64.getDecoder().decode(entry.get("cms").getAsString());if(cms.length>Rfc3161Client.MAX_RESPONSE)throw new IOException("Evidence CMS exceeds limit");
                var retained=new ArrayList<X509CRL>(policy.crls());var factory=CertificateFactory.getInstance("X.509");
                for(var encoded:binding.getAsJsonArray("crls")){
                    byte[] der=Base64.getDecoder().decode(encoded.getAsString());if(der.length>MAX_BYTES)throw new IOException("Evidence CRL exceeds limit");
                    retained.add((X509CRL)factory.generateCRL(new ByteArrayInputStream(der)));
                }
                var currentPolicy=new CertificatePolicy(policy.anchors(),retained,policy.at(),policy.ocsps(),policy.supportingCertificates());
                String issuer=binding.get("issuerCertificateSha256").getAsString();byte[] content=canonical(binding);
                var current=CmsVerification.verify(new ByteArrayInputStream(content),cms,currentPolicy,issuer);
                // Historical evaluation is permitted only after a cryptographically verified,
                // explicitly trusted timestamp binds this exact CMS signature value.
                var timestamp=current.get("timestamp");
                if(timestamp==null)throw new IOException("Evidence has no verified trusted timestamp");
                checks.put(prefix+"timestamp",timestamp);
                if(timestamp.status()==UNKNOWN)throw new EvidenceIncomplete();
                if(timestamp.status()!=PASS)throw new IOException("Evidence has no verified trusted timestamp");
                var signer=new CMSSignedData(cms).getSignerInfos().getSigners().iterator().next();
                var token=new TimeStampToken(ContentInfo.getInstance(signer.getUnsignedAttributes().get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken).getAttrValues().getObjectAt(0)));
                Instant issued=token.getTimeStampInfo().getGenTime().toInstant();
                if(previousTime!=null&&issued.isBefore(previousTime))throw new IOException("Evidence timestamp order is invalid");
                var historicalPolicy=new CertificatePolicy(policy.anchors(),retained,issued,policy.ocsps(),policy.supportingCertificates());
                var historical=CmsVerification.verify(new ByteArrayInputStream(content),cms,historicalPolicy,issuer);
                for(String name:List.of("cryptographicSignature","certificateValidity","certificateTrust","keyPolicy","revocation","timestamp")){
                    var check=historical.get(name);
                    if(check==null)throw new IOException("Evidence issuer or timestamp validation missing");
                    checks.put(prefix+name,check);
                    if(check.status()==UNKNOWN)throw new EvidenceIncomplete();
                    if(check.status()!=PASS&&!(name.equals("revocation")&&check.status()==NOT_APPLICABLE))throw new IOException("Evidence issuer or timestamp validation failed");
                }
                previousHash=hash(canonical(entry));previousTime=issued;
            }
            valid=true;
        }catch(EvidenceIncomplete incomplete){checks.put("evidenceChain",new SecurityReport.Check(UNKNOWN,"TRUST_OR_REVOCATION_EVIDENCE_INCOMPLETE"));}
        catch(Exception failure){checks.put("evidenceChain",new SecurityReport.Check(FAIL,"MISSING_INVALID_OR_UNSUPPORTED_EVIDENCE_CHAIN"));}
        return new SecurityReport(1,valid?"TIMESTAMPED_ARCHIVE_EVIDENCE":"INTEGRITY_ONLY",policy.at().toString(),"VERIFIER_REFERENCE_TIME_WITH_SEPARATELY_VERIFIED_TIMESTAMP_EVIDENCE",checks);
    }
    private static JsonObject read(Path path)throws Exception{
        byte[] bytes;
        try(var input=Files.newInputStream(path)){bytes=input.readNBytes(MAX_BYTES+1);}
        if(bytes.length>MAX_BYTES)throw new IOException("Evidence exceeds size limit");
        String text=new String(bytes,StandardCharsets.UTF_8);
        if(!Arrays.equals(bytes,ManifestEncoding.canonicalize(text)))throw new IOException("Evidence must use canonical UTF-8 JSON");
        return JsonParser.parseString(text).getAsJsonObject();
    }
    private static final class EvidenceIncomplete extends Exception {}
    private static byte[] canonical(JsonElement json)throws IOException{return ManifestEncoding.canonicalize(json.toString());}
    private static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static String pdfHash(Path pdf)throws Exception{
        var digest=MessageDigest.getInstance("SHA-256");
        try(var input=Files.newInputStream(pdf)){byte[] block=new byte[64*1024];for(int count;(count=input.read(block))!=-1;)digest.update(block,0,count);}
        return HexFormat.of().formatHex(digest.digest());
    }
}
