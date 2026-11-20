package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.security.MessageDigest;
import java.io.ByteArrayInputStream;
import java.util.*;
import javax.imageio.stream.MemoryCacheImageInputStream;
import org.dcm4che3.data.*;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.imageio.plugins.dcm.*;

final class LegacyDicomInput {
    record Result(Map<String, String> fields, BufferedImage image, String reason, Map<String, String> displayAdjustments) {}
    record Dataset(Attributes attributes, String syntax) {}
    private static final Set<String> SYNTAXES = Set.of(UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian, UID.ExplicitVRBigEndian);
    private static final Map<Integer, String> TAGS = new LinkedHashMap<>();
    static {
        TAGS.put(Tag.PatientName, "PatientName"); TAGS.put(Tag.PatientID, "PatientID");
        TAGS.put(Tag.StudyInstanceUID, "StudyInstanceUID"); TAGS.put(Tag.StudyDate, "StudyDate");
        TAGS.put(Tag.StudyTime, "StudyTime"); TAGS.put(Tag.StudyID, "StudyID"); TAGS.put(Tag.StudyDescription, "StudyDescription");
        TAGS.put(Tag.SeriesInstanceUID, "SeriesInstanceUID"); TAGS.put(Tag.SeriesNumber, "SeriesNumber");
        TAGS.put(Tag.SeriesDescription, "SeriesDescription"); TAGS.put(Tag.SOPInstanceUID, "SOPInstanceUID");
        TAGS.put(Tag.SOPClassUID, "SOPClassUID"); TAGS.put(Tag.InstanceNumber, "InstanceNumber");
        TAGS.put(Tag.Modality, "Modality"); TAGS.put(Tag.PresentationIntentType, "PresentationIntentType");
        TAGS.put(Tag.BodyPartExamined, "BodyPartExamined"); TAGS.put(Tag.ViewPosition, "ViewPosition");
        TAGS.put(Tag.PatientOrientation, "PatientOrientation"); TAGS.put(Tag.ImageLaterality, "ImageLaterality");
        TAGS.put(Tag.Laterality, "Laterality"); TAGS.put(Tag.Rows, "Rows"); TAGS.put(Tag.Columns, "Columns");
        TAGS.put(Tag.PhotometricInterpretation, "PhotometricInterpretation"); TAGS.put(Tag.BitsAllocated, "BitsAllocated");
        TAGS.put(Tag.BitsStored, "BitsStored"); TAGS.put(Tag.HighBit, "HighBit"); TAGS.put(Tag.PixelRepresentation, "PixelRepresentation");
        TAGS.put(Tag.NumberOfFrames, "NumberOfFrames"); TAGS.put(Tag.WindowCenter, "WindowCenter"); TAGS.put(Tag.WindowWidth, "WindowWidth");
        TAGS.put(Tag.PresentationLUTShape, "PresentationLUTShape"); TAGS.put(Tag.VOILUTFunction, "VOILUTFunction");
        TAGS.put(Tag.RescaleSlope, "RescaleSlope"); TAGS.put(Tag.RescaleIntercept, "RescaleIntercept");
    }
    static Result inspect(byte[] bytes) {
        Map<String, String> fields = new LinkedHashMap<>();
        try {
            // Pixel data is referenced from the immutable source bytes by the renderer; do not duplicate it during metadata parsing.
            Dataset dataset = dataset(bytes);
            Attributes attrs = dataset.attributes(); String syntax = dataset.syntax();
            fields.putAll(fields(dataset));
            require(SYNTAXES.contains(syntax), "Unsupported transfer syntax " + syntax + "; only native uncompressed Implicit LE, Explicit LE and Explicit BE are supported");
            require(UID.DigitalIntraOralXRayImageStorageForPresentation.equals(attrs.getString(Tag.SOPClassUID)), "Unsupported SOP class; requires Digital Intra-Oral X-Ray Image Storage - For Presentation");
            String intent = attrs.getString(Tag.PresentationIntentType);
            require(intent == null || intent.equals("FOR PRESENTATION"), "Image is not intended for presentation");
            require(attrs.getInt(Tag.NumberOfFrames, 1) == 1, "Multi-frame images are outside the pilot");
            require(attrs.getInt(Tag.SamplesPerPixel, 0) == 1 && Set.of("MONOCHROME1", "MONOCHROME2").contains(attrs.getString(Tag.PhotometricInterpretation, "")), "Only single-sample MONOCHROME1/2 images are supported");
            int allocated = attrs.getInt(Tag.BitsAllocated, 0), stored = attrs.getInt(Tag.BitsStored, 0), high = attrs.getInt(Tag.HighBit, -1);
            require((allocated == 8 || allocated == 16) && stored >= 1 && stored <= allocated && high == stored - 1, "Unsupported bit layout (8/16 allocated, right-aligned BitsStored required)");
            int signed = attrs.getInt(Tag.PixelRepresentation, -1);
            require(signed == 0 || signed == 1, "Missing or invalid PixelRepresentation");
            require(allocated != 8 || signed == 0, "Signed 8-bit pixels are outside the pilot");
            int rows = attrs.getInt(Tag.Rows, 0), cols = attrs.getInt(Tag.Columns, 0);
            require(rows > 0 && cols > 0 && (long) rows * cols <= 16_777_216, "Invalid or excessive image dimensions (maximum 16 megapixels)");
            require(!attrs.contains(Tag.ModalityLUTSequence) && !attrs.contains(Tag.VOILUTSequence) && !attrs.contains(Tag.PresentationLUTSequence), "LUT sequences are outside the pilot; linear rescale/window only");
            String shape = attrs.getString(Tag.PresentationLUTShape);
            String expectedShape = attrs.getString(Tag.PhotometricInterpretation).equals("MONOCHROME1") ? "INVERSE" : "IDENTITY";
            require(shape == null || shape.equals(expectedShape), "PresentationLUTShape must match grayscale polarity (" + expectedShape + ")");
            String function = attrs.getString(Tag.VOILUTFunction, "LINEAR");
            require(function.equals("LINEAR"), "Only LINEAR VOI windowing is supported");
            double slope = attrs.getFloat(Tag.RescaleSlope, 1), intercept = attrs.getFloat(Tag.RescaleIntercept, 0);
            require(Double.isFinite(slope) && slope != 0 && Double.isFinite(intercept), "Invalid linear rescale values");
            var reader = new DicomImageReader(new DicomImageReaderSpi());
            try (var imageInput = new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
                reader.setInput(imageInput);
                var param = (DicomImageReadParam) reader.getDefaultReadParam();
                Map<String,String> display = display(attrs, reader, slope, intercept, stored, signed);
                param.setAutoWindowing(false); param.setPreferWindow(true); param.setOverlayActivationMask(0);
                param.setWindowCenter(Float.parseFloat(display.get("windowCenter")));
                param.setWindowWidth(Float.parseFloat(display.get("windowWidth")));
                BufferedImage image = reader.read(0, param);
                require(image != null, "dcm4che returned no image");
                return new Result(Collections.unmodifiableMap(fields), image, null, display);
            } finally { reader.dispose(); }
        } catch (Exception e) {
            String message = e.getMessage();
            return new Result(Collections.unmodifiableMap(fields), null, message == null ? e.getClass().getSimpleName() : message, Map.of());
        }
    }
    static Dataset dataset(byte[] bytes) throws Exception {
        try (var in = new DicomInputStream(new ByteArrayInputStream(bytes))) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            require(in.readFileMetaInformation() != null, "DICOM Part 10 file meta information is required");
            String syntax = in.getTransferSyntax();
            return new Dataset(in.readDataset(), syntax);
        }
    }
    static Map<String,String> fields(byte[] bytes) {
        try { return fields(dataset(bytes)); } catch (Exception e) { return Map.of(); }
    }
    private static Map<String,String> fields(Dataset dataset) {
        Attributes attrs = dataset.attributes(); Map<String,String> fields = new LinkedHashMap<>();
        for (var tag : TAGS.entrySet()) {
            String[] values = attrs.getStrings(tag.getKey());
            if (values != null && values.length > 0) {
                String value = String.join("\\", values);
                if (!value.isBlank()) fields.put(tag.getValue(), value);
            }
        }
        fields.put("TransferSyntaxUID", dataset.syntax());
        copyCodes(attrs, Tag.AnatomicRegionSequence, "AnatomicRegion", fields);
        copyCodes(attrs, Tag.PrimaryAnatomicStructureSequence, "PrimaryAnatomicStructure", fields);
        return Collections.unmodifiableMap(fields);
    }
    private static Map<String,String> display(Attributes attrs, DicomImageReader reader, double slope,
                                               double intercept, int stored, int signed) throws Exception {
        // dcm4che uses floats internally. Record the actual float inputs supplied to its renderer.
        float center, width; String method;
        if (attrs.containsValue(Tag.WindowCenter) && attrs.containsValue(Tag.WindowWidth)) {
            center = attrs.getFloat(Tag.WindowCenter, Float.NaN); width = attrs.getFloat(Tag.WindowWidth, Float.NaN);
            require(Float.isFinite(center) && Float.isFinite(width) && width >= 1, "Invalid source window center/width");
            method = "source-window-0";
        } else {
            var raster = reader.readRaster(0, reader.getDefaultReadParam());
            int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE, mask = (1 << stored) - 1, sign = 1 << (stored - 1);
            for (int y = 0; y < raster.getHeight(); y++) for (int x = 0; x < raster.getWidth(); x++) {
                int value = raster.getSample(x, y, 0) & mask;
                if (signed == 1 && value >= sign) value -= 1 << stored;
                min = Math.min(min, value); max = Math.max(max, value);
            }
            double low = Math.min(min * slope + intercept, max * slope + intercept);
            double high = Math.max(min * slope + intercept, max * slope + intercept);
            width = (float) Math.max(1, high - low + 1); center = (float) ((low + high + 1) / 2);
            require(Float.isFinite(center) && Float.isFinite(width), "Invalid automatic display window");
            method = "auto-min-max-v1";
        }
        Map<String,String> result = new LinkedHashMap<>();
        result.put("renderer", "dcm4che 5.33.1"); result.put("windowCenter", Float.toString(center));
        result.put("windowWidth", Float.toString(width)); result.put("windowMethod", method);
        result.put("rescaleSlope", Float.toString((float) slope)); result.put("rescaleIntercept", Float.toString((float) intercept));
        result.put("invert", Boolean.toString("MONOCHROME1".equals(attrs.getString(Tag.PhotometricInterpretation))));
        result.put("voiLUTFunction", "LINEAR"); result.put("rotationDegrees", "0");
        result.put("flipHorizontal", "false"); result.put("flipVertical", "false");
        result.put("overlayPolicy", "disabled"); result.put("pixelAspectRatio", "1:1");
        return Collections.unmodifiableMap(result);
    }
    /** Canonical preview digest: RGB8 red/green/blue bytes in row-major order, no alpha or header. */
    static String previewSha256(BufferedImage image) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        // Same grayscale-to-sRGB conversion used for the PDF preview.
        BufferedImage rgb = rgb(image);
        byte[] row = new byte[rgb.getWidth() * 3];
        for (int y = 0; y < rgb.getHeight(); y++) {
            for (int x = 0; x < rgb.getWidth(); x++) {
                int value = rgb.getRGB(x, y); row[x*3] = (byte) (value >> 16); row[x*3+1] = (byte) (value >> 8); row[x*3+2] = (byte) value;
            }
            digest.update(row);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
    static BufferedImage rgb(BufferedImage image) {
        if (image.getType() == BufferedImage.TYPE_INT_RGB) return image;
        var rgb = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
        var graphics = rgb.createGraphics(); try { graphics.drawImage(image, 0, 0, null); } finally { graphics.dispose(); }
        return rgb;
    }
    private static void copyCodes(Attributes attrs, int tag, String prefix, Map<String,String> fields) {
        Sequence sequence = attrs.getSequence(tag);
        if (sequence == null) return;
        for (int i = 0; i < sequence.size(); i++) {
            Attributes item = sequence.get(i);
            for (int codeTag : new int[]{Tag.CodeValue, Tag.CodingSchemeDesignator, Tag.CodeMeaning}) {
                String value = item.getString(codeTag);
                if (value != null && !value.isBlank()) fields.put(prefix + "[" + i + "]." + ElementDictionary.keywordOf(codeTag, null), value);
            }
        }
    }
    private static void require(boolean test, String reason) { if (!test) throw new IllegalArgumentException(reason); }
}
