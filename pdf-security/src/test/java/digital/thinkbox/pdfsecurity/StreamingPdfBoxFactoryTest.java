package digital.thinkbox.pdfsecurity;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class StreamingPdfBoxFactoryTest {
    @TempDir Path directory;
    private Path prepared()throws Exception{
        Path base=directory.resolve("base.pdf"),prepared=directory.resolve("prepared.pdf");
        try(var document=new PDDocument()){document.addPage(new PDPage());document.save(base.toFile());}
        try(var document=Loader.loadPDF(base.toFile());var output=Files.newOutputStream(prepared)){
            var signature=new PDSignature();signature.setFilter(PDSignature.FILTER_ADOBE_PPKLITE);signature.setSubFilter(org.apache.pdfbox.cos.COSName.getPDFName("ETSI.RFC3161"));
            document.addSignature(signature);
            document.saveIncrementalForExternalSigning(output).setSignature(new byte[0]);
        }
        return prepared;
    }
    @Test void insertsOnlyTheTokenAndPreservesEverySignedByte()throws Exception{
        Path file=prepared();byte[] before=Files.readAllBytes(file),cms={0x30,0x03,0x02,0x01,0x07};int[] range;
        try(var document=Loader.loadPDF(file.toFile())){range=document.getSignatureDictionaries().getLast().getByteRange();}
        var output=new ByteArrayOutputStream();StreamingPdfBoxFactory.writeSignature(file,cms,output);byte[] after=output.toByteArray();
        assertEquals(before.length,after.length);
        assertArrayEquals(Arrays.copyOfRange(before,0,range[1]),Arrays.copyOfRange(after,0,range[1]));
        assertArrayEquals(Arrays.copyOfRange(before,range[2],before.length),Arrays.copyOfRange(after,range[2],after.length));
        assertEquals(HexFormat.of().withUpperCase().formatHex(cms),new String(after,range[1]+1,cms.length*2,StandardCharsets.US_ASCII));
        assertArrayEquals(before,Files.readAllBytes(file),"The prepared PDF is immutable");
    }
    @Test void refusesNonemptySlotsAndTokensThatDoNotFit()throws Exception{
        Path file=prepared();int[] range;
        try(var document=Loader.loadPDF(file.toFile())){range=document.getSignatureDictionaries().getLast().getByteRange();}
        assertThrows(IOException.class,()->StreamingPdfBoxFactory.writeSignature(file,new byte[range[2]-range[1]],new ByteArrayOutputStream()));
        byte[] changed=Files.readAllBytes(file);changed[range[1]+5]='1';Files.write(file,changed);
        assertThrows(IOException.class,()->StreamingPdfBoxFactory.writeSignature(file,new byte[]{1,2,3},new ByteArrayOutputStream()));
    }
}
