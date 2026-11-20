package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.*;

/** Finalize C2PA and then the covering document timestamp in the same revision. */
public final class C2paPades {
    private C2paPades(){}
    public static void finish(Path input,Path output,SigningIdentity identity,Rfc3161Client timestamp,Instant at,C2paProfile profile)throws Exception{
        if(identity==null||timestamp==null)throw new IOException("C2PA archival revisions require a signing identity and timestamp service");
        C2pa.requireSigningCredential(identity);
        if(Files.exists(output,LinkOption.NOFOLLOW_LINKS)||input.toAbsolutePath().normalize().equals(output.toAbsolutePath().normalize()))throw new IOException("C2PA archival signing requires a new output PDF");
        identity.check(at);boolean created=false;
        try{
            byte[] marker;
            try(var document=Loader.loadPDF(input.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache());var options=new SignatureOptions()){
                if(!C2pa.enabled(document,profile)||document.getSignatureDictionaries().isEmpty())throw new IOException("Missing C2PA reservation or export signature");
                marker=C2pa.reserveRevision(document,profile);
                var signature=new PDSignature();signature.setFilter(PDSignature.FILTER_ADOBE_PPKLITE);
                signature.setSubFilter(COSName.getPDFName("ETSI.RFC3161"));signature.getCOSObject().setName(COSName.TYPE,"DocTimeStamp");
                options.setPreferredSignatureSize(128*1024);document.addSignature(signature,options);
                for(var field:document.getSignatureFields())if(field.getSignature()!=null&&field.getSignature().getCOSObject()==signature.getCOSObject())field.setAlternateFieldName("C2PA archival document timestamp");
                try(var destination=Files.newOutputStream(output,StandardOpenOption.CREATE_NEW)){
                    created=true;document.saveIncrementalForExternalSigning(destination).setSignature(new byte[0]);
                }
            }
            long[] range;
            try(var document=Loader.loadPDF(output.toFile())){
                range=C2pa.signatureRange(document.getSignatureDictionaries().stream().max(Comparator.comparingLong(signature->{try{var r=C2pa.signatureRange(signature);return r[2]+r[3];}catch(IOException failure){throw new IllegalArgumentException(failure);}})).orElseThrow());
            }
            C2pa.complete(output,identity,range,marker,profile);
            byte[] token;
            try(var first=Files.newInputStream(output);var second=Files.newInputStream(output)){
                second.skipNBytes(range[2]);
                var bounded=new FilterInputStream(first){long remaining=range[1];
                    @Override public int read()throws IOException{if(remaining==0)return -1;int value=super.read();if(value>=0)remaining--;return value;}
                    @Override public int read(byte[] bytes,int offset,int count)throws IOException{if(remaining==0)return -1;int n=super.read(bytes,offset,(int)Math.min(count,remaining));if(n>0)remaining-=n;return n;}
                };
                token=timestamp.timestampDocument(new SequenceInputStream(bounded,second));
            }
            byte[] encoded=HexFormat.of().formatHex(token).getBytes(StandardCharsets.US_ASCII);
            if(encoded.length>range[2]-range[1]-2)throw new IOException("Document timestamp exceeds reservation");
            try(var file=new RandomAccessFile(output.toFile(),"rw")){file.seek(range[1]+1);file.write(encoded);}
        }catch(Exception failure){if(created)Files.deleteIfExists(output);throw failure;}
    }
}
