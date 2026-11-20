package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PackageLimitsTest {
    @TempDir Path temporary;
    private static final long MIB = 1024L * 1024;

    @Test void documentWriterStopsBeforeWritingBeyondItsBound() throws Exception {
        var bytes=new ByteArrayOutputStream();
        try(var output=PackageLimits.documentOutput(bytes,4)){
            output.write(new byte[]{1,2,3});output.write(4);
            assertThrows(IOException.class,()->output.write(5));
            assertThrows(IOException.class,()->output.write(new byte[]{6,7}));
            assertArrayEquals(new byte[]{1,2,3,4},bytes.toByteArray());
        }
    }

    @Test void resourceAndSavedDocumentRefusalsPreserveExistingOutputAndRemoveStaging() throws Exception {
        Path input=Files.createDirectory(temporary.resolve("input"));
        Files.copy(Path.of("fixtures/expanded/sc-native-gray8.dcm"),input.resolve("image.dcm"));
        Path output=temporary.resolve("existing.pdf");byte[] previous={17,23,42};Files.write(output,previous);
        assertThrows(IOException.class,()->DicomPdf.create(input,output,"archival-master",1,PackageLimits.DOCUMENT));
        assertArrayEquals(previous,Files.readAllBytes(output));
        assertThrows(IOException.class,()->DicomPdf.create(input,output,"archival-master",PackageLimits.ATTACHMENTS,1));
        assertArrayEquals(previous,Files.readAllBytes(output));
        try(var files=Files.list(temporary)){
            assertFalse(files.anyMatch(path->path.getFileName().toString().startsWith(".dicom-pdf-")));
        }
    }

    @Test void largeInputsAndResourcesHaveNoPilotByteCeiling() throws Exception {
        long used = PackageLimits.reserve(0, 128 * MIB);
        used = PackageLimits.reserve(used, 128 * MIB);
        used = PackageLimits.reserve(used, 64 * MIB);
        long full = used;
        assertEquals(320*MIB, full);
        // A viewer or manifest must not be excluded from the recovery budget.
        assertEquals(full+1,PackageLimits.reserve(full,1));
        assertEquals(5L*1024*MIB,PackageLimits.reserve(0,5L*1024*MIB));
    }

    @Test void exactBoundsAreInclusiveAndInvalidOrOverflowingLengthsFail() throws Exception {
        assertEquals(PackageLimits.PAYLOAD, PackageLimits.reserve(0, PackageLimits.PAYLOAD));
        assertEquals(PackageLimits.ATTACHMENTS, PackageLimits.reserve(PackageLimits.ATTACHMENTS, 0));
        assertThrows(IOException.class, () -> PackageLimits.reserve(0, PackageLimits.PAYLOAD + 1));
        assertThrows(IOException.class, () -> PackageLimits.reserve(-1, 0));
        assertThrows(IOException.class, () -> PackageLimits.reserve(0, -1));
        assertThrows(IOException.class, () -> PackageLimits.reserve(Long.MAX_VALUE, 1));
    }
}
