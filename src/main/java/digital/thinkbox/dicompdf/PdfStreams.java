package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.filter.FilterFactory;
import org.apache.pdfbox.pdmodel.common.PDStream;

/** PDFBox filter implementations with disk-backed intermediate output instead of RAM buffers. */
final class PdfStreams {
    private PdfStreams(){}
    static InputStream open(PDStream stream)throws IOException{
        var filters=stream.getFilters();if(filters==null||filters.isEmpty())return stream.getCOSObject().createRawInputStream();
        COSBase parameters=stream.getCOSObject().getDictionaryObject(COSName.DECODE_PARMS);
        if(parameters instanceof COSArray array&&array.size()==1)parameters=array.getObject(0);
        if(filters.size()==1&&Set.of("FlateDecode","Fl").contains(filters.getFirst().getName())
            &&(parameters==null||parameters instanceof COSNull||parameters instanceof COSDictionary d&&d.getInt(COSName.PREDICTOR,1)<=1)){
            // Standard zlib stream, without image predictors: JDK's incremental
            // inflater avoids PDFBox's eager, whole-output decode buffer.
            return new InflaterInputStream(stream.getCOSObject().createRawInputStream(),new Inflater(),64*1024){
                @Override public void close()throws IOException{try{super.close();}finally{inf.end();}}
            };
        }
        Path directory=SourceContent.scratchDirectory("decoded-stream-",null);
        InputStream current=null;
        try{
            current=stream.getCOSObject().createRawInputStream();
            for(int i=0;i<filters.size();i++){
                Path decoded=directory.resolve("filter-"+i);var input=current;
                try(input;var output=Files.newOutputStream(decoded,StandardOpenOption.CREATE_NEW)){
                    FilterFactory.INSTANCE.getFilter(filters.get(i)).decode(input,output,stream.getCOSObject(),i);
                }
                current=Files.newInputStream(decoded);
            }
            return new FilterInputStream(current){
                private boolean closed;
                @Override public void close()throws IOException{if(closed)return;closed=true;try{super.close();}finally{remove(directory);}}
            };
        }catch(Throwable failure){if(current!=null)try{current.close();}catch(IOException ignored){}remove(directory);throw failure;}
    }
    private static void remove(Path directory)throws IOException{
        try(var files=Files.list(directory)){for(var path:files.toList())Files.deleteIfExists(path);}Files.deleteIfExists(directory);
    }
}
