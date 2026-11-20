package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;

/** Generated from mathematical shapes only: no source radiographs or patient data. */
public final class SyntheticFixtures {
    public static final String STUDY_UID = "2.25.945092014509234551230001";
    public static final int WIDTH = 192;
    public static final int HEIGHT = 128;
    private static final String[] SYNTAXES = { UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian,
            UID.ExplicitVRBigEndian };
    private static final String[] NAMES = { "explicit-le", "implicit-le", "explicit-be" };

    private SyntheticFixtures() {}

    public static void main(String[] args) throws Exception {
        boolean references = args.length > 0 && args[0].equals("--references");
        Path root = Path.of(references ? (args.length > 1 ? args[1] : "fixtures/references") : (args.length == 0 ? "fixtures/synthetic" : args[0]));
        if (references) writeReferences(root);
        else { writeSupported(root); writeUnsupported(root.resolve("unsupported")); }
        System.out.println("Wrote synthetic DICOM fixtures to " + root.toAbsolutePath());
    }

    public static void writeSupported(Path root) throws IOException {
        Files.createDirectories(root);
        int instance = 1;
        for (int syntax = 0; syntax < SYNTAXES.length; syntax++) {
            for (int bits : new int[]{8, 16}) {
                for (int signed : new int[]{0, 1}) {
                    for (int mono : new int[]{1, 2}) {
                        String name = NAMES[syntax] + "-" + bits + "-" + (signed == 1 ? "signed" : "unsigned")
                                + "-mono" + mono + ".dcm";
                        Attributes image = image(SYNTAXES[syntax], bits, signed, mono, instance++);
                        write(root.resolve(name), SYNTAXES[syntax], image);
                    }
                }
            }
        }
        Attributes missing = image(UID.ExplicitVRLittleEndian, 16, 0, 2, instance);
        for (int tag : new int[]{Tag.PatientName, Tag.PatientID, Tag.StudyDate, Tag.StudyTime,
                Tag.StudyDescription, Tag.SeriesDescription, Tag.ImageLaterality, Tag.BodyPartExamined}) {
            missing.remove(tag);
        }
        write(root.resolve("missing-optional-metadata.dcm"), UID.ExplicitVRLittleEndian, missing);
    }

    public static void writeUnsupported(Path root) throws IOException {
        Files.createDirectories(root);
        Attributes multi = image(UID.ExplicitVRLittleEndian, 8, 0, 2, 90);
        multi.setInt(Tag.NumberOfFrames, VR.IS, 2);
        byte[] frame = multi.getBytes(Tag.PixelData);
        byte[] frames = new byte[frame.length * 2];
        System.arraycopy(frame, 0, frames, 0, frame.length);
        System.arraycopy(frame, 0, frames, frame.length, frame.length);
        multi.setBytes(Tag.PixelData, VR.OB, frames);
        write(root.resolve("multiframe.dcm"), UID.ExplicitVRLittleEndian, multi);

        Attributes color = image(UID.ExplicitVRLittleEndian, 8, 0, 2, 91);
        color.setString(Tag.PhotometricInterpretation, VR.CS, "RGB");
        color.setInt(Tag.SamplesPerPixel, VR.US, 3);
        color.setInt(Tag.PlanarConfiguration, VR.US, 0);
        color.setBytes(Tag.PixelData, VR.OB, new byte[WIDTH * HEIGHT * 3]);
        write(root.resolve("color.dcm"), UID.ExplicitVRLittleEndian, color);

        Attributes deflated = image(UID.DeflatedExplicitVRLittleEndian, 16, 0, 2, 92);
        write(root.resolve("deflated.dcm"), UID.DeflatedExplicitVRLittleEndian, deflated);
        Files.writeString(root.resolve("corrupt.dcm"), "Synthetic malformed DICOM: originals must still survive.\n");
        Files.write(root.resolve("empty.dcm"), new byte[0]);
    }

