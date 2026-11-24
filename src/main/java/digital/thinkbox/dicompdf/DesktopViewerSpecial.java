package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;

final class DesktopViewerSpecial {
    record Surface(float[] coordinates, int[] triangles) {}
    record Dose(BufferedImage image, String legend) {}
    record Trace(double[] real, double[] imaginary, String axis) {}
    record Spectrum(int frames, int rows, int columns, int points, String domain, int components,
                    double width, ByteBuffer samples) {
        Trace trace(int frame, int row, int column, boolean transform) {
            int start = (((frame - 1) * rows + row - 1) * columns + column - 1) * points * components * 4;
            int count = transform ? Integer.highestOneBit(points - 1) << 1 : points;
            double[] real = new double[count];
            double[] imaginary = components == 2 ? new double[count] : null;
            for (int i = 0; i < points; i++) {
                real[i] = samples.getFloat(start + i * components * 4);
                if (imaginary != null) imaginary[i] = samples.getFloat(start + i * components * 4 + 4);
            }
            if (!transform) return new Trace(real, imaginary, domain.equals("TIME") ? "Acquisition time (ms)" : "Frequency offset (Hz)");
            var fftImaginary = imaginary == null ? new double[count] : imaginary;
            fft(real, fftImaginary);
            var magnitude = new double[count];
            for (int i = 0; i < count; i++) {
                int bin = (count / 2 - 1 - i + count) % count;
                magnitude[i] = Math.hypot(real[bin], fftImaginary[bin]) / points;
            }
            return new Trace(magnitude, null, "Frequency offset (Hz)");
        }
    }
    private DesktopViewerSpecial() {}

    static Attributes read(SourceContent content) throws Exception {
        // Bulk elements for advanced objects are decoded only after the original hash is checked.
        long limit = Math.min(128L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 12);
        if (content.digest().length() > limit) throw new IOException("This DICOM object exceeds the desktop preview memory limit");
        try (var stream = new DicomInputStream(content.open())) {
            stream.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            return stream.readDataset();
        }
    }

    static Spectrum spectrum(Attributes attrs) throws IOException {
        int rows = attrs.getInt(Tag.Rows, 0), columns = attrs.getInt(Tag.Columns, 0);
        int frames = attrs.getInt(Tag.NumberOfFrames, 1), points = attrs.getInt(Tag.DataPointColumns, 0);
        String domain = attrs.getString(Tag.SignalDomainColumns, "");
        String representation = attrs.getString(Tag.DataRepresentation, "");
        int components = representation.equals("COMPLEX") ? 2 : 1;
        double width = attrs.getDouble(Tag.SpectralWidth, 0);
        var samples = buffer(attrs, Tag.SpectroscopyData);
        if (rows <= 0 || columns <= 0 || frames <= 0 || points < 2 || points > 65_536
                || attrs.getInt(Tag.DataPointRows, 0) != 1 || !(width > 0 && Double.isFinite(width))
                || !List.of("TIME", "FREQUENCY").contains(domain)
                || !List.of("COMPLEX", "REAL", "IMAGINARY", "MAGNITUDE").contains(representation)
                || (double) rows * columns * frames * points * components * 4 != samples.limit())
            throw new IOException("Invalid MR spectroscopy sample layout");
        for (int offset = 0; offset < samples.limit(); offset += 4)
            if (!Float.isFinite(samples.getFloat(offset))) throw new IOException("Invalid MR spectroscopy sample");
        return new Spectrum(frames, rows, columns, points, domain, components, width, samples);
    }

