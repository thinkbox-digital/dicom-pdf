package digital.thinkbox.dicompdf;

import java.nio.file.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;

/** Mathematical 1,001-instance study for creator/validator/viewer scale checks. */
public final class LargeStudyFixtureMain {
    public static void main(String[] args)throws Exception{
        Path work=Path.of(args[0]),output=Path.of(args[1]);
        Files.createDirectories(work);Path seeds=work.resolve("seeds");SyntheticFixtures.writeSupported(seeds);
        Attributes template;try(var input=new DicomInputStream(seeds.resolve("explicit-le-8-unsigned-mono2.dcm").toFile())){template=input.readDataset();}
        template.setInt(Tag.Rows,VR.US,16);template.setInt(Tag.Columns,VR.US,16);
        Path sources=Files.createDirectory(work.resolve("inputs"));
        for(int index=1;index<=1001;index++){
            var image=new Attributes(template);image.setString(Tag.SOPInstanceUID,VR.UI,"2.25.9467810000"+index);image.setInt(Tag.InstanceNumber,VR.IS,index);
            byte[] pixels=new byte[256];for(int pixel=0;pixel<pixels.length;pixel++)pixels[pixel]=(byte)(pixel+index);
            image.setBytes(Tag.PixelData,VR.OB,pixels);
            try(var destination=new DicomOutputStream(sources.resolve(String.format("instance-%04d.dcm",index)).toFile())){destination.writeDataset(image.createFileMetaInformation(UID.ExplicitVRLittleEndian),image);}
        }
        var manifest=DicomPdf.create(sources,output);if(manifest.images().size()!=1001)throw new AssertionError("Large study was truncated");
        System.out.println("Created synthetic 1,001-instance study without truncation.");
    }
}
