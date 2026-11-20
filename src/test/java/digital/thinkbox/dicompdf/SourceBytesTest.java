package digital.thinkbox.dicompdf;

import java.io.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SourceBytesTest {
    @Test void snapshotReadsExactObservedLengthIncludingEmptyAndFragmentedStreams()throws Exception{
        byte[] expected=new byte[200000];new Random(123).nextBytes(expected);
        var input=new ByteArrayInputStream(expected){
            @Override public synchronized int read(byte[] bytes,int off,int length){return super.read(bytes,off,Math.min(7,length));}
            @Override public byte[] readNBytes(int length){throw new AssertionError("Allocating whole-stream reader must not be used");}
        };
        assertArrayEquals(expected,SourceBytes.readExact(input,expected.length,expected.length));
        assertArrayEquals(new byte[0],SourceBytes.readExact(new ByteArrayInputStream(new byte[0]),0,100));
    }
    @Test void growthTruncationAndLimitsRefuseTheSnapshot()throws Exception{
        assertThrows(IOException.class,()->SourceBytes.readExact(new ByteArrayInputStream(new byte[2]),3,10));
        assertThrows(IOException.class,()->SourceBytes.readExact(new ByteArrayInputStream(new byte[4]),3,10));
        assertThrows(IOException.class,()->SourceBytes.readExact(new ByteArrayInputStream(new byte[1]),11,10));
        assertThrows(IOException.class,()->SourceBytes.readExact(new ByteArrayInputStream(new byte[1]),-1,10));
    }
    @Test void streamingEqualityDetectsMiddleChangesShorterAndLongerInputs()throws Exception{
        byte[] expected=new byte[200000];new Random(456).nextBytes(expected);
        assertTrue(SourceBytes.matches(new ByteArrayInputStream(expected),expected));
        byte[] changed=expected.clone();changed[90000]^=1;assertFalse(SourceBytes.matches(new ByteArrayInputStream(changed),expected));
        assertFalse(SourceBytes.matches(new ByteArrayInputStream(Arrays.copyOf(expected,expected.length-1)),expected));
        assertFalse(SourceBytes.matches(new ByteArrayInputStream(Arrays.copyOf(expected,expected.length+1)),expected));
        assertTrue(SourceBytes.matches(new ByteArrayInputStream(new byte[0]),new byte[0]));
        assertFalse(SourceBytes.matches(new ByteArrayInputStream(new byte[]{1}),new byte[0]));
    }
}