    private static void fft(double[] real, double[] imaginary) {
        int count = real.length;
        for (int i = 1, j = 0; i < count; i++) {
            int bit = count >> 1;
            while ((j & bit) != 0) { j ^= bit; bit >>= 1; }
            j ^= bit;
            if (i < j) {
                double r = real[i], m = imaginary[i];
                real[i] = real[j];
                imaginary[i] = imaginary[j];
                real[j] = r;
                imaginary[j] = m;
            }
        }
        for (int stride = 2; stride <= count; stride *= 2) {
            int half = stride / 2;
            for (int k = 0; k < half; k++) {
                double angle = -2 * Math.PI * k / stride;
                double cosine = Math.cos(angle), sine = Math.sin(angle);
                for (int i = k; i < count; i += stride) {
                    int j = i + half;
                    double r = real[j] * cosine - imaginary[j] * sine;
                    double m = real[j] * sine + imaginary[j] * cosine;
                    real[j] = real[i] - r;
                    imaginary[j] = imaginary[i] - m;
                    real[i] += r;
                    imaginary[i] += m;
                }
            }
        }
    }

    static Dose dose(Attributes attrs, int frame) throws IOException {
        int rows = attrs.getInt(Tag.Rows, 0), columns = attrs.getInt(Tag.Columns, 0);
        int bits = attrs.getInt(Tag.BitsAllocated, 0), frames = attrs.getInt(Tag.NumberOfFrames, 1);
        boolean signed = attrs.getInt(Tag.PixelRepresentation, 0) == 1;
        double scale = attrs.getDouble(Tag.DoseGridScaling, Double.NaN);
        var bytes = buffer(attrs, Tag.PixelData);
        long pixels = (long) rows * columns;
        int stride = bits / 8;
        if (rows <= 0 || columns <= 0 || pixels > 16_777_216 || (bits != 16 && bits != 32)
                || frames < 1 || frame < 1 || frame > frames || pixels * frames * stride != bytes.limit()
                || !Double.isFinite(scale) || scale <= 0)
            throw new IOException("Invalid RT Dose grid");
        long minimum = Long.MAX_VALUE, maximum = Long.MIN_VALUE;
        for (int i = 0; i < bytes.limit(); i += stride) {
            long value = doseSample(bytes, i, stride, signed);
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
        }
        var image = new BufferedImage(columns, rows, BufferedImage.TYPE_INT_RGB);
        var colors = ((java.awt.image.DataBufferInt) image.getRaster().getDataBuffer()).getData();
        int start = (int) ((frame - 1L) * pixels * stride);
        double range = Math.max(1, maximum - minimum);
        for (int i = 0; i < colors.length; i++) {
            double intensity = (doseSample(bytes, start + i * stride, stride, signed) - minimum) / range;
            colors[i] = java.awt.Color.HSBtoRGB((float) (0.70 * (1 - intensity)), 1, intensity == 0 ? 0 : .95f);
        }
        return new Dose(image, String.format(java.util.Locale.ROOT, "Dose range %.5g–%.5g %s",
                minimum * scale, maximum * scale, attrs.getString(Tag.DoseUnits, "")));
    }

    static Dose rleDose(SourceContent original, Attributes attrs, int frame) throws IOException {
        int rows = attrs.getInt(Tag.Rows, 0), columns = attrs.getInt(Tag.Columns, 0);
        int bits = attrs.getInt(Tag.BitsAllocated, 0), frames = attrs.getInt(Tag.NumberOfFrames, 1);
        boolean signed = attrs.getInt(Tag.PixelRepresentation, 0) == 1;
        double scale = attrs.getDouble(Tag.DoseGridScaling, Double.NaN);
        int stride = bits / 8;
        long pixels = (long) rows * columns;
        long limit = Math.min(128L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 12);
        if (rows <= 0 || columns <= 0 || pixels > 16_777_216 || (bits != 16 && bits != 32)
                || frames < 1 || frame < 1 || frame > frames || pixels * frames * stride > limit
                || !Double.isFinite(scale) || scale <= 0) throw new IOException("Invalid or excessive RT Dose RLE grid");
        var samples = ByteBuffer.allocate((int) (pixels * frames * stride)).order(ByteOrder.LITTLE_ENDIAN);
        try (var input = new DicomInputStream(original.open())) {
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            input.readDatasetUntilPixelData();
            if (input.tag() != Tag.PixelData) throw new IOException("Missing RT Dose RLE Pixel Data");
            Rgb32Reader.beginRle(input, frames);
            for (int index = 0; index < frames; index++) {
                Rgb32Reader.readRleItem(input, (int) pixels, 1, stride, (channel, decoded) -> {
                    for (int value : decoded) {
                        if (stride == 4) samples.putInt(value);
                        else samples.putShort((short) value);
                    }
                });
            }
        }
        var nativeGrid = new Attributes(attrs, false);
        nativeGrid.setBytes(Tag.PixelData, org.dcm4che3.data.VR.OW, samples.array());
        return dose(nativeGrid, frame);
    }

