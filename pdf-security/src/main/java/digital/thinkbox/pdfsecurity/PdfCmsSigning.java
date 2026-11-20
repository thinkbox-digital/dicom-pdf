package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.*;

/** Signs the completed PDF, separately from detached manifest signing. */
public final class PdfCmsSigning {
    private PdfCmsSigning() {}
    public static void sign(Path input,Path output,SigningIdentity identity,Instant at)throws Exception{
        sign(input,output,identity,at,null);
    }
    public static void sign(Path input,Path output,SigningIdentity identity,Instant at,Rfc3161Client timestampClient)throws Exception{
        sign(input,output,identity,at,timestampClient,null,true);
    }
    public static void sign(Path input,Path output,SigningIdentity identity,Instant at,Rfc3161Client timestampClient,C2paProfile profile,boolean finalizeC2pa)throws Exception{
        sign(input,output,identity,at,timestampClient,profile,finalizeC2pa,"Archive export integrity; source authenticity and completeness are not asserted");
    }
    public static void sign(Path input,Path output,SigningIdentity identity,Instant at,Rfc3161Client timestampClient,C2paProfile profile,boolean finalizeC2pa,String reason)throws Exception{
        if(Files.exists(output)||input.toAbsolutePath().normalize().equals(output.toAbsolutePath().normalize()))
            throw new IOException("PDF signing requires a new destination");
        identity.check(at);
        boolean created=false;
        try(var document=Loader.loadPDF(input.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache());var options=new SignatureOptions()){
            if(finalizeC2pa&&profile!=null&&C2pa.enabled(document,profile))C2pa.requireSigningCredential(identity);
            if(!document.getSignatureDictionaries().isEmpty())throw new IOException("Signing an already signed PDF requires evidence-renewal support");
            var signature=new PDSignature();signature.setFilter(PDSignature.FILTER_ADOBE_PPKLITE);
            signature.setSubFilter(PDSignature.SUBFILTER_ETSI_CADES_DETACHED);
            if(reason!=null&&!reason.isBlank())signature.setReason(reason);
            signature.setSignDate(GregorianCalendar.from(at.atZone(ZoneOffset.UTC)));
            options.setPreferredSignatureSize(128*1024);
            if(finalizeC2pa&&profile!=null&&C2pa.enabled(document,profile)){
                // Reserve the PDF signature before C2PA hashing; then patch both signatures in place.
                document.addSignature(signature,options);
                for(var field:document.getSignatureFields())field.setAlternateFieldName("Archive export signature");
                try(OutputStream destination=Files.newOutputStream(output,StandardOpenOption.CREATE_NEW)){
                    created=true;var external=document.saveIncrementalForExternalSigning(destination);external.setSignature(new byte[0]);
                }
                long[] ranges;
                try(var reserved=Loader.loadPDF(output.toFile())){ranges=C2pa.signatureRange(reserved.getSignatureDictionaries().getFirst());}
                C2pa.complete(output,identity,ranges,profile);
                byte[] cms;
                try(var first=Files.newInputStream(output);var second=Files.newInputStream(output)){
                    second.skipNBytes(ranges[2]);
                    var bounded=new FilterInputStream(first){long remaining=ranges[1];@Override public int read()throws IOException{if(remaining==0)return -1;int value=super.read();if(value>=0)remaining--;return value;}@Override public int read(byte[] bytes,int offset,int count)throws IOException{if(remaining==0)return -1;int n=super.read(bytes,offset,(int)Math.min(count,remaining));if(n>0)remaining-=n;return n;}};
                    cms=CmsSigning.signPdf(new SequenceInputStream(bounded,second),identity,at,timestampClient);
                }
                byte[] encoded=HexFormat.of().formatHex(cms).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
                if(encoded.length>ranges[2]-ranges[1]-2)throw new IOException("PDF signature exceeds reservation");
                try(var target=new RandomAccessFile(output.toFile(),"rw")){target.seek(ranges[1]+1);target.write(encoded);}
                return;
            }
            document.addSignature(signature,content->{try{return CmsSigning.signPdf(content,identity,at,timestampClient);}catch(Exception failure){throw new IOException("PDF CMS signing failed",failure);}},options);
            for(var field:document.getSignatureFields())field.setAlternateFieldName("Archive export signature");
            try(OutputStream destination=Files.newOutputStream(output,StandardOpenOption.CREATE_NEW)){
                created=true;
                document.saveIncremental(destination);
            }
        }catch(Exception failure){if(created)Files.deleteIfExists(output);throw failure;}
    }
}
