package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import javax.imageio.IIOException;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.ImageDescriptor;
import org.dcm4che3.imageio.plugins.dcm.DicomMetaData;
import org.dcm4che3.imageio.stream.EncapsulatedPixelDataImageInputStream;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.util.ByteUtils;
import org.opencv.core.CvType;
import org.opencv.imgcodecs.Imgcodecs;

/** Decodes a 12-bit sequential JPEG frame for the existing grayscale rendering pipeline. */
final class JpegExtended {
    private static final long MAX_OFFSET_TABLE_BYTES = 64L * 1024 * 1024;

    private JpegExtended() {}

    static DicomMetaData unpack(SourceContent source, Attributes effective, int frameIndex,
                                int rows, int columns) throws IOException {
        byte[] encoded = readFrame(source, frameIndex);
        validateScan(encoded, rows, columns);

        var decoded = CompressedDicomReader.decode(encoded, Imgcodecs.DICOM_FLAG_UNSIGNED);
        byte[] pixels;
        try {
            if (decoded.type() != CvType.CV_16UC1 || decoded.rows() != rows || decoded.cols() != columns) {
                throw new IIOException("JPEG Extended decoding did not produce the expected 12-bit grayscale frame");
            }
            pixels = new byte[rows * columns * Short.BYTES];
            var samples = ByteBuffer.wrap(pixels).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
            var row = new short[columns];
            for (int y = 0; y < rows; y++) {
                if (decoded.get(y, 0, row) != row.length * Short.BYTES) {
                    throw new IIOException("Could not read the decoded JPEG Extended samples");
                }
                samples.put(row);
            }
        } finally {
            decoded.release();
        }

        Attributes image = new Attributes(effective, false);
        image.remove(Tag.SharedFunctionalGroupsSequence);
        image.remove(Tag.PerFrameFunctionalGroupsSequence);
        image.setInt(Tag.NumberOfFrames, VR.IS, 1);
        image.setBytes(Tag.PixelData, VR.OW, pixels);
        return new DicomMetaData(image.createFileMetaInformation(UID.ExplicitVRLittleEndian), image);
    }

    private static byte[] readFrame(SourceContent source, int frameIndex) throws IOException {
        try (var stream = source.open(); var input = new DicomInputStream(stream)) {
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            var attrs = input.readDatasetUntilPixelData();
            if (input.tag() != Tag.PixelData || input.unsignedLength() != -1) {
                throw new IIOException("Missing encapsulated JPEG Extended Pixel Data");
            }
            var descriptor = new ImageDescriptor(attrs);
            // The encapsulated stream constructor allocates the Basic Offset Table.
            input.mark(12);
            input.readHeader();
            long tableLength = input.unsignedLength();
            if (input.tag() != Tag.Item || tableLength < 0 || tableLength > MAX_OFFSET_TABLE_BYTES
                    || tableLength % Integer.BYTES != 0
                    || tableLength > (long) descriptor.getFrames() * Integer.BYTES) {
                throw new IIOException("Invalid JPEG Extended Basic Offset Table");
            }
            input.reset();
            // A JPEG frame may span more than one DICOM fragment.
            try (var frames = new EncapsulatedPixelDataImageInputStream(input, descriptor)) {
                for (int index = 0; index < frameIndex; index++) {
                    if (!frames.seekNextFrame()) throw new IIOException("Missing encapsulated JPEG Extended frame");
                }
                return CompressedDicomReader.readEncodedFrame(frames);
            }
        }
    }

    private static void validateScan(byte[] frame, int rows, int columns) throws IIOException {
        if (frame.length < 2 || ByteUtils.bytesToUShortBE(frame, 0) != 0xffd8) {
            throw new IIOException("Missing JPEG Extended start of image");
        }
        int offset = 2;
        int frameComponent = -1;
        while (offset < frame.length && frame[offset++] == (byte) 0xff) {
            while (offset < frame.length && frame[offset] == (byte) 0xff) offset++;
            if (frame.length - offset < 3) break;
            int marker = frame[offset++] & 0xff;
            int length = ByteUtils.bytesToUShortBE(frame, offset);
            if (length < 2 || length > frame.length - offset) break;
            int start = offset + 2;
            int end = offset + length;
            if (marker == 0xc1) {
                if (frameComponent != -1 || length != 11 || frame[start] != 12 || frame[start + 5] != 1) {
                    throw new IIOException("Expected a single-component 12-bit JPEG Extended frame");
                }
                if (ByteUtils.bytesToUShortBE(frame, start + 1) != rows
                        || ByteUtils.bytesToUShortBE(frame, start + 3) != columns) {
                    throw new IIOException("JPEG Extended dimensions differ from DICOM metadata");
                }
                frameComponent = frame[start + 6] & 0xff;
            } else if (marker == 0xda) {
                if (frameComponent < 0 || length != 8 || frame[start] != 1
                        || (frame[start + 1] & 0xff) != frameComponent || frame[start + 3] != 0
                        || (frame[start + 4] != 63 && frame[start + 4] != 0) || frame[start + 5] != 0) {
                    throw new IIOException("Invalid 12-bit JPEG Extended scan header");
                }
                validateEndOfImage(frame, end);
                // Legacy sequential encoders used Se=0 even though the scan contains all 64 coefficients.
                frame[start + 4] = 63;
                return;
            } else if (marker != 0xc4 && marker != 0xdb && marker != 0xdd && marker != 0xfe
                    && (marker < 0xe0 || marker > 0xef)) {
                throw new IIOException("Unexpected marker in 12-bit JPEG Extended header");
            }
            offset = end;
        }
        throw new IIOException("Missing or truncated JPEG Extended scan header");
    }

    private static void validateEndOfImage(byte[] frame, int offset) throws IIOException {
        while (offset < frame.length) {
            if (frame[offset++] != (byte) 0xff) continue;
            while (offset < frame.length && frame[offset] == (byte) 0xff) offset++;
            if (offset == frame.length) break;
            int marker = frame[offset++] & 0xff;
            if (marker == 0xd9) return;
            if (marker != 0 && (marker < 0xd0 || marker > 0xd7)) break;
        }
        throw new IIOException("Missing or invalid JPEG Extended end of image");
    }
}
