package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class DesktopReplacementTest {
    @TempDir Path root;
    @Test void completedReplacementKeepsTheOldFileUntilAtomicPublication()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),target=Files.writeString(root.resolve("archive.pdf"),"original");
        assertNull(DesktopReplacement.inspect(source,root.resolve("new.pdf")));
        Path stage;
        try(var replacement=DesktopReplacement.inspect(source,target)){
            stage=replacement.stage(()->false);Files.writeString(stage,"completed replacement");
            assertEquals("original",Files.readString(target));replacement.commit(()->false);
            assertTrue(replacement.committed());assertEquals("completed replacement",Files.readString(target));
        }
        assertFalse(Files.exists(stage));
    }
    @Test void failureAndCancellationRemoveOnlyTheStagedReplacement()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),target=Files.writeString(root.resolve("archive.pdf"),"original");Path stage;
        try(var replacement=DesktopReplacement.inspect(source,target)){
            stage=replacement.stage(()->false);Files.writeString(stage,"unfinished replacement");
            assertThrows(IOException.class,()->replacement.commit(()->true));assertFalse(replacement.committed());
        }
        assertEquals("original",Files.readString(target));assertFalse(Files.exists(stage));
        try(var replacement=DesktopReplacement.inspect(source,target)){
            replacement.stage(()->false);assertThrows(IOException.class,()->replacement.commit(()->false));
        }
        assertEquals("original",Files.readString(target));
    }
    @Test void changedTargetIsPreservedEvenWithTheOriginalSizeAndTimestamp()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),target=Files.writeString(root.resolve("archive.pdf"),"original");
        var modified=Files.getLastModifiedTime(target);
        try(var replacement=DesktopReplacement.inspect(source,target)){
            Path stage=replacement.stage(()->false);Files.writeString(stage,"new complete PDF");
            Files.writeString(target,"modified");Files.setLastModifiedTime(target,modified);
            assertThrows(IOException.class,()->replacement.commit(()->false));assertEquals("modified",Files.readString(target));
        }
    }
    @Test void sourceFilesSourceFoldersAndSymlinkTargetsCannotBeOverwritten()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),master=Files.writeString(source.resolve("master.pdf"),"master");
        assertThrows(IOException.class,()->DesktopReplacement.inspect(source,master));
        assertThrows(IOException.class,()->DesktopReplacement.inspect(master,master));
        Path alias=Files.createSymbolicLink(root.resolve("alias.pdf"),master);
        assertThrows(IOException.class,()->DesktopReplacement.inspect(source,alias));assertEquals("master",Files.readString(master));
    }
}
