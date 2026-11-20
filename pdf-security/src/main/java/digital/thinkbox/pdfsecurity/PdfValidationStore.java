package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.security.MessageDigest;
import java.security.cert.*;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.asn1.cms.ContentInfo;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.tsp.TimeStampToken;

/** Standard PDF DSS storage, not a trust source. Written before the export signature. */
public final class PdfValidationStore {
    private static final COSName DSS=COSName.getPDFName("DSS");
    private static final int MAX_ITEM=16*1024*1024,MAX_TOTAL=32*1024*1024,MAX_ENTRIES=256;
    public record Evidence(List<X509Certificate> certificates,List<X509CRL> crls,List<byte[]> ocsps){
        public Evidence{certificates=List.copyOf(certificates);crls=List.copyOf(crls);ocsps=ocsps.stream().map(byte[]::clone).toList();}
        @Override public List<byte[]> ocsps(){return ocsps.stream().map(byte[]::clone).toList();}
        public CertificatePolicy augment(CertificatePolicy policy){
            var combinedCrls=new ArrayList<>(policy.crls());combinedCrls.addAll(crls);
            var combinedOcsp=new ArrayList<>(policy.ocsps());combinedOcsp.addAll(ocsps);
            var supporting=new ArrayList<>(policy.supportingCertificates());supporting.addAll(certificates);
            return new CertificatePolicy(policy.anchors(),combinedCrls,policy.at(),deduplicate(combinedOcsp),supporting);
        }
    }
    private PdfValidationStore(){}
    public static void retain(PDDocument document,List<X509Certificate> certificates,CertificatePolicy policy)throws Exception{
        var catalog=document.getDocumentCatalog().getCOSObject();
        if(catalog.containsKey(DSS))throw new IOException("Replacing existing PDF validation evidence requires archival renewal support");
        var dictionary=new COSDictionary();dictionary.setName(COSName.TYPE,"DSS");
        var certs=new ArrayList<byte[]>();for(var cert:certificates)certs.add(cert.getEncoded());
        for(var cert:policy.supportingCertificates())certs.add(cert.getEncoded());
        var crls=new ArrayList<byte[]>();for(var crl:policy.crls())crls.add(crl.getEncoded());
        long[] total={0};
        put(document,dictionary,"Certs",certs,total);put(document,dictionary,"CRLs",crls,total);put(document,dictionary,"OCSPs",policy.ocsps(),total);
        catalog.setItem(DSS,dictionary);
        read(document); // Same bounded structural/DER parser used by the verifier.
    }
    private static void put(PDDocument document,COSDictionary d,String name,List<byte[]> items,long[] total)throws Exception{
        var unique=deduplicate(items);if(unique.isEmpty())return;
        if(unique.size()>MAX_ENTRIES)throw new IOException("PDF validation evidence count limit");
        var array=new COSArray();
        for(byte[] bytes:unique){
            total[0]+=bytes.length;if(bytes.length==0||bytes.length>MAX_ITEM||total[0]>MAX_TOTAL)throw new IOException("PDF validation evidence size limit");
            var stream=document.getDocument().createCOSStream();
            try(var out=stream.createOutputStream(COSName.FLATE_DECODE)){out.write(bytes);}
            array.add(stream);
        }
        d.setItem(COSName.getPDFName(name),array);
    }
    public static Evidence read(PDDocument document)throws Exception{
        var value=document.getDocumentCatalog().getCOSObject().getDictionaryObject(DSS);
        if(value==null)return null;
        if(!(value instanceof COSDictionary d)||value instanceof COSStream)throw new IOException("Invalid PDF DSS dictionary");
        for(var key:d.keySet())if(!Set.of("Type","Certs","CRLs","OCSPs").contains(key.getName()))throw new IOException("Unsupported PDF DSS entry");
        if(d.containsKey(COSName.TYPE)&&!"DSS".equals(d.getNameAsString(COSName.TYPE)))throw new IOException("Invalid PDF DSS type");
        var certs=new ArrayList<X509Certificate>();var crls=new ArrayList<X509CRL>();var ocsps=new ArrayList<byte[]>();
        var factory=CertificateFactory.getInstance("X.509");long total=0;
        for(String name:List.of("Certs","CRLs","OCSPs")){
            var entry=d.getDictionaryObject(COSName.getPDFName(name));if(entry==null)continue;
            if(!(entry instanceof COSArray array)||array.size()==0||array.size()>MAX_ENTRIES)throw new IOException("Invalid PDF validation evidence array");
            for(int i=0;i<array.size();i++){
                if(!(array.getObject(i) instanceof COSStream stream))throw new IOException("PDF validation evidence stream required");
                byte[] bytes;try(var input=stream.createInputStream()){bytes=input.readNBytes((int)Math.min(MAX_ITEM,MAX_TOTAL-total)+1);}
                total+=bytes.length;if(bytes.length==0||bytes.length>MAX_ITEM||total>MAX_TOTAL)throw new IOException("Expanded PDF validation evidence size limit");
                byte[] canonical;
                switch(name){
                    case "Certs"->{var cert=(X509Certificate)factory.generateCertificate(new ByteArrayInputStream(bytes));certs.add(cert);canonical=cert.getEncoded();}
                    case "CRLs"->{var crl=(X509CRL)factory.generateCRL(new ByteArrayInputStream(bytes));crls.add(crl);canonical=crl.getEncoded();}
                    default->{OfflineOcsp.parse(bytes);ocsps.add(bytes);canonical=bytes;}
                }
                if(!Arrays.equals(bytes,canonical))throw new IOException("Noncanonical or trailing PDF validation evidence");
            }
        }
        if(certs.isEmpty())throw new IOException("PDF DSS contains no certificates");
        return new Evidence(certs,crls,deduplicate(ocsps));
    }
    /** Public chains in a detached CMS and its signature timestamp, with no trust upgrade. */
    public static List<X509Certificate> cmsCertificates(byte[] encoded)throws Exception{
        if(encoded.length>Rfc3161Client.MAX_RESPONSE)throw new IOException("CMS evidence size limit");
        // PDF /Contents includes reserved zero padding, outside the CMS ASN.1 object.
        try(var input=new org.bouncycastle.asn1.ASN1InputStream(encoded)){
            var object=input.readObject();if(object==null)throw new IOException("Empty CMS evidence");
            encoded=object.getEncoded();for(int value;(value=input.read())!=-1;)if(value!=0)throw new IOException("Nonzero trailing CMS evidence");
        }
        var cms=new CMSSignedData(encoded);var result=new ArrayList<X509Certificate>();
        var converter=new JcaX509CertificateConverter().setProvider(SigningIdentity.BC);
        for(Object item:cms.getCertificates().getMatches(null))result.add(converter.getCertificate((X509CertificateHolder)item));
        for(var signer:cms.getSignerInfos().getSigners()){
            var attributes=signer.getUnsignedAttributes();var attribute=attributes==null?null:attributes.get(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken);
            if(attribute==null)continue;
            if(attributes.getAll(PKCSObjectIdentifiers.id_aa_signatureTimeStampToken).size()!=1||attribute.getAttrValues().size()!=1)throw new IOException("Ambiguous CMS timestamp");
            var token=new TimeStampToken(ContentInfo.getInstance(attribute.getAttrValues().getObjectAt(0)));
            for(Object item:token.getCertificates().getMatches(null))result.add(converter.getCertificate((X509CertificateHolder)item));
        }
        if(result.size()>MAX_ENTRIES)throw new IOException("CMS certificate count limit");
        return List.copyOf(result);
    }
    public static boolean containsCertificates(Evidence evidence,List<X509Certificate> required)throws Exception{
        var hashes=new HashSet<String>();for(var cert:evidence.certificates())hashes.add(hash(cert.getEncoded()));
        for(var cert:required)if(!hashes.contains(hash(cert.getEncoded())))return false;
        return true;
    }
    private static String hash(byte[] value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
    private static List<byte[]> deduplicate(List<byte[]> items){
        var result=new ArrayList<byte[]>();var seen=new HashSet<String>();
        for(var item:items){String key=Base64.getEncoder().encodeToString(item);if(seen.add(key))result.add(item.clone());}
        return List.copyOf(result);
    }
}
