package digital.thinkbox.dicompdf;

import java.nio.file.Files;
import java.nio.file.Path;
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

    private static DesktopViewerDocument.Display frame(DesktopViewerDocument document, int number) throws Exception {
        var display = document.load(document.entries.getFirst(), number, DesktopViewerDocument.INITIAL);
        assertNotNull(display.image());
        assertEquals(ExpandedSyntheticFixtures.WIDTH, display.image().getWidth());
        assertEquals(ExpandedSyntheticFixtures.HEIGHT, display.image().getHeight());
        return display;
    }
}
