package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.text.Normalizer;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.zip.*;

/** Private, bounded staging for single-file and ZIP desktop inputs. Masters stay untouched. */
final class DesktopInputs {
    private static final long TOTAL=Long.MAX_VALUE;
    private DesktopInputs(){}
    static Path prepare(Path selected,Path stage,BooleanSupplier stopped)throws IOException{
        return prepare(selected,stage,stopped,null);
    }
    static Path prepare(Path selected,Path stage,BooleanSupplier stopped,Path receipt)throws IOException{
        return prepare(selected,stage,stopped,receipt,message->{});
    }
    static Path prepare(Path selected,Path stage,BooleanSupplier stopped,Path receipt,java.util.function.Consumer<String> progress)throws IOException{
        if(Files.isSymbolicLink(selected))throw new IOException("Select a regular file or directory, not a symbolic link.");
        if(Files.isDirectory(selected)){progress.accept("Selected folder is ready; subfolders will be included.");return selected.toRealPath();}
        if(!Files.isRegularFile(selected))throw new IOException("Choose an existing file, directory or ZIP archive.");
        Files.createDirectory(stage);
        Path original=stage.resolve(selected.getFileName());
        progress.accept("Copying the selected input into temporary staging…");
        long size=Files.size(selected),copied;
        try(var in=Files.newInputStream(selected);var out=Files.newOutputStream(original,StandardOpenOption.CREATE_NEW)){
            copied=copy(in,out,Math.min(PackageLimits.PAYLOAD,TOTAL),stopped,null);
        }
        if(copied!=size)throw new IOException("Source size changed during staging. No archive was created.");
        if(!selected.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".zip"))return stage;
        long total=0;int files=0;Set<String> names=new HashSet<>();
        Path contents=stage.resolve("contents");Files.createDirectory(contents);
        try(var zip=new ZipFile(original.toFile())){
            long count=zip.stream().filter(entry->!entry.isDirectory()).count();
            var all=zip.entries();
            while(all.hasMoreElements()){
                check(stopped);ZipEntry entry=all.nextElement();
                String name=entry.getName();if(entry.isDirectory()&&name.endsWith("/"))name=name.substring(0,name.length()-1);
                if(name.isEmpty()||name.length()>1024||name.startsWith("/")||name.contains("\\")||name.contains(":"))throw new IOException("ZIP contains an unsafe path.");
                String[] parts=name.split("/",-1);if(parts.length>64||Arrays.stream(parts).anyMatch(part->part.isEmpty()||part.equals(".")||part.equals("..")))throw new IOException("ZIP contains an unsafe path.");
                String key=Normalizer.normalize(name,Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
                if(!names.add(key))throw new IOException("ZIP contains duplicate or colliding paths.");
                Path destination=contents.resolve(name).normalize();if(!destination.startsWith(contents))throw new IOException("ZIP path escapes staging.");
                if(entry.isDirectory()){Files.createDirectories(destination);continue;}
                files++;
                progress.accept("Unpacking ZIP file "+files+"/"+count+": "+name.replaceAll("[\\p{Cntrl}]","?"));
                if(entry.getSize()>TOTAL-total)throw new IOException("ZIP expanded data exceeds archive limits.");
                Files.createDirectories(destination.getParent());CRC32 crc=new CRC32();long length;
                try(var in=zip.getInputStream(entry);var out=Files.newOutputStream(destination,StandardOpenOption.CREATE_NEW)){
                    length=copy(in,out,Math.min(PackageLimits.PAYLOAD,TOTAL-total),stopped,crc);
                }
                if(entry.getSize()!=length||entry.getCrc()!=crc.getValue())throw new IOException("ZIP entry size or CRC does not match. No archive was created.");
                total+=length;
            }
        }
        if(files==0)throw new IOException("ZIP contains no files to convert.");
        if(receipt!=null)try{ImportProvenance.writeZip(original,selected.getFileName().toString(),files,receipt);}catch(Exception error){throw new IOException("Could not record the ZIP import receipt.",error);}
        Files.delete(original);
        InputFiles.collect(stage);return stage;
    }
    private static long copy(InputStream in,OutputStream out,long limit,BooleanSupplier stopped,CRC32 crc)throws IOException{
        byte[] buffer=new byte[64*1024];long total=0;int count;
        while((count=in.read(buffer))!=-1){check(stopped);if(count>limit-total)throw new IOException("Input or expanded ZIP exceeds archive limits.");out.write(buffer,0,count);if(crc!=null)crc.update(buffer,0,count);total+=count;}
        return total;
    }
    private static void check(BooleanSupplier stopped)throws IOException{if(stopped.getAsBoolean()||Thread.currentThread().isInterrupted())throw new IOException("Input preparation stopped.");}
    static void remove(Path directory)throws IOException{
        if(!Files.exists(directory))return;
        try(var files=Files.walk(directory)){for(Path path:files.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}
    }
}
