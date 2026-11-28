package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.*;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Stages a GUI archive beside its destination until it is ready to publish. */
final class DesktopReplacement implements AutoCloseable {
    private final Path destination;
    private final BasicFileAttributes confirmed;
    private Path directory;
    private Path staged;
    private byte[] originalHash;
    private volatile boolean committed;
    private DesktopReplacement(Path destination,BasicFileAttributes confirmed){this.destination=destination;this.confirmed=confirmed;}
    static DesktopReplacement inspect(Path source,Path destination)throws IOException{
        destination=destination.toAbsolutePath().normalize();
        if(destination.getFileName()==null||!destination.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".pdf"))throw new IOException("Choose an output filename ending in .pdf.");
        Path parent=destination.getParent(),ancestor=parent;
        while(Files.notExists(ancestor,LinkOption.NOFOLLOW_LINKS))ancestor=ancestor.getParent();
        Path canonical=ancestor.toRealPath().resolve(ancestor.relativize(destination));
        BasicFileAttributes attributes;
        try{attributes=Files.readAttributes(canonical,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);}
        catch(NoSuchFileException missing){attributes=null;}
        if(attributes!=null&&!attributes.isRegularFile())throw new IOException("Only a regular PDF file can be replaced; symbolic links and directories are not supported.");
        Path original=source.toRealPath();
        if(Files.isDirectory(original)&&canonical.startsWith(original)||attributes!=null&&Files.isSameFile(original,canonical))
            throw new IOException("Output PDF must be outside the source inputs; originals cannot be replaced.");
        return new DesktopReplacement(canonical,attributes);
    }
    Path destination(){return destination;}
    boolean replacing(){return confirmed!=null;}
    boolean committed(){return committed;}
    Path stage(BooleanSupplier stopped)throws Exception{
        checkStopped(stopped);
        if(replacing()){
            checkUnchanged();originalHash=hash(destination,stopped);checkUnchanged();
        }
        Path parent=Files.createDirectories(destination.getParent());
        directory=SourceContent.privateDirectory(parent,".dicom-pdf-desktop-");
        staged=directory.resolve("archive.pdf");
        return staged;
    }
    void commit(BooleanSupplier stopped)throws Exception{
        if(staged==null||!Files.isRegularFile(staged,LinkOption.NOFOLLOW_LINKS))throw new IOException("The staged PDF was not completed.");
        checkStopped(stopped);
        if(replacing()){
            checkUnchanged();
            if(!MessageDigest.isEqual(originalHash,hash(destination,stopped)))throw new IOException("The existing PDF changed during conversion. Retry to confirm the new replacement.");
            checkUnchanged();checkStopped(stopped);
            Files.move(staged,destination,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        }else{
            // ATOMIC_MOVE can replace an existing destination even without REPLACE_EXISTING.
            try{Files.createLink(destination,staged);}
            catch(FileAlreadyExistsException collision){throw new IOException("The output PDF appeared during conversion. Choose another path or confirm replacement on retry.",collision);}
            catch(UnsupportedOperationException unsupported){throw new IOException("Choose an output filesystem that supports hard links for atomic publication.",unsupported);}
        }
        committed=true;
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
    private static void checkStopped(BooleanSupplier stopped)throws IOException{
        if(stopped.getAsBoolean())throw new IOException("Creation stopped before publication.");
    }
    @Override public void close()throws IOException{if(directory!=null)DesktopInputs.remove(directory);}
}
