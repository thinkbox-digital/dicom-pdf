package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class RuntimePathsTest {
    @TempDir Path work;

    @Test void installedCliCreatesAndVerifiesWithNoWorkingDirectoryTarget()throws Exception{
        Files.writeString(work.resolve("target"),"occupied");
        Path input=Files.createDirectory(work.resolve("inputs"));
        Files.copy(Path.of("fixtures/spec-display/unsigned-padding-range.dcm"),input.resolve("image.dcm"));
        Path archive=work.resolve("study.pdf"),report=work.resolve("verify.json");
        runCli(0,null,"create","--input",input.toString(),"--output",archive.toString(),"--c2pa","off");
        Path scratch=work.resolve("scratch");
        runCli(2,scratch,"verify","--input",archive.toString(),"--sources",input.toString(),"--output",report.toString());
        var checks=JsonParser.parseString(Files.readString(report)).getAsJsonObject();
        assertEquals("NOT_CHECKED",checks.getAsJsonObject("pdfa4f").get("status").getAsString());
        assertEquals("PASS",checks.getAsJsonObject("externalSources").get("status").getAsString());
        assertEquals("PASS",checks.getAsJsonObject("metadataAccuracy").get("status").getAsString());
        Path incomplete=work.resolve("unchecked.json");
        runCli(2,work.resolve("target"),"verify","--input",archive.toString(),"--sources",input.toString(),"--output",incomplete.toString());
        var skipped=JsonParser.parseString(Files.readString(incomplete)).getAsJsonObject();
        for(String key:List.of("sourceBytes","externalSources","metadataAccuracy","unresolvedReferences"))
            assertEquals("NOT_CHECKED",skipped.getAsJsonObject(key).get("status").getAsString(),key);
        assertEquals("occupied",Files.readString(work.resolve("target")));
        try(var children=Files.list(scratch)){assertEquals(0,children.count());}
    }

    @Test void scratchDirectoryIsPrivateBeforeWritingSources()throws Exception{
        Path scratch=SourceContent.scratchDirectory("scratch-permissions-",null);
        try{
            if(Files.getFileStore(scratch).supportsFileAttributeView(PosixFileAttributeView.class)){
                assertEquals(PosixFilePermissions.fromString("rwx------"),Files.getPosixFilePermissions(scratch));
            }else{
                var acl=Files.getFileAttributeView(scratch,AclFileAttributeView.class);
                var owner=acl.getOwner();
                var allowed=acl.getAcl().stream().filter(entry->entry.type()==AclEntryType.ALLOW).toList();
                assertFalse(allowed.isEmpty());
                assertTrue(allowed.stream().allMatch(entry->entry.principal().equals(owner)));
            }
        }finally{
            Files.delete(scratch);
        }
    }

    private void runCli(int expected,Path scratch,String... arguments)throws Exception{
        var command=new ArrayList<>(DesktopProcess.javaCommand(List.of(arguments)));
        var builder=new ProcessBuilder(command).directory(work.toFile()).redirectErrorStream(true);
        builder.environment().put("VERAPDF",work.resolve("missing-validator").toString());
        if(scratch==null)builder.environment().remove("DICOMPDF_SCRATCH_DIR");
        else builder.environment().put("DICOMPDF_SCRATCH_DIR",scratch.toString());
        var child=builder.start();
        String log=new String(child.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(expected,child.waitFor(),log);
    }
}
