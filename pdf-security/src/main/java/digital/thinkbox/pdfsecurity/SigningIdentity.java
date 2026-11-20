package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.security.interfaces.*;
import java.time.Instant;
import java.util.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;

/** Caller-owned institutional credential. Never serialised or attached to a PDF. */
public final class SigningIdentity implements AutoCloseable {
    static final Provider BC=new BouncyCastleProvider();
    private final PrivateKey key;
    private final List<X509Certificate> chain;
    private final String algorithm;
    private boolean closed;
    private byte[] credentialHash;

    private SigningIdentity(PrivateKey key,List<X509Certificate> chain,Instant at)throws Exception{
        this.key=key;this.chain=List.copyOf(chain);
        if(key instanceof RSAKey rsa&&rsa.getModulus().bitLength()>=2048)algorithm="SHA256withRSA";
        else if(key instanceof ECKey ec&&ec.getParams().getOrder().bitLength()>=256)algorithm="SHA256withECDSA";
        else throw new GeneralSecurityException("Unsupported signing key; RSA >=2048 or EC >=256 is required");
        check(at);
        for(int i=0;i+1<chain.size();i++)chain.get(i).verify(chain.get(i+1).getPublicKey());
        byte[] challenge=new byte[32];new SecureRandom().nextBytes(challenge);
        Signature proof=Signature.getInstance(algorithm,BC);proof.initSign(key);proof.update(challenge);byte[] signature=proof.sign();
        proof.initVerify(chain.getFirst());proof.update(challenge);
        if(!proof.verify(signature))throw new GeneralSecurityException("Signing key and certificate do not match");
    }
    public static SigningIdentity load(Path pkcs12,char[] password,String alias,Instant at)throws Exception{
        KeyStore store=KeyStore.getInstance("PKCS12");
        byte[] credential;
        try(InputStream input=Files.newInputStream(pkcs12)){credential=input.readNBytes(16*1024*1024+1);}
        byte[] credentialDigest;
        try{
            if(credential.length>16*1024*1024)throw new IOException("Signing credential exceeds size limit");
            credentialDigest=MessageDigest.getInstance("SHA-256").digest(credential);
            store.load(new ByteArrayInputStream(credential),password);
        }finally{Arrays.fill(credential,(byte)0);}
        if(alias==null||alias.isBlank()){
            var aliases=new ArrayList<String>();
            for(String candidate:Collections.list(store.aliases()))if(store.isKeyEntry(candidate))aliases.add(candidate);
            if(aliases.size()!=1)throw new GeneralSecurityException("Select a signing alias when the credential has multiple keys");
            alias=aliases.getFirst();
        }
        Key key=store.getKey(alias,password);var certificates=store.getCertificateChain(alias);
        if(!(key instanceof PrivateKey privateKey)||certificates==null||certificates.length==0)
            throw new GeneralSecurityException("The selected credential has no signing key and certificate chain");
        var chain=new ArrayList<X509Certificate>();
        for(var certificate:certificates){if(!(certificate instanceof X509Certificate x509))throw new GeneralSecurityException("X.509 certificates are required");chain.add(x509);}
        var identity=new SigningIdentity(privateKey,chain,at);
        identity.credentialHash=credentialDigest;
        return identity;
    }
    public static SigningIdentity loadWithPassphraseFile(Path credential,Path passwordFile,String alias,Instant at)throws Exception{
        byte[] encoded;
        try(var input=Files.newInputStream(passwordFile)){encoded=input.readNBytes(4097);}
        java.nio.CharBuffer decoded=null;char[] password=null;
        try{
            if(encoded.length>4096)throw new IOException("Passphrase file exceeds size limit");
            decoded=java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(encoded));password=new char[decoded.remaining()];decoded.get(password);
            int length=password.length;while(length>0&&(password[length-1]=='\r'||password[length-1]=='\n'))length--;
            char[] selected=Arrays.copyOf(password,length);
            try{return load(credential,selected,alias,at);}finally{Arrays.fill(selected,'\0');}
        }finally{Arrays.fill(encoded,(byte)0);if(password!=null)Arrays.fill(password,'\0');if(decoded!=null&&decoded.hasArray())Arrays.fill(decoded.array(),'\0');}
    }
    public void check(Instant at)throws GeneralSecurityException{
        if(closed)throw new GeneralSecurityException("Signing credential is closed");
        for(var certificate:chain)certificate.checkValidity(Date.from(at));
        boolean[] usage=chain.getFirst().getKeyUsage();
        if(usage!=null&&(usage.length==0||!usage[0])&&(usage.length<2||!usage[1]))throw new GeneralSecurityException("Certificate does not permit signatures");
    }
    PrivateKey key(){return key;}
    String algorithm(){return algorithm;}
    public List<X509Certificate> certificates(){return chain;}
    public boolean isCredentialPayload(byte[] data)throws GeneralSecurityException{return MessageDigest.isEqual(credentialHash,MessageDigest.getInstance("SHA-256").digest(data));}
    public boolean isCredentialSha256(String digest){return MessageDigest.isEqual(credentialHash,HexFormat.of().parseHex(digest));}
    public String certificateSha256()throws GeneralSecurityException{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(chain.getFirst().getEncoded()));}
    @Override public void close(){closed=true;try{key.destroy();}catch(Exception ignored){/* Provider may not support destruction. */}}
}
