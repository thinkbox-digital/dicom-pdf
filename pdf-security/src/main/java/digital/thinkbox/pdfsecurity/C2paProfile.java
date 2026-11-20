package digital.thinkbox.pdfsecurity;

import com.upokecenter.cbor.CBORObject;
import org.apache.pdfbox.pdmodel.PDDocument;

/** Application-owned C2PA claims and PDF identity. Implementations must be immutable and deterministic. */
public interface C2paProfile {
    default String credentialsFile(){return "content-credentials.c2pa";}
    default String policyFile(){return "c2pa-policy.json";}
    /** Keep provenance outside collection membership while retaining catalog AF association. */
    default boolean associatedFilesOnly(){return false;}
    byte[] policyBytes();
    String assertionLabel();
    String generatorName();
    String generatorVersion();
    default String instanceId(PDDocument document)throws Exception{return C2pa.xmpInstanceId(document);}
    CBORObject createAssertion(PDDocument document,boolean localIdentity)throws Exception;
    void verifyAssertion(PDDocument document,CBORObject assertion)throws Exception;
}
