package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;

/** Verifies bytes actually covered by the PDF signature, not the manifest's claims. */
public final class PdfCmsVerification {
    private PdfCmsVerification() {}
    public static Map<String,SecurityReport.Check> verify(Path pdf,CertificatePolicy policy){
        return verify(pdf,policy,null);
    }
    public static Map<String,SecurityReport.Check> verify(Path pdf,CertificatePolicy policy,String expectedCertificateSha256){
        var result=new LinkedHashMap<String,SecurityReport.Check>();
        String stage="READ";
        try{
            byte[] cms;long[] range=new long[4];
            try(var document=Loader.loadPDF(pdf.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
                var signatures=document.getSignatureDictionaries();
                if(signatures.stream().anyMatch(s->"ETSI.RFC3161".equals(s.getSubFilter())))
                    return DssPades.verify(pdf,policy,expectedCertificateSha256).checks();
                if(signatures.size()!=1)throw new IOException("Expected exactly one PDF export signature");
                var signature=signatures.getFirst();
                if(!PDSignature.SUBFILTER_ETSI_CADES_DETACHED.getName().equals(signature.getSubFilter()))throw new IOException("Unsupported PDF signature format");
                var values=signature.getCOSObject().getCOSArray(COSName.BYTERANGE);
                if(values==null||values.size()!=4)throw new IOException("Invalid byte range");
                for(int i=0;i<4;i++){if(!(values.getObject(i) instanceof COSInteger value))throw new IOException("Non-integer byte range");range[i]=value.longValue();}
                cms=signature.getContents();
            }
            long size=Files.size(pdf),gap=range[2]-range[1];
            stage="BYTE_RANGE";
            if(range[0]!=0||range[1]<=0||range[2]<=range[1]||range[3]<0||range[2]>size||range[3]!=size-range[2]||gap>2L*1024*1024+2)
                throw new IOException("PDF signature does not cover the complete file");
            try(var file=new RandomAccessFile(pdf.toFile(),"r")){
                stage="CONTENTS_BINDING";
                byte[] excluded=new byte[(int)gap];file.seek(range[1]);file.readFully(excluded);
                if(excluded[0]!='<'||excluded[excluded.length-1]!='>')throw new IOException("Unsupported signature Contents encoding");
                byte[] actual=HexFormat.of().parseHex(new String(excluded,1,excluded.length-2,java.nio.charset.StandardCharsets.US_ASCII));
                if(!Arrays.equals(actual,cms))throw new IOException("ByteRange excludes content other than the signature value");
            }
            result.put("coverage",new SecurityReport.Check(PASS,"COMPLETE_PDF_EXCEPT_SIGNATURE_CONTENTS"));
            // A valid byte range is a separate result from the retained evidence's validity.
            try(var document=Loader.loadPDF(pdf.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
                var evidence=PdfValidationStore.read(document);
                if(evidence!=null){
                    result.put("validationStore",new SecurityReport.Check(PASS,"BOUNDED_DER_DSS_PARSED_NOT_A_TRUST_ANCHOR"));
                    boolean complete=PdfValidationStore.containsCertificates(evidence,PdfValidationStore.cmsCertificates(cms));
                    result.put("retainedCertificates",new SecurityReport.Check(complete?PASS:FAIL,complete?"PDF_SIGNER_AND_TIMESTAMP_CHAINS_RETAINED":"PDF_SIGNER_OR_TIMESTAMP_CERTIFICATE_MISSING_FROM_DSS"));
                    policy=evidence.augment(policy);
                }else result.put("validationStore",new SecurityReport.Check(NOT_APPLICABLE,"NO_STANDARD_PDF_DSS_PRESENT"));
            }catch(Exception invalid){result.put("validationStore",new SecurityReport.Check(FAIL,"MALFORMED_OR_UNSUPPORTED_PDF_DSS"));}
            try(InputStream signed=new ByteRanges(pdf,range)){result.putAll(CmsVerification.verify(signed,cms,policy,expectedCertificateSha256));}
        }catch(Exception failure){result.put("coverage",new SecurityReport.Check(FAIL,"MISSING_INVALID_OR_UNSUPPORTED_PDF_SIGNATURE_"+stage));}
        return result;
    }
    private static final class ByteRanges extends InputStream {
        private final RandomAccessFile file;private final long[] range;private int part;private long remaining;
        ByteRanges(Path path,long[] range)throws IOException{file=new RandomAccessFile(path.toFile(),"r");this.range=range;remaining=range[1];}
        @Override public int read()throws IOException{byte[] one=new byte[1];return read(one,0,1)==-1?-1:one[0]&255;}
        @Override public int read(byte[] bytes,int offset,int length)throws IOException{
            Objects.checkFromIndexSize(offset,length,bytes.length);if(length==0)return 0;
            if(remaining==0){if(part==1)return -1;part=1;file.seek(range[2]);remaining=range[3];if(remaining==0)return -1;}
            int read=file.read(bytes,offset,(int)Math.min(remaining,length));if(read<0)throw new EOFException("Truncated signed PDF");remaining-=read;return read;
        }
        @Override public void close()throws IOException{file.close();}
    }
}
