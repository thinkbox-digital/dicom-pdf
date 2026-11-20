package digital.thinkbox.pdfsecurity.testing;

import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.math.BigInteger;
import java.net.URI;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.operator.jcajce.*;
import org.bouncycastle.tsp.*;


public final class TestTimestampService {
    private static final String POLICY="1.2.3.4.5";
    public static Rfc3161Client.Exchange service(SecurityFixtures.Institution institution,String defect)throws Exception{
        var tsa=SecurityFixtures.timestampIdentity(institution);
        var provider=new JcaDigestCalculatorProviderBuilder().build();
        var signer=new JcaSignerInfoGeneratorBuilder(provider).build(new JcaContentSignerBuilder("SHA256withRSA").build(tsa.key().getPrivate()),tsa.certificate());
        var token=new TimeStampTokenGenerator(signer,provider.get(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256)),new ASN1ObjectIdentifier(POLICY));
        token.addCertificates(new JcaCertStore(List.of(tsa.certificate(),institution.root())));
        var responses=new TimeStampResponseGenerator(token,Set.of(TSPAlgorithms.SHA256));
        return bytes->{
            var request=new TimeStampRequest(bytes);
            if(!request.getCertReq()||request.getNonce()==null||request.getNonce().bitLength()<160||!TSPAlgorithms.SHA256.equals(request.getMessageImprintAlgOID()))
                throw new IOException("Synthetic TSA received an unexpected request");
            if("reject".equals(defect))return responses.generateFailResponse(2,org.bouncycastle.asn1.cmp.PKIFailureInfo.badRequest,"Synthetic rejection").getEncoded();
            if(Set.of("nonce","imprint","policy").contains(defect)){
                var altered=new TimeStampRequestGenerator();altered.setCertReq(true);
                if("policy".equals(defect))altered.setReqPolicy(new ASN1ObjectIdentifier("1.2.3.99"));
                else if(request.getReqPolicy()!=null)altered.setReqPolicy(request.getReqPolicy());
                request=altered.generate(TSPAlgorithms.SHA256,"imprint".equals(defect)?new byte[32]:request.getMessageImprintDigest(),"nonce".equals(defect)?request.getNonce().add(BigInteger.ONE):request.getNonce());
            }
            Instant issued=institution.now().plusSeconds("future".equals(defect)?3600:"old".equals(defect)?-3600:0);
            return responses.generateGrantedResponse(request,BigInteger.valueOf(123),Date.from(issued)).getEncoded();
        };
    }
    public static Rfc3161Client client(SecurityFixtures.Institution institution,Rfc3161Client.Exchange exchange)throws Exception{
        return new Rfc3161Client(exchange,institution.policy(false),Clock.fixed(institution.now(),ZoneOffset.UTC),POLICY);
    }
}