    /** Explicit references include a missing instance, ambiguous duplicate ID, and invalid frame. */
    public static void writeReferences(Path root) throws IOException {
        Files.createDirectories(root);
        Attributes target = image(UID.ExplicitVRLittleEndian, 16, 0, 2, 202);
        write(root.resolve("resolved-target.dcm"), UID.ExplicitVRLittleEndian, target);
        Attributes duplicate = image(UID.ExplicitVRLittleEndian, 16, 0, 2, 203);
        write(root.resolve("duplicate-identical-a.dcm"), UID.ExplicitVRLittleEndian, duplicate);
        Files.copy(root.resolve("duplicate-identical-a.dcm"), root.resolve("duplicate-identical-b.dcm"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        Attributes conflict = new Attributes(duplicate);
        conflict.setString(Tag.PatientID, VR.LO, "SYNTHETIC-CONFLICTING-COPY");
        write(root.resolve("duplicate-conflicting.dcm"), UID.ExplicitVRLittleEndian, conflict);
        Attributes source = image(UID.ExplicitVRLittleEndian, 8, 0, 2, 201);
        var references = source.newSequence(Tag.ReferencedImageSequence, 4);
        references.add(reference(STUDY_UID + ".202", 1));
        references.add(reference(STUDY_UID + ".999", 1));
        references.add(reference(STUDY_UID + ".203", 1));
        references.add(reference(STUDY_UID + ".202", 2));
        // Exercise recursive traversal rather than only the top-level image sequence.
        var series = source.newSequence(Tag.ReferencedSeriesSequence, 1);
        Attributes seriesItem = new Attributes();
        seriesItem.setString(Tag.SeriesInstanceUID, VR.UI, STUDY_UID + ".2");
        seriesItem.newSequence(Tag.ReferencedInstanceSequence, 1).add(reference(STUDY_UID + ".998", 1));
        series.add(seriesItem);
        write(root.resolve("reference-source.dcm"), UID.ExplicitVRLittleEndian, source);
    }

    /** A separate synthetic derived copy: this helper is never used by production creation. */
    public static void writeDeidentifiedCopy(Path root) throws IOException {
        Files.createDirectories(root);
        Attributes derived = image(UID.ExplicitVRLittleEndian, 16, 0, 2, 302);
        derived.remove(Tag.PatientName); derived.remove(Tag.PatientID);
        derived.setString(Tag.PatientIdentityRemoved, VR.CS, "YES");
        derived.setString(Tag.DeidentificationMethod, VR.LO, "Synthetic derived fixture; no real patient");
        write(root.resolve("derived-copy.dcm"), UID.ExplicitVRLittleEndian, derived);
    }

    public static void writeAutoWindow(Path root) throws IOException {
        Files.createDirectories(root);
        Attributes auto = image(UID.ExplicitVRLittleEndian, 8, 0, 2, 303);
        auto.remove(Tag.WindowCenter); auto.remove(Tag.WindowWidth);
        auto.setString(Tag.RescaleSlope, VR.DS, "2");
        auto.setString(Tag.RescaleIntercept, VR.DS, "-10");
        write(root.resolve("auto-window.dcm"), UID.ExplicitVRLittleEndian, auto);
    }

    public static void writeDeepReferences(Path root) throws IOException {
        Files.createDirectories(root);
        Attributes source = image(UID.ExplicitVRLittleEndian, 8, 0, 2, 304);
        Attributes nested = source;
        for (int i = 0; i < 66; i++) {
            Attributes next = new Attributes();
            nested.newSequence(Tag.SourceImageSequence, 1).add(next);
            nested = next;
        }
        nested.newSequence(Tag.ReferencedImageSequence, 1).add(reference(STUDY_UID + ".997", 1));
        write(root.resolve("deep-reference.dcm"), UID.ExplicitVRLittleEndian, source);
    }

    private static Attributes reference(String instance, int frame) {
        Attributes reference = new Attributes();
        reference.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.DigitalIntraOralXRayImageStorageForPresentation);
        reference.setString(Tag.ReferencedSOPInstanceUID, VR.UI, instance);
        reference.setInt(Tag.ReferencedFrameNumber, VR.IS, frame);
        return reference;
    }

    private static Attributes image(String syntax, int allocated, int signed, int mono, int instance) {
        boolean bigEndian = UID.ExplicitVRBigEndian.equals(syntax);
        Attributes a = new Attributes(bigEndian);
        a.setString(Tag.SOPClassUID, VR.UI, UID.DigitalIntraOralXRayImageStorageForPresentation);
        a.setString(Tag.SOPInstanceUID, VR.UI, STUDY_UID + "." + instance);
        a.setString(Tag.StudyInstanceUID, VR.UI, STUDY_UID);
        a.setString(Tag.SeriesInstanceUID, VR.UI, STUDY_UID + ".1");
        a.setString(Tag.PatientName, VR.PN, "Synthetic^Imaging");
        a.setString(Tag.PatientID, VR.LO, "SYNTHETIC-NOT-A-PATIENT");
        a.setString(Tag.StudyDate, VR.DA, "20260101");
        a.setString(Tag.StudyTime, VR.TM, "120000");
        a.setString(Tag.StudyDescription, VR.LO, "Mathematical image phantom - synthetic fixture");
        a.setString(Tag.SeriesDescription, VR.LO, "Synthetic reference images");
        a.setString(Tag.Modality, VR.CS, "IO");
        a.setString(Tag.PresentationIntentType, VR.CS, "FOR PRESENTATION");
        a.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY");
        a.setString(Tag.BodyPartExamined, VR.CS, "TEETH");
        a.setInt(Tag.SeriesNumber, VR.IS, 1);
        a.setInt(Tag.InstanceNumber, VR.IS, instance);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME" + mono);
        a.setInt(Tag.Rows, VR.US, HEIGHT);
        a.setInt(Tag.Columns, VR.US, WIDTH);
        a.setInt(Tag.BitsAllocated, VR.US, allocated);
        int stored = allocated == 8 ? 8 : 12;
        a.setInt(Tag.BitsStored, VR.US, stored);
        a.setInt(Tag.HighBit, VR.US, stored - 1);
        a.setInt(Tag.PixelRepresentation, VR.US, signed);
        int range = 1 << stored;
        int minimum = signed == 1 ? -(range / 2) : 0;
        a.setString(Tag.WindowCenter, VR.DS, String.valueOf(minimum + range / 2));
        a.setString(Tag.WindowWidth, VR.DS, String.valueOf(range));
        ByteBuffer pixel = ByteBuffer.allocate(WIDTH * HEIGHT * allocated / 8)
                .order(bigEndian ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
        for (int y = 0; y < HEIGHT; y++) {
            for (int x = 0; x < WIDTH; x++) {
                double value = 0.04 + x / (double) WIDTH * 0.20;
                for (int tooth = 0; tooth < 4; tooth++) {
                    double dx = (x - (30 + tooth * 44)) / 17.0;
                    double dy = (y - 56) / 47.0;
                    double ellipse = dx * dx + dy * dy;
                    if (ellipse < 1) value = Math.max(value, 0.50 + 0.36 * (1 - ellipse));
                    if (dx * dx / 0.15 + dy * dy / 0.8 < 1) value -= 0.15;
                }
                int sample = minimum + (int) Math.round(Math.clamp(value, 0.0, 1.0) * (range - 1));
                if (allocated == 8) pixel.put((byte) sample);
                else pixel.putShort((short) sample);
            }
        }
        a.setBytes(Tag.PixelData, allocated == 8 ? VR.OB : VR.OW, pixel.array());
        return a;
    }

    private static void write(Path file, String syntax, Attributes image) throws IOException {
        try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
            out.writeDataset(image.createFileMetaInformation(syntax), image);
        }
    }
}
