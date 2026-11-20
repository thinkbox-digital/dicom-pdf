package digital.thinkbox.dicompdf;

import com.google.gson.*;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.cert.*;
import java.time.*;
import java.util.*;

/** Local operator configuration only; never read from an archive or embedded in it. */
final class SecurityConfiguration {
    private final JsonObject json;private final Path parent;
    final ArchiveSecurity.Protection protection;final CertificatePolicy policy;final String verapdf;
    SecurityConfiguration(Path path)throws Exception{
        this(path,null,null,null);
    }
    static SecurityConfiguration forDesktop(Path path,boolean timestamping,String passphrase)throws Exception{
        return new SecurityConfiguration(path,DesktopRequest.VERAPDF,timestamping,passphrase);
    }
    private SecurityConfiguration(Path path,String validatorOverride,Boolean timestamping,String passphraseOverride)throws Exception{
        if(Files.size(path)>1024*1024)throw new IOException("Security configuration is too large");
        parent=path.toRealPath().getParent();json=JsonParser.parseString(Files.readString(path,StandardCharsets.UTF_8)).getAsJsonObject();
        var allowed=Set.of("protection","pkcs12","passphraseFile","alias","trustCertificates","supportingCertificates","crls","ocsps","verapdf","verificationTime","tsaUrl","tsaPolicyOid");
        if(!allowed.containsAll(json.keySet()))throw new IOException("Unknown security configuration property; passwords must use a separate passphrase file");
        if(validatorOverride!=null)json.addProperty("verapdf",validatorOverride);
        if(passphraseOverride!=null&&!passphraseOverride.isBlank())json.addProperty("passphraseFile",Path.of(passphraseOverride).toAbsolutePath().normalize().toString());
        var selected=ArchiveSecurity.Protection.valueOf(required("protection"));
        if(timestamping!=null){
            if(timestamping){json.addProperty("tsaUrl",required("tsaUrl"));if(selected==ArchiveSecurity.Protection.CMS_AND_PDF)selected=ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED;}
            else if(selected!=ArchiveSecurity.Protection.CMS_AND_PDF)throw new IOException("This policy requires timestamps; no protection was downgraded");
            else{json.remove("tsaUrl");json.remove("tsaPolicyOid");}
        }
        protection=selected==ArchiveSecurity.Protection.CMS_AND_PDF&&(json.has("tsaUrl")||json.has("tsaPolicyOid"))?ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED:selected;
        verapdf=resolve(required("verapdf")).toString();
        var factory=CertificateFactory.getInstance("X.509");var anchors=new HashSet<TrustAnchor>();var crls=new ArrayList<X509CRL>();
        if(json.has("trustCertificates"))for(var name:json.getAsJsonArray("trustCertificates")){
            try(var stream=new ByteArrayInputStream(read(resolve(name.getAsString()),1024*1024))){for(var certificate:factory.generateCertificates(stream))anchors.add(new TrustAnchor((X509Certificate)certificate,null));}
        }
        var supporting=new ArrayList<X509Certificate>();
        if(json.has("supportingCertificates"))for(var name:json.getAsJsonArray("supportingCertificates")){
            try(var stream=new ByteArrayInputStream(read(resolve(name.getAsString()),1024*1024))){
                for(var certificate:factory.generateCertificates(stream)){
                    if(supporting.size()>=256)throw new IOException("Supporting certificate count limit");
                    supporting.add((X509Certificate)certificate);
                }
            }
        }
        if(json.has("crls"))for(var name:json.getAsJsonArray("crls")){
            try(var stream=new ByteArrayInputStream(read(resolve(name.getAsString()),16*1024*1024))){for(var crl:factory.generateCRLs(stream))crls.add((X509CRL)crl);}
        }
        Instant at=json.has("verificationTime")?Instant.parse(json.get("verificationTime").getAsString()):Instant.now();
        var ocsps=new ArrayList<byte[]>();
        if(json.has("ocsps"))for(var name:json.getAsJsonArray("ocsps")){
            if(ocsps.size()>=256)throw new IOException("OCSP evidence count limit");
            ocsps.add(read(resolve(name.getAsString()),Rfc3161Client.MAX_RESPONSE));
        }
        policy=new CertificatePolicy(anchors,crls,at,ocsps,supporting);
    }
    Rfc3161Client timestampClient()throws Exception{
        if(protection==ArchiveSecurity.Protection.CMS_AND_PDF)return null;
        if(policy.anchors().isEmpty())throw new IOException("Trusted timestamps require independently selected CA files in trustCertificates");
        return Rfc3161Client.endpoint(java.net.URI.create(required("tsaUrl")),policy,Clock.systemUTC(),json.has("tsaPolicyOid")?required("tsaPolicyOid"):null);
    }
    SigningIdentity identity(Path input)throws Exception{
        Path credential=resolve(required("pkcs12")),passwordFile=resolve(required("passphraseFile")),root=input.toRealPath();
        if(credential.toRealPath().startsWith(root)||passwordFile.toRealPath().startsWith(root))throw new IOException("Signing credentials and passphrases must be outside archival inputs");
        for(Path file:InputFiles.collect(root))if(Files.isSameFile(file,credential)||Files.isSameFile(file,passwordFile))throw new IOException("Signing credentials must not be supplied as originals");
        return loadIdentity();
    }
    SigningIdentity identityForEvidence()throws Exception{return loadIdentity();}
    private SigningIdentity loadIdentity()throws Exception{
        Path credential=resolve(required("pkcs12")),passwordFile=resolve(required("passphraseFile"));
        return SigningIdentity.loadWithPassphraseFile(credential,passwordFile,json.has("alias")?json.get("alias").getAsString():null,Instant.now());
    }
    private String required(String key)throws IOException{
        if(!json.has(key)||!json.get(key).isJsonPrimitive()||json.get(key).getAsString().isBlank())throw new IOException("Missing required security configuration property: "+key);
        return json.get(key).getAsString();
    }
    private Path resolve(String name){return parent.resolve(name).normalize();}
    private static byte[] read(Path path,int limit)throws IOException{
        try(var input=Files.newInputStream(path)){byte[] bytes=input.readNBytes(limit+1);if(bytes.length>limit)throw new IOException("Security evidence exceeds size limit");return bytes;}
    }
}
