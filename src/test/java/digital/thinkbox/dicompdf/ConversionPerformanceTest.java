package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.stream.FileImageInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class ConversionPerformanceTest {
    @TempDir Path directory;
    @Test void streamingSidecarDigestIsSharedOnlyAfterReachingEof() throws Exception {
        byte[] bytes = "Müller <attribute> &".repeat(1024).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var opens = new AtomicInteger();
        var source = new SourceContent(() -> { opens.incrementAndGet(); return new ByteArrayInputStream(bytes); });
        try (var partial = source.openDigesting()) { assertEquals(bytes[0],partial.read()); }
        try (var full = source.openDigesting()) { assertEquals(bytes.length,full.transferTo(OutputStream.nullOutputStream())); }
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),source.digest().sha256());
        assertEquals(bytes.length,source.digest().length());
        assertEquals(2,opens.get());
    }
    @Test void snapshotsDecodeOnceAndSupportIndependentSeeking()throws Exception{
        byte[] bytes=new byte[300_000];new Random(27).nextBytes(bytes);var opens=new AtomicInteger();
        var source=new SourceContent(()->{opens.incrementAndGet();return new ByteArrayInputStream(bytes);});
        Path path=directory.resolve("snapshot.dcm");var snapshot=source.snapshot(path,bytes.length);
        assertEquals(1,opens.get());assertEquals(bytes.length,snapshot.digest().length());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),snapshot.digest().sha256());
        assertArrayEquals(bytes,snapshot.array());
        try(var input=snapshot.imageInput()){
            assertInstanceOf(FileImageInputStream.class,input);
            input.seek(275_000);assertEquals(bytes[275_000]&255,input.read());
            input.seek(17);assertEquals(bytes[17]&255,input.read());
        }
        assertEquals(1,opens.get(),"Repeated reads must use the decoded snapshot");
        Path shortFile=directory.resolve("short");assertThrows(IOException.class,()->source.snapshot(shortFile,bytes.length-1));assertFalse(Files.exists(shortFile));
        assertThrows(FileAlreadyExistsException.class,()->source.snapshot(path,Long.MAX_VALUE));assertArrayEquals(bytes,Files.readAllBytes(path));
    }
    @Test void bulkPixelHashMatchesTheCanonicalRgbBytesForDifferentRasterLayouts()throws Exception{
        for(int type:List.of(BufferedImage.TYPE_INT_RGB,BufferedImage.TYPE_3BYTE_BGR,BufferedImage.TYPE_BYTE_GRAY,BufferedImage.TYPE_4BYTE_ABGR)){
            var image=new BufferedImage(19,13,type);var random=new Random(8);
            for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++)image.setRGB(x,y,random.nextInt());
            for(var sample:List.of(image,image.getSubimage(3,2,11,7))){
                var rgb=DicomInput.rgb(sample);var digest=MessageDigest.getInstance("SHA-256");
                for(int y=0;y<rgb.getHeight();y++)for(int x=0;x<rgb.getWidth();x++){
                    int value=rgb.getRGB(x,y);digest.update((byte)(value>>16));digest.update((byte)(value>>8));digest.update((byte)value);
                }
                assertEquals(HexFormat.of().formatHex(digest.digest()),DicomInput.previewSha256(sample),"Raster type "+type);
            }
        }
    }
    @Test void serialAndParallelPreparationKeepIdenticalInventoryAndPreviewDigests()throws Exception{
        Path input=Files.createDirectory(directory.resolve("input"));
        for(int i=0;i<8;i++)Files.copy(Path.of("fixtures/synthetic/explicit-le-8-unsigned-mono2.dcm"),input.resolve(String.format("image-%02d.dcm",i)));
        String previous=System.getProperty("dicompdf.workers");
        try{
            System.setProperty("dicompdf.workers","1");
            var serial=DicomPdf.create(input,directory.resolve("serial.pdf"),"archival-master",false);
            System.setProperty("dicompdf.workers","4");
            var parallel=DicomPdf.create(input,directory.resolve("parallel.pdf"),"archival-master",false);
            assertEquals(serial,parallel,"Scheduling must not change source order, attachment names, metadata or pixels");
            assertTrue(DicomPdf.captureWorkers(8)<=4);assertEquals(1,DicomPdf.captureWorkers(1));
        }finally{if(previous==null)System.clearProperty("dicompdf.workers");else System.setProperty("dicompdf.workers",previous);}
    }
    @Test void applicationVersionAgreesWithTheMavenDistributionVersion()throws Exception{
        var factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();
        var document=factory.newDocumentBuilder().parse(Path.of("app/pom.xml").toFile());
        var nodes=document.getDocumentElement().getChildNodes();String version=null;
        for(int i=0;i<nodes.getLength();i++)if(nodes.item(i).getNodeName().equals("version"))version=nodes.item(i).getTextContent();
        assertEquals(version,ApplicationVersion.VERSION);assertEquals(ApplicationVersion.VERSION,ArchiveC2pa.FORMAT.generatorVersion());
    }
    @Test void incrementalTextWidthsPreserveExistingUnicodeLineBreaks()throws Exception{
        try(var document=new org.apache.pdfbox.pdmodel.PDDocument();var input=DicomPdf.class.getResourceAsStream("/fonts/DejaVuSans.ttf")){
            var font=org.apache.pdfbox.pdmodel.font.PDType0Font.load(document,input,true);
            for(String text:List.of("SHA-256: "+"0123456789abcdef".repeat(8),"Patient name: Héloïse Αλέξανδρος Алексей ".repeat(5))){
                for(float width:new float[]{30,90,495}){
                    var expected=new ArrayList<String>();var line=new StringBuilder();
                    for(int cp:text.codePoints().toArray()){
                        String next=new String(Character.toChars(cp));
                        if(!line.isEmpty()&&font.getStringWidth(line+next)/1000*9>width){expected.add(line.toString());line.setLength(0);}
                        line.append(next);
                    }
                    expected.add(line.toString());assertEquals(expected,DicomPdf.wrap(font,text,9,width));
                }
            }
        }
    }
}
