package digital.thinkbox.pdfsecurity;

import eu.europa.esig.dss.model.*;
import eu.europa.esig.dss.pades.PAdESCommonParameters;
import eu.europa.esig.dss.pdf.*;
import eu.europa.esig.dss.pdf.pdfbox.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;

/** Uses DSS's prepared timestamp and resources, inserting its CMS in bounded blocks. */
final class StreamingPdfBoxFactory extends PdfBoxNativeObjectFactory {
    @Override public PDFSignatureService newArchiveTimestampService(){
        return configure(new PdfBoxSignatureService(PDFServiceMode.ARCHIVE_TIMESTAMP,getSignatureDrawerFactory()){
            @Override public DSSDocument sign(DSSDocument document,byte[] cms,PAdESCommonParameters parameters){
                var cached=parameters.getPdfSignatureCache().getToBeSignedDocument();
                if(!(cached instanceof FileDocument file)||file.getFile().length()>Integer.MAX_VALUE)
                    return super.sign(document,cms,parameters);
                try(var resources=instantiateResourcesHandler();var output=resources.createOutputStream()){
                    writeSignature(file.getFile().toPath(),cms,output);output.flush();
                    return resources.writeToDSSDocument();
                }catch(IOException failure){throw new DSSException("Could not fill the prepared archival timestamp slot",failure);}
                finally{parameters.reinit();}
            }
        });
    }
    static void writeSignature(Path prepared,byte[] cms,OutputStream output)throws IOException{
        if(cms==null||cms.length==0||cms.length>Rfc3161Client.MAX_RESPONSE)throw new IOException("Invalid timestamp token size");
        long length=Files.size(prepared);int[] range=null;
        try(var document=Loader.loadPDF(prepared.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())){
            for(var signature:document.getSignatureDictionaries()){
                int[] candidate=signature.getByteRange();
                if(candidate!=null&&candidate.length==4&&candidate[0]==0&&(long)candidate[2]+candidate[3]==length){
                    if(range!=null)throw new IOException("Ambiguous prepared timestamp slots");
                    range=candidate;
                }
            }
        }
        if(range==null||range[1]<0||range[2]<=range[1]||range[3]<0)throw new IOException("Invalid prepared timestamp byte ranges");
        long gap=(long)range[2]-range[1];
        if(gap<2L+2L*cms.length||gap>2L*Rfc3161Client.MAX_RESPONSE+2)throw new IOException("Timestamp does not fit the prepared slot");
        byte[] buffer=new byte[64*1024];
        try(var input=new BufferedInputStream(Files.newInputStream(prepared),buffer.length)){
            copy(input,output,range[1],buffer);
            byte[] slot=input.readNBytes((int)gap);
            if(slot.length!=gap||slot[0]!='<'||slot[slot.length-1]!='>')throw new IOException("Malformed prepared timestamp slot");
            for(int i=1;i<slot.length-1;i++)if(slot[i]!='0')throw new IOException("Prepared timestamp slot is not empty");
            byte[] hex=HexFormat.of().withUpperCase().formatHex(cms).getBytes(StandardCharsets.US_ASCII);
            output.write('<');output.write(hex);
            Arrays.fill(buffer,(byte)'0');long padding=gap-2-hex.length;
            while(padding>0){int count=(int)Math.min(buffer.length,padding);output.write(buffer,0,count);padding-=count;}
            output.write('>');copy(input,output,range[3],buffer);
            if(input.read()!=-1)throw new IOException("Prepared PDF changed during timestamp insertion");
        }
    }
    private static void copy(InputStream input,OutputStream output,long length,byte[] buffer)throws IOException{
        while(length>0){int count=input.read(buffer,0,(int)Math.min(buffer.length,length));if(count<0)throw new EOFException("Truncated prepared PDF");output.write(buffer,0,count);length-=count;}
    }
}
