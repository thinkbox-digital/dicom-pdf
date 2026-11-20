package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;

/** Synthetic asymmetric tetrahedron and archive preparation for the browser smoke test. */
public final class SurfaceSegmentationFixtures {
    private SurfaceSegmentationFixtures() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 2 && args[0].equals("--write-dicom")) {
            writeMesh(Path.of(args[1]));
            return;
        }
        if (args.length != 1) {
            throw new IllegalArgumentException("Expected the staged browser fixture directory or --write-dicom <file>");
        }
        Path work = Path.of(args[0]);
        for (String kind : List.of("mesh", "image")) {
            Path input = work.resolve(kind);
            if (Files.isDirectory(input)) {
                DicomPdf.create(input, work.resolve(kind + ".pdf"), "archival-master", false);
            }
        }
    }

    private static void writeMesh(Path path) throws IOException {
        String uid = "2.25.202611200661";
        var data = new Attributes();
        data.setString(Tag.SOPClassUID, VR.UI, UID.SurfaceSegmentationStorage);
        data.setString(Tag.SOPInstanceUID, VR.UI, uid + ".1");
        data.setString(Tag.StudyInstanceUID, VR.UI, uid + ".2");
        data.setString(Tag.SeriesInstanceUID, VR.UI, uid + ".3");
        data.setString(Tag.FrameOfReferenceUID, VR.UI, uid + ".4");
        data.setString(Tag.PatientName, VR.PN, "Synthetic^DICOM");
        data.setString(Tag.PatientID, VR.LO, "SYNTHETIC-NOT-A-PATIENT");
        data.setString(Tag.Modality, VR.CS, "SEG");
        data.setInt(Tag.SeriesNumber, VR.IS, 1);
        data.setInt(Tag.InstanceNumber, VR.IS, 1);
        data.setString(Tag.ContentDate, VR.DA, "20261120");
        data.setString(Tag.ContentTime, VR.TM, "000000");
        data.setString(Tag.ContentLabel, VR.CS, "SYNTHETIC_MESH");

        Attributes segment = item(data, Tag.SegmentSequence);
        segment.setInt(Tag.SegmentNumber, VR.US, 1);
        segment.setString(Tag.SegmentLabel, VR.LO, "Synthetic tetrahedron");
        segment.setString(Tag.SegmentAlgorithmType, VR.CS, "AUTOMATIC");
        segment.setInt(Tag.SurfaceCount, VR.UL, 1);
        item(segment, Tag.ReferencedSurfaceSequence).setInt(Tag.ReferencedSurfaceNumber, VR.UL, 1);

        data.setInt(Tag.NumberOfSurfaces, VR.UL, 1);
        Attributes surface = item(data, Tag.SurfaceSequence);
        surface.setInt(Tag.SurfaceNumber, VR.UL, 1);
        surface.setString(Tag.SurfaceProcessing, VR.CS, "NO");
        surface.setInt(Tag.RecommendedDisplayGrayscaleValue, VR.US, 65535);
        surface.setInt(Tag.RecommendedDisplayCIELabValue, VR.US, 47831, 27412, 21114);
        surface.setFloat(Tag.RecommendedPresentationOpacity, VR.FL, 1);
        surface.setString(Tag.RecommendedPresentationType, VR.CS, "SURFACE");
        surface.setString(Tag.FiniteVolume, VR.CS, "YES");
        surface.setString(Tag.Manifold, VR.CS, "YES");
        surface.setNull(Tag.SurfacePointsNormalsSequence, VR.SQ);

        Attributes points = item(surface, Tag.SurfacePointsSequence);
        points.setInt(Tag.NumberOfSurfacePoints, VR.UL, 4);
        points.setFloat(Tag.PointCoordinatesData, VR.OF,
                -24, -17, -13,
                 30, -11, -13,
                 -9,  22, -13,
                 -4,  -6,  29);

        Attributes primitives = item(surface, Tag.SurfaceMeshPrimitivesSequence);
        primitives.setInt(Tag.LongTrianglePointIndexList, VR.OL, 1, 3, 2, 1, 2, 4, 2, 3, 4, 3, 1, 4);
        primitives.setNull(Tag.LongEdgePointIndexList, VR.OL);
        primitives.setNull(Tag.LongVertexPointIndexList, VR.OL);
        for (int tag : new int[] {Tag.TriangleStripSequence, Tag.TriangleFanSequence, Tag.LineSequence, Tag.FacetSequence}) {
            primitives.setNull(tag, VR.SQ);
        }

        Files.createDirectories(path.toAbsolutePath().getParent());
        try (var output = new DicomOutputStream(path.toFile())) {
            output.writeDataset(data.createFileMetaInformation(UID.ExplicitVRLittleEndian), data);
        }
    }

    private static Attributes item(Attributes parent, int tag) {
        var attributes = new Attributes();
        parent.newSequence(tag, 1).add(attributes);
        return attributes;
    }
}
