package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.file.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class DesktopActivityTest {
    @TempDir Path directory;
    @Test void splitProgressLinesAndLongLogsRetainTheFinalCounts(){
        var activity=new DesktopActivity(0);
        activity.accept("Progress: Reading file 12/",1);
        activity.accept("200: image.dcm\r\n",2);
        assertEquals("Reading file 12/200: image.dcm",activity.phase());
        activity.accept("long diagnostic "+"x".repeat(30_000)+"\n",3);
        String completion="Created archive.pdf: 200 supplied and embedded; 198 displayed; 2 rejected for display.";
        activity.accept(completion+"\n",4);
        activity.accept("REJECTED FOR DISPLAY: "+"y".repeat(30_000)+"\n",5);
        assertEquals(completion,activity.creationSummary());
    }
    @Test void quietStepsShowElapsedTimeWithoutClaimingCompletion(){
        var activity=new DesktopActivity(0);
        activity.accept("Progress: Checking PDF/A…\n",0);
        assertEquals("",activity.heartbeat(9_000_000_000L));
        assertTrue(activity.heartbeat(10_000_000_000L).contains("00:10 elapsed): Checking PDF/A…"));
        assertEquals("",activity.heartbeat(11_000_000_000L));
        activity.accept("Progress: Signing the PDF…\n",19_000_000_000L);
        assertEquals("",activity.heartbeat(20_000_000_000L));
        assertTrue(activity.heartbeat(29_000_000_000L).contains("Signing the PDF…"));
        assertEquals("01:05",activity.elapsed(65_000_000_000L));assertEquals("",activity.creationSummary());
    }
    @Test void cliStreamsFileProgressBeforePublishingTheArchive()throws Exception{
        Path input=Files.createDirectory(directory.resolve("input")),output=directory.resolve("output.pdf");
        Files.copy(Path.of("fixtures/synthetic/explicit-le-8-unsigned-mono2.dcm"),input.resolve("image.dcm"));
        var messages=new ByteArrayOutputStream();
        var progress=new PrintStream(messages){
            @Override public void println(String line){
                if(line.startsWith("Progress: Prepared file")||line.startsWith("Progress: Writing reference page"))assertFalse(Files.exists(output));
                super.println(line);
            }
        };
        var summary=new ByteArrayOutputStream();
        assertEquals(0,Main.run(new String[]{"create","--input",input.toString(),"--output",output.toString(),"--c2pa","off"},new PrintStream(summary),progress),messages.toString());
        String text=messages.toString();
        assertTrue(text.contains("Prepared file 1/1"),text);assertTrue(text.contains("Writing reference page and embedding original 1/1"),text);
        assertTrue(text.contains("Verifying every embedded original"),text);assertTrue(text.contains("Archive creation completed."),text);
        assertTrue(summary.toString().contains("1 supplied and embedded; 1 displayed; 0 rejected for display."));assertTrue(Files.exists(output));
    }
}
