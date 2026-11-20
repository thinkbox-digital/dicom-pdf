package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;

/** Build-time publication: never truncate a JAR that a running JVM may still have open. */
public final class JarPublication {
    private JarPublication() {}

    public static void main(String[] args)throws Exception {
        if(args.length!=3||!args[2].matches("[A-Za-z0-9][A-Za-z0-9_.-]*"))
            throw new IllegalArgumentException("Expected staging directory, distribution directory and version");
        Path staging=Path.of(args[0]),distribution=Path.of(args[1]);
        var artifacts=new LinkedHashMap<String,String>();
        artifacts.put("dicom-pdf-"+args[2]+"-desktop.jar","digital.thinkbox.dicompdf.ArchiveDesktop");
        artifacts.put("dicom-pdf-"+args[2]+".jar","digital.thinkbox.dicompdf.Main");
        // Check both complete artifacts before publishing either of them.
        for(var artifact:artifacts.entrySet()){
            try(var jar=new JarFile(staging.resolve(artifact.getKey()).toFile())){
                var manifest=jar.getManifest();
                if(manifest==null||!artifact.getValue().equals(manifest.getMainAttributes().getValue(Attributes.Name.MAIN_CLASS)))
                    throw new IOException("Missing or incorrect runnable entry point: "+artifact.getKey());
                for(String entry:List.of(artifact.getValue().replace('.','/')+".class","com/google/gson/JsonParser.class","org/apache/pdfbox/pdmodel/PDDocument.class","viewer.html"))
                    if(jar.getJarEntry(entry)==null)throw new IOException("Incomplete runnable JAR: "+artifact.getKey()+" lacks "+entry);
            }
        }
        for(String name:artifacts.keySet())publish(staging.resolve(name),distribution.resolve(name));
    }

    static void publish(Path source,Path destination)throws IOException {
        Path absolute=destination.toAbsolutePath().normalize(),directory=absolute.getParent();
        Files.createDirectories(directory);
        // A temporary copy on the destination filesystem also supports a separate Maven build directory.
        Path temporary=Files.createTempFile(directory,".dicom-pdf-publish-",".jar");
        try{
            Files.copy(source,temporary,StandardCopyOption.REPLACE_EXISTING);
            try(var jar=new JarFile(temporary.toFile())){
                if(jar.size()==0)throw new IOException("Cannot publish an empty JAR");
            }
            try{Files.move(temporary,absolute,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
            catch(AtomicMoveNotSupportedException unavailable){
                throw new IOException("Atomic JAR publication is unavailable; the existing application was not replaced",unavailable);
            }
        }finally{Files.deleteIfExists(temporary);}
    }
}
