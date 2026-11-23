package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.time.Instant;
import java.util.*;
import eu.europa.esig.dss.enumerations.*;
import eu.europa.esig.dss.model.*;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.pades.*;
import eu.europa.esig.dss.pades.signature.PAdESService;
import eu.europa.esig.dss.pades.validation.PDFDocumentValidator;
import eu.europa.esig.dss.pdf.pdfbox.PdfBoxNativeObjectFactory;
import eu.europa.esig.dss.pdf.pdfbox.PdfBoxDocumentReader;
import eu.europa.esig.dss.pdf.modifications.DefaultPdfObjectModificationsFinder;
import eu.europa.esig.dss.spi.client.http.IgnoreDataLoader;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.spi.x509.CommonTrustedCertificateSource;
import eu.europa.esig.dss.spi.x509.aia.DefaultAIASource;
import eu.europa.esig.dss.spi.x509.revocation.crl.ExternalResourcesCRLSource;
import eu.europa.esig.dss.spi.x509.revocation.ocsp.ExternalResourcesOCSPSource;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** EU DSS owns PAdES augmentation, timestamp validation and PDF change analysis. */
public final class DssPades {
    private DssPades(){}
    public record Result(Map<String,SecurityReport.Check> checks,Instant bestSignatureTime,boolean lta){
        public Result{checks=Collections.unmodifiableMap(new LinkedHashMap<>(checks));}
        public boolean valid(){return checks.get("padesValidation")!=null&&checks.get("padesValidation").status()==PASS&&checks.values().stream().allMatch(c->c.status()==PASS||c.status()==NOT_APPLICABLE);}
    }
    private static FileDocument document(Path path){var result=new FileDocument(path.toFile());result.setName("archive.pdf");return result;}
    private static CommonCertificateVerifier verifier(CertificatePolicy policy)throws Exception{
        var result=new CommonCertificateVerifier();var trusted=new CommonTrustedCertificateSource();
        for(var anchor:policy.allTimestampAnchors()){
            if(anchor.getTrustedCert()==null)throw new IOException("EU DSS requires explicit X.509 trust-anchor certificates");
            trusted.addCertificate(new CertificateToken(anchor.getTrustedCert()));
        }
        result.setTrustedCertSources(trusted);result.setAIASource(new DefaultAIASource(new IgnoreDataLoader()));
        var supporting=new eu.europa.esig.dss.spi.x509.CommonCertificateSource();
        for(var certificate:policy.supportingCertificates())supporting.addCertificate(new CertificateToken(certificate));
        result.setAdjunctCertSources(supporting);
        result.setCrlSource(new ExternalResourcesCRLSource(policy.crls().stream().map(crl->{try{return new InMemoryDocument(crl.getEncoded());}catch(CRLException failure){throw new DSSException("Invalid CRL evidence",failure);}}).toArray(DSSDocument[]::new)));
        result.setOcspSource(new ExternalResourcesOCSPSource(policy.ocsps().stream().map(InMemoryDocument::new).toArray(DSSDocument[]::new)));
        return result;
    }
    private static PdfBoxNativeObjectFactory pdfFactory(){
        var result=new StreamingPdfBoxFactory();result.setPdfMemoryUsageSetting(eu.europa.esig.dss.pdf.PdfMemoryUsageSetting.fileOnly());return result;
    }
    private static PdfBoxNativeObjectFactory pdfFactory(byte[] validatedC2pa,C2paProfile profile){
        var result=pdfFactory();
        if(validatedC2pa!=null)result.setPdfObjectModificationsFinder(new DefaultPdfObjectModificationsFinder(){
            @Override public eu.europa.esig.dss.pdf.modifications.PdfObjectModifications find(eu.europa.esig.dss.pdf.PdfDocumentReader before,eu.europa.esig.dss.pdf.PdfDocumentReader after){
                try{
                    // Validation has already bound this exact current stream to the whole PDF.
                    // Normalize its payload only; dictionaries, references, pages and all other
                    // attachments continue through DSS's ordinary modification analysis.
                    C2pa.normalizeForComparison(((PdfBoxDocumentReader)before).getPDDocument(),((PdfBoxDocumentReader)after).getPDDocument(),profile);
                }catch(IOException failure){throw new DSSException("Invalid C2PA archival update",failure);}
                return super.find(before,after);
            }
        });
        return result;
    }
    public static void extend(Path input,Path output,CertificatePolicy policy,Rfc3161Client timestamp)throws Exception{
        extend(input,output,policy,timestamp,null);
    }
    public static void extend(Path input,Path output,CertificatePolicy policy,Rfc3161Client timestamp,C2paProfile profile)throws Exception{
        if(timestamp==null||policy.anchors().isEmpty())throw new IOException("PAdES B-LTA requires a configured TSA and explicit trust anchors; no downgrade");
        if(Files.exists(output,LinkOption.NOFOLLOW_LINKS)||input.toAbsolutePath().normalize().equals(output.toAbsolutePath().normalize()))throw new IOException("PAdES extension requires a new output PDF");
        var resources=new eu.europa.esig.dss.signature.resources.TempFileResourcesHandlerBuilder();
        boolean created=false;
        try{
            byte[] c2pa=profile==null?null:C2pa.validatedStore(input,profile);
            var effective=retainedPolicy(input,policy);var service=new PAdESService(verifier(effective));var factory=pdfFactory(c2pa,profile);factory.setResourcesHandlerBuilder(resources);service.setPdfObjFactory(factory);
            service.setTspSource((algorithm,digest)->{
                if(algorithm!=DigestAlgorithm.SHA256)throw new DSSException("Only configured SHA-256 timestamps are supported");
                try{return new TimestampBinary(timestamp.timestampDigest(digest));}catch(Exception failure){throw new DSSException("Timestamp acquisition failed; no downgrade",failure);}
            });
            var parameters=new PAdESSignatureParameters();parameters.setSignatureLevel(SignatureLevel.PAdES_BASELINE_LTA);parameters.setIncludeVRIDictionary(false);
            parameters.setArchiveTimestampParameters(new PAdESTimestampParameters(DigestAlgorithm.SHA256));
            parameters.setSignatureTimestampParameters(new PAdESTimestampParameters(DigestAlgorithm.SHA256));
            parameters.setContentSize(128*1024);
            var extended=service.extendDocument(document(input),parameters);
            try(var out=Files.newOutputStream(output,StandardOpenOption.CREATE_NEW);var in=extended.openStream()){
                created=true;in.transferTo(out);
            }
            var checked=verify(output,policy,null,c2pa,profile);
            if(!checked.valid()||!checked.lta())throw new IOException("EU DSS could not validate requested PAdES B-LTA: "+checked.checks());
        }catch(Exception failure){if(created)Files.deleteIfExists(output);throw new IOException("EU DSS PAdES extension failed; no output published or protection downgrade",failure);}finally{resources.clear();}
    }
    public static Result verify(Path pdf,CertificatePolicy policy,String expectedCertificate){
        return verify(pdf,policy,expectedCertificate,(C2paProfile)null);
    }
    public static Result verify(Path pdf,CertificatePolicy policy,String expectedCertificate,C2paProfile profile){
        return verify(pdf,policy,expectedCertificate,profile==null?null:C2pa.validatedStore(pdf,profile),profile);
    }

