package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Bounded, private stdin handoff. Passwords never enter argv, environment or files. */
final class DesktopPassword {
    private DesktopPassword(){}
    static void write(OutputStream output,char[] password)throws IOException{
        ByteBuffer encoded=null;
        try{
            encoded=StandardCharsets.UTF_8.newEncoder().encode(CharBuffer.wrap(password));
            if(encoded.remaining()>4096)throw new IOException("Certificate password exceeds the supported length.");
            var data=new DataOutputStream(output);data.writeInt(encoded.remaining());
            while(encoded.hasRemaining())data.writeByte(encoded.get());data.flush();
        }finally{Arrays.fill(password,'\0');if(encoded!=null&&encoded.hasArray())Arrays.fill(encoded.array(),(byte)0);}
    }
    static char[] read(InputStream input)throws IOException{
        var data=new DataInputStream(input);int length=data.readInt();
        if(length<0||length>4096)throw new IOException("Invalid certificate password handoff.");
        byte[] encoded=new byte[length];CharBuffer decoded=null;
        try{
            data.readFully(encoded);decoded=StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(encoded));
            char[] password=new char[decoded.remaining()];decoded.get(password);return password;
        }finally{Arrays.fill(encoded,(byte)0);if(decoded!=null&&decoded.hasArray())Arrays.fill(decoded.array(),'\0');}
    }
}
