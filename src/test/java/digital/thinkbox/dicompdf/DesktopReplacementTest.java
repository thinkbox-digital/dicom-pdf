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
        Path stage;
        try(var replacement=DesktopReplacement.inspect(source,target)){
            assertTrue(replacement.replacing());
            stage=replacement.stage(()->false);Files.writeString(stage,"completed replacement");
            assertEquals("original",Files.readString(target));replacement.commit(()->false);
            assertTrue(replacement.committed());assertEquals("completed replacement",Files.readString(target));
        }
        assertFalse(Files.exists(stage));
    }
    @Test void aPdfThatAppearsDuringCreationIsPreserved()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),target=root.resolve("new/archive.pdf");
        Path stage;
        try(var publication=DesktopReplacement.inspect(source,target)){
            assertFalse(publication.replacing());
            stage=publication.stage(()->false);
            Files.writeString(stage,"completed conversion");
            Files.writeString(stage.resolveSibling("worker-partial.pdf"),"temporary PDF");
            Files.writeString(target,"created by another application");
            assertThrows(IOException.class,()->publication.commit(()->false));
            assertFalse(publication.committed());
        }
        assertEquals("created by another application",Files.readString(target));
        assertFalse(Files.exists(stage.getParent()));
    }
    @Test void aNewArchivePublishesOnlyAfterCommit()throws Exception{
        Path source=Files.createDirectory(root.resolve("inputs")),target=root.resolve("archive.pdf");
        Path stage;
        try(var publication=DesktopReplacement.inspect(source,target)){
            stage=publication.stage(()->false);
            Files.writeString(stage,"completed conversion");
            assertFalse(Files.exists(target));
            publication.commit(()->false);
            assertTrue(publication.committed());
        }
        assertEquals("completed conversion",Files.readString(target));
        assertFalse(Files.exists(stage.getParent()));
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
