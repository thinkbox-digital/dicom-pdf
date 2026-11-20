package digital.thinkbox.pdfsecurity;

import java.io.IOException;
import java.nio.file.*;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class C2paStreamSearchTest {
    @TempDir Path directory;
    @Test void binaryMarkersCrossBlocksAndMustBeUnique()throws Exception{
        byte[] data=new byte[2*1024*1024+20];Arrays.fill(data,(byte)17);
        byte[] marker={(byte)255,0,2,(byte)255,0,3};int offset=1024*1024-3;
        System.arraycopy(marker,0,data,offset,marker.length);
        Path path=directory.resolve("binary.pdf");Files.write(path,data);
        assertEquals(offset,C2pa.find(path,marker));
        System.arraycopy(marker,0,data,data.length-marker.length,marker.length);Files.write(path,data);
        assertThrows(IOException.class,()->C2pa.find(path,marker));
        assertThrows(IOException.class,()->C2pa.find(path,new byte[]{99}));
    }
    @Test void repeatedPrefixesRetainKmpMatchingAndOverlapDetection()throws Exception{
        Path path=directory.resolve("prefixes.pdf");
        byte[] data=new byte[2*1024*1024+6];Arrays.fill(data,(byte)'a');data[data.length-1]='b';Files.write(path,data);
        assertEquals(data.length-6,C2pa.find(path,new byte[]{'a','a','a','a','a','b'}));
        assertThrows(IOException.class,()->C2pa.find(path,new byte[]{'a','a','a'}));
        assertThrows(IOException.class,()->C2pa.find(path,new byte[0]));
    }
}
