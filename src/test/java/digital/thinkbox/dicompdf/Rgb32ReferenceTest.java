package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class Rgb32ReferenceTest {
    private static final int[] FRAME_ONE = {0x40000100, 0x80000200, 0xc0000300, -1, 0, 0x80000400};
    private static final int[] FRAME_TWO = {0, -1, 0x10000000, 0, -1, 0x10000000};
    private static final int[] EXPECTED_ONE = {0x4080bf, 0xff0080};
    private static final int[] EXPECTED_TWO = {0x00ff10, 0x00ff10};

    @TempDir Path temporary;

    @Test void nativeFramesScaleUnsignedChannelsInBothPlanarLayoutsAndByteOrders() throws Exception {
        for (String syntax : List.of(UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian,
                UID.DeflatedExplicitVRLittleEndian, UID.ExplicitVRBigEndian)) {
            for (int planar : new int[]{0, 1}) {
                var attrs = rgb(2, planar, 32, 31);
                byte[] source = nativeDicom(attrs, syntax, VR.OW, FRAME_ONE, FRAME_TWO);
                assertFrame(source, 1, EXPECTED_ONE);
                assertFrame(source, 2, EXPECTED_TWO);
            }
        }
        byte[] byteEncoded = nativeDicom(rgb(1, 0, 32, 31), UID.ExplicitVRBigEndian, VR.OB, FRAME_ONE);
        assertFrame(byteEncoded, 1, EXPECTED_ONE);
    }

    @Test void scalesOnlyDeclaredBitsAndPreservesTheHistoricalRejection() throws Exception {
        var attrs = rgb(1, 0, 24, 27);
        int[] samples = {0xf8000003, 0xf4000005, 0xfffffff7, -1, 0, 0};
        byte[] source = nativeDicom(attrs, UID.ExplicitVRLittleEndian, VR.OW, samples);
        assertFrame(source, 1, new int[]{0x8040ff, 0xff0000});
        var historical = DicomInput.inspectForPreview(source, 1, Map.of(), true, false);
        assertNull(historical.image());
        assertEquals("Unsupported pixel bit layout; requires right-aligned 1/8/16-bit integer pixels", historical.reason());

        attrs.setInt(Tag.PixelRepresentation, VR.US, 1);
        assertNull(DicomInput.inspect(nativeDicom(attrs, UID.ExplicitVRLittleEndian, VR.OW, samples)).image());
        attrs.setInt(Tag.PixelRepresentation, VR.US, 0);
        attrs.setInt(Tag.PlanarConfiguration, VR.US, 2);
        assertNull(DicomInput.inspect(nativeDicom(attrs, UID.ExplicitVRLittleEndian, VR.OW, samples)).image());
        attrs.setInt(Tag.PlanarConfiguration, VR.US, 0);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, 2);
        assertNull(DicomInput.inspect(nativeDicom(attrs, UID.ExplicitVRLittleEndian, VR.OW, samples)).image());
    }

    @Test void rleReadsTwelveBytePlanesAndSelectsTheRequestedFragment() throws Exception {
        byte[] first = rle(FRAME_ONE, false);
        byte[] second = rle(FRAME_TWO, true);
        for (byte[] offsets : List.of(new byte[0], ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(0).putInt(8 + first.length).array())) {
            byte[] source = rleDicom(offsets, first, second);
            assertFrame(source, 1, EXPECTED_ONE);
            assertFrame(source, 2, EXPECTED_TWO);
        }
        first[64] = 2; // The segment contains two pixels, so this three-byte literal must fail.
        assertNull(DicomInput.inspect(rleDicom(new byte[0], first, second)).image());
    }

    @Test void pdfContainsTheScaledRasterAndOriginalBytes() throws Exception {
        byte[] source = nativeDicom(rgb(1, 0, 32, 31), UID.ExplicitVRLittleEndian, VR.OW, FRAME_ONE);
        Path input = Files.createDirectory(temporary.resolve("input"));
        Files.write(input.resolve("rgb32.dcm"), source);
        Path pdf = temporary.resolve("rgb32.pdf");
        var reference = DicomPdf.create(input, pdf).images().getFirst();
        assertEquals("rendered", reference.status(), reference.reason());
        assertEquals(1, reference.sourceFrame());
        try (var document = Loader.loadPDF(pdf.toFile())) {
            var resources = document.getPage(reference.referencePage() - 1).getResources();
            var names = resources.getXObjectNames().iterator();
            assertTrue(names.hasNext());
            var raster = assertInstanceOf(PDImageXObject.class, resources.getXObject(names.next()));
            assertArrayEquals(EXPECTED_ONE, pixels(raster.getImage()));
            assertFalse(names.hasNext());
            var files = document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            assertArrayEquals(source, files.get(reference.attachment()).getEmbeddedFileUnicode().toByteArray());
        }
        assertEquals("PASS", PackageTools.verify(pdf, input, null).metadataAccuracy().status());
    }

    private static void assertFrame(byte[] source, int frame, int[] expected) {
        var result = DicomInput.inspect(source, frame);
        assertNotNull(result.image(), result.reason());
        assertArrayEquals(expected, pixels(result.image()));
        assertEquals("color-direct", result.displayAdjustments().get("windowMethod"));
        assertEquals(Integer.toString(frame), result.displayAdjustments().get("sourceFrame"));
    }

    private static int[] pixels(BufferedImage image) {
        return Arrays.stream(image.getRGB(0, 0, 2, 1, null, 0, 2)).map(pixel -> pixel & 0xffffff).toArray();
    }

    private static Attributes rgb(int frames, int planar, int stored, int high) {
        var attrs = SpecDisplayTest.phantom(false, 0, 0, 0, 0);
        attrs.setInt(Tag.Rows, VR.US, 1);
        attrs.setInt(Tag.Columns, VR.US, 2);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, frames);
        attrs.setInt(Tag.SamplesPerPixel, VR.US, 3);
        attrs.setInt(Tag.PlanarConfiguration, VR.US, planar);
        attrs.setString(Tag.PhotometricInterpretation, VR.CS, "RGB");
        attrs.setInt(Tag.BitsAllocated, VR.US, 32);
        attrs.setInt(Tag.BitsStored, VR.US, stored);
        attrs.setInt(Tag.HighBit, VR.US, high);
        return attrs;
    }

    private static byte[] nativeDicom(Attributes attrs, String syntax, VR vr, int[]... frames) throws Exception {
        boolean bigEndian = UID.ExplicitVRBigEndian.equals(syntax);
        attrs = new Attributes(attrs, bigEndian);
        var samples = ByteBuffer.allocate(24 * frames.length);
        samples.order(bigEndian ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
        int[] order = attrs.getInt(Tag.PlanarConfiguration, 0) == 1
                ? new int[]{0, 3, 1, 4, 2, 5} : new int[]{0, 1, 2, 3, 4, 5};
        for (int[] frame : frames) {
            for (int index : order) {
                int value = frame[index];
                if (bigEndian && vr == VR.OW) value = Integer.rotateLeft(value, 16);
                samples.putInt(value);
            }
        }
        attrs.setBytes(Tag.PixelData, vr, samples.array());
        return encode(attrs, syntax);
    }

    private static byte[] rle(int[] samples, boolean repeat) {
        int segmentBytes = repeat ? 2 : 4;
        var bytes = ByteBuffer.allocate(64 + 12 * segmentBytes).order(ByteOrder.LITTLE_ENDIAN);
        bytes.putInt(12);
        for (int segment = 0; segment < 12; segment++) {
            int start = 64 + segment * segmentBytes;
            bytes.putInt(4 + segment * 4, start);
            int channel = segment / 4;
            int shift = 8 * (3 - segment % 4);
            if (repeat) {
                bytes.put(start, (byte) -1);
                bytes.put(start + 1, (byte) (samples[channel] >>> shift));
            } else {
                bytes.put(start, (byte) 1);
                bytes.put(start + 1, (byte) (samples[channel] >>> shift));
                bytes.put(start + 2, (byte) (samples[channel + 3] >>> shift));
            }
        }
        return bytes.array();
    }

    private static byte[] rleDicom(byte[] offsets, byte[] first, byte[] second) throws Exception {
        var attrs = rgb(2, 1, 32, 31);
        var fragments = attrs.newFragments(Tag.PixelData, VR.OB, 3);
        fragments.add(offsets);
        fragments.add(first);
        fragments.add(second);
        return encode(attrs, UID.RLELossless);
    }

    private static byte[] encode(Attributes attrs, String syntax) throws Exception {
        var bytes = new ByteArrayOutputStream();
        try (var output = new DicomOutputStream(bytes, UID.ExplicitVRLittleEndian)) {
            output.writeDataset(attrs.createFileMetaInformation(syntax), attrs);
        }
        return bytes.toByteArray();
    }
}
