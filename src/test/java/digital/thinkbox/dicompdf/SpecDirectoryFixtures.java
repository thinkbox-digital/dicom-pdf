package digital.thinkbox.dicompdf;

import java.nio.file.*;
import org.dcm4che3.data.*;
import org.dcm4che3.media.DicomDirWriter;

/** Deterministic File-set examples for independent DICOMDIR package checks. */
public final class SpecDirectoryFixtures {
    private SpecDirectoryFixtures() {}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length==0?"fixtures/spec-directory":args[0]);boolean missing=args.length>1 && args[1].equals("missing");
        Path images=root.resolve("IMAGES");Files.createDirectories(images);
        var source=SpecDisplayTest.phantom(false,0,255,255,255);source.setString(Tag.PatientID,VR.LO,"SYNTHETIC");
        source.setString(Tag.PatientName,VR.PN,"Fixture^Directory");source.setString(Tag.StudyDate,VR.DA,"20261115");
        source.setString(Tag.StudyTime,VR.TM,"000000");source.setString(Tag.StudyID,VR.SH,"1");
        Files.write(images.resolve("IMG00001"),SpecDisplayTest.encode(source));
        Path file=root.resolve("DICOMDIR");
        DicomDirWriter.createEmptyDirectory(file.toFile(),"2.25.202611150200","SPEC2026",null,null);
        try(var writer=DicomDirWriter.open(file.toFile())) {
            var patient=new Attributes();patient.setString(Tag.DirectoryRecordType,VR.CS,"PATIENT");
            patient.setString(Tag.PatientID,VR.LO,"SYNTHETIC");patient.setString(Tag.PatientName,VR.PN,"Fixture^Directory");
            var study=new Attributes();study.setString(Tag.DirectoryRecordType,VR.CS,"STUDY");
            study.setString(Tag.StudyInstanceUID,VR.UI,source.getString(Tag.StudyInstanceUID));study.setString(Tag.StudyDate,VR.DA,"20261115");
            study.setString(Tag.StudyTime,VR.TM,"000000");study.setString(Tag.StudyID,VR.SH,"1");
            var series=new Attributes();series.setString(Tag.DirectoryRecordType,VR.CS,"SERIES");series.setString(Tag.SeriesInstanceUID,VR.UI,source.getString(Tag.SeriesInstanceUID));
            series.setString(Tag.Modality,VR.CS,"OT");series.setInt(Tag.SeriesNumber,VR.IS,1);
            var image=new Attributes();image.setString(Tag.DirectoryRecordType,VR.CS,"IMAGE");image.setString(Tag.ReferencedFileID,VR.CS,"IMAGES",missing?"IMG00002":"IMG00001");
            image.setString(Tag.ReferencedSOPClassUIDInFile,VR.UI,source.getString(Tag.SOPClassUID));image.setString(Tag.ReferencedSOPInstanceUIDInFile,VR.UI,source.getString(Tag.SOPInstanceUID));
            image.setString(Tag.ReferencedTransferSyntaxUIDInFile,VR.UI,UID.ExplicitVRLittleEndian);image.setInt(Tag.InstanceNumber,VR.IS,1);
            writer.addRootDirectoryRecord(patient);writer.addLowerDirectoryRecord(patient,study);writer.addLowerDirectoryRecord(study,series);writer.addLowerDirectoryRecord(series,image);
        }
        System.out.println("Wrote synthetic DICOMDIR "+(missing?"missing-target":"resolved-target")+" fixture to "+root);
    }
}
