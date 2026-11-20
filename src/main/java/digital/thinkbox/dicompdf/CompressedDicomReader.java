package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.Locale;
import javax.imageio.IIOException;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.spi.ImageReaderSpi;
import javax.imageio.stream.ImageInputStream;
import org.dcm4che3.image.PhotometricInterpretation;
import org.dcm4che3.imageio.codec.ImageDescriptor;
import org.dcm4che3.imageio.stream.SegmentedInputImageStream;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.imgcodecs.Imgcodecs;
import org.weasis.opencv.op.ImageConversion;

/** Reads one encapsulated frame selected by dcm4che without relying on JDK-private stream fields. */
final class CompressedDicomReader extends ImageReader {
    static final String JPEG_LS = "dicom-jpeg-ls";
    static final String JPEG_2000 = "dicom-jpeg-2000";
    private static final long MAX_ENCODED_FRAME_BYTES = 64L * 1024 * 1024;
    private final boolean jpeg2000;

    private CompressedDicomReader(ImageReaderSpi provider, boolean jpeg2000) {
        super(provider);
        this.jpeg2000 = jpeg2000;
    }

    @Override public BufferedImage read(int index, ImageReadParam param) throws IOException {
        // dcm4che supplies the frame through setInput and manages the backing stream.
        Object input = getInput();
        var descriptor = frameDescriptor(index, input);
        var frame = (SegmentedInputImageStream) input;
        frame.seek(0);
        checkHeader(frame, descriptor);
        frame.seek(0);
        byte[] bytes = readEncodedFrame(frame);
        int flags = jpeg2000 && descriptor.isSigned() ? Imgcodecs.DICOM_FLAG_SIGNED : Imgcodecs.DICOM_FLAG_UNSIGNED;
        var photo = descriptor.getPhotometricInterpretation();
        if (jpeg2000 && photo.isYBR() && photo != PhotometricInterpretation.YBR_ICT && photo != PhotometricInterpretation.YBR_RCT) {
            flags |= Imgcodecs.DICOM_FLAG_YBR;
        }
        Mat decoded = decode(bytes, flags);
        try {
            if (decoded.empty() || decoded.cols() != descriptor.getColumns() || decoded.rows() != descriptor.getRows()
                    || decoded.channels() != descriptor.getSamples()) {
                throw new IIOException("Compressed frame is invalid or differs from DICOM image dimensions or components");
            }
            return ImageConversion.toBufferedImage(decoded);
        } finally {
            decoded.release();
        }
    }

    static byte[] readEncodedFrame(ImageInputStream frame) throws IOException {
        var encoded = new ByteArrayOutputStream();
        byte[] block = new byte[64 * 1024];
        for (int count; (count = frame.read(block)) > 0;) {
            if (count > MAX_ENCODED_FRAME_BYTES - encoded.size()) {
                throw new IIOException("Excessive encapsulated frame length (maximum 64 MiB)");
            }
            encoded.write(block, 0, count);
        }
        return encoded.toByteArray();
    }

    static Mat decode(byte[] bytes, int flags) throws IIOException {
        NativeLibrary.requireLoaded();
        var input = new Mat(1, bytes.length, CvType.CV_8UC1);
        try {
            input.put(0, 0, bytes);
            return Imgcodecs.dicomJpgMatRead(input, flags, Imgcodecs.IMREAD_UNCHANGED);
        } finally {
            input.release();
        }
    }

    private void checkHeader(ImageInputStream frame, ImageDescriptor descriptor) throws IOException {
        if (jpeg2000) {
            if (frame.readInt() != 0xff4fff51) throw new IIOException("Expected a JPEG 2000 Part 1 codestream");
            int headerLength = frame.readUnsignedShort();
            frame.skipBytes(2); // Rsiz
            long right = frame.readUnsignedInt(), bottom = frame.readUnsignedInt();
            long left = frame.readUnsignedInt(), top = frame.readUnsignedInt();
            frame.skipBytes(16); // Tile dimensions and origin
            int components = frame.readUnsignedShort();
            checkDimensions(descriptor, right - left, bottom - top, components);
            if (headerLength != 38 + 3 * components) throw new IIOException("Invalid JPEG 2000 SIZ marker length");
            for (int component = 0; component < components; component++) {
                checkPrecision(descriptor, (frame.readUnsignedByte() & 0x7f) + 1);
                frame.skipBytes(2);
            }
            return;
        }
        if (frame.readUnsignedShort() != 0xffd8) throw new IIOException("Expected a JPEG-LS codestream");
        while (frame.readUnsignedByte() == 0xff) {
            int marker;
            do { marker = frame.readUnsignedByte(); } while (marker == 0xff);
            if (marker == 0xda || marker == 0xd9 || marker == 0) break;
            int size = frame.readUnsignedShort();
            if (marker == 0xf7 && size >= 8) {
                int precision = frame.readUnsignedByte();
                int rows = frame.readUnsignedShort(), columns = frame.readUnsignedShort();
                checkDimensions(descriptor, columns, rows, frame.readUnsignedByte());
                checkPrecision(descriptor, precision);
                return;
            }
            if (size < 2 || frame.skipBytes(size - 2) != size - 2) break;
        }
        throw new IIOException("Missing or invalid JPEG-LS frame header");
    }

