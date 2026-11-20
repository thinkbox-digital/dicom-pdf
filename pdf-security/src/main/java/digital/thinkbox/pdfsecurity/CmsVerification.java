package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.*;
import org.bouncycastle.asn1.ess.SigningCertificateV2;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cert.*;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cms.*;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Recomputes signed-content digest and validates the actual CMS signer, never a manifest claim. */
public final class CmsVerification {
    private CmsVerification() {}
    public static Map<String,SecurityReport.Check> verify(InputStream content,byte[] signature,CertificatePolicy policy){
        return verify(content,signature,policy,null);
    }
    public static Map<String,SecurityReport.Check> verify(InputStream content,byte[] signature,CertificatePolicy policy,String expectedCertificateSha256){
        var result=new LinkedHashMap<String,SecurityReport.Check>();
        try{
            if(signature.length>1024*1024)throw new IOException("CMS size limit");
            // PDF Contents reserves zero-padded space. Let BC parse the ASN.1
            // object, accept only zero padding, and verify that exact CMS object.
            try(var input=new org.bouncycastle.asn1.ASN1InputStream(signature)){
                var object=input.readObject();if(object==null)throw new IOException("Empty CMS");
                signature=object.getEncoded();
                for(int value;(value=input.read())!=-1;)if(value!=0)throw new IOException("Nonzero trailing CMS data");
            }
            if(!new CMSSignedData(signature).isDetachedSignature())throw new IOException("Detached CMS required");
            var parser=new CMSSignedDataParser(new JcaDigestCalculatorProviderBuilder().setProvider(SigningIdentity.BC).build(),new CMSTypedStream(content),signature);
            try{
                parser.getSignedContent().drain();
                var signers=parser.getSignerInfos().getSigners();if(signers.size()!=1)throw new IOException("Expected one CMS signer");
                var signer=signers.iterator().next();
                var matches=parser.getCertificates().getMatches(signer.getSID());if(matches.size()!=1)throw new IOException("Missing or ambiguous signer certificate");
                var certificate=(X509CertificateHolder)matches.iterator().next();
                if(expectedCertificateSha256!=null&&!expectedCertificateSha256.equals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()))))throw new IOException("Unexpected signer certificate");
                if(!"2.16.840.1.101.3.4.2.1".equals(signer.getDigestAlgOID())||!signer.verify(new JcaSimpleSignerInfoVerifierBuilder().setProvider(SigningIdentity.BC).build(certificate)))throw new IOException("CMS signature failed");
                var binding=signer.getSignedAttributes().get(PKCSObjectIdentifiers.id_aa_signingCertificateV2);
                if(binding==null||binding.getAttrValues().size()!=1)throw new IOException("Signing certificate binding missing");
                var certIds=SigningCertificateV2.getInstance(binding.getAttrValues().getObjectAt(0)).getCerts();
                if(certIds.length!=1||!"2.16.840.1.101.3.4.2.1".equals(certIds[0].getHashAlgorithm().getAlgorithm().getId())||!MessageDigest.isEqual(certIds[0].getCertHash(),MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded())))throw new IOException("Signing certificate binding differs");
                result.put("cryptographicSignature",new SecurityReport.Check(PASS,"CMS_CONTENT_DIGEST_AND_SIGNATURE_VERIFIED"));
                var converter=new JcaX509CertificateConverter().setProvider(SigningIdentity.BC);
                List<X509Certificate> chain=new ArrayList<>();
                for(Object item:parser.getCertificates().getMatches(null))chain.add(converter.getCertificate((X509CertificateHolder)item));
                result.putAll(policy.check(converter.getCertificate(certificate),chain));
                result.putAll(Rfc3161Verification.verify(signer,policy));
            }finally{parser.close();}
        }catch(Exception failure){result.put("cryptographicSignature",new SecurityReport.Check(FAIL,"INVALID_OR_UNSUPPORTED_CMS_SIGNATURE"));}
        return result;
    }
}
