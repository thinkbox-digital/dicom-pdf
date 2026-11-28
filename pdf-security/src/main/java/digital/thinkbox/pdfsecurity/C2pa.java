package digital.thinkbox.pdfsecurity;

import COSE.*;
import COSE.Attribute;
import com.upokecenter.cbor.*;

import java.io.*;
import java.math.BigInteger;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.security.spec.ECGenParameterSpec;
import java.time.*;
import java.util.*;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/**
 * Bounded C2PA 2.2 export credentials. COSE/CBOR and JCA provide signature encoding and cryptography.
 */
public final class C2pa {
    static {
        if (Security.getProvider("BC") == null) Security.addProvider(SigningIdentity.BC);
    }

    public static final int CAPACITY = 32768;
    private static final byte[] MARKER = "THINKBOX_PDF_C2PA_RESERVED_STREAM!".getBytes(StandardCharsets.US_ASCII);

    private C2pa() {
    }

    public static byte[] placeholder() {
        byte[] value = new byte[CAPACITY];
        System.arraycopy(MARKER, 0, value, 0, MARKER.length);
        return value;
    }

    public static boolean enabled(PDDocument doc,C2paProfile profile) throws IOException {
        return files(doc).containsKey(profile.credentialsFile());
    }
    public static boolean hasCredentials(PDDocument document)throws IOException{
        for(var file:files(document).values())if("C2PA_Manifest".equals(file.getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship"))))return true;
        var associated=document.getDocumentCatalog().getCOSObject().getCOSArray(COSName.getPDFName("AF"));
        if(associated!=null)for(int index=0;index<associated.size();index++){
            var value=associated.getObject(index);
            if(value instanceof COSDictionary dictionary&&"C2PA_Manifest".equals(dictionary.getNameAsString(COSName.getPDFName("AFRelationship"))))return true;
        }
        return false;
    }

    public static void reserve(PDDocument doc,C2paProfile profile) throws IOException {
        reserve(doc,MARKER,profile);
    }

    private static void reserve(PDDocument doc,byte[] marker,C2paProfile profile)throws IOException{
        var file = files(doc).get(profile.credentialsFile());
        if (file == null) throw new IOException("Missing C2PA reservation");
        try (var output = file.getEmbeddedFile().getCOSObject().createRawOutputStream()) {
            output.write(placeholder(marker));
        }
        file.getEmbeddedFile().getCOSObject().setNeedToBeUpdated(true);
    }

    static byte[] reserveRevision(PDDocument doc,C2paProfile profile)throws IOException{
        byte[] marker=("THINKBOX_PDF_C2PA_"+UUID.randomUUID()).getBytes(StandardCharsets.US_ASCII);
        reserve(doc,marker,profile);return marker;
    }

    private static byte[] placeholder(byte[] marker){
        byte[] value=new byte[CAPACITY];System.arraycopy(marker,0,value,0,marker.length);return value;
    }

    /** Only the C2PA stream payload may differ during archival augmentation. */
    static void normalizeForComparison(PDDocument original,PDDocument current,C2paProfile profile)throws IOException{
        var before=files(original).get(profile.credentialsFile());var after=files(current).get(profile.credentialsFile());
        if(before==null||after==null)throw new IOException("C2PA reservation must be present in the export revision");
        byte[] bytes=payload(before,CAPACITY);
        if(bytes.length!=CAPACITY||payload(after,CAPACITY).length!=CAPACITY)throw new IOException("Invalid C2PA stream capacity");
        try(var output=after.getEmbeddedFile().getCOSObject().createRawOutputStream()){output.write(bytes);}
    }

    public static boolean present(Path pdf,C2paProfile profile)throws IOException{
        try(var document=Loader.loadPDF(pdf.toFile())){return enabled(document,profile);}
    }

    static byte[] store(Path pdf,C2paProfile profile)throws IOException{
        try(var document=Loader.loadPDF(pdf.toFile())){
            var file=files(document).get(profile.credentialsFile());return file==null?null:payload(file,CAPACITY);
        }
    }

    static byte[] validatedStore(Path pdf,C2paProfile profile){
        return verifyStore(pdf,profile).encoded();
    }

    /**
     * Register an uncompressed fixed-size stream, so finalization changes only its payload.
     */
    public static void prepare(PDDocument document,C2paProfile profile)throws Exception{
        requireProfile(profile);
        var names=files(document);
        if(names.containsKey(profile.credentialsFile()))throw new IOException("C2PA attachment already exists");
        var existing=names.get(profile.policyFile());
        if(existing!=null){
            if(!Arrays.equals(payload(existing,1024),profile.policyBytes()))throw new IOException("C2PA policy differs from the selected profile");
        }else{
            var stream=new PDEmbeddedFile(document,new ByteArrayInputStream(profile.policyBytes()));stream.setSubtype("application/json");stream.setSize(profile.policyBytes().length);stream.setModDate(Calendar.getInstance());
            var file=new PDComplexFileSpecification();file.setFile(profile.policyFile());file.setFileUnicode(profile.policyFile());file.setEmbeddedFile(stream);file.setEmbeddedFileUnicode(stream);
            file.getCOSObject().setName(COSName.getPDFName("AFRelationship"),"Supplement");names.put(profile.policyFile(),file);
            if (!profile.associatedFilesOnly()) {
                var dictionary=new PDDocumentNameDictionary(document.getDocumentCatalog());var tree=new PDEmbeddedFilesNameTreeNode();tree.setNames(names);dictionary.setEmbeddedFiles(tree);document.getDocumentCatalog().setNames(dictionary);
            }
            associate(document, file);
        }
        attach(document,profile);
    }
    private static void requireProfile(C2paProfile profile)throws IOException{
        if(profile==null||profile.credentialsFile()==null||profile.policyFile()==null||profile.credentialsFile().isBlank()||profile.policyFile().isBlank()
            ||profile.credentialsFile().equals(profile.policyFile())||profile.policyBytes()==null||profile.policyBytes().length==0||profile.policyBytes().length>1024
            ||profile.assertionLabel()==null||!profile.assertionLabel().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")||profile.assertionLabel().startsWith("c2pa.")
            ||profile.generatorName()==null||profile.generatorName().isBlank()||profile.generatorVersion()==null||profile.generatorVersion().isBlank())
            throw new IOException("Invalid C2PA profile configuration");
    }
    static void checkPreparation(PDDocument document,C2paProfile profile)throws Exception{
        requireProfile(profile);
        var names=files(document);
        if(!names.containsKey(profile.policyFile())||!Arrays.equals(payload(names.get(profile.policyFile()),1024),profile.policyBytes()))
            throw new IOException("The prepared PDF does not match the configured C2PA policy");
        if(!names.containsKey(profile.credentialsFile())||!Arrays.equals(payload(names.get(profile.credentialsFile()),CAPACITY),placeholder()))
            throw new IOException("The configured C2PA profile requires an unfinalized reservation");
        String instance=profile.instanceId(document);
        if(instance==null||instance.isBlank())throw new IOException("Missing PDF instance identifier");
    }
    public static void attach(PDDocument doc,C2paProfile profile) throws Exception {
        requireProfile(profile);
        var names = files(doc);
        if (names.containsKey(profile.credentialsFile())) throw new IOException("C2PA attachment already exists");
        var stream = new PDEmbeddedFile(doc);
        try (var output = stream.getCOSObject().createRawOutputStream()) {
            output.write(placeholder());
        }
        stream.setSubtype("application/c2pa");
        stream.setSize(CAPACITY);
        stream.setModDate(Calendar.getInstance());
        var file = new PDComplexFileSpecification();
        file.setFile(profile.credentialsFile());
        file.setFileUnicode(profile.credentialsFile());
        file.setFileDescription("C2PA archive export provenance; signer trust is assessed separately");
        file.setEmbeddedFile(stream);
        file.setEmbeddedFileUnicode(stream);
        // CAI's PDF byte-range locator expects the EF dictionary inline.
        file.getCOSObject().getCOSDictionary(COSName.EF).setDirect(true);
        file.getCOSObject().setName(COSName.getPDFName("AFRelationship"), "C2PA_Manifest");
        file.getCOSObject().setName(COSName.SUBTYPE, "application/c2pa");
        names.put(profile.credentialsFile(), file);
        if (!profile.associatedFilesOnly()) {
            var dictionary = new PDDocumentNameDictionary(doc.getDocumentCatalog());
            var tree = new PDEmbeddedFilesNameTreeNode();
            tree.setNames(names);
            dictionary.setEmbeddedFiles(tree);
            doc.getDocumentCatalog().setNames(dictionary);
        }
        for (var entry : names.values()) associate(doc, entry);
    }

    /**
     * Finalize before publication. PDF /Contents, if reserved, is the only additional exclusion.
     */
    public static void complete(Path pdf, SigningIdentity identity, long[] signatureRange,C2paProfile profile) throws Exception {
        complete(pdf,identity,signatureRange,MARKER,profile);
    }

    static void complete(Path pdf,SigningIdentity identity,long[] signatureRange,byte[] marker,C2paProfile profile)throws Exception{
        requireProfile(profile);
        long offset = find(pdf, marker);
        List<long[]> exclusions = new ArrayList<>();
        exclusions.add(new long[]{offset, CAPACITY});
        if (signatureRange != null)
            exclusions.add(new long[]{signatureRange[1], signatureRange[2] - signatureRange[1]});
        exclusions.sort(Comparator.comparingLong(r -> r[0]));
        CBORObject profileAssertion;
        String instanceId;
        try (var doc = Loader.loadPDF(pdf.toFile())) {
            profileAssertion = profile.createAssertion(doc,identity==null);
            instanceId = profile.instanceId(doc);
        }
        try (var credential = identity == null ? localIdentity() : null) {
            PrivateKey key = identity == null ? credential.key : identity.key();
            List<X509Certificate> chain = identity == null ? credential.chain : identity.certificates();
            checkCredential(chain.getFirst());
            var assertions = new LinkedHashMap<String, byte[]>();
            CBORObject ranges = CBORObject.NewArray();
            for (long[] range : exclusions) ranges.Add(map("start", range[0], "length", range[1]));
            assertions.put("c2pa.hash.data", assertion("c2pa.hash.data", map("alg", "sha256", "hash", digest(pdf, exclusions), "pad", new byte[0], "exclusions", ranges)));
            assertions.put("c2pa.actions.v2", assertion("c2pa.actions.v2", map("actions", CBORObject.NewArray().Add(map("action", "c2pa.created", "digitalSourceType", "http://c2pa.org/digitalsourcetype/empty")))));
            assertions.put(profile.assertionLabel(), assertion(profile.assertionLabel(), profileAssertion));
            CBORObject references = CBORObject.NewArray();
            for (var entry : assertions.entrySet())
                references.Add(map("url", "self#jumbf=c2pa.assertions/" + entry.getKey(), "hash", sha256(Arrays.copyOfRange(entry.getValue(), 8, entry.getValue().length))));
            String manifestId = "urn:c2pa:" + UUID.randomUUID();
            byte[] claim = map("instanceID", instanceId, "claim_generator_info", map("name", profile.generatorName(), "version", profile.generatorVersion()), "signature", "self#jumbf=/c2pa/" + manifestId + "/c2pa.signature", "created_assertions", references, "alg", "sha256").EncodeToBytes();
            var signature = new Sign1Message(true, false);
            var alg = key instanceof java.security.interfaces.RSAKey ? AlgorithmID.RSA_PSS_256 : AlgorithmID.ECDSA_256;
            if (key instanceof java.security.interfaces.ECKey ec && ec.getParams().getOrder().bitLength() != 256)
                throw new IOException("C2PA currently requires P-256 or RSA; disable C2PA for this credential");
            signature.addAttribute(HeaderKeys.Algorithm, alg.AsCBOR(), Attribute.PROTECTED);
            CBORObject certificates = CBORObject.NewArray();
            for (var certificate : chain) certificates.Add(certificate.getEncoded());
            signature.addAttribute(CBORObject.FromObject(33), certificates, Attribute.UNPROTECTED);
            signature.SetContent(claim);
            signature.sign(new OneKey(chain.getFirst().getPublicKey(), key));
            byte[] padded = null;
            int padding = 0;
            for (int attempt = 0; attempt < 5; attempt++) {
                signature.addAttribute(CBORObject.FromObject("pad"), CBORObject.FromObject(new byte[padding]), Attribute.UNPROTECTED);
                padded = superbox("c2pa", "c2pa", superbox("c2ma", manifestId, superbox("c2as", "c2pa.assertions", assertions.values().toArray(byte[][]::new)), superbox("c2cl", "c2pa.claim.v2", box("cbor", claim)), superbox("c2cs", "c2pa.signature", box("cbor", signature.EncodeToBytes()))));
                if (padded.length == CAPACITY) break;
                padding += CAPACITY - padded.length;
                if (padding < 0) throw new IOException("C2PA evidence exceeds the reserved capacity");
            }
            if (padded.length != CAPACITY) throw new IOException("C2PA padding did not stabilize");
            try (var file = new RandomAccessFile(pdf.toFile(), "rw")) {
                file.seek(offset);
                byte[] reserved = new byte[CAPACITY];
                file.readFully(reserved);
                if (!Arrays.equals(reserved, placeholder(marker))) throw new IOException("C2PA reservation changed");
                file.seek(offset);
                file.write(padded);
            }
        }
        var checks = verifyStore(pdf,profile,null,null,offset).checks();
        if (checks.values().stream().anyMatch(c -> c.status() == SecurityReport.Status.FAIL))
            throw new IOException("C2PA final verification failed: " + checks);
    }

    public static Map<String, SecurityReport.Check> verify(Path path,C2paProfile profile) {
        return verifyStore(path,profile).checks();
    }

    public record ViewerEvidence(Map<String, SecurityReport.Check> checks, List<X509Certificate> chain, boolean localIdentity) {}

    public static ViewerEvidence verifyViewerEvidence(Path path, C2paProfile profile) {
        var chain = new ArrayList<X509Certificate>();
        boolean[] local = {false};
        var store = verifyStore(path, profile, chain, local, -1);
        return new ViewerEvidence(Map.copyOf(store.checks()), List.copyOf(chain), local[0]);
    }

    record StoreVerification(Map<String, SecurityReport.Check> checks, byte[] encoded) {}

    static StoreVerification verifyStore(Path path, C2paProfile profile) {
        return verifyStore(path, profile, null, null, -1);
    }

    private static StoreVerification verifyStore(Path path, C2paProfile profile,
                                                 List<X509Certificate> viewerChain, boolean[] viewerLocalIdentity,
                                                 long reservationOffset) {
        var result = new LinkedHashMap<String, SecurityReport.Check>();
        try (var doc = Loader.loadPDF(path.toFile())) {
            requireProfile(profile);
            var attachments = files(doc);
            boolean declared = attachments.containsKey(profile.policyFile());
            if (!attachments.containsKey(profile.credentialsFile())) {
                result.put("c2pa.presence", check(declared ? "FAIL" : "NOT_APPLICABLE", declared ? "MISSING_C2PA" : "NO_C2PA"));
                return new StoreVerification(result,null);
            }
            if (!declared || !Arrays.equals(profile.policyBytes(), payload(attachments.get(profile.policyFile()), 1024)))
                throw new IOException("C2PA policy missing or unsupported");
            var specification = attachments.get(profile.credentialsFile());
            if (!"C2PA_Manifest".equals(specification.getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship"))))
                throw new IOException("Wrong C2PA relationship");
            byte[] encoded = payload(specification, CAPACITY);
            var root = parse(encoded, 0, encoded.length, 0);
            if (!root.label.equals("c2pa") || !root.uuid.equals("c2pa") || root.end != encoded.length || root.children.size() != 1) throw new IOException("Not a supported manifest store");
            var manifest = root.children.stream().filter(b -> b.uuid.equals("c2ma")).toList();
            if (manifest.size() != 1) throw new IOException("Unsupported C2PA manifest count");
            var active = manifest.getFirst();
            var claimBox = active.child("c2pa.claim.v2");
            byte[] claimBytes = claimBox.content;
            var claim = CBORObject.DecodeFromBytes(claimBytes);
            var assertions = active.child("c2pa.assertions");
            if (!claimBox.uuid.equals("c2cl") || !assertions.uuid.equals("c2as") || !active.child("c2pa.signature").uuid.equals("c2cs")) throw new IOException("Invalid C2PA content types");
            if (!("self#jumbf=/c2pa/" + active.label + "/c2pa.signature").equals(claim.get("signature").AsString()) || !profile.instanceId(doc).equals(claim.get("instanceID").AsString()))
                throw new IOException("C2PA signature/instance identifier mismatch");
            if (!"sha256".equals(claim.get("alg").AsString())) throw new IOException("Unsupported C2PA hash");
            Set<String> claimed = new HashSet<>();
            for (var reference : claim.get("created_assertions").getValues()) {
                String url = reference.get("url").AsString(), prefix = "self#jumbf=c2pa.assertions/";
                if (!url.startsWith(prefix) || !claimed.add(url))
                    throw new IOException("Invalid C2PA assertion reference");
                var assertion = assertions.child(url.substring(prefix.length()));
                if (!MessageDigest.isEqual(reference.get("hash").GetByteString(), sha256(Arrays.copyOfRange(encoded, assertion.start + 8, assertion.end))))
                    throw new IOException("C2PA assertion hash mismatch");
            }
            if (!claimed.equals(Set.of("self#jumbf=c2pa.assertions/" + profile.assertionLabel(), "self#jumbf=c2pa.assertions/c2pa.hash.data", "self#jumbf=c2pa.assertions/c2pa.actions.v2")) || assertions.children.size() != 3)
                throw new IOException("Unsupported archive assertions");
            var archive = CBORObject.DecodeFromBytes(assertions.child(profile.assertionLabel()).content);
            profile.verifyAssertion(doc,archive);
            var signatureObject = CBORObject.DecodeFromBytes(active.child("c2pa.signature").content);
            if (!signatureObject.get(2).isNull()) throw new IOException("C2PA requires a detached claim signature");
            var protectedHeaders = CBORObject.DecodeFromBytes(signatureObject.get(0).GetByteString());
            int algorithm = protectedHeaders.get(CBORObject.FromObject(1)).AsInt32();
            if (algorithm != -7 && algorithm != -37) throw new IOException("Unsupported C2PA signing algorithm");
            var cose = (Sign1Message) Message.DecodeFromBytes(active.child("c2pa.signature").content);
            CBORObject certs = cose.findAttribute(CBORObject.FromObject(33));
            var factory = CertificateFactory.getInstance("X.509");
            var certificate = (X509Certificate) factory.generateCertificate(new ByteArrayInputStream(certs.get(0).GetByteString()));
            checkCredential(certificate);
            cose.SetContent(claimBytes);
            if (!cose.validate(new OneKey(certificate.getPublicKey(), null)))
                throw new IOException("C2PA claim signature mismatch");
            result.put("c2pa.signature", check("PASS", "COSE_CLAIM_SIGNATURE_VALID"));
            var data = CBORObject.DecodeFromBytes(assertions.child("c2pa.hash.data").content);
            List<long[]> exclusions = new ArrayList<>();
            for (var range : data.get("exclusions").getValues())
                exclusions.add(new long[]{range.get("start").AsInt64(), range.get("length").AsInt64()});
            // Never accept arbitrary exclusions that could hide changes to pages or originals.
            // Finalization already located the unique reservation in this file before filling it.
            // Bind the independently parsed attachment to those on-disk bytes before using its span.
            long storeOffset = reservationOffset;
            if(storeOffset<0)storeOffset=find(path,encoded);
            else try(var file=new RandomAccessFile(path.toFile(),"r")){
                file.seek(storeOffset);
                byte[] stored=new byte[encoded.length];
                file.readFully(stored);
                if(!Arrays.equals(encoded,stored))throw new IOException("C2PA attachment differs from the finalized reservation");
            }
            List<long[]> expected = new ArrayList<>();
            expected.add(new long[]{storeOffset, encoded.length});
            var signatures=doc.getSignatureDictionaries();
            long revisionStart=signatures.size()>1?PdfRevisions.latestRevisionStart(doc,Files.size(path)):0;
            // Earlier signature values are finalized and included in the C2PA hash.
            // Only the signature/timestamp in this manifest's revision is excluded.
            var latest=signatures.stream().max(Comparator.comparingLong(s->{try{var range=signatureRange(s);return Math.addExact(range[2],range[3]);}catch(Exception e){throw new IllegalArgumentException(e);}}));
            for (var signature : latest.stream().toList()) {
                long[] range = signatureRange(signature);
                long gap = range[2] - range[1];
                if (range[0] != 0 || range[1] <= 0 || range[2] <= range[1] || range[3] < 0 || range[2] > Files.size(path) || range[3] != Files.size(path) - range[2] || gap > 2L * 1024 * 1024 + 2)
                    throw new IOException("Unsupported signed PDF revision");
                try (var file = new RandomAccessFile(path.toFile(), "r")) {
                    byte[] excluded = new byte[(int) gap];
                    file.seek(range[1]);
                    file.readFully(excluded);
                    if (excluded[0] != '<' || excluded[excluded.length - 1] != '>')
                        throw new IOException("Unsupported PDF signature encoding");
                    byte[] contents = HexFormat.of().parseHex(new String(excluded, 1, excluded.length - 2, StandardCharsets.US_ASCII));
                    if (!Arrays.equals(contents, signature.getContents()))
                        throw new IOException("C2PA exclusion does not bind PDF signature contents");
                }
                expected.add(new long[]{range[1], gap});
            }
            if(signatures.size()>1){
                if(storeOffset<revisionStart)throw new IOException("C2PA must be finalized in the latest timestamp revision");
            }
            expected.sort(Comparator.comparingLong(r -> r[0]));
            if (expected.size() != exclusions.size()) throw new IOException("Unexpected C2PA exclusions");
            for (int i = 0; i < expected.size(); i++)
                if (!Arrays.equals(expected.get(i), exclusions.get(i)))
                    throw new IOException("Unsafe C2PA exclusion range");
            if (!MessageDigest.isEqual(data.get("hash").GetByteString(), digest(path, exclusions)))
                throw new IOException("C2PA content hash mismatch");
            result.put("c2pa.binding", check("PASS", "PDF_AND_ARCHIVE_MANIFEST_BOUND"));
            result.put("c2pa.trust", check("UNKNOWN", "SIGNER_REQUIRES_EXTERNAL_C2PA_TRUST_POLICY"));
            result.put("c2pa.timestamp", check("UNKNOWN", "NO_C2PA_TRUSTED_TIMESTAMP"));
            if (viewerChain != null && certs.size() <= 16) {
                var chain = new ArrayList<X509Certificate>();
                chain.add(certificate);
                for (int i = 1; i < certs.size(); i++) {
                    try {
                        chain.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(certs.get(i).GetByteString())));
                    } catch (Exception ignored) {
                        // An unreadable supporting certificate cannot participate in a trust path.
                    }
                }
                viewerChain.addAll(chain);
                var identity = archive.get("identity");
                viewerLocalIdentity[0] = identity != null && identity.getType() == com.upokecenter.cbor.CBORType.TextString
                        && "LOCAL_EPHEMERAL_UNTRUSTED".equals(identity.AsString());
            }
            return new StoreVerification(result,encoded);
        } catch (Exception e) {
            result.put("c2pa.validation", check("FAIL", "INVALID_OR_UNSUPPORTED_C2PA: " + e.getMessage()));
        }
        return new StoreVerification(result,null);
    }

    private static SecurityReport.Check check(String state, String code) {
        return new SecurityReport.Check(SecurityReport.Status.valueOf(state), code);
    }

    /** Local checks shared by setup validation, signing and verification. */
    public static List<String> signingProfileIssues(X509Certificate certificate)throws Exception{
        var issues=new ArrayList<String>();
        var eku = certificate.getExtendedKeyUsage();
        boolean[] usage = certificate.getKeyUsage();
        var key=certificate.getPublicKey();
        if(key instanceof java.security.interfaces.RSAKey rsa){if(rsa.getModulus().bitLength()<2048)issues.add("C2PA: RSA key must be at least 2048 bits");}
        else if(key instanceof java.security.interfaces.ECKey ec){
            var parameters=AlgorithmParameters.getInstance("EC");parameters.init(new ECGenParameterSpec("secp256r1"));
            var p256=parameters.getParameterSpec(java.security.spec.ECParameterSpec.class);var selected=ec.getParams();
            if(selected==null||!selected.getOrder().equals(p256.getOrder())||!selected.getGenerator().equals(p256.getGenerator())||!selected.getCurve().equals(p256.getCurve()))
                issues.add("C2PA: EC key must use the supported P-256 curve");
        }else issues.add("C2PA: signing key must be RSA or P-256 EC");
        if(certificate.getVersion()!=3)issues.add("C2PA: X.509 version 3 is required");
        if(certificate.getExtensionValue("2.5.29.35")==null)issues.add("C2PA: Authority Key Identifier extension is missing");
        if(certificate.getIssuerUniqueID()!=null||certificate.getSubjectUniqueID()!=null)issues.add("C2PA: issuer/subject unique identifiers are unsupported");
        if(certificate.getBasicConstraints()>=0)issues.add("C2PA: select a non-CA signing certificate, not a certificate-authority certificate");
        if(usage==null||usage.length==0||!usage[0])issues.add("C2PA: Key Usage must include digitalSignature");
        if(eku==null||Collections.disjoint(eku,List.of("1.3.6.1.5.5.7.3.36","1.3.6.1.4.1.62558.2.1","1.3.6.1.5.5.7.3.4")))
            issues.add("C2PA: Extended Key Usage must include documentSigning, C2PA claim signing or emailProtection");
        if(eku!=null&&!Collections.disjoint(eku,List.of("1.3.6.1.5.5.7.3.8","1.3.6.1.5.5.7.3.9","2.5.29.37.0")))
            issues.add("C2PA: timestamping, OCSP signing and anyExtendedKeyUsage are not allowed on the export signing certificate");
        return List.copyOf(issues);
    }

    public static void requireSigningCredential(SigningIdentity identity)throws Exception{
        checkCredential(identity.certificates().getFirst());
    }

    private static void checkCredential(X509Certificate certificate) throws Exception {
        var issues=signingProfileIssues(certificate);
        if(!issues.isEmpty())throw new IOException("C2PA signing certificate is incompatible: "+String.join("; ",issues)+". Configure a compatible certificate or disable C2PA.");
    }

    public static String xmpInstanceId(PDDocument doc) throws Exception {
        var factory = javax.xml.stream.XMLInputFactory.newFactory();
        factory.setProperty(javax.xml.stream.XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty("javax.xml.stream.isSupportingExternalEntities", false);
        var metadata = doc.getDocumentCatalog().getMetadata();
        if (metadata == null) throw new IOException("Missing PDF XMP");
        try (var input = metadata.createInputStream()) {
            var reader = factory.createXMLStreamReader(input);
            try {
                while (reader.hasNext()) {
                    if (reader.next() == javax.xml.stream.XMLStreamConstants.START_ELEMENT && "http://ns.adobe.com/xap/1.0/mm/".equals(reader.getNamespaceURI()) && "InstanceID".equals(reader.getLocalName()))
                        return reader.getElementText();
                }
            } finally {
                reader.close();
            }
        }
        throw new IOException("Missing XMP instance identifier");
    }

    public static byte[] attachmentDigest(PDDocument document,String attachment)throws Exception{
        return embeddedDigest(files(document).get(attachment));
    }

    private static byte[] embeddedDigest(PDComplexFileSpecification specification) throws Exception {
        if (specification == null) throw new IOException("Missing bound attachment");
        var stream = specification.getEmbeddedFileUnicode();
        if (stream == null) stream = specification.getEmbeddedFile();
        if (stream == null) throw new IOException("Missing bound attachment stream");
        var digest = MessageDigest.getInstance("SHA-256");
        try (var input = stream.createInputStream()) {
            byte[] buffer = new byte[1024 * 1024];
            int n;
            while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n);
        }
        return digest.digest();
    }

    static long[] signatureRange(org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature signature) throws IOException {
        var values = signature.getCOSObject().getCOSArray(COSName.BYTERANGE);
        if (values == null || values.size() != 4) throw new IOException("Invalid PDF signature range");
        long[] range = new long[4];
        for (int i = 0; i < 4; i++) {
            if (!(values.getObject(i) instanceof COSInteger value))
                throw new IOException("Invalid PDF signature offset");
            range[i] = value.longValue();
        }
        return range;
    }

    private record Credential(PrivateKey key, List<X509Certificate> chain) implements AutoCloseable {
        public void close() {
            try {
                key.destroy();
            } catch (Exception ignored) {
            }
        }
    }

    private static Credential localIdentity() throws Exception {
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        var issuer = generator.generateKeyPair();
        var leaf = generator.generateKeyPair();
        Instant now = Instant.now();
        X500Name ca = new X500Name("CN=Local DICOM PDF C2PA issuer"), subject = new X500Name("CN=Local DICOM PDF creator - identity unverified");
        X509Certificate root = certificate(ca, ca, issuer.getPublic(), issuer.getPublic(), issuer.getPrivate(), now, true);
        X509Certificate cert = certificate(ca, subject, leaf.getPublic(), issuer.getPublic(), issuer.getPrivate(), now, false);
        try {
            issuer.getPrivate().destroy();
        } catch (Exception ignored) {
        }
        return new Credential(leaf.getPrivate(), List.of(cert, root));
    }

    private static X509Certificate certificate(X500Name issuer, X500Name subject, PublicKey pub, PublicKey issuerPublic, PrivateKey key, Instant at, boolean ca) throws Exception {
        var builder = new JcaX509v3CertificateBuilder(issuer, new BigInteger(159, new SecureRandom()).add(BigInteger.ONE), Date.from(at.minusSeconds(300)), Date.from(at.plus(Duration.ofDays(365))), subject, pub);
        builder.addExtension(org.bouncycastle.asn1.x509.Extension.basicConstraints, true, new BasicConstraints(ca));
        builder.addExtension(org.bouncycastle.asn1.x509.Extension.keyUsage, true, new KeyUsage(ca ? KeyUsage.keyCertSign | KeyUsage.cRLSign : KeyUsage.digitalSignature));
        var utils = new JcaX509ExtensionUtils();
        builder.addExtension(org.bouncycastle.asn1.x509.Extension.subjectKeyIdentifier, false, utils.createSubjectKeyIdentifier(pub));
        builder.addExtension(org.bouncycastle.asn1.x509.Extension.authorityKeyIdentifier, false, utils.createAuthorityKeyIdentifier(issuerPublic));
        if (!ca)
            builder.addExtension(org.bouncycastle.asn1.x509.Extension.extendedKeyUsage, false, new ExtendedKeyUsage(KeyPurposeId.getInstance(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.3.6.1.5.5.7.3.36"))));
        return new JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(key)));
    }

    private static void associate(PDDocument document, PDComplexFileSpecification specification) throws IOException {
        var catalog = document.getDocumentCatalog().getCOSObject();
        var value = catalog.getDictionaryObject(COSName.getPDFName("AF"));
        if (value != null && !(value instanceof COSArray)) throw new IOException("Invalid catalog associated files");
        var array = value == null ? new COSArray() : (COSArray) value;
        for (int i = 0; i < array.size(); i++) if (array.getObject(i) == specification.getCOSObject()) return;
        array.add(specification); catalog.setItem(COSName.getPDFName("AF"), array);
    }

    public static TreeMap<String, PDComplexFileSpecification> files(PDDocument doc) throws IOException {
        var result = new TreeMap<String, PDComplexFileSpecification>();
        var names = doc.getDocumentCatalog().getNames();
        if (names != null && names.getEmbeddedFiles() != null)
            collect(names.getEmbeddedFiles(), result, new HashSet<>(), 0);
        Set<COSDictionary> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (var file : result.values()) seen.add(file.getCOSObject());
        var associated = doc.getDocumentCatalog().getCOSObject().getDictionaryObject(COSName.getPDFName("AF"));
        if (associated != null && !(associated instanceof COSArray)) throw new IOException("Invalid catalog associated files");
        if (associated instanceof COSArray array) for (int i = 0; i < array.size(); i++) {
            if (!(array.getObject(i) instanceof COSDictionary specification)) throw new IOException("Invalid associated file specification");
            if (!seen.add(specification)) continue;
            var file = new PDComplexFileSpecification(specification);
            String filename = file.getFileUnicode(); if (filename == null) filename = file.getFile();
            if (filename == null || filename.isBlank() || result.putIfAbsent(filename, file) != null)
                throw new IOException("Missing or ambiguous associated filename");
        }
        return result;
    }

    private static void collect(org.apache.pdfbox.pdmodel.common.PDNameTreeNode<PDComplexFileSpecification> tree, Map<String, PDComplexFileSpecification> result, Set<COSDictionary> seen, int depth) throws IOException {
        if (depth > 16 || !seen.add(tree.getCOSObject()) || seen.size() > 10000)
            throw new IOException("Invalid attachment tree");
        if (tree.getNames() != null) for (var entry : tree.getNames().entrySet())
            if (result.put(entry.getKey(), entry.getValue()) != null) throw new IOException("Duplicate attachment");
        if (tree.getKids() != null) for (var child : tree.getKids()) collect(child, result, seen, depth + 1);
    }

    private static byte[] payload(PDComplexFileSpecification file, int limit) throws IOException {
        if (file == null) throw new IOException("Missing C2PA resource");
        var stream = file.getEmbeddedFileUnicode();
        if (stream == null) stream = file.getEmbeddedFile();
        if (stream == null) throw new IOException("Missing embedded stream");
        try (var input = stream.createInputStream()) {
            byte[] bytes = input.readNBytes(limit + 1);
            if (bytes.length > limit) throw new IOException("C2PA resource exceeds bound");
            return bytes;
        }
    }

    private static byte[] digest(Path path, List<long[]> exclusions) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        try (var input = Files.newInputStream(path)) {
            long position = 0;
            byte[] buffer = new byte[1024 * 1024];
            for (var range : exclusions) {
                if (range[0] < position || range[1] < 1 || range[0] + range[1] > Files.size(path))
                    throw new IOException("Invalid exclusion");
                hash(input, digest, range[0] - position, buffer);
                input.skipNBytes(range[1]);
                position = range[0] + range[1];
            }
            hash(input, digest, Files.size(path) - position, buffer);
        }
        return digest.digest();
    }

    private static void hash(InputStream in, MessageDigest digest, long size, byte[] buffer) throws IOException {
        while (size > 0) {
            int n = in.read(buffer, 0, (int) Math.min(size, buffer.length));
            if (n < 0) throw new EOFException();
            digest.update(buffer, 0, n);
            size -= n;
        }
    }

    private static byte[] sha256(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }

    private static CBORObject map(Object... entries) {
        var map = CBORObject.NewMap();
        for (int i = 0; i < entries.length; i += 2) map.Add(entries[i], entries[i + 1]);
        return map;
    }

    private static byte[] assertion(String label, CBORObject data) throws IOException {
        return superbox("cbor", label, box("cbor", data.EncodeToBytes()));
    }

    private static byte[] box(String type, byte[] data) throws IOException {
        var out = new ByteArrayOutputStream();
        var writer = new DataOutputStream(out);
        writer.writeInt(data.length + 8);
        writer.writeBytes(type);
        writer.write(data);
        return out.toByteArray();
    }

    private static byte[] superbox(String uuid, String label, byte[]... children) throws IOException {
        var data = new ByteArrayOutputStream();
        var description = new DataOutputStream(data);
        description.writeBytes(uuid);
        description.write(HexFormat.of().parseHex("00110010800000aa00389b71"));
        description.writeByte(3);
        description.write(label.getBytes(StandardCharsets.UTF_8));
        description.writeByte(0);
        var out = new ByteArrayOutputStream();
        out.write(box("jumd", data.toByteArray()));
        for (var child : children) out.write(child);
        return box("jumb", out.toByteArray());
    }

    private record Box(int start, int end, String label, String uuid, byte[] content, List<Box> children) {
        Box child(String name) throws IOException {
            var matches = children.stream().filter(b -> b.label.equals(name)).toList();
            if (matches.size() != 1) throw new IOException("Missing/ambiguous C2PA box: " + name);
            return matches.getFirst();
        }
    }

    private static Box parse(byte[] bytes, int start, int bound, int depth) throws IOException {
        if (depth > 8 || start + 8 > bound) throw new IOException("Invalid JUMBF");
        int length = ByteBuffer.wrap(bytes, start, 4).getInt(), end = start + length;
        if (length < 8 || end < start || end > bound) throw new IOException("Invalid JUMBF length");
        String type = new String(bytes, start + 4, 4, StandardCharsets.US_ASCII);
        if (!type.equals("jumb"))
            return new Box(start, end, "", type, Arrays.copyOfRange(bytes, start + 8, end), List.of());
        int offset = start + 8;
        if (offset + 25 > end) throw new IOException("Missing JUMBF description");
        int dlen = ByteBuffer.wrap(bytes, offset, 4).getInt();
        if (dlen < 26 || offset + dlen > end || !new String(bytes, offset + 4, 4, StandardCharsets.US_ASCII).equals("jumd") || bytes[offset + 24] != 3)
            throw new IOException("Unsupported JUMBF description");
        if (!Arrays.equals(Arrays.copyOfRange(bytes, offset + 12, offset + 24), HexFormat.of().parseHex("00110010800000aa00389b71"))) throw new IOException("Invalid JUMBF type UUID");
        String uuid = new String(bytes, offset + 8, 4, StandardCharsets.US_ASCII);
        int labelStart = offset + 25, labelEnd = labelStart;
        while (labelEnd < offset + dlen && bytes[labelEnd] != 0) labelEnd++;
        if (labelEnd != offset + dlen - 1) throw new IOException("Invalid JUMBF label");
        String label = new String(bytes, labelStart, labelEnd - labelStart, StandardCharsets.UTF_8);
        List<Box> children = new ArrayList<>();
        for (offset += dlen; offset < end; ) {
            Box child = parse(bytes, offset, end, depth + 1);
            children.add(child);
            offset = child.end;
        }
        byte[] content = children.size() == 1 && children.getFirst().uuid.equals("cbor") ? children.getFirst().content : new byte[0];
        return new Box(start, end, label, uuid, content, children);
    }

    static long find(Path path, byte[] pattern) throws IOException {
        // Streaming KMP keeps memory bounded for multi-gigabyte archives and checks uniqueness.
        if(pattern.length==0)throw new IOException("Empty C2PA stream marker");
        int[] prefix = new int[pattern.length];
        for (int i = 1, j = 0; i < pattern.length; i++) {
            while (j > 0 && pattern[i] != pattern[j]) j = prefix[j - 1];
            if (pattern[i] == pattern[j]) j++;
            prefix[i] = j;
        }
        long found = -1, position = 0;
        int matched = 0;
        try (var input = new BufferedInputStream(Files.newInputStream(path), 1024 * 1024)) {
            byte[] buffer = new byte[1024 * 1024];
            int n;
            while ((n = input.read(buffer)) != -1) {
                // Latin-1 preserves every byte exactly. The JDK's single-character
                // search skips non-candidates in bulk; KMP still bounds partial matches.
                String block=new String(buffer,0,n,StandardCharsets.ISO_8859_1);
                for (int i = 0; i < n; i++) {
                if(matched==0){i=block.indexOf(pattern[0]&255,i);if(i<0)break;}
                byte b = buffer[i];
                while (matched > 0 && b != pattern[matched]) matched = prefix[matched - 1];
                if (b == pattern[matched]) matched++;
                if (matched == pattern.length) {
                    if (found >= 0) throw new IOException("Ambiguous C2PA stream location");
                    found = position + i - pattern.length + 1;
                    matched = prefix[matched - 1];
                }
                }
                position+=n;
            }
        }
        if (found < 0) throw new IOException("C2PA stream not found");
        return found;
    }
}
