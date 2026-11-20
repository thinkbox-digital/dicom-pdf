package digital.thinkbox.dicompdf;

import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.erdtman.jcs.JsonCanonicalizer;

/** RFC 8785 bytes for newly created manifests; old manifest bytes are never rewritten. */
final class ManifestEncoding {
    private ManifestEncoding() {}
    static byte[] encode(Manifest manifest) throws IOException {
        String json=new GsonBuilder().serializeNulls().disableHtmlEscaping().create().toJson(manifest);
        return new JsonCanonicalizer(json).getEncodedString().getBytes(StandardCharsets.UTF_8);
    }
    static byte[] canonicalize(String json)throws IOException{return new JsonCanonicalizer(json).getEncodedString().getBytes(StandardCharsets.UTF_8);}
}
