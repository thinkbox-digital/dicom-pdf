package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import javax.imageio.IIOException;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;

/** Scale native or RLE unsigned wide RGB channels across the declared stored range. */
final class Rgb32Reader {
    private static final int CHANNELS = 3;
    private static final int RLE_HEADER_BYTES = 64;
    private final int lowBit;
    private final long maximum;
    private final int sampleBytes;

    private Rgb32Reader(int stored, int high, int sampleBytes) {
        lowBit = high - stored + 1;
        maximum = (1L << stored) - 1;
        this.sampleBytes = sampleBytes;
    }

    static BufferedImage read(SourceContent source, String syntax, int frame, int frames,
                              int rows, int columns, int planar, int stored, int high) throws IOException {
        return readWide(source, syntax, frame, frames, rows, columns, planar, stored, high, 4);
    }

    static BufferedImage readWide(SourceContent source, String syntax, int frame, int frames,
                                  int rows, int columns, int planar, int stored, int high, int sampleBytes) throws IOException {
        var reader = new Rgb32Reader(stored, high, sampleBytes);
        try (var input = new DicomInputStream(source.open())) {
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            input.readDatasetUntilPixelData();
            if (input.tag() != Tag.PixelData) throw new IIOException("Missing 32-bit RGB Pixel Data");
            var image = new BufferedImage(columns, rows, BufferedImage.TYPE_INT_RGB);
            int[] pixels = ((DataBufferInt) image.getRaster().getDataBuffer()).getData();
            if (UID.RLELossless.equals(syntax)) {
                if (sampleBytes == 4 && input.vr() != VR.OB) throw new IIOException("Expected encapsulated 32-bit RGB RLE Pixel Data");
                readRle(input, frame, frames, pixels.length, CHANNELS, sampleBytes, (channel, samples) -> {
                    for (int pixel = 0; pixel < pixels.length; pixel++)
                        pixels[pixel] |= reader.toByte(samples[pixel]) << (8 * (2 - channel));
                });
            }
            else reader.readNative(input, frame, frames, columns, planar, pixels);
            return image;
        }
    }

