package digital.thinkbox.dicompdf;

import java.nio.file.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;

/** Synthetic structural failures only; never modifies supplied input files. */
public final class StructureFixtureMain {
    public static void main(String[] args)throws Exception{
        if(args.length!=2)throw new IllegalArgumentException("Expected new target input directory and new PDF path");
        Path input=Path.of(args[0]).toAbsolutePath().normalize();
        if(!input.startsWith(Path.of("target").toRealPath())||Files.exists(input)||Files.exists(Path.of(args[1])))throw new IllegalArgumentException("Choose new synthetic input/output paths; inputs must be under target");
        Files.createDirectories(input);Attributes data;
        try(var source=new DicomInputStream(Path.of("fixtures/expanded/sc-native-gray8.dcm").toFile())){data=source.readDataset();}
        for(int tag:new int[]{Tag.PatientName,Tag.PatientID,Tag.PatientBirthDate,Tag.PatientSex,Tag.StudyDate,Tag.StudyTime,Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber,Tag.SeriesNumber})if(!data.contains(tag))data.setNull(tag,ElementDictionary.vrOf(tag,null));
        data.setString(Tag.ConversionType,VR.CS,"SYN");data.remove(Tag.Modality);
        write(input.resolve("01-valid-sc.dcm"),data,"2.25.31001");
        var wrong=new Attributes(data);wrong.setBytes(Tag.PixelData,VR.OB,new byte[2]);write(input.resolve("02-invalid-pixel-length.dcm"),wrong,"2.25.31002");
        var external=new Attributes(data);external.remove(Tag.PixelData);external.setString(Tag.PixelDataProviderURL,VR.UR,"https://invalid.example/never-fetch");write(input.resolve("03-external-pixels.dcm"),external,"2.25.31003");
        Files.write(input.resolve("04-unsupported.bin"),new byte[]{1,2,3,4});
        DicomPdf.create(input,Path.of(args[1]));
        System.out.println("Created synthetic structure sample: valid, invalid native length, external pixels and non-DICOM original.");
    }
    private static void write(Path path,Attributes data,String uid)throws Exception{
        data=new Attributes(data);data.setString(Tag.SOPInstanceUID,VR.UI,uid);
        try(var stream=new DicomOutputStream(path.toFile())){stream.writeDataset(data.createFileMetaInformation(UID.ExplicitVRLittleEndian),data);}
    }
}
