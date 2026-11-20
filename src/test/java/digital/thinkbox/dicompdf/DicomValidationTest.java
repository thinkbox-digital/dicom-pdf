package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DicomValidationTest {
    @TempDir Path temporary;
    private static final Gson JSON=new GsonBuilder().serializeNulls().setPrettyPrinting().disableHtmlEscaping().create();
    private static Attributes valid() throws Exception {
        Attributes attrs;
        try(var in=new DicomInputStream(Path.of("fixtures/expanded/sc-native-gray8.dcm").toFile())) {attrs=in.readDataset();}
        // Empty but present Type 2 values are truthful synthetic values, not inferred metadata.
        for(int tag:new int[]{Tag.PatientName,Tag.PatientID,Tag.PatientBirthDate,Tag.PatientSex,Tag.StudyDate,Tag.StudyTime,Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber,Tag.SeriesNumber})
            if(!attrs.contains(tag))attrs.setNull(tag,ElementDictionary.vrOf(tag,null));
        return attrs;
    }
    private static byte[] encode(Attributes attrs) throws Exception {return encode(attrs,attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian));}
    private static byte[] encode(Attributes attrs,Attributes meta) throws Exception {
        var bytes=new ByteArrayOutputStream();try(var output=new DicomOutputStream(bytes,UID.ExplicitVRLittleEndian)){output.writeDataset(meta,attrs);}return bytes.toByteArray();
    }
    private static DicomValidation.Image inspect(byte[] bytes)throws Exception{return DicomValidation.inspect("original-0001.dcm","SYNTHETIC/IMAGE001",bytes);}
    private static boolean has(DicomValidation.Image image,String code){return image.issues().stream().anyMatch(issue->issue.code().equals(code));}
    @Test void validScopedImageAllowsEmptyTypeTwoAndPreservesSourceBytes() throws Exception {
        byte[] bytes=encode(valid()),before=bytes.clone();var checked=inspect(bytes);
        assertEquals("PASS",checked.status(),checked.issues().toString());assertArrayEquals(before,bytes);
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),checked.sha256());
        assertFalse(has(checked,"EMPTY_TYPE_1"));assertFalse(has(checked,"MISSING_TYPE_2"));
    }
    @Test void missingTypeTwoDiffersFromPresentEmptyAndTypeOneCannotBeEmpty() throws Exception {
        var attrs=valid();attrs.remove(Tag.PatientSex);var missing=inspect(encode(attrs));
        assertEquals("FAIL",missing.status());assertTrue(missing.issues().stream().anyMatch(issue->issue.code().equals("MISSING_TYPE_2")&&issue.path().endsWith("(0010,0040)")));
        attrs.setNull(Tag.PatientSex,VR.CS);attrs.setNull(Tag.StudyInstanceUID,VR.UI);var empty=inspect(encode(attrs));
        assertFalse(has(empty,"MISSING_TYPE_2"));assertTrue(has(empty,"EMPTY_TYPE_1"));
    }
    @Test void fileMetaIdentitiesMustAgreeWithDatasetAndMandatoryFieldsAreChecked()throws Exception {
        var attrs=valid();var meta=attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);meta.setString(Tag.MediaStorageSOPInstanceUID,VR.UI,"2.25.999999");
        assertTrue(has(inspect(encode(attrs,meta)),"FILE_META_IDENTITY_MISMATCH"));
        byte[] bytes=encode(attrs);int tag=find(bytes,new byte[]{2,0,0x10,0,'U','I'});assertTrue(tag>0);bytes[tag+2]=0x11;
        assertTrue(has(inspect(bytes),"MISSING_FILE_META_ATTRIBUTE"));
    }
    @Test void rawPrefixGroupLengthAndVersionBitsAreCheckedWithoutRewritingPreamble()throws Exception {
        byte[] bytes=encode(valid()),changed=bytes.clone();changed[128]='X';assertTrue(has(inspect(changed),"MISSING_DICM_PREFIX"));
        changed=bytes.clone();changed[140]++;assertTrue(has(inspect(changed),"FILE_META_GROUP_LENGTH"));
        int version=find(bytes,new byte[]{2,0,1,0,'O','B',0,0,2,0,0,0});assertTrue(version>0);
        changed=bytes.clone();changed[version+12]=0x7f;changed[version+13]=3;
        assertFalse(has(inspect(changed),"UNSUPPORTED_FILE_META_VERSION"),"All other version bits shall not be checked");
        changed[version+13]=2;assertTrue(has(inspect(changed),"UNSUPPORTED_FILE_META_VERSION"));
        changed=bytes.clone();changed[0]='M';changed[1]='Z';var checked=inspect(changed);assertEquals("PASS",checked.status());assertTrue(has(checked,"EXECUTABLE_LIKE_PREAMBLE"));assertEquals('M',changed[0]);
    }
    @Test void uidSyntaxIncludesLengthAndLeadingZeroComponentsAndDoesNotInventPrivateRegistration()throws Exception {
        for(String uid:List.of("2.25.123","1.2.840.10008.1.2.1","0.0","2.0"))assertTrue(DicomValidation.validUid(uid),uid);
        for(String uid:List.of("","1","3.1","1.40.1","1.02.3","2.25.","2..25","2.25.01","2.25."+"9".repeat(60)))assertFalse(DicomValidation.validUid(uid),uid);
        var attrs=valid();var item=new Attributes();item.setString(Tag.ReferencedSOPInstanceUID,VR.UI,"2.25.001");attrs.newSequence(Tag.ReferencedImageSequence,1).add(item);
        assertTrue(inspect(encode(attrs)).issues().stream().anyMatch(issue->issue.code().equals("INVALID_UID")&&issue.path().contains("[1]")));
    }
    @Test void suppliedVrVmAndPixelGeometryAreIndependentlyChecked()throws Exception {
        var attrs=valid();attrs.setString(Tag.Rows,VR.LO,"48");attrs.setString(Tag.PixelSpacing,VR.DS,"0.1");attrs.setString(Tag.ImageOrientationPatient,VR.DS,"1","0","0","1","0","0");
        var image=inspect(encode(attrs));assertTrue(has(image,"VR_MISMATCH"));assertTrue(has(image,"VM_MISMATCH"));assertTrue(has(image,"INVALID_ORIENTATION"));
        attrs=valid();attrs.setInt(Tag.BitsStored,VR.US,9);attrs.setInt(Tag.HighBit,VR.US,8);assertTrue(has(inspect(encode(attrs)),"INVALID_PIXEL_BIT_LAYOUT"));
        attrs=valid();attrs.setString(Tag.PixelSpacing,VR.DS,"0","0.1");assertTrue(has(inspect(encode(attrs)),"INVALID_SPACING"));
    }
    @Test void integerStringsRespectSignedThirtyTwoBitBounds()throws Exception {
        var attrs=valid();
        for (String value:List.of("-2147483648","2147483647","+0000000001")) {
            attrs.setString(Tag.SeriesNumber,VR.IS,value);assertFalse(has(inspect(encode(attrs)),"IS_VALUE_RANGE"),value);
        }
        for (String value:List.of("-2147483649","2147483648")) {
            attrs.setString(Tag.SeriesNumber,VR.IS,value);assertTrue(has(inspect(encode(attrs)),"IS_VALUE_RANGE"),value);
        }
    }
    @Test void functionalGroupsRequireCorrectCountsAndNeverSharedPerFrameOverlap()throws Exception {
        var attrs=valid();attrs.setInt(Tag.NumberOfFrames,VR.IS,2);attrs.setInt(Tag.InstanceNumber,VR.IS,1);attrs.setString(Tag.ContentDate,VR.DA,"20260101");attrs.setString(Tag.ContentTime,VR.TM,"120000");
        byte[] first=attrs.getBytes(Tag.PixelData),pixels=Arrays.copyOf(first,first.length*2);System.arraycopy(first,0,pixels,first.length,first.length);attrs.setBytes(Tag.PixelData,VR.OB,pixels);
        var shared=new Attributes();var transform=new Attributes();transform.setString(Tag.RescaleSlope,VR.DS,"1");transform.setString(Tag.RescaleIntercept,VR.DS,"0");transform.setString(Tag.RescaleType,VR.LO,"US");shared.newSequence(Tag.PixelValueTransformationSequence,1).add(transform);attrs.newSequence(Tag.SharedFunctionalGroupsSequence,1).add(shared);
        var per=attrs.newSequence(Tag.PerFrameFunctionalGroupsSequence,2);per.add(new Attributes());per.add(new Attributes());
        assertEquals("PASS",inspect(encode(attrs)).status());
        per.get(1).newSequence(Tag.PixelValueTransformationSequence,1).add(new Attributes(transform));assertTrue(has(inspect(encode(attrs)),"SHARED_PER_FRAME_GROUP_OVERLAP"));
        per.remove(1);assertTrue(has(inspect(encode(attrs)),"PER_FRAME_FUNCTIONAL_GROUP_COUNT"));
    }
    @Test void derivationGroupsMayContainMultipleItemsAndDirectoryDoesNotNeedSopCommon()throws Exception {
        var attrs=valid();attrs.setInt(Tag.NumberOfFrames,VR.IS,1);attrs.setInt(Tag.InstanceNumber,VR.IS,1);attrs.setString(Tag.ContentDate,VR.DA,"20260101");attrs.setString(Tag.ContentTime,VR.TM,"120000");
        var shared=new Attributes();var derived=shared.newSequence(Tag.DerivationImageSequence,2);derived.add(new Attributes());derived.add(new Attributes());attrs.newSequence(Tag.SharedFunctionalGroupsSequence,1).add(shared);
        assertFalse(has(inspect(encode(attrs)),"FUNCTIONAL_GROUP_ITEM_COUNT"),"Derivation Image Sequence permits zero or more Items");
        var directory=new Attributes();directory.setString(Tag.FileSetID,VR.CS,"SYNTHETIC");directory.newSequence(Tag.DirectoryRecordSequence,0);
        var meta=new Attributes();meta.setString(Tag.MediaStorageSOPClassUID,VR.UI,UID.MediaStorageDirectoryStorage);meta.setString(Tag.MediaStorageSOPInstanceUID,VR.UI,"2.25.999");meta.setString(Tag.TransferSyntaxUID,VR.UI,UID.ExplicitVRLittleEndian);meta.setString(Tag.ImplementationClassUID,VR.UI,"2.25.123");meta.setBytes(Tag.FileMetaInformationVersion,VR.OB,new byte[]{0,1});
        var checked=inspect(encode(directory,meta));assertFalse(has(checked,"MISSING_TYPE_1"));assertFalse(has(checked,"FILE_META_IDENTITY_MISMATCH"));
    }
    @Test void versionedInventoryIsHashedAndReparsedSeparatelyFromPreservation()throws Exception {
        Path sources=temporary.resolve("sources");Files.createDirectory(sources);Files.write(sources.resolve("valid.dcm"),encode(valid()));Files.writeString(sources.resolve("README.txt"),"Synthetic non-DICOM supplied file");
        Path pdf=temporary.resolve("package.pdf");var manifest=DicomPdf.create(sources,pdf);
        assertTrue(manifest.artifactSha256().containsKey("dicom-validation.json"));assertTrue(manifest.artifactSha256().containsKey("dicom-directory.json"));
        var checked=PackageTools.verify(pdf,sources,null);assertEquals("PASS",checked.dicomInputConformance().status(),checked.dicomInputConformance().details().toString());assertEquals("PASS",checked.metadataAccuracy().status());
        try(var doc=Loader.loadPDF(pdf.toFile())) {
            var file=doc.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("dicom-validation.json");
            var inventory=JsonParser.parseString(new String(file.getEmbeddedFileUnicode().toByteArray(),StandardCharsets.UTF_8)).getAsJsonObject();
            assertFalse(inventory.get("fullIodValidation").getAsBoolean());assertEquals("2026d",inventory.get("standardEdition").getAsString());assertEquals(2,inventory.getAsJsonArray("images").size());
        }
    }
    private static int find(byte[] bytes,byte[] pattern) {outer:for(int i=0;i<=bytes.length-pattern.length;i++){for(int j=0;j<pattern.length;j++)if(bytes[i+j]!=pattern[j])continue outer;return i;}return -1;}
}
