package example;

import com.upokecenter.cbor.CBORObject;
import digital.thinkbox.pdfsecurity.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;

/** A separate Maven consumer: no dependency on the DICOM application or its archive profile. */
public final class ReusableSigningExample {
    private static final C2paProfile PROFILE=new C2paProfile(){
        public String credentialsFile(){return "example-content-credentials.c2pa";}
        public String policyFile(){return "example-provenance-policy.json";}
        public byte[] policyBytes(){return "{\"purpose\":\"EXAMPLE_RECEIPT\"}\n".getBytes(StandardCharsets.UTF_8);}
        public String assertionLabel(){return "org.example.receipt";}
        public String generatorName(){return "standalone-pdf-consumer";}
        public String generatorVersion(){return "1.0.0";}
        public CBORObject createAssertion(PDDocument document,boolean local)throws Exception{
            return CBORObject.NewMap().Add("receiptDigest",C2pa.attachmentDigest(document,"example-receipt.json"));
        }
        public void verifyAssertion(PDDocument document,CBORObject assertion)throws Exception{
            if(!MessageDigest.isEqual(assertion.get("receiptDigest").GetByteString(),C2pa.attachmentDigest(document,"example-receipt.json")))throw new IOException("Receipt differs from its signed claim");
        }
    };
    private ReusableSigningExample(){}
    public static void main(String[] args)throws Exception{
        if(args.length!=1)throw new IllegalArgumentException("Usage: ReusableSigningExample <new-output.pdf>");
        Path destination=Path.of(args[0]).toAbsolutePath().normalize();
        if(Files.exists(destination,LinkOption.NOFOLLOW_LINKS))throw new IOException("Choose a new output PDF");
        Files.createDirectories(destination.getParent());Path staged=Files.createTempFile(destination.getParent(),".example-provenance-",".pdf");
        try{
            try(var document=new PDDocument()){
                document.addPage(new PDPage());
                var metadata=new PDMetadata(document);metadata.importXMPMetadata(("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"><xmpMM:InstanceID>urn:uuid:"+UUID.randomUUID()+"</xmpMM:InstanceID></rdf:Description></rdf:RDF></x:xmpmeta>").getBytes(StandardCharsets.UTF_8));document.getDocumentCatalog().setMetadata(metadata);
                byte[] data="{\"example\":\"SYNTHETIC RECEIPT\"}\n".getBytes(StandardCharsets.UTF_8);
                var stream=new PDEmbeddedFile(document,new ByteArrayInputStream(data));stream.setSubtype("application/json");stream.setSize(data.length);
                var file=new PDComplexFileSpecification();file.setFile("example-receipt.json");file.setFileUnicode("example-receipt.json");file.setEmbeddedFile(stream);file.setEmbeddedFileUnicode(stream);file.getCOSObject().setName(COSName.getPDFName("AFRelationship"),"Data");
                var tree=new PDEmbeddedFilesNameTreeNode();tree.setNames(new TreeMap<>(Map.of("example-receipt.json",file)));var names=new PDDocumentNameDictionary(document.getDocumentCatalog());names.setEmbeddedFiles(tree);document.getDocumentCatalog().setNames(names);
                C2pa.prepare(document,PROFILE);document.save(staged.toFile());
            }
            // No configured identity: this example deliberately demonstrates local, untrusted C2PA only.
            C2pa.complete(staged,null,null,PROFILE);
            var checks=C2pa.verify(staged,PROFILE);
            for(String key:List.of("c2pa.signature","c2pa.binding"))if(checks.get(key)==null||checks.get(key).status()!=SecurityReport.Status.PASS)throw new IOException("Independent library example did not verify: "+checks);
            Files.createLink(destination,staged);
            System.out.println(new SecurityReport(1,"EXAMPLE_INTEGRITY_ONLY",java.time.Instant.now().toString(),"NO_TRUSTED_TIMESTAMP",checks).json());
        }finally{Files.deleteIfExists(staged);}
    }
}
