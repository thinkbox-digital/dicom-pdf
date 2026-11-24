package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.filespecification.PDComplexFileSpecification;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DicomPdfTest {
    @TempDir Path temporary;

    @Test void preservesAllOriginalsAndMapsEveryReferencePageWithoutInventingMetadata() throws Exception {
        Path input = temporary.resolve("input");
        SyntheticFixtures.writeSupported(input);
        SyntheticFixtures.writeUnsupported(input.resolve("unsupported"));
        // Same basename in separate directories must not collide in ordinary PDF attachment tools.
        Files.createDirectories(input.resolve("duplicate"));
        Files.copy(input.resolve("explicit-le-8-unsigned-mono2.dcm"), input.resolve("duplicate/explicit-le-8-unsigned-mono2.dcm"));
        Path output = temporary.resolve("study.pdf");
        DicomPdf.create(input, output);
        try (PDDocument pdf = Loader.loadPDF(output.toFile())) {
            var files = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            assertNotNull(files);
            assertTrue(files.containsKey("manifest.json"));
            assertFalse(files.containsKey("viewer.html"));
            assertTrue(files.containsKey("dicom-xmp.rng"));
            JsonObject manifest = JsonParser.parseString(new String(bytes(files.get("manifest.json")), StandardCharsets.UTF_8)).getAsJsonObject();
            assertFalse(manifest.getAsJsonObject("artifactSha256").has("viewer.html"));
            assertEquals(2, manifest.get("schemaVersion").getAsInt());
            assertEquals("0.4.0", manifest.get("profileVersion").getAsString());
            assertEquals(ApplicationVersion.CREATOR, manifest.get("creator").getAsString());
            assertEquals("archival-master", manifest.get("sourceRole").getAsString());
            for (String resource : new String[]{"profile.json", "field-mapping.json", "RECOVERY.txt", "inventory.txt"}) assertTrue(files.containsKey(resource), "Missing recovery resource " + resource);
            JsonArray images = manifest.getAsJsonArray("images");
            assertEquals(31, images.size());
            assertTrue(pdf.getNumberOfPages() > images.size(), "Readable front matter must precede references");
            var originals = new HashSet<String>();
            var attachments = new HashSet<String>();
            var pages = new HashSet<Integer>();
            Map<String, PDImageXObject> renderedImages = new HashMap<>();
            int rendered = 0;
            int unrendered = 0;
            for (var item : images) {
                JsonObject image = item.getAsJsonObject();
                assertTrue(image.get("supplied").getAsBoolean());
                assertTrue(image.get("embedded").getAsBoolean());
                String relative = image.get("sourcePath").getAsString();
                assertTrue(originals.add(relative), "repeated source");
                Path original = input.resolve(relative);
                String attachment = image.get("attachment").getAsString();
                assertTrue(attachments.add(attachment), "attachment name collision");
                PDComplexFileSpecification specification = files.get(attachment);
                assertNotNull(specification);
                assertEquals("Source", specification.getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship")));
                byte[] expected = Files.readAllBytes(original);
                assertArrayEquals(expected, bytes(specification), relative);
                assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(expected)), image.get("sha256").getAsString());
                int page = image.get("referencePage").getAsInt();
                assertTrue(page > 1 && page <= pdf.getNumberOfPages());
                assertTrue(pages.add(page), "repeated reference page");
                PDImageXObject raster = raster(pdf.getPage(page - 1));
                if (image.get("status").getAsString().equals("rendered")) {
                    rendered++;
                    assertFalse(image.get("displayRejected").getAsBoolean());
                    assertEquals(1, image.get("sourceFrame").getAsInt());
                    JsonObject display = image.getAsJsonObject("displayAdjustments");
                    assertTrue(Double.parseDouble(display.get("windowWidth").getAsString()) >= 1);
                    assertEquals("disabled", display.get("overlayPolicy").getAsString());
                    assertEquals("0", display.get("rotationDegrees").getAsString());
                    assertNotNull(raster, relative + " has no reference image");
                    assertEquals(SyntheticFixtures.WIDTH, raster.getWidth());
                    assertEquals(SyntheticFixtures.HEIGHT, raster.getHeight());
                    renderedImages.put(relative, raster);
                    assertEquals(SyntheticFixtures.STUDY_UID, image.getAsJsonObject("fields").get("StudyInstanceUID").getAsString());
                    assertTrue(image.get("sopInstanceUID").getAsString().startsWith(SyntheticFixtures.STUDY_UID + "."));
                } else {
                    unrendered++;
                    assertTrue(image.get("displayRejected").getAsBoolean());
                    assertTrue(image.get("sourceFrame").isJsonNull());
                    assertNull(raster, "Unsupported source must have a diagnostic page");
                    assertFalse(image.get("reason").getAsString().isBlank());
                    if (relative.contains("-8-signed-")) assertTrue(image.get("reason").getAsString().contains("Signed 8-bit"));
                }
                if (relative.equals("missing-optional-metadata.dcm")) {
                    JsonObject fields = image.getAsJsonObject("fields");
                    for (String absent : new String[]{"PatientName", "PatientID", "StudyDate", "StudyTime",
                            "StudyDescription", "SeriesDescription", "ImageLaterality", "BodyPartExamined"}) {
                        assertFalse(fields.has(absent), "Invented source field: " + absent);
                    }
                }
            }
            assertEquals(29, rendered);
            assertEquals(2, unrendered);
            // Check actual photometric inversion independently of status/manifest flags.
            var mono1 = renderedImages.get("explicit-le-8-unsigned-mono1.dcm").getImage();
            var mono2 = renderedImages.get("explicit-le-8-unsigned-mono2.dcm").getImage();
            int light = mono1.getRGB(0, 0) & 255;
            int dark = mono2.getRGB(0, 0) & 255;
            assertTrue(light > dark + 150, "MONOCHROME1 must invert low pixel values");
            String text = new PDFTextStripper().getText(pdf);
            assertTrue(text.toLowerCase().contains("synthetic"));
            assertTrue(text.toLowerCase().contains("unrendered") || text.toLowerCase().contains("not rendered"));
            assertEquals(2.0f, pdf.getVersion());
            var factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            var metadata = factory.newDocumentBuilder().parse(new ByteArrayInputStream(pdf.getDocumentCatalog().getMetadata().toByteArray()));
            assertEquals("4", metadata.getElementsByTagNameNS("http://www.aiim.org/pdfa/ns/id/", "part").item(0).getTextContent());
            assertEquals("F", metadata.getElementsByTagNameNS("http://www.aiim.org/pdfa/ns/id/", "conformance").item(0).getTextContent());
            String xmpInventory = metadata.getElementsByTagNameNS(PdfMetadata.NAMESPACE, "inventoryJson").item(0).getTextContent();
            assertEquals(manifest, JsonParser.parseString(xmpInventory));
            assertEquals("Schema", files.get("dicom-xmp.rng").getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship")));
            assertTrue(new String(bytes(files.get("dicom-xmp.rng")), StandardCharsets.UTF_8).contains("http://relaxng.org/ns/structure/1.0"));
            COSArray associated = (COSArray) pdf.getDocumentCatalog().getCOSObject().getDictionaryObject(COSName.getPDFName("AF"));
            assertEquals(files.size(), associated.size());
            for (int i = 0; i < associated.size(); i++) assertInstanceOf(COSDictionary.class, associated.getObject(i));
        }
    }

    @Test void rejectsAnEmptyDirectoryWithoutCreatingAnOutput() throws Exception {
        Path input = temporary.resolve("empty");
        Files.createDirectories(input);
        Path output = temporary.resolve("empty.pdf");
        assertThrows(Exception.class, () -> DicomPdf.create(input, output));
        assertFalse(Files.exists(output));
    }

    private static byte[] bytes(PDComplexFileSpecification file) throws Exception {
        var embedded = file.getEmbeddedFileUnicode();
        return (embedded != null ? embedded : file.getEmbeddedFile()).toByteArray();
    }

    private static PDImageXObject raster(PDPage page) throws Exception {
        for (COSName name : page.getResources().getXObjectNames()) {
            if (page.getResources().getXObject(name) instanceof PDImageXObject image) return image;
        }
        return null;
    }
}
