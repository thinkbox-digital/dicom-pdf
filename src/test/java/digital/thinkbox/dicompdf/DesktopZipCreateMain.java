package digital.thinkbox.dicompdf;

import java.nio.file.*;

/** Local ZIP-import/conversion check using the exact desktop staging/CLI pipeline. */
public final class DesktopZipCreateMain {
    public static void main(String[] args)throws Exception{
        if(args.length!=3)throw new IllegalArgumentException("Expected ZIP input, new PDF output, new working directory under target");
        Path work=Path.of(args[2]).toAbsolutePath().normalize();
        if(!work.startsWith(Path.of("target").toAbsolutePath().normalize())||Files.exists(work))throw new IllegalArgumentException("Choose a new working directory under target");
        Files.createDirectories(work);
        var request=new DesktopRequest(true,args[0],args[1],"","",false).prepare(work,()->false);
        int result=Main.run(request.arguments(work.resolve("report.json")).toArray(String[]::new),System.out,System.err);
        if(result!=0)throw new IllegalStateException("ZIP conversion did not complete");
        Files.writeString(work.resolve("original-source-directory.txt"),request.input()+"\n");
    }
}
