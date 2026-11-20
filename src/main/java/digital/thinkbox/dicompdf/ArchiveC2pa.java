package digital.thinkbox.dicompdf;

import com.upokecenter.cbor.CBORObject;
import digital.thinkbox.pdfsecurity.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.*;
import org.apache.pdfbox.pdmodel.PDDocument;

/** DICOM archive profile adapter; all COSE, PDF hashing and revision handling live in pdf-security. */
public final class ArchiveC2pa {
    public static final String FILE="content-credentials.c2pa",POLICY="c2pa-policy.json",PROFILE="0.4.0";
    public static final byte[] POLICY_BYTES=("{\"attachment\":\""+FILE+"\",\"schemaVersion\":1,\"scope\":\"ARCHIVE_EXPORT\",\"specification\":\"2.2\"}\n").getBytes(StandardCharsets.UTF_8);
    public static final int CAPACITY=C2pa.CAPACITY;
    public static final C2paProfile FORMAT=new C2paProfile(){
        @Override public byte[] policyBytes(){return POLICY_BYTES.clone();}
        @Override public String assertionLabel(){return "digital.thinkbox.archive";}
        @Override public String generatorName(){return "dicom-pdf";}
        @Override public String generatorVersion(){return ApplicationVersion.VERSION;}
        @Override public CBORObject createAssertion(PDDocument document,boolean local)throws Exception{
            return CBORObject.NewMap().Add("schemaVersion",1).Add("manifestSha256",C2pa.attachmentDigest(document,"manifest.json"))
                .Add("scope","ARCHIVE_EXPORT").Add("originalsModified",false).Add("identity",local?"LOCAL_EPHEMERAL_UNTRUSTED":"CONFIGURED_CERTIFICATE");
        }
        @Override public void verifyAssertion(PDDocument document,CBORObject assertion)throws Exception{
            if(!MessageDigest.isEqual(assertion.get("manifestSha256").GetByteString(),C2pa.attachmentDigest(document,"manifest.json")))
                throw new IOException("C2PA manifest binding mismatch");
        }
    };
    private ArchiveC2pa(){}
    public static void attach(PDDocument document)throws Exception{C2pa.attach(document,FORMAT);}
    public static void reserve(PDDocument document)throws IOException{C2pa.reserve(document,FORMAT);}
    public static boolean present(Path pdf)throws IOException{return C2pa.present(pdf,FORMAT);}
    public static void complete(Path pdf,SigningIdentity identity,long[] range)throws Exception{C2pa.complete(pdf,identity,range,FORMAT);}
    public static Map<String,SecurityReport.Check> verify(Path pdf){return C2pa.verify(pdf,FORMAT);}
    public static List<String> signingProfileIssues(X509Certificate certificate)throws Exception{return C2pa.signingProfileIssues(certificate);}
    public static void requireSigningCredential(SigningIdentity identity)throws Exception{C2pa.requireSigningCredential(identity);}
}
