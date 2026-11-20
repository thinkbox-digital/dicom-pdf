package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.dcm4che3.data.*;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Independently bounded pixel phantoms for PS3.3 padding and display geometry. */
class SpecDisplayTest {
    @TempDir Path temporary;
    static Attributes phantom(boolean signed,int... pixels) {
        var a=new Attributes();
        a.setString(Tag.SOPClassUID,VR.UI,UID.SecondaryCaptureImageStorage); a.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150001");
        a.setString(Tag.StudyInstanceUID,VR.UI,"2.25.20261115"); a.setString(Tag.SeriesInstanceUID,VR.UI,"2.25.2026111501");
        a.setString(Tag.Modality,VR.CS,"OT"); a.setString(Tag.ConversionType,VR.CS,"WSD");
        for (int tag:new int[]{Tag.PatientName,Tag.PatientID,Tag.PatientBirthDate,Tag.PatientSex,Tag.StudyDate,Tag.StudyTime,
                Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber,Tag.Manufacturer})
            a.setNull(tag,ElementDictionary.vrOf(tag,null));
        a.setString(Tag.SeriesNumber,VR.IS,"1"); a.setString(Tag.InstanceNumber,VR.IS,"1");
        a.setInt(Tag.Rows,VR.US,2); a.setInt(Tag.Columns,VR.US,2); a.setInt(Tag.SamplesPerPixel,VR.US,1);
        a.setString(Tag.PhotometricInterpretation,VR.CS,"MONOCHROME2");
        a.setInt(Tag.BitsAllocated,VR.US,16); a.setInt(Tag.BitsStored,VR.US,16); a.setInt(Tag.HighBit,VR.US,15); a.setInt(Tag.PixelRepresentation,VR.US,signed?1:0);
        var encoded=ByteBuffer.allocate(pixels.length*2).order(ByteOrder.LITTLE_ENDIAN);
        for (int value:pixels) encoded.putShort((short)value);
        a.setBytes(Tag.PixelData,VR.OW,encoded.array()); return a;
    }
    static byte[] encode(Attributes a)throws Exception {
        return encode(a,UID.ExplicitVRLittleEndian);
    }
    private static byte[] encode(Attributes a,String syntax)throws Exception {
        var bytes=new ByteArrayOutputStream();
        try(var out=new DicomOutputStream(bytes,UID.ExplicitVRLittleEndian)){
            out.writeDataset(a.createFileMetaInformation(syntax),a);
        }
        return bytes.toByteArray();
    }
    @Test void deflatedPaddingReopensTheFrameAndPreservesHistoricalDiagnostics()throws Exception {
        var a=phantom(true,-100,-50,10,80);
        a.setInt(Tag.PixelPaddingValue,VR.SS,-100);
        var nativeImage=DicomInput.inspect(encode(a));
        byte[] deflated=encode(a,UID.DeflatedExplicitVRLittleEndian);
        var result=DicomInput.inspect(deflated);
        assertNotNull(result.image(),result.reason());
        assertEquals(nativeImage.displayAdjustments(),result.displayAdjustments());
        assertEquals(DicomInput.previewSha256(nativeImage.image()),DicomInput.previewSha256(result.image()));
        assertNull(DicomInput.inspectForPreview(deflated,1,Map.of(),true,true,false).image());
    }
    @Test void zeroPlaceholderUsesOnlyNonPaddingPixelsAndKeepsLegacyRejection()throws Exception {
        var a=phantom(false,0,0,100,200);
        a.setInt(Tag.PixelPaddingValue,VR.US,0);
        var baseline=DicomInput.inspect(encode(a));
        a.setString(Tag.WindowCenter,VR.DS,"-0.0");
        a.setString(Tag.WindowWidth,VR.DS,"+0E+3");
        byte[] encoded=encode(a);
        var result=DicomInput.inspect(encoded);
        assertNotNull(result.image(),result.reason());
        assertEquals(baseline.displayAdjustments(),result.displayAdjustments());
        assertEquals(DicomInput.previewSha256(baseline.image()),DicomInput.previewSha256(result.image()));
        assertNull(DicomInput.inspectForPreview(encoded,1,Map.of(),true,true,false).image());
        a.setString(Tag.WindowWidth,VR.DS,"0","5");
        assertNull(DicomInput.inspect(encode(a)).image(),"Multiple windows are not a zero placeholder");
        a.setString(Tag.WindowWidth,VR.DS,"0");
        a.setString(Tag.WindowCenter,VR.DS,"1e-60");
        assertNull(DicomInput.inspect(encode(a)).image(),"Underflow to zero is not a zero placeholder");
        a.setString(Tag.WindowCenter,VR.DS,"0");
        a.setString(Tag.VOILUTFunction,VR.CS,"LINEAR_EXACT");
        assertNull(DicomInput.inspect(encode(a)).image());
        a.remove(Tag.VOILUTFunction);
        var shared=a.newSequence(Tag.SharedFunctionalGroupsSequence,1);
        var group=new Attributes();shared.add(group);
        var window=new Attributes();group.newSequence(Tag.FrameVOILUTSequence,1).add(window);
        window.setString(Tag.WindowCenter,VR.DS,"0");
        window.setString(Tag.WindowWidth,VR.DS,"0");
        assertNull(DicomInput.inspect(encode(a)).image(),"Functional group windows are not placeholders");
    }
    @Test void excludesSignedStoredPaddingRangeBeforeNegativeRescale()throws Exception {
        var a=phantom(true,-2048,-1025,10,20);a.setInt(Tag.PixelPaddingValue,VR.SS,-2048);a.setInt(Tag.PixelPaddingRangeLimit,VR.SS,-1025);
        a.setString(Tag.RescaleSlope,VR.DS,"-2");a.setString(Tag.RescaleIntercept,VR.DS,"100");byte[] source=encode(a),snapshot=source.clone();
        var result=DicomInput.inspect(source);assertNotNull(result.image(),result.reason());
        assertEquals("auto-min-max-padding-v2",result.displayAdjustments().get("windowMethod"));
        assertEquals("21.0",result.displayAdjustments().get("windowWidth"));assertEquals("70.5",result.displayAdjustments().get("windowCenter"));
        assertEquals("-2048",result.displayAdjustments().get("pixelPaddingMin"));assertEquals("-1025",result.displayAdjustments().get("pixelPaddingMax"));
        assertArrayEquals(snapshot,source);
    }
    @Test void allPaddingNeedsAnExplicitWindowAndOlderBaselineRemainsReproducible()throws Exception {
        var a=phantom(false,0,0,0,0);a.setInt(Tag.PixelPaddingValue,VR.US,0);byte[] source=encode(a);
        assertNull(DicomInput.inspect(source).image());assertTrue(DicomInput.inspect(source).reason().contains("non-padding"));
        assertNotNull(DicomInput.inspectForPreview(source,1,Map.of("windowMethod","auto-min-max-v1")).image());
        a.setString(Tag.WindowCenter,VR.DS,"0.5");a.setString(Tag.WindowWidth,VR.DS,"1");
        var explicit=DicomInput.inspect(encode(a));assertNotNull(explicit.image(),explicit.reason());assertEquals("source-window-0",explicit.displayAdjustments().get("windowMethod"));
    }
    @Test void linearExactUsesSignedRescaledSamplesAndSourcePolarity()throws Exception {
        var a=phantom(true,-2,-1,0,1);
        a.setString(Tag.PhotometricInterpretation,VR.CS,"MONOCHROME1");
        a.setString(Tag.VOILUTFunction,VR.CS,"LINEAR_EXACT");
        a.setString(Tag.RescaleSlope,VR.DS,"-0.5");
        a.setString(Tag.WindowCenter,VR.DS,"0.25");
        a.setString(Tag.WindowWidth,VR.DS,"1");
        byte[] source=encode(a);
        var exact=DicomInput.inspect(source);
        assertNotNull(exact.image(),exact.reason());
        assertEquals("LINEAR_EXACT",exact.displayAdjustments().get("voiLUTFunction"));
        assertArrayEquals(new int[]{0,64,191,255},Arrays.stream(exact.image().getRGB(0,0,2,2,null,0,2)).map(rgb->rgb&255).toArray());
        var historical=DicomInput.inspectForPreview(source,1,Map.of(),false);
        assertNull(historical.image());
        assertEquals("Only LINEAR grayscale VOI is currently implemented",historical.reason());
        a.setString(Tag.WindowWidth,VR.DS,"0.5");
        assertNotNull(DicomInput.inspect(encode(a)).image());
        a.setString(Tag.WindowWidth,VR.DS,"0");
        assertNull(DicomInput.inspect(encode(a)).image());
    }
    @Test void pixelSpacingDefinesRowThenColumnAspectAndPdfPlacement()throws Exception {
        var a=phantom(false,10,20,30,40);a.setString(Tag.PixelSpacing,VR.DS,"2","1");byte[] source=encode(a);
        var rendered=DicomInput.inspect(source);assertNotNull(rendered.image(),rendered.reason());
        assertEquals("2.0:1",rendered.displayAdjustments().get("pixelAspectRatio"));assertEquals("PixelSpacing",rendered.displayAdjustments().get("geometrySource"));
        var input=temporary.resolve("source");Files.createDirectories(input);Files.write(input.resolve("aspect.dcm"),source);
        var pdf=temporary.resolve("aspect.pdf");var manifest=DicomPdf.create(input,pdf);
        try(var document=Loader.loadPDF(pdf.toFile())) {
            var tokens=new PDFStreamParser(document.getPage(manifest.images().getFirst().referencePage()-1)).parse();boolean checked=false;
            for(int i=6;i<tokens.size();i++)if(tokens.get(i) instanceof Operator op && op.getName().equals("cm")) {
                double width=((COSNumber)tokens.get(i-6)).floatValue(),height=((COSNumber)tokens.get(i-3)).floatValue();
                assertEquals(2,height/width,1e-5);checked=true;
            }
            assertTrue(checked,"Reference image placement matrix was not found");
        }
        assertEquals("PASS",PackageTools.verify(pdf,input,null).metadataAccuracy().status());
    }
    @Test void explicitAspectFallbackAndLegacySquareRecipeAreDistinct()throws Exception {
        var a=phantom(false,0,10,20,30);a.setString(Tag.PixelAspectRatio,VR.IS,"3","2");byte[] source=encode(a);
        assertEquals("1.5:1",DicomInput.inspect(source).displayAdjustments().get("pixelAspectRatio"));
        var old=DicomInput.inspectForPreview(source,1,Map.of("windowMethod","auto-min-max-v1","pixelAspectRatio","1:1"));
        assertEquals("1:1",old.displayAdjustments().get("pixelAspectRatio"));assertFalse(old.displayAdjustments().containsKey("geometryMethod"));
        a.setString(Tag.PixelSpacing,VR.DS,"-1","1");assertNull(DicomInput.inspect(encode(a)).image(),"Invalid supplied spacing must not silently fall back to another tag");
    }
    @Test void sharedPixelMeasuresApplyWithoutDuplicatingTheMacroPerFrame()throws Exception {
        var a=phantom(false,0,10,20,30);var shared=new Attributes();var measures=new Attributes();measures.setString(Tag.PixelSpacing,VR.DS,"4","1");
        shared.newSequence(Tag.PixelMeasuresSequence,1).add(measures);a.newSequence(Tag.SharedFunctionalGroupsSequence,1).add(shared);
        var result=DicomInput.inspect(encode(a));assertNotNull(result.image(),result.reason());
        assertEquals("4.0:1",result.displayAdjustments().get("pixelAspectRatio"));assertEquals("functional-groups.PixelSpacing",result.displayAdjustments().get("geometrySource"));
    }
}
