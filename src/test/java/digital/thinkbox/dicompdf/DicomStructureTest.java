package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DicomStructureTest {
    @TempDir Path temporary;
    private static Attributes source()throws Exception{
        Attributes data;try(var input=new DicomInputStream(Path.of("fixtures/expanded/sc-native-gray8.dcm").toFile())){data=input.readDataset();}
        data.setString(Tag.ConversionType,VR.CS,"SYN");return data;
    }
    private static byte[] bytes(Attributes data)throws Exception{return bytes(data,UID.ExplicitVRLittleEndian);}
    private static byte[] bytes(Attributes data,String syntax)throws Exception{
        var bytes=new ByteArrayOutputStream();try(var output=new DicomOutputStream(bytes,UID.ExplicitVRLittleEndian)){output.writeDataset(data.createFileMetaInformation(syntax),data);}return bytes.toByteArray();
    }
    private static DicomStructure.Image inspect(byte[] bytes)throws Exception{return DicomStructure.inspect("original.dcm","synthetic.dcm",bytes);}
    private static boolean issue(DicomStructure.Image record,String code){return record.issues().stream().anyMatch(issue->issue.code().equals(code));}
    @Test void nativePayloadMatchesDimensionsForLittleBigAndDeflatedEncodings()throws Exception{
        var data=source();for(String syntax:List.of(UID.ImplicitVRLittleEndian,UID.ExplicitVRLittleEndian,UID.ExplicitVRBigEndian,UID.DeflatedExplicitVRLittleEndian)){
            byte[] encoded=bytes(data,syntax),snapshot=encoded.clone();var checked=inspect(encoded);
            assertEquals("PASS",checked.checks().get("pixelStructure").status(),checked.toString());assertEquals(checked.expectedPixelBytes(),checked.suppliedPixelBytes());assertArrayEquals(snapshot,encoded);
        }
        data.setBytes(Tag.PixelData,VR.OB,new byte[2]);assertTrue(issue(inspect(bytes(data)),"NATIVE_PIXEL_LENGTH_MISMATCH"));
    }
    @Test void packedFramesHaveOneFinalPaddingNotPerFramePadding()throws Exception{
        var data=source();data.setInt(Tag.Rows,VR.US,1);data.setInt(Tag.Columns,VR.US,3);data.setInt(Tag.BitsAllocated,VR.US,1);data.setInt(Tag.BitsStored,VR.US,1);data.setInt(Tag.HighBit,VR.US,0);data.setString(Tag.NumberOfFrames,VR.IS,"3");
        data.setBytes(Tag.PixelData,VR.OB,new byte[2]);var checked=inspect(bytes(data));
        assertEquals(2L,checked.expectedPixelBytes());assertEquals("PASS",checked.checks().get("pixelStructure").status());
        data.setBytes(Tag.PixelData,VR.OB,new byte[6]);assertTrue(issue(inspect(bytes(data)),"NATIVE_PIXEL_LENGTH_MISMATCH"));
    }
    @Test void subsampledYbrUsesTwoStoredSamplesAndOddNativeValuesUseFinalEvenPadding()throws Exception{
        var data=source();data.setInt(Tag.Rows,VR.US,2);data.setInt(Tag.Columns,VR.US,4);data.setInt(Tag.SamplesPerPixel,VR.US,3);data.setString(Tag.PhotometricInterpretation,VR.CS,"YBR_FULL_422");data.setInt(Tag.PlanarConfiguration,VR.US,0);data.setBytes(Tag.PixelData,VR.OB,new byte[16]);
        var checked=inspect(bytes(data));assertEquals(16L,checked.expectedPixelBytes());assertEquals("PASS",checked.checks().get("pixelStructure").status());
        data.setBytes(Tag.PixelData,VR.OB,new byte[24]);assertTrue(issue(inspect(bytes(data)),"NATIVE_PIXEL_LENGTH_MISMATCH"));
        data=source();data.setInt(Tag.Rows,VR.US,1);data.setInt(Tag.Columns,VR.US,3);data.setBytes(Tag.PixelData,VR.OB,new byte[3]);checked=inspect(bytes(data));assertEquals(4L,checked.expectedPixelBytes());assertEquals("PASS",checked.checks().get("pixelStructure").status());
    }
    @Test void floatHeadersAndTruncatedDataAreNotSilentlyAccepted()throws Exception{
        var data=source();data.setString(Tag.SOPClassUID,VR.UI,UID.ParametricMapStorage);data.setInt(Tag.Rows,VR.US,2);data.setInt(Tag.Columns,VR.US,3);data.remove(Tag.PixelData);data.remove(Tag.BitsStored);data.remove(Tag.HighBit);data.remove(Tag.PixelRepresentation);data.setInt(Tag.BitsAllocated,VR.US,32);data.setBytes(Tag.FloatPixelData,VR.OF,new byte[24]);
        var checked=inspect(bytes(data));assertEquals(24L,checked.expectedPixelBytes());assertEquals("PASS",checked.checks().get("pixelStructure").status());assertEquals("UNKNOWN",checked.status());
        data.setInt(Tag.BitsAllocated,VR.US,64);assertTrue(issue(inspect(bytes(data)),"FLOAT_PIXEL_ENCODING"));
        byte[] encoded=bytes(source());assertEquals("FAIL",inspect(Arrays.copyOf(encoded,encoded.length-2)).status());
        assertEquals("UNKNOWN",inspect(new byte[]{1,2,3}).status());
        data=source();data.remove(Tag.PixelData);data.setString(Tag.PixelDataProviderURL,VR.UR,"https://invalid.example/never-fetch");
        assertEquals("UNKNOWN",inspect(bytes(data)).checks().get("pixelStructure").status());
        assertTrue(DicomInput.inspect(bytes(data)).reason().contains("no network retrieval"));
    }
    @Test void selectedLibraryRulesDistinguishMissingEmptyAndEnumeratedValues()throws Exception{
        var data=source();data.remove(Tag.ConversionType);assertTrue(issue(inspect(bytes(data)),"MISSING_MODULE_ATTRIBUTE"));
        data.setString(Tag.ConversionType,VR.CS,"VENDOR");assertEquals("PASS",inspect(bytes(data)).checks().get("selectedModuleRules").status(),"Defined Terms are extensible, not a closed enum");
        data.setString(Tag.PatientSex,VR.CS,"UNKNOWN");assertTrue(issue(inspect(bytes(data)),"INVALID_MODULE_VALUE"));
        data.setNull(Tag.PatientSex,VR.CS);assertEquals("PASS",inspect(bytes(data)).checks().get("selectedModuleRules").status());
    }
    @Test void classicCtMrRulesAreScopedAndUseDcm4cheVrVmValidation()throws Exception{
        var data=source();data.setString(Tag.SOPClassUID,VR.UI,UID.CTImageStorage);data.setString(Tag.ImageType,VR.CS,"DERIVED","SECONDARY");data.setString(Tag.PixelSpacing,VR.DS,"1","1");data.setString(Tag.ImagePositionPatient,VR.DS,"0","0","0");data.setString(Tag.ImageOrientationPatient,VR.DS,"1","0","0","0","1","0");data.setNull(Tag.SliceThickness,VR.DS);data.setString(Tag.RescaleSlope,VR.DS,"1");data.setString(Tag.RescaleIntercept,VR.DS,"0");
        assertEquals("PASS",inspect(bytes(data)).checks().get("selectedModuleRules").status());
        data.setString(Tag.PixelSpacing,VR.DS,"1");assertTrue(issue(inspect(bytes(data)),"INVALID_MODULE_VALUE"));
        data.setString(Tag.PixelSpacing,VR.DS,"1","1");data.setString(Tag.SOPClassUID,VR.UI,UID.MRImageStorage);data.setString(Tag.ScanningSequence,VR.CS,"SE");data.setString(Tag.SequenceVariant,VR.CS,"NONE");data.setNull(Tag.ScanOptions,VR.CS);data.setNull(Tag.MRAcquisitionType,VR.CS);
        assertEquals("PASS",inspect(bytes(data)).checks().get("selectedModuleRules").status());
        data.setString(Tag.MRAcquisitionType,VR.CS,"4D");assertTrue(issue(inspect(bytes(data)),"INVALID_MODULE_VALUE"));
    }
    @Test void encapsulatedHeadersAreCheckedWithoutClaimingCodestreamValidity()throws Exception{
        var checked=inspect(Files.readAllBytes(Path.of("fixtures/expanded/sc-jpeg-baseline-gray8.dcm")));
        assertEquals("PASS",checked.checks().get("pixelStructure").status(),checked.toString());assertNull(checked.expectedPixelBytes());
        assertTrue(checked.checks().get("pixelStructure").scope().contains("codestream not assessed"));
    }
    @Test void sourceValidityIsSeparateFromPreservationAndSecondaryCaptureModalityIsOptional()throws Exception{
        var data=source();for(int tag:new int[]{Tag.PatientName,Tag.PatientID,Tag.PatientBirthDate,Tag.PatientSex,Tag.StudyDate,Tag.StudyTime,Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber,Tag.SeriesNumber})if(!data.contains(tag))data.setNull(tag,ElementDictionary.vrOf(tag,null));
        data.remove(Tag.Modality);Path input=temporary.resolve("inputs");Files.createDirectories(input);byte[] original=bytes(data);Files.write(input.resolve("image.dcm"),original);
        Path pdf=temporary.resolve("archive.pdf");var manifest=DicomPdf.create(input,pdf);var originals=Map.of(manifest.images().getFirst().attachment(),original);
        assertEquals("PASS",DicomValidation.capture(manifest.images(),originals).images().getFirst().status());assertEquals(2,DicomValidation.capture(manifest.images(),originals).schemaVersion());
        assertEquals("FAIL",DicomValidation.captureLegacy(manifest.images(),originals).images().getFirst().status());assertEquals(1,DicomValidation.captureLegacy(manifest.images(),originals).schemaVersion());
        var verified=PackageTools.verify(pdf,input,null);assertEquals("PASS",verified.sourceBytes().status());assertEquals("PASS",verified.metadataAccuracy().status());assertEquals("PASS",verified.dicomStructure().status(),verified.dicomStructure().details().toString());
        data.setBytes(Tag.PixelData,VR.OB,new byte[2]);Files.write(input.resolve("image.dcm"),bytes(data));Path invalid=temporary.resolve("invalid.pdf");DicomPdf.create(input,invalid);
        var retained=PackageTools.verify(invalid,input,null);assertEquals("PASS",retained.sourceBytes().status());assertEquals("PASS",retained.metadataAccuracy().status());assertEquals("FAIL",retained.dicomStructure().status());
    }
}
