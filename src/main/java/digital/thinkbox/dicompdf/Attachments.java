package digital.thinkbox.dicompdf;

import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.Calendar;
import java.util.Map;
import java.util.TreeMap;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.filter.Filter;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import java.util.zip.*;

/** Associated-file and name-tree registration, following the EA-PDF attachment pattern. */
final class Attachments {
    private final PDDocument doc;
    private final Map<String, PDComplexFileSpecification> files = new TreeMap<>();
    private final COSArray associated = new COSArray();

    record Encoded(Path path,byte[] md5){}

    Attachments(PDDocument doc) { this.doc = doc; }
    PDComplexFileSpecification add(String name, byte[] data, String mime, String relationship, String description) throws Exception {
        return add(name,SourceContent.of(data),mime,relationship,description);
    }
    PDComplexFileSpecification add(String name, SourceContent data, String mime, String relationship, String description) throws Exception {
        var embedded=flateStream();
        byte[] md5;
        try(var output=embedded.getCOSObject().createRawOutputStream()){
            md5=deflate(data,output);
        }
        return register(name,embedded,data.digest().length(),md5,mime,relationship,description);
    }
    static Encoded prepare(SourceContent data,Path path)throws Exception{
        try(var output=Files.newOutputStream(path,StandardOpenOption.CREATE_NEW)){
            return new Encoded(path,deflate(data,output));
        }
    }
    PDComplexFileSpecification add(String name,Encoded data,long size,String mime,String relationship,String description)throws Exception{
        var embedded=flateStream();
        try(var input=Files.newInputStream(data.path());var output=embedded.getCOSObject().createRawOutputStream()){
            input.transferTo(output);
        }
        Files.delete(data.path());
        return register(name,embedded,size,data.md5(),mime,relationship,description);
    }
    private PDEmbeddedFile flateStream(){
        var embedded=new PDEmbeddedFile(doc);
        embedded.getCOSObject().setItem(COSName.FILTER,COSName.FLATE_DECODE);
        return embedded;
    }
    private static byte[] deflate(SourceContent data,OutputStream output)throws Exception{
        var md5=MessageDigest.getInstance("MD5");
        var deflater=new Deflater(Filter.getCompressionLevel());
        try(var input=new DigestInputStream(data.openDigesting(),md5)){
            var compressed=new DeflaterOutputStream(output,deflater,64*1024);
            input.transferTo(compressed);
            compressed.finish();
        }finally{deflater.end();}
        return md5.digest();
    }
    private PDComplexFileSpecification register(String name,PDEmbeddedFile embedded,long size,byte[] md5,String mime,String relationship,String description){
        if (files.containsKey(name)) throw new IllegalArgumentException("Duplicate attachment: " + name);
        var file = new PDComplexFileSpecification();
        file.setFile(name); file.setFileUnicode(name); file.setFileDescription(description);
        embedded.setSubtype(mime); embedded.setModDate(Calendar.getInstance());
        if(embedded.getCOSObject().getDictionaryObject(COSName.PARAMS)==null)embedded.getCOSObject().setItem(COSName.PARAMS,new COSDictionary());
        COSDictionary params = (COSDictionary) embedded.getCOSObject().getDictionaryObject(COSName.PARAMS);
        params.setLong(COSName.SIZE,size);
        params.setItem(COSName.CHECK_SUM, new COSString(md5));
        file.setEmbeddedFile(embedded); file.setEmbeddedFileUnicode(embedded);
        file.getCOSObject().setName(COSName.getPDFName("AFRelationship"), relationship);
        files.put(name, file); associated.add(file);
        return file;
    }
    void finish() throws Exception {
        var names = new PDDocumentNameDictionary(doc.getDocumentCatalog());
        var tree = new PDEmbeddedFilesNameTreeNode(); tree.setNames(files);
        names.setEmbeddedFiles(tree); doc.getDocumentCatalog().setNames(names);
        doc.getDocumentCatalog().getCOSObject().setItem(COSName.getPDFName("AF"), associated);
    }
}
