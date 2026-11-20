package digital.thinkbox.dicompdf;

import java.nio.file.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.DicomOutputStream;

/** Mathematical 1,000-frame fixture; all generated data stays outside supplied inputs. */
public final class StackScaleFixtureMain {
    public static void main(String[] args)throws Exception{
        if(args.length!=2)throw new IllegalArgumentException("Expected new target input directory and new PDF");
        Path directory=Path.of(args[0]).toAbsolutePath().normalize();
        if(!directory.startsWith(Path.of("target").toRealPath())||Files.exists(directory)||Files.exists(Path.of(args[1])))throw new IllegalArgumentException("Choose new synthetic paths under target and a new PDF destination");
        Files.createDirectories(directory);var data=new Attributes();
        data.setString(Tag.SOPClassUID,VR.UI,UID.MultiFrameGrayscaleWordSecondaryCaptureImageStorage);
        data.setString(Tag.SOPInstanceUID,VR.UI,"2.25.41003");data.setString(Tag.StudyInstanceUID,VR.UI,"2.25.41001");data.setString(Tag.SeriesInstanceUID,VR.UI,"2.25.41002");
        data.setString(Tag.PatientName,VR.PN,"Synthetic^Stack");data.setString(Tag.PatientID,VR.LO,"SYNTHETIC-STACK-ONLY");
        for(int tag:new int[]{Tag.PatientBirthDate,Tag.PatientSex,Tag.StudyDate,Tag.StudyTime,Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber})data.setNull(tag,ElementDictionary.vrOf(tag,null));
        data.setString(Tag.SeriesNumber,VR.IS,"1");data.setString(Tag.InstanceNumber,VR.IS,"1");data.setString(Tag.ConversionType,VR.CS,"SYN");
        data.setString(Tag.SeriesDescription,VR.LO,"Synthetic 1000-frame mathematical stack");
        data.setInt(Tag.Rows,VR.US,256);data.setInt(Tag.Columns,VR.US,256);data.setInt(Tag.SamplesPerPixel,VR.US,1);data.setString(Tag.PhotometricInterpretation,VR.CS,"MONOCHROME2");
        data.setInt(Tag.BitsAllocated,VR.US,16);data.setInt(Tag.BitsStored,VR.US,12);data.setInt(Tag.HighBit,VR.US,11);data.setInt(Tag.PixelRepresentation,VR.US,0);
        data.setString(Tag.NumberOfFrames,VR.IS,"1000");data.setString(Tag.FrameTime,VR.DS,"100");data.setInt(Tag.FrameIncrementPointer,VR.AT,Tag.FrameTime);
        data.setString(Tag.WindowCenter,VR.DS,"2048");data.setString(Tag.WindowWidth,VR.DS,"4096");
        byte[] pixels=new byte[1000*256*256*2];
        for(int frame=0;frame<1000;frame++)for(int y=0;y<256;y++)for(int x=0;x<256;x++){
            int value=(x*9+y*5+frame*7)&4095,at=((frame*256+y)*256+x)*2;pixels[at]=(byte)value;pixels[at+1]=(byte)(value>>>8);
        }
        data.setBytes(Tag.PixelData,VR.OW,pixels);
        try(var output=new DicomOutputStream(directory.resolve("synthetic-1000-frames.dcm").toFile())){output.writeDataset(data.createFileMetaInformation(UID.ExplicitVRLittleEndian),data);}
        // Release the generator's large raster before running the real creator.
        data=null;pixels=null;
        Main.main(new String[]{"create","--input",directory.toString(),"--output",args[1]});
    }
}
