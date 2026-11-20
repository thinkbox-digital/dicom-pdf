package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class DesktopInputsTest {
    @TempDir Path root;
    @Test void singleFileAndDirectoryKeepSourceBytesAndPaths()throws Exception{
        Path file=Files.write(root.resolve("image.dcm"),new byte[]{1,2,3});byte[] before=Files.readAllBytes(file);
        Path staged=DesktopInputs.prepare(file,root.resolve("staged"),()->false);
        assertArrayEquals(before,Files.readAllBytes(staged.resolve("image.dcm")));assertArrayEquals(before,Files.readAllBytes(file));
        assertEquals(staged.toRealPath(),DesktopInputs.prepare(staged,root.resolve("unused"),()->false));
        assertFalse(Files.exists(root.resolve("unused")));DesktopInputs.remove(staged);assertTrue(Files.exists(file));
    }
    @Test void zipPreservesMembersAndReceiptWithoutEmbeddingTheTransportContainer()throws Exception{
        Path zip=zip("study.zip",List.of("DICOMDIR","SERIES/image","SERIES/report.txt"));byte[] original=Files.readAllBytes(zip);
        Path receipt=root.resolve("import-source.json");
        Path one=DesktopInputs.prepare(zip,root.resolve("one"),()->false,receipt),two=DesktopInputs.prepare(zip,root.resolve("two"),()->false);
        assertFalse(Files.exists(one.resolve("study.zip")));assertArrayEquals(original,Files.readAllBytes(zip));
        for(Path file:InputFiles.collect(one))assertArrayEquals(Files.readAllBytes(file),Files.readAllBytes(two.resolve(one.relativize(file))));
        assertEquals(3,InputFiles.collect(one).size());
        var observed=com.google.gson.JsonParser.parseString(new String(ImportProvenance.read(receipt),java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
        assertFalse(observed.get("containerEmbedded").getAsBoolean());assertEquals(3,observed.get("memberCount").getAsInt());
        assertEquals(HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(original)),observed.get("sourceSha256").getAsString());
        DesktopInputs.remove(one);assertFalse(Files.exists(one));assertTrue(Files.exists(zip));
    }
    @Test void traversalAbsoluteAndPortableCollisionsAreRefused()throws Exception{
        int count=0;
        for(List<String> names:List.of(List.of("../escape"),List.of("/absolute"),List.of("C:/drive"),List.of("a\\escape"),List.of("a//bad"),List.of("A.dcm","a.dcm"))){
            int id=count++;Path zip=zip("bad-"+id+".zip",names);
            assertThrows(IOException.class,()->DesktopInputs.prepare(zip,root.resolve("bad-stage-"+id),()->false));
        }
        assertFalse(Files.exists(root.resolve("escape")));
    }
    @Test void corruptionAndCancellationFailWhileLargeFileCountsAreAccepted()throws Exception{
        Path invalid=Files.writeString(root.resolve("invalid.zip"),"not a ZIP");
        assertThrows(IOException.class,()->DesktopInputs.prepare(invalid,root.resolve("invalid-stage"),()->false));
        Path zip=zip("valid.zip",List.of("image.dcm"));
        assertThrows(IOException.class,()->DesktopInputs.prepare(zip,root.resolve("cancelled"),()->true));
        Path excessive=zip("too-many.zip",java.util.stream.IntStream.range(0,10001).mapToObj(i->"file-"+i).toList());
        assertEquals(10001,InputFiles.collect(DesktopInputs.prepare(excessive,root.resolve("excessive"),()->false)).size());
        assertEquals("not a ZIP",Files.readString(invalid));
    }
    @Test void largeMembersAreStreamedAndCrcTamperingIsDetected()throws Exception{
        Path bomb=root.resolve("expanded.zip");
        try(var zip=new ZipOutputStream(Files.newOutputStream(bomb))){
            zip.putNextEntry(new ZipEntry("large.dcm"));byte[] block=new byte[1024*1024];
            for(int i=0;i<129;i++)zip.write(block);zip.closeEntry();
        }
        var expanded=DesktopInputs.prepare(bomb,root.resolve("bomb-stage"),()->false);assertEquals(129L*1024*1024,Files.size(expanded.resolve("contents/large.dcm")));
        Path corrupt=zip("crc.zip",List.of("image.dcm"));byte[] data=Files.readAllBytes(corrupt);
        for(int i=0;i<data.length-20;i++)if(data[i]==0x50&&data[i+1]==0x4b&&data[i+2]==1&&data[i+3]==2){data[i+16]^=1;break;}
        Files.write(corrupt,data);
        assertThrows(IOException.class,()->DesktopInputs.prepare(corrupt,root.resolve("crc-stage"),()->false));
    }
    @Test void desktopRequestNormalizesSingleInputsAndAppliesFixedValidatorWithoutChangingConfig()throws Exception{
        Path source=Files.writeString(root.resolve("image.dcm"),"synthetic");Path config=Files.writeString(root.resolve("config.json"),"{\"protection\":\"CMS_AND_PDF\",\"pkcs12\":\"keys/institution.p12\",\"verapdf\":\"old\"}");
        Path work=Files.createDirectory(root.resolve("work"));
        var prepared=new DesktopRequest(true,source.toString(),root.resolve("archive.pdf").toString(),"",config.toString(),false).prepare(work,()->false);
        var args=prepared.arguments(work.resolve("report.json"));assertFalse(args.contains("--source-role"));assertTrue(Files.isDirectory(Path.of(prepared.input())));
        var rewritten=com.google.gson.JsonParser.parseString(Files.readString(Path.of(prepared.securityConfig()))).getAsJsonObject();
        assertEquals(DesktopRequest.VERAPDF,rewritten.get("verapdf").getAsString());assertEquals(root.resolve("keys/institution.p12").toString(),rewritten.get("pkcs12").getAsString());
        assertTrue(Files.readString(config).contains("\"old\""));
    }
    @Test void stagingDoesNotBypassCredentialAndPassphraseExclusion()throws Exception{
        Path password=Files.writeString(root.resolve("password.txt"),"synthetic-secret\n");
        Path supplied=Files.copy(password,root.resolve("supplied-file"));
        Path config=Files.writeString(root.resolve("secret-config.json"),"{\"protection\":\"CMS_AND_PDF\",\"passphraseFile\":\"password.txt\"}");
        Path work=Files.createDirectory(root.resolve("private-work"));
        var request=new DesktopRequest(true,supplied.toString(),root.resolve("new.pdf").toString(),"",config.toString(),false);
        assertThrows(IllegalArgumentException.class,()->request.prepare(work,()->false));
        assertEquals("synthetic-secret\n",Files.readString(password));assertFalse(Files.exists(root.resolve("new.pdf")));
    }
    private Path zip(String name,List<String> members)throws IOException{
        Path path=root.resolve(name);try(var zip=new ZipOutputStream(Files.newOutputStream(path))){
            for(String member:members){zip.putNextEntry(new ZipEntry(member));zip.write(("data-"+member).getBytes(java.nio.charset.StandardCharsets.UTF_8));zip.closeEntry();}
        }return path;
    }
}
