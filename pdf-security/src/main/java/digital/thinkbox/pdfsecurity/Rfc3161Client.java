package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.math.BigInteger;
import java.net.URI;
import java.security.*;
import java.time.*;
import java.util.*;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.cms.*;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cms.*;
import org.bouncycastle.tsp.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS;

/** Explicit opt-in timestamp acquisition. Only an imprint, nonce and policy leave the process. */
public final class Rfc3161Client {
    public static final int MAX_RESPONSE=1024*1024;
    @FunctionalInterface public interface Exchange { byte[] request(byte[] encodedRequest)throws Exception; }
    private final Exchange exchange;
    private final CertificatePolicy policy;
    private final Clock clock;
    private final ASN1ObjectIdentifier requestedPolicy;

    public Rfc3161Client(Exchange exchange,CertificatePolicy policy,Clock clock,String policyOid){
        this.exchange=Objects.requireNonNull(exchange);this.policy=Objects.requireNonNull(policy);this.clock=Objects.requireNonNull(clock);
        requestedPolicy=policyOid==null?null:new ASN1ObjectIdentifier(policyOid);
    }
    public static Rfc3161Client https(URI endpoint,CertificatePolicy policy,Clock clock,String policyOid){
        if(!"https".equalsIgnoreCase(endpoint.getScheme()))throw new IllegalArgumentException("HTTPS timestamp endpoint required");
        return endpoint(endpoint,policy,clock,policyOid);
    }
    /** RFC 3161 authenticates the signed response independently of HTTP transport. */
    public static Rfc3161Client endpoint(URI endpoint,CertificatePolicy policy,Clock clock,String policyOid){
        if(!Set.of("http","https").contains(endpoint.getScheme()==null?"":endpoint.getScheme().toLowerCase(Locale.ROOT))||endpoint.getHost()==null||endpoint.getRawUserInfo()!=null||endpoint.getRawQuery()!=null||endpoint.getRawFragment()!=null)
            throw new IllegalArgumentException("Timestamp service requires an HTTP or HTTPS URL without credentials, query or fragment");
        return new Rfc3161Client(request->{
            java.net.HttpURLConnection connection=null;
            try{
                connection=(java.net.HttpURLConnection)endpoint.toURL().openConnection();
                connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
                connection.setConnectTimeout(10000);connection.setReadTimeout(30000);
                connection.setRequestMethod("POST");connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type","application/timestamp-query");
                connection.setRequestProperty("Accept","application/timestamp-reply");
                connection.setFixedLengthStreamingMode(request.length);
                try(var output=connection.getOutputStream()){output.write(request);}
                int status=connection.getResponseCode();
                if(status!=200)throw new IOException("Timestamp service returned HTTP "+status+(status>=300&&status<400?"; configure the final TSA URL because redirects are not followed":""));
                String type=connection.getContentType(),encoding=connection.getContentEncoding();
                if(type==null||!type.split(";",2)[0].trim().equalsIgnoreCase("application/timestamp-reply"))
                    throw new IOException("Timestamp service returned an unsupported Content-Type: "+safeMessage(type));
                if(encoding!=null&&!encoding.equalsIgnoreCase("identity"))throw new IOException("Timestamp service returned an unsupported Content-Encoding: "+safeMessage(encoding));
                if(connection.getContentLengthLong()>MAX_RESPONSE)throw new IOException("Timestamp response exceeds size limit");
                try(var input=connection.getInputStream()){
                    byte[] response=input.readNBytes(MAX_RESPONSE+1);
                    if(response.length>MAX_RESPONSE)throw new IOException("Timestamp response exceeds size limit");
                    return response;
                }
            }catch(Exception failure){
                int port=endpoint.getPort()>=0?endpoint.getPort():"https".equalsIgnoreCase(endpoint.getScheme())?443:80;
                String reason=failure instanceof java.net.ConnectException?"Connection refused or unreachable; check the configured protocol and port"
                    :failure instanceof java.net.UnknownHostException?"Timestamp server hostname could not be resolved"
                    :failure instanceof java.net.SocketTimeoutException?"Timestamp service request timed out"
                    :failure.getClass().getSimpleName()+": "+safeMessage(failure.getMessage());
                throw new IOException("Timestamp service exchange failed at "+endpoint.getScheme()+"://"+endpoint.getHost()+":"+port+": "+reason+"; no protection downgrade",failure);
            }
            finally{if(connection!=null)connection.disconnect();}
        },policy,clock,policyOid);
    }
    private static String safeMessage(String value){
        if(value==null)return "not supplied";
        String text=value.replaceAll("[\\p{Cntrl}]"," ");return text.substring(0,Math.min(text.length(),320));
    }
    public byte[] timestampCms(byte[] encodedCms)throws Exception{
        var cms=new CMSSignedData(encodedCms);var signers=cms.getSignerInfos().getSigners();
        if(!cms.isDetachedSignature()||signers.size()!=1)throw new IOException("Timestamping requires one detached CMS signer");
        var signer=signers.iterator().next();
        if(signer.getUnsignedAttributes()!=null&&signer.getUnsignedAttributes().get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken)!=null)
            throw new IOException("Existing timestamp requires evidence-renewal support");
        var token=requestToken(MessageDigest.getInstance("SHA-256").digest(signer.getSignature()));
        var attribute=new Attribute(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken,new DERSet(token.toCMSSignedData().toASN1Structure()));
        var attributes=signer.getUnsignedAttributes()==null?new Hashtable<ASN1ObjectIdentifier,Attribute>():signer.getUnsignedAttributes().toHashtable();
        attributes.put(attribute.getAttrType(),attribute);
        var updated=SignerInformation.replaceUnsignedAttributes(signer,new AttributeTable(attributes));
        byte[] result=CMSSignedData.replaceSigners(cms,new SignerInformationStore(updated)).getEncoded();
        if(result.length>MAX_RESPONSE)throw new IOException("Timestamped CMS exceeds size limit");
        return result;
    }
    /** Stream-hashed document byte ranges; only the imprint is sent to the TSA. */
    public byte[] timestampDocument(InputStream content)throws Exception{
        var digest=MessageDigest.getInstance("SHA-256");byte[] block=new byte[64*1024];
        for(int count;(count=content.read(block))!=-1;)digest.update(block,0,count);
        return requestToken(digest.digest()).getEncoded(ASN1Encoding.DER);
    }
    /** Adapter for maintained signing libraries that compute the document imprint. */
    public byte[] timestampDigest(byte[] imprint)throws Exception{
        if(imprint==null||imprint.length!=32)throw new IOException("SHA-256 timestamp imprint required");
        return requestToken(imprint.clone()).getEncoded(ASN1Encoding.DER);
    }
    private TimeStampToken requestToken(byte[] imprint)throws Exception{
        var generator=new TimeStampRequestGenerator();generator.setCertReq(true);
        if(requestedPolicy!=null)generator.setReqPolicy(requestedPolicy);
        BigInteger nonce=new BigInteger(160,new SecureRandom()).setBit(159);
        var request=generator.generate(TSPAlgorithms.SHA256,imprint,nonce);
        byte[] responseBytes=exchange.request(request.getEncoded());
        if(responseBytes==null||responseBytes.length>MAX_RESPONSE)throw new IOException("Timestamp response missing or exceeds size limit");
        var response=new TimeStampResponse(responseBytes);response.validate(request);
        var token=response.getTimeStampToken();
        if((response.getStatus()!=0&&response.getStatus()!=1)||token==null)throw new IOException("Timestamp service did not grant the request");
        var info=token.getTimeStampInfo();
        if(!nonce.equals(info.getNonce())||requestedPolicy!=null&&!requestedPolicy.equals(info.getPolicy()))throw new IOException("Timestamp nonce or policy does not match request");
        Instant now=clock.instant(),issued=info.getGenTime().toInstant();
        if(issued.isBefore(now.minusSeconds(300))||issued.isAfter(now.plusSeconds(60)))throw new IOException("Timestamp service time is outside the accepted response window");
        var freshPolicy=new CertificatePolicy(policy.anchors(),policy.crls(),now,policy.ocsps(),policy.supportingCertificates());
        var checked=Rfc3161Verification.verifyToken(token,imprint,freshPolicy);
        if(checked.get("timestamp")==null||checked.get("timestamp").status()!=PASS){
            String details=checked.entrySet().stream().filter(entry->entry.getValue().status()!=PASS&&entry.getValue().status()!=SecurityReport.Status.NOT_APPLICABLE)
                .filter(entry->!entry.getKey().equals("timestamp")||checked.size()==1).limit(6)
                .map(entry->entry.getKey()+"="+entry.getValue().status()+" ("+entry.getValue().code()+")").collect(java.util.stream.Collectors.joining("; "));
            throw new IOException("Timestamp signature, TSA trust or revocation could not be verified: "+details+"; no protection downgrade");
        }
        return token;
    }
}
