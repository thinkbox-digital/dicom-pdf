package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** Enumerate a bounded tree before reading any source payloads. */
final class InputFiles {
    static final int MAX_FILES=Integer.MAX_VALUE, MAX_ENTRIES=Integer.MAX_VALUE;
    private InputFiles() {}
    static List<Path> collect(Path root)throws IOException{return collect(root,MAX_FILES,MAX_ENTRIES);}
    static List<Path> collect(Path root,int maxFiles,int maxEntries)throws IOException{
        if(maxFiles<1||maxEntries<1)
            throw new IllegalArgumentException("Invalid input scan limits");
        List<Path> files=new ArrayList<>();long visited=0;
        try(var walk=Files.walk(root)){
            var iterator=walk.iterator();
            while(iterator.hasNext()){
                Path path=iterator.next();
                if(++visited>maxEntries)throw new IOException("Input directory scan exceeds the entry limit (including directories)");
                if(Files.isSymbolicLink(path))throw new IOException("Symbolic links are outside the pilot: "+root.relativize(path));
                if(Files.isDirectory(path,LinkOption.NOFOLLOW_LINKS))continue;
                if(!Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS))throw new IOException("Input is not a regular file: "+path);
                if(files.size()>=maxFiles)throw new IOException("Input file count exceeds the configured limit ("+maxFiles+" files)");
                files.add(path);
            }
        }
        // Preserve historical attachment numbering without sorting the entire tree.
        files.sort(Comparator.naturalOrder());return List.copyOf(files);
    }
}
