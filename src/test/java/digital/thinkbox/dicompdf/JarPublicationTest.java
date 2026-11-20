package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.jar.*;
import java.util.zip.CRC32;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class JarPublicationTest {
    @TempDir Path root;

    @Test void publishingPreservesLazyLoadingInAnAlreadyRunningApplication() throws Exception {
        Path source=Path.of(JsonParser.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        Path running=root.resolve("application.jar"),replacement=root.resolve("replacement.jar");
        copyWithPadding(source,running,0);copyWithPadding(source,replacement,65536);
        try(var loader=new URLClassLoader(new URL[]{running.toUri().toURL()},ClassLoader.getPlatformClassLoader())){
            Class<?> warm=loader.loadClass("com.google.gson.JsonElement");
            JarPublication.publish(replacement,running);
            assertEquals(-1,Files.mismatch(replacement,running));
            Class<?> lazy=null;Throwable failure=null;
            try{lazy=loader.loadClass("com.google.gson.JsonParser");}catch(Throwable error){failure=error;}
            assertNull(failure,String.valueOf(failure));
            assertSame(warm.getClassLoader(),lazy.getClassLoader());
            try(var fresh=new URLClassLoader(new URL[]{running.toUri().toURL()},ClassLoader.getPlatformClassLoader())){
                assertEquals("com.google.gson.JsonParser",fresh.loadClass("com.google.gson.JsonParser").getName());
            }
        }
    }

    @Test void invalidReplacementPreservesTheExistingJarAndCleansStaging()throws Exception{
        Path original=Path.of(JsonParser.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        Path published=root.resolve("application.jar"),invalid=root.resolve("invalid.jar");
        Files.copy(original,published);Files.writeString(invalid,"not a JAR");byte[] before=Files.readAllBytes(published);
        assertThrows(IOException.class,()->JarPublication.publish(invalid,published));
        assertArrayEquals(before,Files.readAllBytes(published));
        try(var files=Files.list(root)){assertFalse(files.anyMatch(path->path.getFileName().toString().startsWith(".dicom-pdf-publish-")));}
    }

    private static void copyWithPadding(Path source,Path destination,int size)throws Exception{
        try(var input=new JarFile(source.toFile());var output=new JarOutputStream(Files.newOutputStream(destination))){
            byte[] padding=new byte[size];var crc=new CRC32();crc.update(padding);
            var entry=new JarEntry("build-padding");entry.setMethod(JarEntry.STORED);entry.setSize(size);entry.setCompressedSize(size);entry.setCrc(crc.getValue());
            output.putNextEntry(entry);output.write(padding);output.closeEntry();
            for(var item:java.util.Collections.list(input.entries())){
                output.putNextEntry(new JarEntry(item.getName()));
                try(var stream=input.getInputStream(item)){stream.transferTo(output);}output.closeEntry();
            }
        }
    }
}
