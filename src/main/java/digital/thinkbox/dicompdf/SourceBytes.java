package digital.thinkbox.dicompdf;

import java.io.*;
import java.util.Arrays;

/** Bounded source snapshots and streaming comparison without a second full-size buffer. */
final class SourceBytes {
    private SourceBytes(){}
    static byte[] readExact(InputStream input,long length,long limit)throws IOException{
        if(length<0||length>limit||length>Integer.MAX_VALUE)throw new IOException("Source byte length exceeds the configured limit");
        byte[] result=new byte[(int)length];
        if(!readFully(input,result,result.length)||input.read()!=-1)
            throw new IOException("Byte length differs from the recorded or observed size");
        return result;
    }
    static boolean matches(InputStream input,byte[] expected)throws IOException{
        byte[] block=new byte[Math.min(64*1024,Math.max(1,expected.length))];int offset=0;
        while(offset<expected.length){
            int count=Math.min(block.length,expected.length-offset);
            if(!readFully(input,block,count)||Arrays.mismatch(expected,offset,offset+count,block,0,count)>=0)return false;
            offset+=count;
        }
        return input.read()==-1;
    }
    private static boolean readFully(InputStream input,byte[] bytes,int length)throws IOException{
        int offset=0;
        while(offset<length){
            int count=input.read(bytes,offset,length-offset);
            if(count<0)return false;
            if(count==0){
                int value=input.read();
                if(value<0)return false;
                bytes[offset++]=(byte)value;
            }else offset+=count;
        }
        return true;
    }
}
