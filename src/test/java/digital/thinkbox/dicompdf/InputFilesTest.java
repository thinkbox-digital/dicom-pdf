package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import java.io.IOException;
import java.nio.file.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class InputFilesTest {
    @TempDir Path root;
    @Test void filesKeepHistoricalLexicalOrderAndDuplicateBasenames()throws Exception{
        Files.createDirectories(root.resolve("z"));Files.createDirectories(root.resolve("a"));
        Files.write(root.resolve("z/image.dcm"),new byte[0]);Files.write(root.resolve("a/image.dcm"),new byte[0]);Files.write(root.resolve("b.txt"),new byte[0]);
        assertEquals(List.of(root.resolve("a/image.dcm"),root.resolve("b.txt"),root.resolve("z/image.dcm")),InputFiles.collect(root));
    }
    @Test void directoriesConsumeScanBudgetButNotFileBudget()throws Exception{
        Files.createDirectories(root.resolve("a/b/c"));
        assertThrows(IOException.class,()->InputFiles.collect(root,1,3));
        assertTrue(InputFiles.collect(root,1,4).isEmpty());
    }
    @Test void fileBudgetIsInclusiveAndTheDefaultAcceptsMoreThan500Files()throws Exception{
        for(int i=0;i<501;i++)Files.write(root.resolve("source-"+i),new byte[0]);
        assertEquals(501,InputFiles.collect(root).size());
        assertThrows(IOException.class,()->InputFiles.collect(root,500,1000));
        Files.delete(root.resolve("source-500"));assertEquals(500,InputFiles.collect(root,500,1000).size());
    }
    @Test void nestedSymbolicLinksAreNeverFollowed()throws Exception{
        Path target=root.resolve("actual.dcm");Files.write(target,new byte[]{42});
        try{Files.createSymbolicLink(root.resolve("link.dcm"),target);}catch(UnsupportedOperationException e){org.junit.jupiter.api.Assumptions.abort("Symbolic links unsupported");}
        assertThrows(IOException.class,()->InputFiles.collect(root));assertArrayEquals(new byte[]{42},Files.readAllBytes(target));
    }
}
