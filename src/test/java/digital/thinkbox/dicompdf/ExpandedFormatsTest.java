package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Cross-format checks use only deterministic generated pixels, never patient-image corpora. */
class ExpandedFormatsTest {
    private static final Set<String> COMPRESSED_FIXTURES=Set.of("ct-jpeg2000-lossless16.dcm","sc-jpegls-lossless-gray8.dcm",
            "sc-jpegls-lossless-gray16.dcm","sc-jpegls-near-lossless-gray8.dcm");
    @TempDir Path temporary;

    @Test void nativeAndImageIoFormatsRenderRealPixels()throws Exception {
        Path input=temporary.resolve("native-and-imageio");ExpandedSyntheticFixtures.writeAll(input);
        Map<String,DicomInput.Result> decoded=new LinkedHashMap<>();
        try(var files=Files.list(input)) {
            for(Path file:files.sorted().toList()) {
                var result=DicomInput.inspect(Files.readAllBytes(file));
                assertNotNull(result.image(),file.getFileName()+": "+result.reason());
                assertEquals(ExpandedSyntheticFixtures.WIDTH,result.image().getWidth());
                assertEquals(ExpandedSyntheticFixtures.HEIGHT,result.image().getHeight());
                decoded.put(file.getFileName().toString(),result);
            }
        }
        assertEquals(21,decoded.size());
        assertEquals(DicomInput.previewSha256(decoded.get("sc-rgb-interleaved.dcm").image()),
                DicomInput.previewSha256(decoded.get("sc-rgb-planar.dcm").image()),"Planar/interleaved RGB must show the same pixels");
        assertEquals(DicomInput.previewSha256(decoded.get("sc-native-gray8.dcm").image()),
                DicomInput.previewSha256(decoded.get("sc-rle-gray8.dcm").image()),"Lossless RLE must match raw native pixels");
        assertEquals(DicomInput.previewSha256(decoded.get("ct-explicit-le-16.dcm").image()),
                DicomInput.previewSha256(decoded.get("ct-deflated-16.dcm").image()),"Deflation must preserve the image");
        assertEquals(DicomInput.previewSha256(decoded.get("ct-explicit-le-16.dcm").image()),
                DicomInput.previewSha256(decoded.get("ct-explicit-be-16.dcm").image()),"Endian interpretation must preserve the image");
        for(String name:List.of("sc-rgb-interleaved.dcm","sc-rgb-planar.dcm","sc-ybr-full.dcm","sc-ybr-full-422.dcm","sc-palette-color.dcm","sc-jpeg-baseline-rgb.dcm")) {
            var image=decoded.get(name).image();int red=image.getRGB(10,10),green=image.getRGB(32,10),blue=image.getRGB(54,10);
            assertTrue(((red>>16)&255)>150 && ((red>>8)&255)<90 && (red&255)<90,name+" red patch");
            assertTrue(((green>>8)&255)>150 && ((green>>16)&255)<90 && (green&255)<90,name+" green patch");
            assertTrue((blue&255)>150 && ((blue>>8)&255)<90 && ((blue>>16)&255)<90,name+" blue patch");
        }
        var bit=decoded.get("sc-single-bit.dcm").image();
        assertTrue((bit.getRGB(5,5)&255)<40 && (bit.getRGB(50,5)&255)>200,"Packed one-bit samples must unpack with correct bit order");
        for(String name:List.of("sc-jpeg-lossless-sv1-gray8.dcm","sc-jpeg-lossless14-gray8.dcm","sc-jpeg-lossless-sv1-gray12.dcm")) {
            var image=decoded.get(name).image();
            assertEquals(image.getRGB(0,0),image.getRGB(63,47),name+" constant SOF3 fixture must remain constant");
            assertTrue((image.getRGB(0,0)&255)>20 && (image.getRGB(0,0)&255)<240,name+" must not decode as a blank black/white image");
        }
    }