    private static long doseSample(ByteBuffer bytes, int offset, int stride, boolean signed) {
        if (stride == 2) {
            short value = bytes.getShort(offset);
            return signed ? value : Short.toUnsignedInt(value);
        }
        int value = bytes.order() == ByteOrder.LITTLE_ENDIAN ? bytes.getInt(offset)
                : Short.toUnsignedInt(bytes.getShort(offset)) | bytes.getShort(offset + 2) << 16;
        return signed ? value : Integer.toUnsignedLong(value);
    }

    static List<Surface> surfaces(Attributes dataset) throws IOException {
        var sequence = dataset.getSequence(Tag.SurfaceSequence);
        if (sequence == null || sequence.isEmpty()) throw new IOException("Surface sequence is empty");
        var result = new ArrayList<Surface>();
        for (var surface : sequence) {
            var points = surface.getNestedDataset(Tag.SurfacePointsSequence);
            var mesh = surface.getNestedDataset(Tag.SurfaceMeshPrimitivesSequence);
            if (points == null || mesh == null) throw new IOException("Surface coordinates or mesh are missing");
            int count = points.getInt(Tag.NumberOfSurfacePoints, 0);
            var data = buffer(points, Tag.PointCoordinatesData);
            if (count <= 0 || data.remaining() != count * 12L) throw new IOException("Invalid surface coordinate count");
            var coordinates = new float[count * 3];
            for (int i = 0; i < coordinates.length; i++) {
                coordinates[i] = data.getFloat();
                if (!Float.isFinite(coordinates[i])) throw new IOException("Invalid surface coordinate");
            }
            int[] direct = indices(mesh, Tag.LongTrianglePointIndexList, Tag.TrianglePointIndexList, count);
            if (direct.length % 3 != 0) throw new IOException("Invalid triangle list");
            var faces = new java.io.ByteArrayOutputStream();
            try (var out = new java.io.DataOutputStream(faces)) {
                for (int index : direct) out.writeInt(index);
                for (int tag : new int[]{Tag.TriangleStripSequence, Tag.TriangleFanSequence, Tag.FacetSequence}) {
                    var primitives = mesh.getSequence(tag);
                    if (primitives == null) continue;
                    for (var primitive : primitives) {
                        var indices = indices(primitive, Tag.LongPrimitivePointIndexList, Tag.PrimitivePointIndexList, count);
                        for (int i = 0; i + 2 < indices.length; i++) {
                            int flip = tag == Tag.TriangleStripSequence ? i % 2 : 0;
                            out.writeInt(indices[tag == Tag.TriangleStripSequence ? i : 0]);
                            out.writeInt(indices[i + 1 + flip]);
                            out.writeInt(indices[i + 2 - flip]);
                        }
                    }
                }
            }
            int[] facesArray = new int[faces.size() / 4];
            ByteBuffer.wrap(faces.toByteArray()).asIntBuffer().get(facesArray);
            if (facesArray.length == 0) throw new IOException("The surface contains no supported triangle primitives");
            result.add(new Surface(coordinates, facesArray));
        }
        return List.copyOf(result);
    }

    private static int[] indices(Attributes mesh, int longTag, int shortTag, int pointCount) throws IOException {
        boolean wide = mesh.containsValue(longTag);
        int tag = wide ? longTag : shortTag;
        if (!mesh.containsValue(tag)) return new int[0];
        var bytes = buffer(mesh, tag);
        int stride = wide ? 4 : 2;
        if (bytes.remaining() % stride != 0) throw new IOException("Invalid primitive index layout");
        var values = new int[bytes.remaining() / stride];
        for (int i = 0; i < values.length; i++) {
            long index = wide ? Integer.toUnsignedLong(bytes.getInt()) : Short.toUnsignedInt(bytes.getShort());
            if (index < 1 || index > pointCount) throw new IOException("Primitive index is outside its surface");
            values[i] = (int) index - 1;
        }
        return values;
    }