    record CredentialVerification(Result pades, Map<String, SecurityReport.Check> credentials) {}

    /** The caller owns the staged revision and keeps its bytes unchanged through both checks. */
    static CredentialVerification verifyPrivateRevision(Path revision, CertificatePolicy policy, String expectedCertificate, C2paProfile profile) {
        if (profile == null) return new CredentialVerification(verify(revision,policy,expectedCertificate,null,null),Map.of());
        var store = C2pa.verifyStore(revision,profile);
        return new CredentialVerification(verify(revision,policy,expectedCertificate,store.encoded(),profile),store.checks());
    }
    private static Result verify(Path pdf,CertificatePolicy policy,String expectedCertificate,byte[] validatedC2pa,C2paProfile profile){
        return verify(pdf,policy,expectedCertificate,validatedC2pa,profile,null);
    }

    public static Result verifyForViewer(Path pdf,CertificatePolicy policy,String expectedCertificate,C2paProfile profile,
                                         java.util.function.Consumer<String> progress){
        return verify(pdf,policy,expectedCertificate,profile==null?null:C2pa.validatedStore(pdf,profile),profile,progress);
    }

    private static Result verify(Path pdf,CertificatePolicy policy,String expectedCertificate,byte[] validatedC2pa,C2paProfile profile,
                                 java.util.function.Consumer<String> progress){
        var checks=new LinkedHashMap<String,SecurityReport.Check>();Instant best=null;boolean lta=false;
        try{
            if(validatedC2pa!=null&&!Arrays.equals(validatedC2pa,C2pa.store(pdf,profile)))throw new IOException("C2PA payload changed during DSS augmentation");
            var effective=retainedPolicy(pdf,policy);
            var validator=new PDFDocumentValidator(document(pdf));validator.setPdfObjFactory(pdfFactory(validatedC2pa,profile));validator.setCertificateVerifier(verifier(effective));validator.setValidationTime(Date.from(policy.at()));
            validator.setTokenExtractionStrategy(TokenExtractionStrategy.EXTRACT_CERTIFICATES_ONLY);
            if(progress!=null)progress.accept("Checking PDF signatures and timestamp evidence…");
            var reports=validator.validateDocument();var simple=reports.getSimpleReport();var diagnostic=reports.getDiagnosticData();
            if(simple.getSignatureIdList().size()!=1)throw new IOException("Exactly one archive export signature required");
            String id=simple.getFirstSignatureId();var signature=diagnostic.getSignatureById(id);
            boolean crypto=signature.isSignatureIntact()&&signature.isSignatureValid();
            checks.put("cryptographicSignature",new SecurityReport.Check(crypto?PASS:FAIL,"EU_DSS_PDF_CONTENT_DIGEST_AND_SIGNATURE"));
            var signing=signature.getSigningCertificate();
            if(expectedCertificate!=null){
                boolean matched=expectedCertificate.equals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(signing.getBinaries())));
                if(!matched||progress!=null)checks.put("issuerBinding",new SecurityReport.Check(matched?PASS:FAIL,matched?"PDF_SIGNER_CERTIFICATE_MATCHES_MANIFEST":"UNEXPECTED_PDF_SIGNER_CERTIFICATE"));
            }
            var indication=simple.getIndication(id);
            var status=indication==Indication.TOTAL_PASSED?PASS:indication==Indication.TOTAL_FAILED?FAIL:UNKNOWN;
            checks.put("padesValidation",new SecurityReport.Check(status,"EU_DSS_"+indication+(simple.getSubIndication(id)==null?"":"_"+simple.getSubIndication(id))));
            lta=simple.getSignatureFormat(id)==SignatureLevel.PAdES_BASELINE_LTA;
            checks.put("padesLevel",new SecurityReport.Check(lta?PASS:UNKNOWN,"EU_DSS_LEVEL_"+simple.getSignatureFormat(id)));
            if(progress!=null)progress.accept("Inspecting saved PDF revisions…");
            var revision=signature.getPDFRevision();
            boolean changes=revision!=null&&revision.isSignatureByteRangeValid()&&revision.isPdfSignatureDictionaryConsistent()
                &&signature.getPdfUndefinedChanges().isEmpty()&&signature.getPdfAnnotationChanges().isEmpty()&&signature.getPdfSignatureOrFormFillChanges().isEmpty()
                &&signature.getPdfPageDifferenceConcernedPages().isEmpty()&&signature.getPdfVisualDifferenceConcernedPages().isEmpty();
            changes&=unchangedDocumentInformation(pdf,(eu.europa.esig.dss.pades.validation.PAdESSignature)validator.getSignatureById(id));
            checks.put("allowedChanges",new SecurityReport.Check(changes?PASS:FAIL,"EU_DSS_ONLY_SECURE_PDF_EXTENSION_CHANGES_ALLOWED"));
            boolean finalCoverage=latestTimestampCoversFile(pdf);
            checks.put("coverage",new SecurityReport.Check(changes&&finalCoverage?PASS:FAIL,"EU_DSS_REVISIONS_AND_FINAL_DOCUMENT_TIMESTAMP_COVERAGE"));
            // DSS uses one trust store for the document. Report signer trust using
            // the operator's anchors when a timestamp-only root is also present.
            if(progress!=null)progress.accept("Checking offline certificate trust and revocation…");
            boolean trusted=signature.isTrustedChain()&&policy.timestampAnchors().isEmpty();
            checks.put("certificateTrust",new SecurityReport.Check(trusted?PASS:policy.anchors().isEmpty()?UNKNOWN:FAIL,"EU_DSS_EXPLICIT_OPERATOR_TRUST_CHAIN"));
            if(status==PASS&&simple.getBestSignatureTime(id)!=null)best=simple.getBestSignatureTime(id).toInstant();
            if(best!=null||!policy.timestampAnchors().isEmpty()){
                var historical=best==null?effective:effective.withTime(best);
                var factory=CertificateFactory.getInstance("X.509");var leaf=(X509Certificate)factory.generateCertificate(new ByteArrayInputStream(signing.getBinaries()));
                var chain=new ArrayList<X509Certificate>();for(var cert:signature.getCertificateChain())chain.add((X509Certificate)factory.generateCertificate(new ByteArrayInputStream(cert.getBinaries())));
                var signerChecks=historical.check(leaf,chain);
                checks.putAll(signerChecks);
                var signerTrust=signerChecks.get("certificateTrust").status();
                if(!policy.timestampAnchors().isEmpty()&&signerTrust!=PASS){
                    best=null;
                    if(status==PASS)checks.put("padesValidation",new SecurityReport.Check(signerTrust,"OPERATOR_SIGNER_TRUST_REQUIRED"));
                }
            }
            boolean timestamps=true;int ordinal=0;
            var timestampReports=new HashMap<String,Indication>();
            for(var report:simple.getSignatureTimestamps(id))timestampReports.put(report.getId(),report.getIndication());
            for(var token:signature.getTimestampList()){
                boolean math=token.isSignatureIntact()&&token.isSignatureValid()&&token.isMessageImprintDataIntact();
                var conclusion=timestampReports.get(token.getId());
                boolean valid=math&&token.isTrustedChain()&&conclusion==Indication.PASSED;timestamps&=valid;
                var tokenStatus=valid?PASS:!math||conclusion==Indication.FAILED||!token.isTrustedChain()&&!policy.allTimestampAnchors().isEmpty()?FAIL:UNKNOWN;
                checks.put("timestamp."+(++ordinal),new SecurityReport.Check(tokenStatus,"EU_DSS_"+token.getType()+"_INTEGRITY_AND_TRUST"));
                if(progress!=null){
                    var imprint=token.isMessageImprintDataIntact()?PASS:token.isMessageImprintDataFound()?FAIL:UNKNOWN;
                    checks.put("timestampImprint."+ordinal,new SecurityReport.Check(imprint,"EU_DSS_TIMESTAMP_IMPRINT"));
                    checks.put("timestampSignature."+ordinal,new SecurityReport.Check(
                            token.isSignatureIntact()&&token.isSignatureValid()?PASS:FAIL,"EU_DSS_TIMESTAMP_SIGNATURE"));
                    checks.put("timestampTrust."+ordinal,new SecurityReport.Check(
                            token.isTrustedChain()?PASS:UNKNOWN,"EU_DSS_TIMESTAMP_CERTIFICATE_PATH"));
                }
            }
            checks.put("timestamp",new SecurityReport.Check(timestamps&&ordinal>0&&status==PASS?PASS:status==FAIL?FAIL:UNKNOWN,"EU_DSS_SIGNATURE_AND_ARCHIVE_TIMESTAMP_VALIDATION"));
        }catch(Exception failure){checks.put("padesValidation",new SecurityReport.Check(FAIL,"EU_DSS_VALIDATION_FAILED"));checks.putIfAbsent("coverage",new SecurityReport.Check(FAIL,"EU_DSS_COVERAGE_NOT_VERIFIED"));}
        return new Result(checks,best,lta);
    }
    public static CertificatePolicy retainedPolicy(Path pdf,CertificatePolicy policy)throws Exception{
        try(var doc=Loader.loadPDF(pdf.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){var retained=PdfValidationStore.read(doc);return retained==null?policy:retained.augment(policy);}
    }
    private static boolean unchangedDocumentInformation(Path pdf,eu.europa.esig.dss.pades.validation.PAdESSignature signature)throws Exception{
        // DSS's normal modification analysis starts at /Root. Use its same
        // comparator for trailer /Info, which is outside that catalog tree.
        var signed=PAdESUtils.getRevisionContent(document(pdf),signature.getPdfRevision().getByteRange());
        Path revision=Files.createTempFile("pdf-security-signed-revision-",".pdf");
        try{
        try(var input=signed.openStream();var output=Files.newOutputStream(revision)){input.transferTo(output);}
        try(var original=new PdfBoxDocumentReader(document(revision),null,eu.europa.esig.dss.pdf.PdfMemoryUsageSetting.fileOnly());var current=new PdfBoxDocumentReader(document(pdf),null,eu.europa.esig.dss.pdf.PdfMemoryUsageSetting.fileOnly())){
            var before=original.createPdfDict();var after=current.createPdfDict();
            ((COSDictionary)before.getValue()).setItem(COSName.INFO,original.getPDDocument().getDocument().getTrailer().getItem(COSName.INFO));
            ((COSDictionary)after.getValue()).setItem(COSName.INFO,current.getPDDocument().getDocument().getTrailer().getItem(COSName.INFO));
            return new DefaultPdfObjectModificationsFinder().find(before,after).isEmpty();
        }
        }finally{Files.deleteIfExists(revision);}
    }
    private static boolean latestTimestampCoversFile(Path pdf)throws Exception{
        long size=Files.size(pdf),end=-1;boolean timestamp=false;
        try(var doc=Loader.loadPDF(pdf.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
            for(var signature:doc.getSignatureDictionaries()){
                var range=signature.getCOSObject().getCOSArray(COSName.BYTERANGE);if(range==null||range.size()!=4)throw new IOException("Invalid signature byte range");
                for(int i=0;i<4;i++)if(!(range.getObject(i) instanceof COSInteger))throw new IOException("Noninteger signature range");
                long offset=((COSInteger)range.getObject(2)).longValue(),length=((COSInteger)range.getObject(3)).longValue();
                if(offset<0||length<0||offset>size||length>size-offset)throw new IOException("Invalid signature range");
                long covered=offset+length;
                if(covered>end){end=covered;timestamp="ETSI.RFC3161".equals(signature.getSubFilter())&&"DocTimeStamp".equals(signature.getCOSObject().getNameAsString(COSName.TYPE));}
            }
        }
        return end==size&&timestamp;
    }
}