    private static void checkDimensions(ImageDescriptor descriptor, long width, long height, int components) throws IIOException {
        if (width != descriptor.getColumns() || height != descriptor.getRows() || components != descriptor.getSamples()) {
            throw new IIOException("Compressed frame header differs from DICOM image dimensions or components");
        }
    }

    private static void checkPrecision(ImageDescriptor descriptor, int precision) throws IIOException {
        if (precision != descriptor.getBitsStored()) throw new IIOException("Compressed frame precision differs from DICOM Bits Stored");
    }

    private static ImageDescriptor frameDescriptor(int index, Object input) throws IIOException {
        if (index != 0) throw new IndexOutOfBoundsException(index);
        if (input instanceof SegmentedInputImageStream frame) {
            ImageDescriptor descriptor = frame.getImageDescriptor();
            if (descriptor != null) return descriptor;
        }
        throw new IIOException("DICOM encapsulated frame unavailable");
    }

    @Override public int getNumImages(boolean allowSearch) { return 1; }
    @Override public int getWidth(int index) throws IOException { return frameDescriptor(index, getInput()).getColumns(); }
    @Override public int getHeight(int index) throws IOException { return frameDescriptor(index, getInput()).getRows(); }
    @Override public Iterator<ImageTypeSpecifier> getImageTypes(int index) throws IOException {
        return java.util.List.of(ImageTypeSpecifier.createFromRenderedImage(read(index))).iterator();
    }
    @Override public IIOMetadata getStreamMetadata() { return null; }
    @Override public IIOMetadata getImageMetadata(int index) { return null; }

    private abstract static class Provider extends ImageReaderSpi {
        private final boolean jpeg2000;

        Provider(String name, boolean jpeg2000) {
            super("Thinkbox", "1", new String[]{name}, null, null, CompressedDicomReader.class.getName(),
                    new Class<?>[]{SegmentedInputImageStream.class}, null, false, null, null, null, null,
                    false, null, null, null, null);
            this.jpeg2000 = jpeg2000;
        }

        // Only the explicit DICOM transfer-syntax mapping should select this reader.
        @Override public boolean canDecodeInput(Object source) { return false; }
        @Override public ImageReader createReaderInstance(Object extension) { return new CompressedDicomReader(this, jpeg2000); }
        @Override public String getDescription(Locale locale) { return getFormatNames()[0]; }
    }

    static final class JpegLsProvider extends Provider { JpegLsProvider() { super(JPEG_LS, false); } }
    static final class Jpeg2000Provider extends Provider { Jpeg2000Provider() { super(JPEG_2000, true); } }

    private static final class NativeLibrary {
        private static final Throwable LOAD_FAILURE = load();

        static void requireLoaded() throws IIOException {
            if (LOAD_FAILURE != null) throw new IIOException("Bundled JPEG decoder is unavailable: " + LOAD_FAILURE.getMessage(), LOAD_FAILURE);
        }

        private static Throwable load() {
            String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
            String architecture = switch (System.getProperty("os.arch", "")) {
                case "amd64", "x86_64" -> "x86-64";
                case "arm64", "aarch64" -> "aarch64";
                default -> "";
            };
            String name = os.startsWith("linux") ? "linux-" + architecture + ".so"
                    : os.startsWith("mac") ? "macosx-" + architecture + ".dylib"
                    : os.startsWith("windows") ? "windows-" + architecture + ".dll" : "";
            try (var resource = CompressedDicomReader.class.getResourceAsStream("/dicom-codecs/" + name)) {
                if (name.isEmpty() || resource == null) throw new IOException("unsupported platform");
                Path directory = Files.createTempDirectory("dicom-pdf-codec-");
                directory.toFile().deleteOnExit();
                Path binary = directory.resolve(name);
                binary.toFile().deleteOnExit();
                Files.copy(resource, binary);
                System.load(binary.toAbsolutePath().toString());
                return null;
            } catch (IOException | LinkageError | SecurityException problem) {
                return problem;
            }
        }
    }
}
