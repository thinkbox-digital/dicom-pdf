package digital.thinkbox.dicompdf;

import java.util.Set;
import javax.imageio.ImageIO;
import javax.imageio.spi.IIORegistry;
import org.dcm4che3.data.UID;
import org.dcm4che3.imageio.codec.ImageReaderFactory;

/** Explicit codec selection for each supported transfer syntax. */
final class DicomCodecs {
    private DicomCodecs() {}
    static final Set<String> NATIVE = Set.of(UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian,
            UID.ExplicitVRBigEndian, UID.DeflatedExplicitVRLittleEndian);
    static final Set<String> JPEG = Set.of(UID.JPEGBaseline8Bit, UID.JPEGExtended12Bit,
            UID.JPEGSpectralSelectionNonHierarchical68, UID.JPEGFullProgressionNonHierarchical1012,
            UID.JPEGLossless, UID.JPEGLosslessSV1);
    private static final Set<String> JPEG_LS = Set.of(UID.JPEGLSLossless, UID.JPEGLSNearLossless);
    private static final Set<String> JPEG_2000 = Set.of(UID.JPEG2000Lossless, UID.JPEG2000);
    private static boolean configured;
    static synchronized void ensureConfigured() {
        if (configured) return;
        ImageIO.scanForPlugins();
        var factory = ImageReaderFactory.getDefault();
        for (String syntax : JPEG) factory.put(syntax, new ImageReaderFactory.ImageReaderParam(
                "JPEG", "com.twelvemonkeys.imageio.plugins.jpeg.JPEGImageReader", null, new String[0]));
        factory.put(UID.RLELossless, new ImageReaderFactory.ImageReaderParam(
                "rle", "org.dcm4che3.imageio.plugins.rle.RLEImageReader", null, new String[0]));
        var registry = IIORegistry.getDefaultInstance();
        registry.registerServiceProvider(new CompressedDicomReader.JpegLsProvider());
        registry.registerServiceProvider(new CompressedDicomReader.Jpeg2000Provider());
        for (String syntax : JPEG_LS) factory.put(syntax, compressedReader(CompressedDicomReader.JPEG_LS));
        for (String syntax : JPEG_2000) factory.put(syntax, compressedReader(CompressedDicomReader.JPEG_2000));
        configured = true;
    }
    private static ImageReaderFactory.ImageReaderParam compressedReader(String format) {
        return new ImageReaderFactory.ImageReaderParam(format, CompressedDicomReader.class.getName(), null, new String[0]);
    }
    static boolean supported(String syntax, boolean expandedFormats) {
        return NATIVE.contains(syntax) || JPEG.contains(syntax) || UID.RLELossless.equals(syntax)
                || expandedFormats && (JPEG_LS.contains(syntax) || JPEG_2000.contains(syntax));
    }
}
