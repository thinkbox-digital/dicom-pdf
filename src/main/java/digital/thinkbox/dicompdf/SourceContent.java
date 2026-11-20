package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import javax.imageio.stream.*;

/** Reopenable original content. Pixels and archival bodies stay on disk or in PDF streams. */
final class SourceContent {
    @FunctionalInterface interface Opener {InputStream open()throws IOException;}
    record Digest(long length,String sha256){}
    private final Opener opener;
    private final Path file;
    private Digest digest;
    SourceContent(Opener opener){this(opener,null);}
    private SourceContent(Opener opener,Path file){this.opener=opener;this.file=file;}
    static SourceContent of(Object value){
        if(value==null)return null;if(value instanceof SourceContent source)return source;
        if(value instanceof byte[] bytes)return new SourceContent(()->new ByteArrayInputStream(bytes));
        throw new IllegalArgumentException("Unsupported source content");
    }
    static SourceContent file(Path path){return new SourceContent(()->new BufferedInputStream(Files.newInputStream(path,LinkOption.NOFOLLOW_LINKS),64*1024),path);}
    static SourceContent file(Path path,Digest known){
        var content=file(path);
        content.digest=known;
        return content;
    }
    static final class ScratchUnavailable extends IOException {
        ScratchUnavailable(String reason,Throwable cause){super(reason,cause);}
    }
    static Path scratchDirectory(String prefix,Path sources)throws ScratchUnavailable{
        try {
            String override=System.getenv("DICOMPDF_SCRATCH_DIR");
            Path root=(override==null||override.isBlank())?Path.of(System.getProperty("java.io.tmpdir")):Path.of(override);
            root=root.toFile().getCanonicalFile().toPath();
            if(sources!=null && root.startsWith(sources.toFile().getCanonicalFile().toPath()))
                throw new IOException("Select a scratch directory outside the source tree using DICOMPDF_SCRATCH_DIR");
            Files.createDirectories(root);
            return Files.createTempDirectory(root,prefix);
        } catch (IOException | InvalidPathException e) {
            throw new ScratchUnavailable("Cannot create local scratch directory: "+e.getMessage(),e);
        }
    }
    InputStream open()throws IOException{return opener.open();}
    /** A complete sequential read populates the digest of this immutable content. Partial reads leave it unknown. */
    InputStream openDigesting() throws Exception {
        if (digest != null) return open();
        var sha = MessageDigest.getInstance("SHA-256");
        var input = open();
        return new InputStream() {
            long length;
            final byte[] single = new byte[1];
            @Override public int read() throws IOException {
                return read(single,0,1) == -1 ? -1 : single[0] & 255;
            }
            @Override public int read(byte[] bytes,int offset,int size) throws IOException {
                int count = input.read(bytes,offset,size);
                if (count > 0) {
                    sha.update(bytes,offset,count);
                    length = Math.addExact(length,count);
                } else if (count == -1 && digest == null) digest = new Digest(length,HexFormat.of().formatHex(sha.digest()));
                return count;
            }
            @Override public void close() throws IOException { input.close(); }
        };
    }
    ImageInputStream imageInput()throws IOException{
        if(file==null)return new FileCacheImageInputStream(open(),null);
        if(Files.isSymbolicLink(file))throw new IOException("Image input is a symbolic link");
        return new FileImageInputStream(file.toFile());
    }
    /** Decode/copy once, computing the digest while writing an immutable, seekable snapshot. */
    SourceContent snapshot(Path path,long limit)throws Exception{
        var hash=MessageDigest.getInstance("SHA-256");long count=0;byte[] block=new byte[64*1024];
        boolean complete=false,created=false;
        try{
            try(var input=open()){
                var raw=Files.newOutputStream(path,StandardOpenOption.CREATE_NEW);created=true;
                try(var output=raw){
                    for(int n;(n=input.read(block))!=-1;){
                        if(n>limit-count)throw new ScratchUnavailable("Insufficient temporary space for the original snapshot",null);
                        try { output.write(block,0,n); }
                        catch(IOException e){throw new ScratchUnavailable("Cannot write local snapshot: "+e.getMessage(),e);}
                        hash.update(block,0,n);count+=n;
                    }
                }
            }
            var copy=file(path);copy.digest=new Digest(count,HexFormat.of().formatHex(hash.digest()));complete=true;return copy;
        }finally{if(created&&!complete)Files.deleteIfExists(path);}
    }
    Digest digest()throws Exception{
        if(digest==null){var hash=MessageDigest.getInstance("SHA-256");long count=0;byte[] block=new byte[64*1024];
            try(var input=open()){for(int n;(n=input.read(block))!=-1;){count=Math.addExact(count,n);hash.update(block,0,n);}}
            digest=new Digest(count,HexFormat.of().formatHex(hash.digest()));}
        return digest;
    }
    byte[] prefix(int length)throws IOException{try(var input=open()){return input.readNBytes(length);}}
    byte[] array()throws Exception{
        long length=digest().length();
        long available=Runtime.getRuntime().maxMemory()-(Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory());
        if(length>Math.min(Integer.MAX_VALUE-8L,available/3))throw new IOException("This operation needs more available Java heap; original content remains streamable");
        try(var input=open()){return SourceBytes.readExact(input,length,length);}
    }
    void writeTo(Path path)throws Exception{Files.createDirectories(path.getParent());try(var input=open();var output=Files.newOutputStream(path,StandardOpenOption.CREATE_NEW)){input.transferTo(output);}}
}
