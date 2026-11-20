package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.util.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.apache.pdfbox.cos.COSName;

/** Check signature revision boundaries; this alone does not authorize later changes. */
final class PdfRevisions {
    private PdfRevisions(){}
    static long latestRevisionStart(PDDocument document,long size)throws IOException{
        var signatures=new ArrayList<>(document.getSignatureDictionaries());
        if(signatures.size()<2||signatures.size()>256)throw new IOException("Expected an export signature and bounded archival timestamps");
        var ends=new TreeMap<Long,PDSignature>();
        for(var signature:signatures){
            long[] range=C2pa.signatureRange(signature);
            if(range[0]!=0||range[1]<=0||range[2]<=range[1]||range[2]-range[1]>2L*1024*1024+2||range[3]<0||range[2]>size||range[3]>size-range[2])
                throw new IOException("Invalid PDF revision range");
            if(ends.put(range[2]+range[3],signature)!=null)throw new IOException("Ambiguous PDF revision boundaries");
        }
        if(ends.lastKey()!=size)throw new IOException("The final timestamp must cover the current PDF");
        var first=ends.pollFirstEntry();
        if(!"ETSI.CAdES.detached".equals(first.getValue().getSubFilter()))throw new IOException("Expected one archive export signature");
        long previous=first.getKey(),latestStart=previous;
        for(var entry:ends.entrySet()){
            var signature=entry.getValue();long[] range=C2pa.signatureRange(signature);
            if(!"ETSI.RFC3161".equals(signature.getSubFilter())||!"DocTimeStamp".equals(signature.getCOSObject().getNameAsString(COSName.TYPE))||range[1]<previous)
                throw new IOException("Only archival document timestamps may follow the export signature");
            latestStart=previous;previous=entry.getKey();
        }
        return latestStart;
    }
}
