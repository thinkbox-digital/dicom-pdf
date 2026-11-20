package digital.thinkbox.dicompdf;

import java.nio.file.*;
import java.util.*;

/** Synthetic incompressible bulk source to exercise streaming beyond former byte limits. */
public final class LargeArchiveFixtureMain {
    public static void main(String[] args)throws Exception{
        Path work=Path.of(args[0]),pdf=Path.of(args[1]),inputs=work.resolve("inputs");Files.createDirectories(inputs);
        Files.copy(Path.of("fixtures/expanded/sc-native-gray8.dcm"),inputs.resolve("image.dcm"));
        byte[] block=new byte[1024*1024];new Random(8675309).nextBytes(block);
        byte[] label="SYNTHETIC NON-DICOM BULK SOURCE\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII);System.arraycopy(label,0,block,0,label.length);
        try(var out=Files.newOutputStream(inputs.resolve("bulk.dat"),StandardOpenOption.CREATE_NEW)){for(int i=0;i<Integer.parseInt(args[2]);i++)out.write(block);}
        var manifest=DicomPdf.create(inputs,pdf);if(manifest.images().size()!=2)throw new AssertionError("Source inventory was truncated");
        var result=PackageTools.verify(pdf,inputs,args.length>3?args[3]:null);Files.writeString(work.resolve("verification.json"),result.json());
        if(!result.sourceBytes().status().equals("PASS")||!result.metadataAccuracy().status().equals("PASS")||!result.externalSources().status().equals("PASS"))throw new AssertionError("Streaming recovery checks failed");
        Path recovered=work.resolve("recovered");PackageTools.extract(pdf,recovered);
        for(var source:List.of("bulk.dat","image.dcm"))if(Files.mismatch(inputs.resolve(source),recovered.resolve("originals").resolve(source))!=-1)throw new AssertionError("Recovery mismatch");
        System.out.println("Synthetic large archive verified and recovered byte for byte; PDF bytes="+Files.size(pdf));
    }
}
