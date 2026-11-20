package digital.thinkbox.pdfsecurity;

import com.google.gson.GsonBuilder;
import java.util.*;

/** A successful byte check must never imply authenticated acquisition or completeness. */
public record SecurityReport(int schemaVersion,String assurance,String verificationTime,String timeEvidence,Map<String,Check> checks) {
    public enum Status {PASS,FAIL,UNKNOWN,NOT_APPLICABLE}
    public record Check(Status status,String code) {}
    public SecurityReport {checks=Collections.unmodifiableMap(new LinkedHashMap<>(checks));}
    public String json(){return new GsonBuilder().serializeNulls().setPrettyPrinting().create().toJson(this)+"\n";}
    public int exitCode(){return checks.values().stream().anyMatch(c->c.status()==Status.FAIL)?1:
        checks.values().stream().anyMatch(c->c.status()==Status.UNKNOWN)?2:0;}
}
