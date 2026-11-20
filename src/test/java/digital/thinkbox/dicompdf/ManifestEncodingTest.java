package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.common.filespecification.PDComplexFileSpecification;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ManifestEncodingTest {
    @TempDir Path temporary;
    private Manifest manifest(Map<String,String> fields) {
        var image=new Manifest.Image("source.dcm","café/ภาพ.dcm",null,"0".repeat(64),0,2,
            "unrendered","Synthetic source",fields,true,true,true,null,Map.of(),null);
        return new Manifest(2,"dicom-images","0.3.0","test","archival-master",null,
            List.of(image),List.of(),Map.of(),Map.of());
    }
    @Test void mappingInsertionOrderCannotChangeManifestEvidence() throws Exception {
        Map<String,String> first=new LinkedHashMap<>(),second=new LinkedHashMap<>();
        first.put("SeriesDescription","Literal <text> café");first.put("StudyInstanceUID","2.25.1");
        second.put("StudyInstanceUID","2.25.1");second.put("SeriesDescription","Literal <text> café");
        assertArrayEquals(ManifestEncoding.encode(manifest(first)),ManifestEncoding.encode(manifest(second)));
        String encoded=new String(ManifestEncoding.encode(manifest(first)),StandardCharsets.UTF_8);
        assertTrue(encoded.contains("café/ภาพ.dcm"));assertTrue(encoded.contains("Literal <text> café"));
        assertFalse(encoded.contains("\n"));assertFalse(encoded.endsWith("\n"));
    }
    @Test void repeatedCreationHasIdenticalManifestAndUnchangedOriginals() throws Exception {
        Path input=temporary.resolve("input");SyntheticFixtures.writeDeidentifiedCopy(input);
        Path first=temporary.resolve("first.pdf"),second=temporary.resolve("second.pdf");
        DicomPdf.create(input,first);DicomPdf.create(input,second);
        assertArrayEquals(manifestBytes(first),manifestBytes(second));
        assertEquals("PASS",PackageTools.verify(first,input,null).sourceBytes().status());
        assertEquals("PASS",PackageTools.verify(second,input,null).metadataAccuracy().status());
    }
    private byte[] manifestBytes(Path pdf) throws Exception {
        try(var doc=Loader.loadPDF(pdf.toFile())) {
            Map<String,PDComplexFileSpecification> files=doc.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            return files.get("manifest.json").getEmbeddedFileUnicode().toByteArray();
        }
    }
}