    static BufferedImage floating(Attributes attrs, int frame, DesktopViewerDocument.Window window) throws IOException {
        int rows = attrs.getInt(Tag.Rows, 0), columns = attrs.getInt(Tag.Columns, 0);
        long count = (long) rows * columns;
        if (rows <= 0 || columns <= 0 || count > 16_777_216) throw new IOException("Invalid Parametric Map dimensions");
        boolean wide = attrs.containsValue(Tag.DoubleFloatPixelData);
        var bytes = buffer(attrs, wide ? Tag.DoubleFloatPixelData : Tag.FloatPixelData);
        int stride = wide ? 8 : 4;
        long start = (frame - 1L) * count * stride;
        if (start < 0 || start + count * stride > bytes.limit()) throw new IOException("Parametric Map frame is incomplete");
        var effective = DicomInput.effectiveAttributes(attrs, frame - 1);
        double slope = effective.getDouble(Tag.RescaleSlope, 1);
        double intercept = effective.getDouble(Tag.RescaleIntercept, 0);
        double center = window == DesktopViewerDocument.INITIAL ? effective.getDouble(Tag.WindowCenter, Double.NaN) : window.center();
        double width = window == DesktopViewerDocument.INITIAL ? effective.getDouble(Tag.WindowWidth, Double.NaN) : window.width();
        String function = effective.getString(Tag.VOILUTFunction, "LINEAR");
        boolean automatic = !Double.isFinite(center) || !Double.isFinite(width) || width <= 0;
        double padding = attrs.getDouble(wide ? Tag.DoubleFloatPixelPaddingValue : Tag.FloatPixelPaddingValue, Double.NaN);
        double limit = attrs.getDouble(wide ? Tag.DoubleFloatPixelPaddingRangeLimit : Tag.FloatPixelPaddingRangeLimit, padding);
        double low = Math.min(padding, limit), high = Math.max(padding, limit);
        if (automatic) {
            double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
            bytes.position((int) start);
            for (int i = 0; i < count; i++) {
                double raw = wide ? bytes.getDouble() : bytes.getFloat();
                if (!Double.isFinite(raw) || (raw >= low && raw <= high)) continue;
                double value = raw * slope + intercept;
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
            width = Math.max(1e-12, max - min);
            center = min + width / 2;
            function = "LINEAR_EXACT";
        }
        bytes.position((int) start);
        var image = new BufferedImage(columns, rows, BufferedImage.TYPE_BYTE_GRAY);
        byte[] pixels = ((java.awt.image.DataBufferByte) image.getRaster().getDataBuffer()).getData();
        for (int i = 0; i < count; i++) {
            double raw = wide ? bytes.getDouble() : bytes.getFloat();
            if (!Double.isFinite(raw) || (raw >= low && raw <= high)) continue;
            double value = raw * slope + intercept;
            double unit = switch (function) {
                case "SIGMOID" -> 1 / (1 + Math.exp(-4 * (value - center) / width));
                case "LINEAR_EXACT" -> (value - center) / width + 0.5;
                default -> width <= 1 ? (value > center - 0.5 ? 1 : 0)
                        : (value - center + 0.5) / (width - 1) + 0.5;
            };
            pixels[i] = (byte) Math.round(255 * Math.clamp(unit, 0, 1));
        }
        return image;
    }

    private static ByteBuffer buffer(Attributes attrs, int tag) throws IOException {
        byte[] bytes = attrs.getBytes(tag);
        if (bytes == null) throw new IOException("Missing DICOM data element " + Integer.toHexString(tag));
        return ByteBuffer.wrap(bytes).order(attrs.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
    }
}
