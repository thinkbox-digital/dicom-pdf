package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import org.bouncycastle.asn1.DERSet;
import org.bouncycastle.asn1.cms.*;
import org.bouncycastle.asn1.ess.*;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cms.*;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.operator.jcajce.*;

/** Detached CAdES/CMS generation using BC; no verifier state or trust assertions. */
public final class CmsSigning {
    private CmsSigning() {}
    public static byte[] sign(InputStream bytes,SigningIdentity identity,Instant at)throws Exception{
        return sign(bytes,identity,at,null);
    }
    public static byte[] sign(InputStream bytes,SigningIdentity identity,Instant at,Rfc3161Client timestampClient)throws Exception{
        return sign(bytes,identity,at,timestampClient,false);
    }
    /** PAdES uses PDF /M for the claimed signing time, not CMS signingTime. */
    public static byte[] signPdf(InputStream bytes,SigningIdentity identity,Instant at,Rfc3161Client timestampClient)throws Exception{
        return sign(bytes,identity,at,timestampClient,true);
    }
    private static byte[] sign(InputStream bytes,SigningIdentity identity,Instant at,Rfc3161Client timestampClient,boolean pdf)throws Exception{
        identity.check(at);
        var attributes=new Hashtable<org.bouncycastle.asn1.ASN1ObjectIdentifier,Attribute>();
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(identity.certificates().getFirst().getEncoded());
        var binding=new Attribute(PKCSObjectIdentifiers.id_aa_signingCertificateV2,new DERSet(new SigningCertificateV2(new ESSCertIDv2(hash))));
        attributes.put(binding.getAttrType(),binding);
        attributes.put(CMSAttributes.signingTime,new Attribute(CMSAttributes.signingTime,new DERSet(new Time(Date.from(at)))));
        var signer=new JcaSignerInfoGeneratorBuilder(new JcaDigestCalculatorProviderBuilder().setProvider(SigningIdentity.BC).build());
        var defaults=new DefaultSignedAttributeTableGenerator(new AttributeTable(attributes));
        signer.setSignedAttributeGenerator(parameters->{
            var generated=defaults.getAttributes(parameters);
            return pdf?generated.remove(CMSAttributes.signingTime):generated;
        });
        var generator=new CMSSignedDataStreamGenerator();
        generator.addSignerInfoGenerator(signer.build(new JcaContentSignerBuilder(identity.algorithm()).setProvider(SigningIdentity.BC).build(identity.key()),identity.certificates().getFirst()));
        generator.addCertificates(new JcaCertStore(identity.certificates()));
        var output=new ByteArrayOutputStream();
        try(OutputStream content=generator.open(output,false)){bytes.transferTo(content);}
        byte[] encoded=timestampClient==null?output.toByteArray():timestampClient.timestampCms(output.toByteArray());
        return pdf?org.bouncycastle.asn1.ASN1Primitive.fromByteArray(encoded).getEncoded(org.bouncycastle.asn1.ASN1Encoding.DER):encoded;
    }
}
