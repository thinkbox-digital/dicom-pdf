package digital.thinkbox.dicompdf;

import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.util.Calendar;
import java.util.Map;
import java.util.TreeMap;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;

/** Associated-file and name-tree registration, following the EA-PDF attachment pattern. */
final class Attachments {
    private final PDDocument doc;
    private final Map<String, PDComplexFileSpecification> files = new TreeMap<>();
    private final COSArray associated = new COSArray();
    Attachments(PDDocument doc) { this.doc = doc; }
    PDComplexFileSpecification add(String name, byte[] data, String mime, String relationship, String description) throws Exception {
        return add(name,SourceContent.of(data),mime,relationship,description);
    }
    PDComplexFileSpecification add(String name, SourceContent data, String mime, String relationship, String description) throws Exception {
        if (files.containsKey(name)) throw new IllegalArgumentException("Duplicate attachment: " + name);
        var file = new PDComplexFileSpecification();
        file.setFile(name); file.setFileUnicode(name); file.setFileDescription(description);
        var md5=MessageDigest.getInstance("MD5");PDEmbeddedFile embedded;
        try(var input=new java.security.DigestInputStream(data.open(),md5)){embedded=new PDEmbeddedFile(doc,input,COSName.FLATE_DECODE);}
        embedded.setSubtype(mime); embedded.setModDate(Calendar.getInstance());
        if(embedded.getCOSObject().getDictionaryObject(COSName.PARAMS)==null)embedded.getCOSObject().setItem(COSName.PARAMS,new COSDictionary());
        COSDictionary params = (COSDictionary) embedded.getCOSObject().getDictionaryObject(COSName.PARAMS);
        params.setLong(COSName.SIZE,data.digest().length());
        params.setItem(COSName.CHECK_SUM, new COSString(md5.digest()));
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