    private void readNative(DicomInputStream input, int frame, int frames, int columns,
                            int planar, int[] pixels) throws IOException {
        long frameBytes = (long) pixels.length * CHANNELS * sampleBytes;
        if (input.unsignedLength() != frameBytes * frames) {
            throw new IIOException("32-bit RGB Pixel Data length differs from the declared dimensions and frame count");
        }
        input.skipFully(frameBytes * frame);
        boolean bigEndianWords = input.bigEndian() && input.vr() == VR.OW;
        int rowSamples = planar == 0 ? columns * CHANNELS : columns;
        byte[] row = new byte[rowSamples * sampleBytes];
        var values = ByteBuffer.wrap(row).order(input.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
        for (int channel = 0; channel < (planar == 0 ? 1 : CHANNELS); channel++) {
            for (int start = 0; start < pixels.length; start += columns) {
                input.readFully(row);
                values.rewind();
                for (int pixel = start; pixel < start + columns; pixel++) {
                    if (planar == 0) {
                        int red = toByte(readSample(values, bigEndianWords));
                        int green = toByte(readSample(values, bigEndianWords));
                        int blue = toByte(readSample(values, bigEndianWords));
                        pixels[pixel] = red << 16 | green << 8 | blue;
                    } else {
                        pixels[pixel] |= toByte(readSample(values, bigEndianWords)) << (8 * (2 - channel));
                    }
                }
            }
        }
    }

    private int readSample(ByteBuffer values, boolean bigEndianWords) {
        if (sampleBytes == 2) return Short.toUnsignedInt(values.getShort());
        if (!bigEndianWords) return values.getInt();
        // OW stores the lower word first, with big-endian bytes inside each word.
        int low = Short.toUnsignedInt(values.getShort());
        return low | Short.toUnsignedInt(values.getShort()) << 16;
    }

    static void readRle(DicomInputStream input, int frame, int frames, int pixels, int channels, int sampleBytes,
                        java.util.function.BiConsumer<Integer, int[]> decoded) throws IOException {
        beginRle(input, frames);
        for (int i = 0; i < frame; i++) input.skipFully(itemLength(input));
        readRleItem(input, pixels, channels, sampleBytes, decoded);
    }

    static void beginRle(DicomInputStream input, int frames) throws IOException {
        if (input.unsignedLength() != -1 || (input.vr() != VR.OB && input.vr() != VR.OW))
            throw new IIOException("Expected encapsulated RLE Pixel Data");
        long tableLength = itemLength(input);
        if (tableLength != 0 && tableLength != (long) frames * Integer.BYTES) {
            throw new IIOException("Invalid RLE Basic Offset Table length");
        }
        input.skipFully(tableLength);
    }

    // DICOM RLE stores exactly one item per frame, including with an empty offset table.
    static void readRleItem(DicomInputStream input, int pixels, int channels, int sampleBytes,
                            java.util.function.BiConsumer<Integer, int[]> decoded) throws IOException {
        long frameLength = itemLength(input);
        if (frameLength < RLE_HEADER_BYTES) throw new IIOException("Truncated RLE frame header");
        byte[] headerBytes = new byte[RLE_HEADER_BYTES];
        input.readFully(headerBytes);
        var header = ByteBuffer.wrap(headerBytes).order(ByteOrder.LITTLE_ENDIAN);
        int segments = channels * sampleBytes;
        if (header.getInt() != segments) throw new IIOException("Unexpected number of RLE segments");
        long[] offsets = new long[segments + 1];
        offsets[segments] = frameLength;
        for (int i = 0; i < segments; i++) offsets[i] = Integer.toUnsignedLong(header.getInt());
        if (offsets[0] != RLE_HEADER_BYTES) throw new IIOException("Invalid first RLE segment offset");
        for (int i = 0; i < segments; i++) {
            if (offsets[i] >= offsets[i + 1]) throw new IIOException("Invalid RLE segment offsets");
        }

        int[] channelSamples = new int[pixels];
        byte[] literal = new byte[128];
        for (int channel = 0; channel < channels; channel++) {
            Arrays.fill(channelSamples, 0);
            for (int plane = 0; plane < sampleBytes; plane++) {
                int segment = channel * sampleBytes + plane;
                readRleSegment(input, offsets[segment + 1] - offsets[segment], channelSamples, 8 * (sampleBytes - 1 - plane), literal);
            }
            decoded.accept(channel, channelSamples);
        }
    }

    private static long itemLength(DicomInputStream input) throws IOException {
        input.readHeader();
        long length = input.unsignedLength();
        if (input.tag() != Tag.Item || length < 0 || (length & 1) != 0) {
            throw new IIOException("Invalid or missing encapsulated RLE item");
        }
        return length;
    }

    private static void readRleSegment(DicomInputStream input, long length, int[] samples, int shift,
                                       byte[] literal) throws IOException {
        long end = input.getPosition() + length;
        int written = 0;
        while (written < samples.length && input.getPosition() < end) {
            int next = input.read();
            if (next < 0) throw new IIOException("Truncated 32-bit RGB RLE segment");
            int control = (byte) next;
            if (control == -128) continue;
            boolean repeat = control < 0;
            int run = repeat ? 1 - control : 1 + control;
            int encoded = repeat ? 1 : run;
            if (run > samples.length - written || encoded > end - input.getPosition()) {
                throw new IIOException("Invalid 32-bit RGB RLE run");
            }
            input.readFully(literal, 0, encoded);
            for (int i = 0; i < run; i++) {
                samples[written++] |= Byte.toUnsignedInt(literal[repeat ? 0 : i]) << shift;
            }
        }
        if (written != samples.length) throw new IIOException("Truncated 32-bit RGB RLE segment");
        input.skipFully(end - input.getPosition());
    }

    private int toByte(int sample) {
        long value = (Integer.toUnsignedLong(sample) >>> lowBit) & maximum;
        return (int) ((255 * value + maximum / 2) / maximum);
    }
}
