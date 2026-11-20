package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.util.regex.Pattern;

/** Build-time publication: never truncate a JAR that a running JVM may still have open. */
public final class JarPublication {
    private JarPublication() {}

    public static void main(String[] args)throws Exception {
        if(args.length!=3||!args[2].matches("\\d+\\.\\d+\\.\\d+"))
            throw new IllegalArgumentException("Expected staging directory, distribution directory and version");
        publishPair(Path.of(args[0]),Path.of(args[1]),args[2]);
    }

    static void publishPair(Path staging,Path distribution,String version)throws IOException {
        var artifacts=new LinkedHashMap<String,String>();
        artifacts.put("dicom-pdf-"+version+"-desktop.jar","digital.thinkbox.dicompdf.ArchiveDesktop");
        artifacts.put("dicom-pdf-"+version+".jar","digital.thinkbox.dicompdf.Main");
        Files.createDirectories(distribution);
        Path lock=distribution.resolve(".dicom-pdf-publication");
        Files.createDirectory(lock);
        List<Path> installed=new ArrayList<>();
        boolean ready=false;
        try {
            byte[] viewer=null;
            for(var artifact:artifacts.entrySet()) {
                String name=artifact.getKey();
                if(Files.exists(distribution.resolve(name),LinkOption.NOFOLLOW_LINKS))
                    throw new IOException("Distribution version "+version+" already exists. Advance the application version before rebuilding.");
                Path candidate=Files.copy(staging.resolve(name),lock.resolve(name));
                try(var jar=new JarFile(candidate.toFile())){
                    var manifest=jar.getManifest();
                    if(manifest==null||!artifact.getValue().equals(manifest.getMainAttributes().getValue(Attributes.Name.MAIN_CLASS)))
                        throw new IOException("Missing or incorrect runnable entry point: "+name);
                    for(String entry:List.of(artifact.getValue().replace('.','/')+".class","com/google/gson/JsonParser.class","org/apache/pdfbox/pdmodel/PDDocument.class","viewer.html"))
                        if(jar.getJarEntry(entry)==null)throw new IOException("Incomplete runnable JAR: "+name+" lacks "+entry);
                    try(var input=jar.getInputStream(jar.getJarEntry("viewer.html"))) {
                        byte[] current=input.readAllBytes();
                        if(current.length==0)throw new IOException("Missing viewer content in "+name);
                        if(viewer!=null&&!Arrays.equals(viewer,current))
                            throw new IOException("Runnable JARs embed different viewers");
                        viewer=current;
                    }
                }
            }
            for(String name:artifacts.keySet()) {
                Path destination=distribution.resolve(name);
                Files.move(lock.resolve(name),destination,StandardCopyOption.ATOMIC_MOVE);
                installed.add(destination);
            }
            ready=true;
            Pattern versionedJar=Pattern.compile("dicom-pdf-\\d+\\.\\d+\\.\\d+(?:-desktop)?\\.jar");
            try(var files=Files.list(distribution)) {
                for(Path file:files.toList()) {
                    String name=file.getFileName().toString();
                    if(versionedJar.matcher(name).matches()&&!artifacts.containsKey(name)&&Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS))
                        Files.delete(file);
                }
            }
        } catch(IOException failure) {
            if(!ready)for(Path path:installed)try{Files.delete(path);}catch(IOException rollback){failure.addSuppressed(rollback);}
            throw failure;
        } finally {
            for(String name:artifacts.keySet())Files.deleteIfExists(lock.resolve(name));
            Files.delete(lock);
        }
    }
}
