package digital.thinkbox.dicompdf;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.stream.FileImageInputStream;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.common.filespecification.PDEmbeddedFile;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

class DesktopViewerDirectDicomTest {
    private static final Path FIXTURES = Path.of("fixtures/expanded");

    @TempDir Path temporary;

    @Test void opensAndDisplaysAStandaloneDicomFile() throws Exception {
        var path = FIXTURES.resolve("ct-explicit-le-16.dcm");
        try (var document = DesktopViewerDocument.open(path)) {
            assertFalse(document.isArchive());
            assertFalse(document.hasInstitutionalEvidence());
            assertEquals(0, document.pages());
            assertEquals(1, document.entries.size());
            var entry = document.entries.getFirst();
            var metadata = document.selectedMetadata(entry);
            assertEquals(path.getFileName().toString(), metadata.get("Source file"));
            assertEquals("CT", metadata.get("Modality"));
            assertFalse(metadata.containsKey("Attachment"));
            assertFalse(metadata.containsKey("Original integrity"));
            assertFalse(metadata.containsKey("SHA-256"));
            assertFalse(metadata.containsKey("PDF reference page"));
            assertEquals(1, frame(document, 1).frames());
        }
    }

    @Test void decodesEachFrameOfADicomFileWithoutAnExtension() throws Exception {
        var path = Files.copy(FIXTURES.resolve("sc-multiframe-gray8.dcm"), temporary.resolve("multiframe"));
        try (var document = DesktopViewerDocument.open(path)) {
            var first = frame(document, 1);
            var second = frame(document, 2);
            assertEquals(2, first.frames());
            assertEquals(2, second.frames());
            assertNotEquals(first.image().getRGB(0, 0), second.image().getRGB(0, 0));
        }
    }

    @Test void displaysADicomDatasetWithoutPart10FileMeta() throws Exception {
        Attributes dataset;
        try (var input = new DicomInputStream(FIXTURES.resolve("sc-native-gray8.dcm").toFile())) {
            dataset = input.readDataset();
        }
        var path = temporary.resolve("dataset.bin");
        try (var output = new DicomOutputStream(Files.newOutputStream(path), UID.ExplicitVRLittleEndian)) {
            output.writeDataset(null, dataset);
        }
        try (var document = DesktopViewerDocument.open(path)) {
            assertFalse(document.isArchive());
            assertEquals(1, frame(document, 1).frames());
        }
    }

    @Test void reusesTheVerifiedSnapshotUntilTheSelectedOriginalChanges() throws Exception {
        var input = Files.createDirectory(temporary.resolve("input"));
        var multiframe = Files.copy(FIXTURES.resolve("sc-multiframe-gray8.dcm"), input.resolve("multiframe.dcm"));
        Files.copy(FIXTURES.resolve("ct-explicit-le-16.dcm"), input.resolve("single.dcm"));
        var archive = temporary.resolve("archive.pdf");
        DicomPdf.create(input, archive, "archival-master", false);

        SourceContent last;
        try (var document = DesktopViewerDocument.open(archive);
             var standalone = DesktopViewerDocument.open(multiframe)) {
            var selected = document.entries.stream().filter(e -> e.sourcePath().equals("multiframe.dcm")).findFirst().orElseThrow();
            var other = document.entries.stream().filter(e -> e != selected).findFirst().orElseThrow();
            var first = document.load(selected, 1, DesktopViewerDocument.INITIAL);
            var snapshot = document.checked(selected);
            try (var stream = snapshot.imageInput()) {
                assertInstanceOf(FileImageInputStream.class, stream);
            }
            assertEquals(SourceContent.file(multiframe).digest(), snapshot.digest());
            var second = document.load(selected, 2, DesktopViewerDocument.INITIAL);
            assertSame(snapshot, document.checked(selected));
            assertEquals(DicomInput.previewSha256(frame(standalone, 1).image()), DicomInput.previewSha256(first.image()));
            assertEquals(DicomInput.previewSha256(frame(standalone, 2).image()), DicomInput.previewSha256(second.image()));

            document.checked(other);
            assertSame(snapshot, document.checked(selected));
            document.load(other, 1, DesktopViewerDocument.INITIAL);
            assertThrows(IOException.class, () -> snapshot.open().close());
            last = document.checked(other);
        }
        assertThrows(IOException.class, () -> last.open().close());
    }

    @Test void rejectsAnOriginalWithTheRightSizeAndTheWrongDigest() throws Exception {
        var input = Files.createDirectory(temporary.resolve("input"));
        var original = Files.copy(FIXTURES.resolve("sc-multiframe-gray8.dcm"), input.resolve("multiframe.dcm"));
        var archive = temporary.resolve("archive.pdf");
        DicomPdf.create(input, archive, "archival-master", false);
        byte[] changed = Files.readAllBytes(original);
        changed[changed.length - 1] ^= 1;
        var modified = temporary.resolve("modified.pdf");
        try (var pdf = Loader.loadPDF(archive.toFile())) {
            var specification = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("original-0001.dcm");
            var replacement = new PDEmbeddedFile(pdf, new ByteArrayInputStream(changed), COSName.FLATE_DECODE);
            specification.setEmbeddedFile(replacement);
            specification.setEmbeddedFileUnicode(replacement);
            pdf.save(modified.toFile());
        }
        try (var document = DesktopViewerDocument.open(modified)) {
            var failure = assertThrows(IOException.class,
                    () -> document.load(document.entries.getFirst(), 1, DesktopViewerDocument.INITIAL));
            assertTrue(failure.getMessage().contains("recorded size and SHA-256"));
        }
    }

    private static DesktopViewerDocument.Display frame(DesktopViewerDocument document, int number) throws Exception {
        var display = document.load(document.entries.getFirst(), number, DesktopViewerDocument.INITIAL);
        assertNotNull(display.image());
        assertEquals(ExpandedSyntheticFixtures.WIDTH, display.image().getWidth());
        assertEquals(ExpandedSyntheticFixtures.HEIGHT, display.image().getHeight());
        return display;
    }
}
