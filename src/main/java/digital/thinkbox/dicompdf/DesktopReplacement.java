package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.*;
import java.util.*;
import java.util.function.BooleanSupplier;

/** A confirmed GUI replacement is published only as a completed atomic rename. */
final class DesktopReplacement implements AutoCloseable {
    private final Path destination;
    private final BasicFileAttributes confirmed;
    private Path staged;
    private byte[] originalHash;
    private volatile boolean committed;
    private DesktopReplacement(Path destination,BasicFileAttributes confirmed){this.destination=destination;this.confirmed=confirmed;}
    static DesktopReplacement inspect(Path source,Path destination)throws IOException{
        destination=destination.toAbsolutePath().normalize();
        if(!Files.exists(destination,LinkOption.NOFOLLOW_LINKS))return null;
        if(destination.getFileName()==null||!destination.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".pdf"))throw new IOException("Choose an output filename ending in .pdf.");
        var attributes=Files.readAttributes(destination,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!attributes.isRegularFile()||Files.isSymbolicLink(destination))throw new IOException("Only a regular PDF file can be replaced; symbolic links and directories are not supported.");
        Path original=source.toRealPath(),canonical=destination.getParent().toRealPath().resolve(destination.getFileName());
        if(Files.isSameFile(original,canonical)||Files.isDirectory(original)&&canonical.startsWith(original))throw new IOException("Output PDF must be outside the source inputs; originals cannot be replaced.");
        return new DesktopReplacement(canonical,attributes);
    }
    Path destination(){return destination;}
    boolean committed(){return committed;}
    Path stage(BooleanSupplier stopped)throws Exception{
        checkUnchanged();originalHash=hash(destination,stopped);checkUnchanged();
        staged=Files.createTempFile(destination.getParent(),".dicom-replacement-",".pdf");Files.delete(staged);return staged;
    }
    void commit(BooleanSupplier stopped)throws Exception{
        if(staged==null||!Files.isRegularFile(staged,LinkOption.NOFOLLOW_LINKS))throw new IOException("The replacement PDF was not completed.");
        checkUnchanged();
        if(!MessageDigest.isEqual(originalHash,hash(destination,stopped)))throw new IOException("The existing PDF changed during conversion. Retry to confirm the new replacement.");
        checkUnchanged();if(stopped.getAsBoolean())throw new IOException("Replacement stopped before publication; the existing PDF is unchanged.");
        // No delete-then-move fallback: unsupported atomic replacement must fail safely.
        Files.move(staged,destination,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);committed=true;
    }
    private void checkUnchanged()throws IOException{
        var current=Files.readAttributes(destination,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!current.isRegularFile()||!Objects.equals(current.fileKey(),confirmed.fileKey())||current.size()!=confirmed.size()||!current.lastModifiedTime().equals(confirmed.lastModifiedTime()))
            throw new IOException("The existing PDF changed during conversion. Retry to confirm the new replacement.");
    }
    private static byte[] hash(Path file,BooleanSupplier stopped)throws Exception{
        var digest=MessageDigest.getInstance("SHA-256");byte[] block=new byte[64*1024];
        try(var input=Files.newInputStream(file)){
            int count;while((count=input.read(block))!=-1){if(stopped.getAsBoolean())throw new IOException("Replacement stopped; the existing PDF is unchanged.");digest.update(block,0,count);}
        }return digest.digest();
    }
    @Override public void close()throws IOException{if(!committed&&staged!=null)Files.deleteIfExists(staged);}
}
