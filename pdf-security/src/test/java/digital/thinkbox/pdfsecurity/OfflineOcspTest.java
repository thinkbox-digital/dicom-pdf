package digital.thinkbox.pdfsecurity;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;
import static digital.thinkbox.pdfsecurity.testing.TestOcspService.response;
import static digital.thinkbox.pdfsecurity.testing.TestOcspService.policy;

import digital.thinkbox.pdfsecurity.*;
import java.nio.file.*;
import java.security.cert.*;
import java.time.*;
import java.util.*;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.cert.ocsp.*;
import org.bouncycastle.cert.ocsp.jcajce.JcaBasicOCSPRespBuilder;
import org.bouncycastle.operator.jcajce.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

class OfflineOcspTest {
    @TempDir Path temporary;
    @Test void freshIssuerSignedResponseEstablishesRevocationWithoutCrlOrNetwork()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);
        var checks=policy(i,List.of(response(i,"")),i.now()).check(i.leaf(),List.of(i.leaf(),i.root()));
        assertEquals(PASS,checks.get("certificateTrust").status(),checks.toString());assertEquals(PASS,checks.get("revocation").status(),checks.toString());
    }
    @Test void revokedForgedAndAmbiguousResponsesNeverPass()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);
        for(String defect:List.of("revoked","forged","duplicate")){
            var checks=policy(i,List.of(response(i,defect)),i.now()).check(i.leaf(),List.of(i.leaf(),i.root()));
            assertEquals(FAIL,checks.get("revocation").status(),defect+checks);
        }
        var contradictory=policy(i,List.of(response(i,""),response(i,"revoked")),i.now()).check(i.leaf(),List.of(i.leaf(),i.root()));
        assertEquals(FAIL,contradictory.get("revocation").status());
    }
    @Test void staleFutureUnknownAndUnrelatedEvidenceRemainUnknown()throws Exception{
        var i=SecurityFixtures.institution(temporary.resolve("one"),false);var other=SecurityFixtures.institution(temporary.resolve("other"),false);
        for(String defect:List.of("future","unknown","no-next-update"))assertEquals(UNKNOWN,policy(i,List.of(response(i,defect)),i.now()).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status(),defect);
        assertEquals(UNKNOWN,policy(i,List.of(response(i,"")),i.now().plusSeconds(7200)).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status());
        assertEquals(UNKNOWN,policy(i,List.of(response(other,"")),i.now()).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status());
    }
    @Test void malformedEvidenceFailsAndPoliciesDefensivelyCopyResponses()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);byte[] good=response(i,"");
        var selected=policy(i,List.of(good),i.now());good[0]^=1;selected.ocsps().getFirst()[0]^=1;
        assertEquals(PASS,selected.check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status());
        assertEquals(FAIL,policy(i,List.of(good),i.now()).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status());
        assertThrows(IllegalArgumentException.class,()->policy(i,List.of(new byte[1024*1024+1]),i.now()));
    }
    @Test void delegatedRespondersRequireIssuerAuthorizationAndSupportedRevocationPolicy()throws Exception{
        var i=SecurityFixtures.institution(temporary,false);
        assertEquals(PASS,policy(i,List.of(response(i,"delegate")),i.now()).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status());
        for(String defect:List.of("unauthorized-delegate","delegate-no-nocheck"))assertEquals(UNKNOWN,policy(i,List.of(response(i,defect)),i.now()).check(i.leaf(),List.of(i.leaf(),i.root())).get("revocation").status(),defect);
    }
}
