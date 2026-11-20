package digital.thinkbox.dicompdf;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import com.google.gson.JsonParser;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class CompressedXmpTest {
    @TempDir Path root;
    @Test void compressedXmpAndZipReceiptRemainVerifiableAndRecoverable()throws Exception{
        Path source=Files.createDirectory(root.resolve("source"));SyntheticFixtures.writeSupported(source);
        Path zip=root.resolve("study.zip");
        try(var archive=new java.util.zip.ZipOutputStream(Files.newOutputStream(zip))){
            for(Path path:InputFiles.collect(source)){archive.putNextEntry(new java.util.zip.ZipEntry(path.getFileName().toString()));Files.copy(path,archive);archive.closeEntry();}
        }
        Path work=Files.createDirectory(root.resolve("work")),pdf=root.resolve("archive.pdf");
        var request=new DesktopRequest(true,zip.toString(),pdf.toString(),"","",false).prepare(work,()->false);
        byte[] receipt=ImportProvenance.read(Path.of(request.importProvenance()));
        var manifest=DicomPdf.create(Path.of(request.input()),pdf,"archival-master",receipt);
        assertEquals(25,manifest.images().size());assertTrue(manifest.artifactSha256().containsKey("import-source.json"));
        assertTrue(manifest.images().stream().noneMatch(image->image.sourcePath().endsWith(".zip")));
        try(var document=Loader.loadPDF(pdf.toFile())){
            var metadata=document.getDocumentCatalog().getMetadata();assertEquals(COSName.FLATE_DECODE,metadata.getCOSObject().getCOSName(COSName.FILTER));
            byte[] decoded;try(var input=metadata.exportXMPMetadata()){decoded=input.readAllBytes();}
            long stored=metadata.getCOSObject().getInt(COSName.LENGTH);assertTrue(stored<decoded.length/2);
            assertTrue(new String(decoded,StandardCharsets.UTF_8).contains("metadataJson"));
        }
        var checked=PackageTools.verify(pdf,Path.of(request.input()),System.getProperty("dicompdf.test.verapdf"));
        assertEquals("PASS",checked.sourceBytes().status());assertEquals("PASS",checked.metadataAccuracy().status());
        if(System.getProperty("dicompdf.test.verapdf")!=null)assertEquals("PASS",checked.pdfa4f().status(),checked.pdfa4f().details().toString());
        PackageTools.extract(pdf,root.resolve("recovered"));
        assertArrayEquals(receipt,Files.readAllBytes(root.resolve("recovered/package/import-source.json")));
    }
}
