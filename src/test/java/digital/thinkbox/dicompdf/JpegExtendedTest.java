package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.HexFormat;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;

class JpegExtendedTest {
    @Test void rendersStandardAndLegacyScansAtFullPrecision() throws Exception {
        Attributes attrs = image();
        var expectedPixels = ByteBuffer.allocate(16 * 8 * Short.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 16; x++) expectedPixels.putShort((short) (x < 8 ? 1000 : 3000));
        }
        attrs.setBytes(Tag.PixelData, VR.OW, expectedPixels.array());
        var expected = DicomInput.inspect(bytes(attrs, UID.ExplicitVRLittleEndian));
        assertNotNull(expected.image(), expected.reason());

        for (int spectralEnd : new int[]{0, 63}) {
            byte[] source = compressed(image(), jpeg(spectralEnd));
            byte[] original = source.clone();
            var result = DicomInput.inspect(source);
            assertNotNull(result.image(), result.reason());
            assertEquals("2000.5", result.displayAdjustments().get("windowCenter"));
            assertEquals("2001.0", result.displayAdjustments().get("windowWidth"));
            assertEquals(DicomInput.previewSha256(expected.image()), DicomInput.previewSha256(result.image()));
            assertArrayEquals(original, source);
            assertNull(DicomInput.inspectForPreview(source, 1, null, true, false).image());
        }
    }

    @Test void rejectsIncompleteScansAndMismatchedDimensions() throws Exception {
        byte[] frame = jpeg(63);
        var incomplete = DicomInput.inspect(compressed(image(), Arrays.copyOf(frame, frame.length - 2)));
        assertNull(incomplete.image());
        assertEquals("Missing or invalid JPEG Extended end of image", incomplete.reason());

        Attributes attrs = image();
        attrs.setInt(Tag.Columns, VR.US, 17);
        var mismatch = DicomInput.inspect(compressed(attrs, frame));
        assertNull(mismatch.image());
        assertEquals("JPEG Extended dimensions differ from DICOM metadata", mismatch.reason());
    }

    @Test void rendersFramesSplitAcrossFragmentsWithTheirOwnWindows() throws Exception {
        byte[] first = jpeg(0), second = jpeg(63);
        int boundary = 42;
        byte[] offsetTable = ByteBuffer.allocate(2 * Integer.BYTES).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(0).putInt(((first.length + 1) & ~1) + 16).array();
        for (var table : new byte[][]{new byte[0], offsetTable}) {
            Attributes attrs = image();
            attrs.setInt(Tag.NumberOfFrames, VR.IS, 2);
            var perFrame = attrs.newSequence(Tag.PerFrameFunctionalGroupsSequence, 2);
            perFrame.add(new Attributes());
            var frame2 = new Attributes();
            perFrame.add(frame2);
            var window = new Attributes();
            window.setString(Tag.WindowCenter, VR.DS, "2500");
            window.setString(Tag.WindowWidth, VR.DS, "3000");
            frame2.newSequence(Tag.FrameVOILUTSequence, 1).add(window);
            var geometry = new Attributes();
            geometry.setString(Tag.PixelSpacing, VR.DS, "0.5", "1");
            frame2.newSequence(Tag.PixelMeasuresSequence, 1).add(geometry);
            byte[] source = compressedWithOffsetTable(attrs, table, Arrays.copyOf(first, boundary),
                    Arrays.copyOfRange(first, boundary, first.length), Arrays.copyOf(second, boundary),
                    Arrays.copyOfRange(second, boundary, second.length));

            var initial = DicomInput.inspect(source, 1);
            var selected = DicomInput.inspect(source, 2);
            assertNotNull(initial.image(), initial.reason());
            assertNotNull(selected.image(), selected.reason());
            assertEquals("2", selected.displayAdjustments().get("sourceFrame"));
            assertEquals("2500.0", selected.displayAdjustments().get("windowCenter"));
            assertEquals("3000.0", selected.displayAdjustments().get("windowWidth"));
            assertEquals("functional-groups", selected.displayAdjustments().get("windowSource"));
            assertEquals("0.5:1", selected.displayAdjustments().get("pixelAspectRatio"));
            assertNotEquals(DicomInput.previewSha256(initial.image()), DicomInput.previewSha256(selected.image()));
        }
    }

    private static Attributes image() {
        var attrs = new Attributes();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.MultiFrameGrayscaleWordSecondaryCaptureImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, "2.25.1000");
        attrs.setInt(Tag.Rows, VR.US, 8);
        attrs.setInt(Tag.Columns, VR.US, 16);
        attrs.setInt(Tag.SamplesPerPixel, VR.US, 1);
        attrs.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        attrs.setInt(Tag.BitsAllocated, VR.US, 16);
        attrs.setInt(Tag.BitsStored, VR.US, 12);
        attrs.setInt(Tag.HighBit, VR.US, 11);
        attrs.setInt(Tag.PixelRepresentation, VR.US, 0);
        return attrs;
    }

    private static byte[] compressed(Attributes attrs, byte[]... fragments) throws Exception {
        return compressedWithOffsetTable(attrs, new byte[0], fragments);
    }

    private static byte[] compressedWithOffsetTable(Attributes attrs, byte[] offsetTable, byte[]... fragments) throws Exception {
        var pixels = attrs.newFragments(Tag.PixelData, VR.OB, fragments.length + 1);
        pixels.add(offsetTable);
        pixels.addAll(Arrays.asList(fragments));
        return bytes(attrs, UID.JPEGExtended12Bit);
    }

    private static byte[] bytes(Attributes attrs, String syntax) throws Exception {
        var bytes = new ByteArrayOutputStream();
        try (var stream = new DicomOutputStream(bytes, UID.ExplicitVRLittleEndian)) {
            stream.writeDataset(attrs.createFileMetaInformation(syntax), attrs);
        }
        return bytes.toByteArray();
    }

    private static byte[] jpeg(int spectralEnd) {
        // Two 8x8 blocks with DC values -1048 and +952 reconstruct samples 1000 and 3000.
        return HexFormat.of().parseHex("ffd8ffdb00430008" + "01".repeat(63)
                + "ffc1000b0c0008001001011100"
                + "ffc40027000101" + "00".repeat(14) + "000b1001" + "00".repeat(15) + "00"
                + "ffda000801010000" + HexFormat.of().toHexDigits((byte) spectralEnd) + "00"
                + "9f3afa0fffd9");
    }
}