    @Test void frameSelectionUsesDistinctOriginalFramesWithoutChangingTheSource()throws Exception {
        Path input=temporary.resolve("frames");ExpandedSyntheticFixtures.writeAll(input);
        byte[] bytes=Files.readAllBytes(input.resolve("sc-multiframe-gray8.dcm")),snapshot=bytes.clone();
        var first=DicomInput.inspect(bytes,1);var second=DicomInput.inspect(bytes,2);
        assertNotNull(first.image(),first.reason());assertNotNull(second.image(),second.reason());
        assertNotEquals(DicomInput.previewSha256(first.image()),DicomInput.previewSha256(second.image()));
        assertEquals("1",first.displayAdjustments().get("sourceFrame"));assertEquals("2",second.displayAdjustments().get("sourceFrame"));
        assertNull(DicomInput.inspect(bytes,3).image(),"Frame beyond supplied count must fail explicitly");
        assertArrayEquals(snapshot,bytes,"Rendering must never change the original bytes");
    }

    @Test void enhancedFramesUseExclusivePerFrameWindowAndRescaleMacros()throws Exception {
        Path input=temporary.resolve("functional-groups");ExpandedSyntheticFixtures.writeAll(input);
        byte[] bytes=Files.readAllBytes(input.resolve("mr-enhanced-functional-groups.dcm"));
        var first=DicomInput.inspect(bytes,1);var second=DicomInput.inspect(bytes,2);
        assertNotNull(first.image(),first.reason());assertNotNull(second.image(),second.reason());
        assertEquals("1024.0",first.displayAdjustments().get("windowCenter"));assertEquals("2048.0",first.displayAdjustments().get("windowWidth"));
        assertEquals("1.0",first.displayAdjustments().get("rescaleSlope"));assertEquals("0.0",first.displayAdjustments().get("rescaleIntercept"));
        assertEquals("1000.0",second.displayAdjustments().get("windowCenter"));assertEquals("2000.0",second.displayAdjustments().get("windowWidth"));
        assertEquals("2.0",second.displayAdjustments().get("rescaleSlope"));assertEquals("-1000.0",second.displayAdjustments().get("rescaleIntercept"));
        assertEquals("functional-groups",second.displayAdjustments().get("windowSource"));assertEquals("functional-groups",first.displayAdjustments().get("rescaleSource"));
        assertNotEquals(DicomInput.previewSha256(first.image()),DicomInput.previewSha256(second.image()));
    }

    @Test void imageFormatsRenderAndPreserveEverySource()throws Exception {
        Path input=temporary.resolve("expanded");ExpandedSyntheticFixtures.writeAll(input);
        for(String file:COMPRESSED_FIXTURES)Files.copy(Path.of("fixtures/expanded").resolve(file),input.resolve(file));
        Path pdf=temporary.resolve("expanded.pdf");var manifest=DicomPdf.create(input,pdf);
        assertEquals("dicom-images",manifest.profile());assertEquals("0.4.0",manifest.profileVersion());
        assertEquals(25,manifest.images().size());
        try(var document=Loader.loadPDF(pdf.toFile())) {
            var files=document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            for(var image:manifest.images()) {
                byte[] source=Files.readAllBytes(input.resolve(image.sourcePath()));
                assertArrayEquals(source,files.get(image.attachment()).getEmbeddedFileUnicode().toByteArray(),image.sourcePath());
                assertEquals("rendered",image.status(),image.sourcePath()+": "+image.reason());
                assertEquals(1,image.sourceFrame());
            }
        }
        var checked=PackageTools.verify(pdf,input,null);
        assertEquals("PASS",checked.sourceBytes().status());assertEquals("PASS",checked.externalSources().status());
        assertEquals("PASS",checked.metadataAccuracy().status());assertEquals("PASS",checked.unresolvedReferences().status());
        Path recovery=temporary.resolve("recovery");assertEquals(25,PackageTools.extract(pdf,recovery).originals());
        try(var files=Files.list(input)){for(Path source:files.toList())assertArrayEquals(Files.readAllBytes(source),Files.readAllBytes(recovery.resolve("originals").resolve(source.getFileName())));}
    }
}
