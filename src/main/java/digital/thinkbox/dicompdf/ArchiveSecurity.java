package digital.thinkbox.dicompdf;

import com.google.gson.*;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.function.Consumer;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Archive orchestration only. Signing and cryptographic verification are separate classes. */
public final class ArchiveSecurity {
    public enum Protection {CMS_AND_PDF,CMS_AND_PDF_TIMESTAMPED,PADES_B_LTA}
    public record Options(SigningIdentity identity,CertificatePolicy policy,String verapdf,Protection protection,Clock clock,Rfc3161Client timestampClient){
        public Options(SigningIdentity identity,CertificatePolicy policy,String verapdf,Protection protection,Clock clock){this(identity,policy,verapdf,protection,clock,null);}
        public Options {Objects.requireNonNull(identity);Objects.requireNonNull(policy);Objects.requireNonNull(protection);Objects.requireNonNull(clock);}
        /** Borrowed credential; the caller that loaded it retains responsibility for closing it. */
        public SigningIdentity getIdentity(){return identity;}
    }
    private ArchiveSecurity() {}
    public static Manifest create(Path input,Path output,Options options)throws Exception{
        return create(input,output,"archival-master",options);
    }
    public static Manifest create(Path input,Path output,String sourceRole,Options options)throws Exception{
        return create(input,output,sourceRole,options,null);
    }
    public static Manifest create(Path input,Path output,String sourceRole,Options options,boolean c2pa)throws Exception{
        return create(input,output,sourceRole,options,null,c2pa);
    }
    static Manifest create(Path input,Path output,String sourceRole,Options options,byte[] importReceipt)throws Exception{
        return create(input,output,sourceRole,options,importReceipt,false);
    }
    static Manifest create(Path input,Path output,String sourceRole,Options options,byte[] importReceipt,boolean c2pa)throws Exception{
        return create(input,output,sourceRole,options,importReceipt,c2pa,message->{});
    }
    static Manifest create(Path input,Path output,String sourceRole,Options options,byte[] importReceipt,boolean c2pa,Consumer<String> progress)throws Exception{
        progress.accept("Checking signing setup…");
        preflight(options,c2pa);
        Path root=input.toRealPath(),destination=output.toAbsolutePath().normalize();
        Files.createDirectories(destination.getParent());destination=destination.getParent().toRealPath().resolve(destination.getFileName());
        if(destination.startsWith(root)||Files.exists(destination,LinkOption.NOFOLLOW_LINKS))throw new IOException("Secure creation requires a new output PDF outside the input set");
        Path working=Files.createTempDirectory("dicom-secure-");
        Path signed=Files.createTempFile(destination.getParent(),".dicom-secure-",".pdf");Files.delete(signed);
        Instant started=options.clock().instant();
        try{
            Path base=working.resolve("base.pdf"),prepared=working.resolve("prepared.pdf");
            Manifest manifest=DicomPdf.create(root,base,sourceRole,PackageLimits.ATTACHMENTS,PackageLimits.DOCUMENT,
                data->{if(options.getIdentity().isCredentialSha256(data.digest().sha256()))throw new IOException("Signing credential material must not be supplied as archival input");},importReceipt,c2pa,true,progress);
            progress.accept("Checking preserved originals, metadata and PDF/A before signing…");
            var verifiedLengths=new HashMap<String,Long>();
            var validation=PackageTools.verify(base,root,options.verapdf(),verifiedLengths);
            requirePreservation(validation);
            try(var document=Loader.loadPDF(base.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
                var files=files(document);
                byte[] originalManifest=bytes(files.get("manifest.json"));
                var value=JsonParser.parseString(new String(originalManifest,StandardCharsets.UTF_8)).getAsJsonObject();
                var provenance=new JsonObject();provenance.addProperty("schemaVersion",1);
                provenance.addProperty("acquisitionAuthentication","UNKNOWN");provenance.addProperty("delivery","UNKNOWN");
                var events=new JsonArray();
                var ingestion=new JsonObject();ingestion.addProperty("event","INGESTION");ingestion.addProperty("basis","CREATOR_CAPTURE_AND_EXTERNAL_BYTE_COMPARISON");
                ingestion.addProperty("startedAt",started.toString());ingestion.addProperty("completedAt",options.clock().instant().toString());ingestion.addProperty("fileCount",manifest.images().size());events.add(ingestion);
                ingestion.addProperty("inputInventorySha256",hash(ManifestEncoding.canonicalize(inputInventory(value).toString())));
                var processing=new JsonObject();processing.addProperty("event","PROCESSING");processing.addProperty("software",manifest.creator());processing.addProperty("originalsModified",false);events.add(processing);
                var checked=new JsonObject();checked.addProperty("event","VALIDATION");checked.addProperty("basis","LOCAL_EXPORT_VERIFIER");
                var validationResults=JsonParser.parseString(validation.json()).getAsJsonObject();
                for(var result:validationResults.entrySet()){
                    var item=result.getValue().getAsJsonObject();if(!item.has("status"))continue;String state=item.get("status").getAsString();
                    item.addProperty("status",state.equals("PASS")?"PASS":state.equals("FAIL")?"FAIL":"UNKNOWN");
                }
                checked.add("results",validationResults);events.add(checked);
                var request=new JsonObject();request.addProperty("event","SIGNING_REQUEST");request.addProperty("requestedAt",options.clock().instant().toString());request.addProperty("protection",options.protection().name());events.add(request);
                provenance.add("events",events);
                byte[] evidence=ManifestEncoding.canonicalize(provenance.toString());
                var security=new JsonObject();security.addProperty("schemaVersion",1);security.addProperty("protection",options.protection().name());
                security.addProperty("canonicalization","RFC8785");security.addProperty("manifestSignature","manifest.p7s");
                security.addProperty("provenance","provenance.json");security.addProperty("issuerCertificateSha256",options.getIdentity().certificateSha256());
                value.add("security",security);value.getAsJsonObject("artifactSha256").addProperty("provenance.json",hash(evidence));
                byte[] revocations=null;
                if(!options.policy().crls().isEmpty()||!options.policy().ocsps().isEmpty()){
                    var crls=new JsonArray();for(var crl:options.policy().crls())crls.add(Base64.getEncoder().encodeToString(crl.getEncoded()));
                    var payload=new JsonObject();payload.addProperty("schemaVersion",1);payload.add("crls",crls);
                    if(!options.policy().ocsps().isEmpty()){
                        var ocsps=new JsonArray();for(byte[] ocsp:options.policy().ocsps())ocsps.add(Base64.getEncoder().encodeToString(ocsp));payload.add("ocsps",ocsps);
                    }
                    revocations=ManifestEncoding.canonicalize(payload.toString());value.getAsJsonObject("artifactSha256").addProperty("revocation.json",hash(revocations));
                }
                byte[] securedManifest=ManifestEncoding.canonicalize(value.toString());
                replace(document,files.get("manifest.json"),securedManifest,"application/json");
                byte[] manifestChecksum=(hash(securedManifest)+"  manifest.json\n").getBytes(StandardCharsets.US_ASCII);
                replace(document,files.get("manifest.sha256"),manifestChecksum,"text/plain");
                var attachments=new Attachments(document);
                attachments.add("provenance.json",evidence,"application/json","Supplement","Observed export events; acquisition and delivery remain unknown");
                if(revocations!=null)attachments.add("revocation.json",revocations,"application/json","Supplement","Local signed revocation evidence; not trusted without issuer/path validation");
                progress.accept(options.timestampClient()==null?"Signing the archive inventory…":"Signing the archive inventory and obtaining its trusted timestamp…");
                byte[] cms=CmsSigning.sign(new ByteArrayInputStream(securedManifest),options.getIdentity(),options.clock().instant(),options.timestampClient());
                PdfValidationStore.retain(document,PdfValidationStore.cmsCertificates(cms),options.policy());
                attachments.add("manifest.p7s",cms,"application/pkcs7-signature","Data","Detached CMS over exact canonical manifest bytes; public certificates only");
                // Attachments.finish replaces the name tree; re-add existing specifications intact.
                var names=new TreeMap<String,PDComplexFileSpecification>(files);
                attachments.finish();names.putAll(document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames());
                document.getDocumentCatalog().getNames().getEmbeddedFiles().setNames(names);
                var associated=new COSArray();for(var specification:names.values())associated.add(specification);
                document.getDocumentCatalog().getCOSObject().setItem(COSName.getPDFName("AF"),associated);
                verifiedLengths.put("manifest.json",(long)securedManifest.length);
                verifiedLengths.put("manifest.sha256",(long)manifestChecksum.length);
                verifiedLengths.put("provenance.json",(long)evidence.length);
                verifiedLengths.put("manifest.p7s",(long)cms.length);
                if(revocations!=null)verifiedLengths.put("revocation.json",(long)revocations.length);
                if(c2pa)verifiedLengths.put(ArchiveC2pa.FILE,(long)ArchiveC2pa.CAPACITY);
                long total=0;
                for(String name:names.keySet()){
                    Long length=verifiedLengths.get(name);
                    if(length==null)throw new IOException("Missing verified length for "+name);
                    total=PackageLimits.reserve(total,length);
                }
                PdfMetadata.applyStream(document,new String(securedManifest,StandardCharsets.UTF_8),PackageTools.content(files.get("dicom-metadata.json")));
                if(c2pa)ArchiveC2pa.reserve(document);
                try(OutputStream stream=PackageLimits.documentOutput(Files.newOutputStream(prepared),PackageLimits.DOCUMENT)){document.save(stream);}
            }
            PdfSecurity.sign(prepared,signed,PdfSecurity.Protection.valueOf(options.protection().name()),
                new PdfSecurity.Options(options.getIdentity(),options.policy(),options.timestampClient(),options.clock(),c2pa?ArchiveC2pa.FORMAT:null),progress);
            progress.accept("Running final independent signature, timestamp and archive checks…");
            // Setup may precede the timestamps by minutes or hours on a large input.
            // Creation checks use the completion clock; explicit verify() calls retain their reference time.
            var verified=verify(signed,root,options.policy().withTime(options.clock().instant()),options.verapdf(),options.protection());
            // The final security report includes the complete preservation verification.
            // Require explicit PASS here instead of re-reading and re-rendering the same PDF twice.
            for (String name : List.of("pdfa4f", "originalBytes", "inventoryReconciliation", "metadataAgreement")) {
                var check = verified.checks().get(name);
                if (check == null || check.status() != PASS)
                    throw new IOException("Final preservation check failed: " + name + " "
                            + (check == null ? "missing from the verification report" : check.status() + " (" + check.code() + ")"));
            }
            if(options.protection()==Protection.PADES_B_LTA&&(!"EXPORT_AUTHENTICATED".equals(verified.assurance())||verified.checks().get("padesBLta").status()!=PASS))
                throw new IOException("Requested PAdES B-LTA protection was not fully verified; no output published or downgrade");
            var failures=verified.checks().entrySet().stream().filter(e->!Set.of("source.dicomInputSubset","source.dicomStructure").contains(e.getKey())&&e.getValue().status()==FAIL).map(e->e.getKey()+"="+e.getValue().code()).toList();
            if(!failures.isEmpty())throw new IOException("Signed archive failed independent security checks; output was not published: "+String.join(", ",failures));
            // Explicit trust/revocation failures abort. Missing trust is reported UNKNOWN,
            // never upgraded to authenticated acquisition or an LTA claim.
            progress.accept("All required checks passed; saving the completed archive…");
            Files.createLink(destination,signed);return manifest;
        }finally{
            Files.deleteIfExists(signed);
            try(var walk=Files.walk(working)){for(Path path:walk.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}
        }
    }
    /** Local setup checks only: no input conversion, output creation or TSA request. */
    public static void preflight(Options options,boolean c2pa)throws Exception{
        var issues=new ArrayList<String>();
        boolean timestampRequired=options.protection()!=Protection.CMS_AND_PDF;
        boolean timestampConfigured=options.timestampClient()!=null;
        if(timestampRequired!=timestampConfigured)issues.add("Timestamped protection requires an explicit timestamp client; no downgrade was performed");
        if(options.protection()==Protection.PADES_B_LTA&&options.policy().anchors().isEmpty())issues.add("PAdES B-LTA requires explicit institutional and TSA trust anchors");
        if(options.verapdf()==null||options.verapdf().isBlank())issues.add("Secure publication requires an explicit PDF/A-4f validator");
        try{options.getIdentity().check(options.clock().instant());}catch(java.security.GeneralSecurityException failure){issues.add("Archive signing certificate: "+failure.getMessage());}
        if(c2pa)issues.addAll(ArchiveC2pa.signingProfileIssues(options.getIdentity().certificates().getFirst()));
        var checks=options.policy().withTime(options.clock().instant()).check(options.getIdentity().certificates().getFirst(),options.getIdentity().certificates());
        if(checks.get("certificateTrust").status()==FAIL)issues.add("Archive signer trust: certificate chain is not trusted by trustCertificates; configure its independently trusted issuer CA as well as the TSA root");
        if(checks.get("revocation").status()==FAIL)issues.add("Archive signer revocation: "+checks.get("revocation").code());
        if(options.protection()==Protection.PADES_B_LTA&&checks.get("revocation").status()==UNKNOWN)issues.add("Archive signer revocation: fresh issuer CRL/OCSP evidence is required for B-LTA");
        if(!issues.isEmpty())throw new IOException("Signing setup failed before creation:\n - "+String.join("\n - ",issues));
    }
    private static void requirePreservation(PackageTools.Verification validation) throws IOException {
        var checks = List.of(Map.entry("PDF/A-4f", validation.pdfa4f()),
                Map.entry("Embedded originals", validation.sourceBytes()),
                Map.entry("External sources", validation.externalSources()),
                Map.entry("Metadata accuracy", validation.metadataAccuracy()));
        var failures = new ArrayList<String>();
        for (var entry : checks) {
            var check = entry.getValue();
            if (!check.status().equals("PASS")) {
                var reason = check.details().isEmpty() ? "" : " — " + check.details().getFirst();
                failures.add(entry.getKey() + " " + check.status() + reason);
            }
        }
        if (!failures.isEmpty())
            throw new IOException("Preservation checks must pass before publication:\n - " + String.join("\n - ", failures));
    }
    public static SecurityReport verify(Path pdf,Path sources,CertificatePolicy policy,String verapdf,Protection required){
        var checks=new LinkedHashMap<String,SecurityReport.Check>();
        checks.put("clinicalCompleteness",new SecurityReport.Check(UNKNOWN,"CLINICAL_COMPLETENESS_NOT_ASSESSED"));
        checks.put("acquisitionProvenance",new SecurityReport.Check(UNKNOWN,"NO_AUTHENTICATED_ACQUISITION_EVIDENCE"));
        checks.put("deliveryProvenance",new SecurityReport.Check(UNKNOWN,"DELIVERY_NOT_OBSERVED"));
        try{
            var base=PackageTools.verify(pdf,sources,verapdf);
            checks.putAll(base.c2pa());
            for(var entry:Map.of("originalBytes",base.sourceBytes(),"inventoryReconciliation",base.externalSources(),"metadataAgreement",base.metadataAccuracy(),"pdfa4f",base.pdfa4f()).entrySet())
                checks.put(entry.getKey(),new SecurityReport.Check("PASS".equals(entry.getValue().status())?PASS:"FAIL".equals(entry.getValue().status())?FAIL:UNKNOWN,"INDEPENDENT_"+entry.getKey().toUpperCase(Locale.ROOT)));
            checks.put("source.dicomInputSubset",new SecurityReport.Check("PASS".equals(base.dicomInputConformance().status())?PASS:"FAIL".equals(base.dicomInputConformance().status())?FAIL:UNKNOWN,"DOCUMENTED_SUBSET_NOT_FULL_IOD_VALIDATION"));
            checks.put("source.dicomStructure",new SecurityReport.Check("PASS".equals(base.dicomStructure().status())?PASS:"FAIL".equals(base.dicomStructure().status())?FAIL:UNKNOWN,"NATIVE_PAYLOAD_AND_SELECTED_LIBRARY_RULES_NOT_FULL_IOD_VALIDATION"));
            checks.put("referenceCoverage",new SecurityReport.Check("PASS".equals(base.unresolvedReferences().status())?PASS:"FAIL".equals(base.unresolvedReferences().status())?FAIL:UNKNOWN,"EXPLICIT_REFERENCES_NOT_CLINICAL_COMPLETENESS"));
            try(var document=Loader.loadPDF(pdf.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
                var files=files(document);byte[] manifest=bytes(files.get("manifest.json"));
                if(!Arrays.equals(manifest,ManifestEncoding.canonicalize(new String(manifest,StandardCharsets.UTF_8))))throw new IOException("Signed manifest is not canonical");
                var value=JsonParser.parseString(new String(manifest,StandardCharsets.UTF_8)).getAsJsonObject();
                var security=value.getAsJsonObject("security");
                if(security==null||security.get("schemaVersion").getAsInt()!=1||!"RFC8785".equals(security.get("canonicalization").getAsString())||!"manifest.p7s".equals(security.get("manifestSignature").getAsString()))throw new IOException("Security declaration missing or unsupported");
                var declared=Protection.valueOf(security.get("protection").getAsString());
                String issuer=security.get("issuerCertificateSha256").getAsString();
                var provenance=JsonParser.parseString(new String(bytes(files.get("provenance.json")),StandardCharsets.UTF_8)).getAsJsonObject();
                var receipt=provenance.getAsJsonArray("events").get(0).getAsJsonObject();
                boolean reconciled="INGESTION".equals(receipt.get("event").getAsString())&&receipt.get("fileCount").getAsInt()==value.getAsJsonArray("images").size()
                    &&hash(ManifestEncoding.canonicalize(inputInventory(value).toString())).equals(receipt.get("inputInventorySha256").getAsString());
                checks.put("capturedInventory",new SecurityReport.Check(reconciled?PASS:FAIL,reconciled?"CAPTURED_SET_MATCHES_SIGNED_MANIFEST":"CAPTURED_SET_RECEIPT_MISMATCH"));
                var localCrls=new ArrayList<java.security.cert.X509CRL>(policy.crls());
                var localOcsps=new ArrayList<byte[]>(policy.ocsps());
                if(files.containsKey("revocation.json")){
                    var retained=JsonParser.parseString(new String(bytes(files.get("revocation.json")),StandardCharsets.UTF_8)).getAsJsonObject();
                    if(retained.get("schemaVersion").getAsInt()!=1)throw new IOException("Unsupported revocation evidence schema");
                    var factory=java.security.cert.CertificateFactory.getInstance("X.509");
                    for(var encoded:retained.getAsJsonArray("crls"))localCrls.add((java.security.cert.X509CRL)factory.generateCRL(new ByteArrayInputStream(Base64.getDecoder().decode(encoded.getAsString()))));
                    if(retained.has("ocsps"))for(var encoded:retained.getAsJsonArray("ocsps"))localOcsps.add(Base64.getDecoder().decode(encoded.getAsString()));
                }
                var effectivePolicy=new CertificatePolicy(policy.anchors(),localCrls,policy.at(),localOcsps,policy.supportingCertificates());
                try{
                    var dss=PdfValidationStore.read(document);if(dss!=null)effectivePolicy=dss.augment(effectivePolicy);
                }catch(Exception invalid){checks.put("pdf.validationStore",new SecurityReport.Check(FAIL,"MALFORMED_OR_UNSUPPORTED_PDF_DSS"));}
                checks.put("manifestCanonicalization",new SecurityReport.Check(PASS,"RFC8785_CANONICAL_BYTES"));
                var manifestPolicy=effectivePolicy;
                if(declared==Protection.PADES_B_LTA||required==Protection.PADES_B_LTA){
                    var pades=DssPades.verify(pdf,effectivePolicy,issuer,ArchiveC2pa.FORMAT);
                    for(var entry:pades.checks().entrySet())checks.put("pdf."+entry.getKey(),entry.getValue());
                    checks.put("padesBLta",new SecurityReport.Check(pades.valid()&&pades.lta()?PASS:pades.checks().values().stream().anyMatch(c->c.status()==FAIL)?FAIL:UNKNOWN,"EU_DSS_BASELINE_LTA_AND_ARCHIVE_CHANGE_POLICY"));
                    // Only library-validated historical evidence permits evaluating the
                    // manifest signer at the export's independently established time.
                    if(pades.valid()&&pades.bestSignatureTime()!=null)manifestPolicy=new CertificatePolicy(effectivePolicy.anchors(),effectivePolicy.crls(),pades.bestSignatureTime(),effectivePolicy.ocsps(),effectivePolicy.supportingCertificates());
                }else{
                    for(var entry:PdfCmsVerification.verify(pdf,effectivePolicy,issuer).entrySet())checks.put("pdf."+entry.getKey(),entry.getValue());
                    checks.put("padesBLta",new SecurityReport.Check(NOT_APPLICABLE,"CMS_AND_PDF_REQUESTED_NO_LTA_CLAIM"));
                }
                for(var entry:CmsVerification.verify(new ByteArrayInputStream(manifest),bytes(files.get("manifest.p7s")),manifestPolicy,issuer).entrySet())checks.put("manifest."+entry.getKey(),entry.getValue());
                var timestamps=Arrays.asList(checks.get("manifest.timestamp"),checks.get("pdf.timestamp"));
                var timestampStatus=timestamps.stream().anyMatch(c->c!=null&&c.status()==FAIL)?FAIL:timestamps.stream().allMatch(c->c!=null&&c.status()==PASS)?PASS:UNKNOWN;
                checks.put("trustedTimestamp",new SecurityReport.Check(timestampStatus,"SEE_MANIFEST_AND_PDF_RFC3161_RESULTS"));
                if(declared!=Protection.CMS_AND_PDF||required!=Protection.CMS_AND_PDF){
                    boolean level=(required!=Protection.PADES_B_LTA||declared==Protection.PADES_B_LTA)&&
                        (declared!=Protection.PADES_B_LTA||checks.get("padesBLta").status()==PASS);
                    checks.put("requestedProtection",new SecurityReport.Check(level&&declared!=Protection.CMS_AND_PDF&&timestampStatus==PASS?PASS:FAIL,"REQUESTED_LEVEL_AND_BOTH_VERIFIED_TIMESTAMPS_REQUIRED"));
                }
                boolean sourceSignature=false;
                for(var image:value.getAsJsonArray("images")){
                    var source=image.getAsJsonObject();
                    try(var input=new org.dcm4che3.io.DicomInputStream(PackageTools.content(files.get(source.get("attachment").getAsString())).open())){
                        input.setIncludeBulkData(org.dcm4che3.io.DicomInputStream.IncludeBulkData.NO);
                        if(hasSignature(input.readDataset(-1,-1),0,new int[]{0}))sourceSignature=true;
                    }catch(Exception unreadable){checks.put("sourceSignatureCoverage",new SecurityReport.Check(UNKNOWN,"UNREADABLE_SOURCE_SIGNATURE_COVERAGE"));}
                }
                checks.put("dicomSignatures",new SecurityReport.Check(sourceSignature?UNKNOWN:checks.containsKey("sourceSignatureCoverage")?UNKNOWN:NOT_APPLICABLE,
                    sourceSignature?"DICOM_PS3_15_SIGNATURES_PRESERVED_NOT_VERIFIED":"NO_SUPPORTED_AUTHENTICATED_DICOM_SIGNATURE_EVIDENCE"));
            }
        }catch(Exception failure){checks.put("securityStructure",new SecurityReport.Check(FAIL,"MISSING_INVALID_OR_UNSUPPORTED_SECURITY_EVIDENCE"));}
        boolean authenticated=List.of("manifest.cryptographicSignature","manifest.certificateTrust","manifest.certificateValidity","manifest.keyPolicy","manifest.revocation",
            "pdf.coverage","pdf.cryptographicSignature","pdf.certificateTrust","pdf.certificateValidity","pdf.keyPolicy","pdf.revocation","originalBytes","capturedInventory")
            .stream().allMatch(name->checks.containsKey(name)&&(checks.get(name).status()==PASS||name.endsWith(".revocation")&&checks.get(name).status()==NOT_APPLICABLE));
        return new SecurityReport(1,authenticated?"EXPORT_AUTHENTICATED":"INTEGRITY_ONLY",policy.at().toString(),"VERIFIER_REFERENCE_TIME_NOT_A_TRUSTED_TIMESTAMP",checks);
    }
    private static boolean hasSignature(org.dcm4che3.data.Attributes dataset,int depth,int[] count)throws IOException{
        if(depth>64)throw new IOException("Signature scan depth limit");
        for(int tag:dataset.tags()){
            if(++count[0]>200000)throw new IOException("Signature scan element limit");
            if(tag==org.dcm4che3.data.Tag.DigitalSignaturesSequence)return true;
            if(dataset.getVR(tag)==org.dcm4che3.data.VR.SQ)for(var item:dataset.getSequence(tag))if(hasSignature(item,depth+1,count))return true;
        }return false;
    }
    private static String hash(byte[] data)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));}
    private static JsonArray inputInventory(JsonObject manifest){
        var result=new JsonArray();for(var value:manifest.getAsJsonArray("images")){
            var source=value.getAsJsonObject();var entry=new JsonObject();
            for(String key:List.of("attachment","sourcePath","size","sha256"))entry.add(key,source.get(key));result.add(entry);
        }return result;
    }
    private static byte[] bytes(PDComplexFileSpecification file)throws Exception{
        if(file==null)throw new IOException("Required security attachment missing");
        var embedded=file.getEmbeddedFileUnicode()!=null?file.getEmbeddedFileUnicode():file.getEmbeddedFile();
        if(embedded==null)throw new IOException("Required embedded content missing");
        return new SourceContent(()->PdfStreams.open(embedded)).array();
    }
    private static void replace(PDDocument doc,PDComplexFileSpecification file,byte[] data,String mime)throws IOException{
        var embedded=new PDEmbeddedFile(doc,new ByteArrayInputStream(data));embedded.setSubtype(mime);embedded.setSize(data.length);
        file.setEmbeddedFile(embedded);file.setEmbeddedFileUnicode(embedded);
    }
    private static Map<String,PDComplexFileSpecification> files(PDDocument doc)throws IOException{
        var result=new TreeMap<String,PDComplexFileSpecification>();
        if(doc.getDocumentCatalog().getNames()==null)throw new IOException("Attachment tree missing");
        collect(doc.getDocumentCatalog().getNames().getEmbeddedFiles(),result,Collections.newSetFromMap(new IdentityHashMap<>()));return result;
    }
    private static void collect(org.apache.pdfbox.pdmodel.PDEmbeddedFilesNameTreeNode node,Map<String,PDComplexFileSpecification> result,Set<COSDictionary> visited)throws IOException{
        if(node==null||!visited.add(node.getCOSObject()))throw new IOException("Invalid attachment tree");
        if(node.getNames()!=null)for(var entry:node.getNames().entrySet())if(result.put(entry.getKey(),entry.getValue())!=null)throw new IOException("Duplicate attachment name");
        if(node.getKids()!=null)for(var kid:node.getKids())collect((org.apache.pdfbox.pdmodel.PDEmbeddedFilesNameTreeNode)kid,result,visited);
    }
}
