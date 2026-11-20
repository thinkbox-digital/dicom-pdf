package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.dcm4che3.media.DicomDirWriter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DicomDirectoryTest {
    @TempDir Path temporary;
    private record Package(List<Manifest.Image> images,Map<String,byte[]> originals) {}
    private static byte[] source()throws IOException{return Files.readAllBytes(Path.of("fixtures/expanded/sc-native-gray8.dcm"));}
    private static Attributes dataset(byte[] bytes)throws IOException {
        try(var input=new DicomInputStream(new ByteArrayInputStream(bytes))){return input.readDataset();}
    }
    private static Attributes imageRecord(String... fileID)throws Exception {
        Attributes source=dataset(source()),record=new Attributes();
        record.setString(Tag.DirectoryRecordType,VR.CS,"IMAGE");record.setString(Tag.ReferencedFileID,VR.CS,fileID);
        record.setString(Tag.ReferencedSOPClassUIDInFile,VR.UI,source.getString(Tag.SOPClassUID));
        record.setString(Tag.ReferencedSOPInstanceUIDInFile,VR.UI,source.getString(Tag.SOPInstanceUID));
        record.setString(Tag.ReferencedTransferSyntaxUIDInFile,VR.UI,UID.ExplicitVRLittleEndian);
        record.setInt(Tag.InstanceNumber,VR.IS,1);return record;
    }
    private byte[] directory(Attributes... images)throws Exception {
        Path path=temporary.resolve(UUID.randomUUID()+"-DICOMDIR");
        DicomDirWriter.createEmptyDirectory(path.toFile(),"2.25.123456789012345678901234567890","TESTSET",null,null);
        try(var writer=DicomDirWriter.open(path.toFile())) {
            Attributes patient=new Attributes();patient.setString(Tag.DirectoryRecordType,VR.CS,"PATIENT");patient.setString(Tag.PatientID,VR.LO,"SYNTHETIC");patient.setString(Tag.PatientName,VR.PN,"Synthetic^Directory");
            Attributes study=new Attributes();study.setString(Tag.DirectoryRecordType,VR.CS,"STUDY");study.setString(Tag.StudyInstanceUID,VR.UI,"2.25.123456789.1");study.setString(Tag.StudyDate,VR.DA,"20260101");study.setString(Tag.StudyTime,VR.TM,"120000");study.setString(Tag.StudyID,VR.SH,"TEST");
            Attributes series=new Attributes();series.setString(Tag.DirectoryRecordType,VR.CS,"SERIES");series.setString(Tag.SeriesInstanceUID,VR.UI,"2.25.123456789.2");series.setString(Tag.Modality,VR.CS,"OT");series.setInt(Tag.SeriesNumber,VR.IS,1);
            writer.addRootDirectoryRecord(patient);writer.addLowerDirectoryRecord(patient,study);writer.addLowerDirectoryRecord(study,series);
            for(Attributes image:images)writer.addLowerDirectoryRecord(series,image);
        }
        return Files.readAllBytes(path);
    }
    private static Package pack(Map<String,byte[]> sources)throws Exception {
        List<Manifest.Image> images=new ArrayList<>();Map<String,byte[]> originals=new LinkedHashMap<>();int index=1;
        for(var source:sources.entrySet()) {
            String attachment="original-"+(index++)+".dcm";byte[] bytes=source.getValue();var fields=DicomInput.fields(bytes);
            images.add(new Manifest.Image(attachment,source.getKey(),fields.get("SOPInstanceUID"),
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),bytes.length,index,"unrendered","test-only metadata inventory",fields,
                    true,true,true,null,Map.of(),null));originals.put(attachment,bytes);
        }
        return new Package(images,originals);
    }
    private static Map<String,byte[]> sources(byte[] directory,Map<String,byte[]> targets) {
        Map<String,byte[]> result=new LinkedHashMap<>();result.put("SET/DICOMDIR",directory);result.putAll(targets);return result;
    }
    private static DicomDirectory.Inventory capture(Package pack){return DicomDirectory.capture(pack.images(),pack.originals());}

    @Test void resolvesRelativeFileIDsUsingFileMetaWithoutDatasetSopCommon()throws Exception {
        byte[] directory=directory(imageRecord("IMAGES","IMG00001")),image=source(),before=directory.clone();
        assertFalse(dataset(directory).contains(Tag.SOPInstanceUID),"A Basic Directory does not require SOP Common in its dataset");
        var preview=DicomInput.inspect(directory);assertNull(preview.image());assertTrue(preview.reason().contains("DICOMDIR directory object"),preview.reason());
        Package pack=pack(sources(directory,Map.of("SET/IMAGES/IMG00001",image)));
        var inventory=capture(pack);assertEquals(1,inventory.schemaVersion());assertEquals(1,inventory.directories().size());
        assertEquals("checked",inventory.directories().getFirst().status(),inventory.directories().getFirst().reason());
        var reference=inventory.references().getFirst();assertEquals("resolved",reference.status(),reference.reason());
        assertEquals("IMAGES\\IMG00001",reference.fileID());assertEquals("SET/IMAGES/IMG00001",reference.targetSourcePath());
        assertEquals(List.of("original-2.dcm"),reference.resolvedAttachments());assertEquals("dataset/(0004,1220)[4]/(0004,1500)",reference.sequencePath());
        assertArrayEquals(before,directory);assertEquals(inventory,capture(pack),"Inventory must be deterministic");
        assertTrue(new String(DicomDirectory.bytes(inventory),java.nio.charset.StandardCharsets.UTF_8).contains("\"schemaVersion\":1"));
    }
    @Test void reportsMissingAndUnsafePathsWithoutSearchingOutsideTheSuppliedSet()throws Exception {
        byte[] directory=directory(imageRecord("IMAGES","MISSING"),imageRecord("..","IMG00001"),imageRecord("/IMAGES","IMG00001"));
        var inventory=capture(pack(sources(directory,Map.of("IMG00001",source()))));
        assertEquals(List.of("missing","unsafe-file-id","unsafe-file-id"),inventory.references().stream().map(DicomDirectory.Reference::status).toList());
        assertTrue(inventory.references().stream().allMatch(r->r.resolvedAttachments().isEmpty()));
        assertNull(inventory.references().get(1).targetSourcePath());
    }
    @Test void preservesKnownButNonconformingFileIDsWithoutCaseGuessing()throws Exception {
        byte[] directory=directory(imageRecord("images","img00001"),imageRecord("IMAGES","IMG00001"));
        var inventory=capture(pack(sources(directory,Map.of("SET/images/img00001",source()))));
        assertEquals("invalid-file-id",inventory.references().getFirst().status());
        assertEquals(List.of("original-2.dcm"),inventory.references().getFirst().resolvedAttachments());
        assertEquals("missing",inventory.references().get(1).status(),"Uppercase IDs must not be matched by changing case");
    }
    @Test void reportsClassInstanceAndTransferSyntaxMismatchesSeparately()throws Exception {
        Attributes badClass=imageRecord("IMAGES","CLASS"),badInstance=imageRecord("IMAGES","INSTANCE"),badSyntax=imageRecord("IMAGES","SYNTAX");
        badClass.setString(Tag.ReferencedSOPClassUIDInFile,VR.UI,UID.CTImageStorage);
        badInstance.setString(Tag.ReferencedSOPInstanceUIDInFile,VR.UI,"2.25.999999999");
        badSyntax.setString(Tag.ReferencedTransferSyntaxUIDInFile,VR.UI,UID.ImplicitVRLittleEndian);
        var inventory=capture(pack(sources(directory(badClass,badInstance,badSyntax),Map.of("SET/IMAGES/CLASS",source(),"SET/IMAGES/INSTANCE",source(),"SET/IMAGES/SYNTAX",source()))));
        assertEquals(List.of("class-mismatch","instance-mismatch","transfer-syntax-mismatch"),inventory.references().stream().map(DicomDirectory.Reference::status).toList());
        assertTrue(inventory.references().stream().allMatch(reference->reference.resolvedAttachments().size()==1));
    }
    @Test void duplicateInstanceIDsDoNotMergeDifferentFileIDsAndDuplicateReferencesAreReported()throws Exception {
        byte[] image=source(),directory=directory(imageRecord("IMAGES","ONE"),imageRecord("IMAGES","TWO"));
        var inventory=capture(pack(sources(directory,Map.of("SET/IMAGES/ONE",image,"SET/IMAGES/TWO",image))));
        assertEquals(List.of("resolved","resolved"),inventory.references().stream().map(DicomDirectory.Reference::status).toList());
        assertNotEquals(inventory.references().getFirst().resolvedAttachments(),inventory.references().get(1).resolvedAttachments());
        var duplicate=capture(pack(sources(directory(imageRecord("IMAGES","ONE"),imageRecord("IMAGES","ONE")),Map.of("SET/IMAGES/ONE",image))));
        assertTrue(duplicate.references().stream().allMatch(r->r.status().equals("duplicate-reference")));
        assertTrue(duplicate.directories().getFirst().reason().contains("more than one Directory Record"));
    }
    @Test void reportsAmbiguousSuppliedPathsAndUnreadableTargets()throws Exception {
        Package pack=pack(sources(directory(imageRecord("IMAGES","ONE")),Map.of("SET/IMAGES/ONE",source())));
        var images=new ArrayList<>(pack.images());var duplicate=images.get(1);images.add(new Manifest.Image("another.dcm",duplicate.sourcePath(),duplicate.sopInstanceUID(),duplicate.sha256(),duplicate.size(),9,
                duplicate.status(),duplicate.reason(),duplicate.fields(),true,true,true,null,Map.of(),null));
        var originals=new LinkedHashMap<>(pack.originals());originals.put("another.dcm",source());
        assertEquals("ambiguous",capture(new Package(images,originals)).references().getFirst().status());
        var unreadable=capture(pack(sources(directory(imageRecord("IMAGES","ONE")),Map.of("SET/IMAGES/ONE",new byte[]{1,2,3}))));
        assertEquals("unreadable-target",unreadable.references().getFirst().status());
    }
    @Test void detectsCyclesAndDanglingOffsetsUsingActualRecordItemPositions()throws Exception {
        byte[] directory=directory(imageRecord("IMAGES","ONE"));
        long first=dataset(directory).getLong(Tag.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity,0);
        byte[] cycle=patchRecord(directory,0,Tag.OffsetOfTheNextDirectoryRecord,first);
        var cycled=capture(pack(sources(cycle,Map.of("SET/IMAGES/ONE",source()))));
        assertTrue(cycled.directories().getFirst().reason().contains("cycle"),cycled.directories().getFirst().reason());
        byte[] dangling=patchRecord(directory,0,Tag.OffsetOfReferencedLowerLevelDirectoryEntity,999999);
        var broken=capture(pack(sources(dangling,Map.of("SET/IMAGES/ONE",source()))));
        assertTrue(broken.directories().getFirst().reason().contains("nonexistent item"));
        assertTrue(broken.directories().getFirst().assessment().contains("full Basic Directory IOD"));
    }
    @Test void inactiveRecordsAndMissingReferencedIdentityRemainExplicit()throws Exception {
        byte[] bytes=directory(imageRecord("IMAGES","ONE"));
        var inactive=capture(pack(sources(patchRecord(bytes,3,Tag.RecordInUseFlag,0),Map.of("SET/IMAGES/ONE",source()))));
        assertEquals("inactive-record",inactive.references().getFirst().status());
        assertTrue(inactive.directories().getFirst().reason().contains("retired inactive"));
        var incomplete=imageRecord("IMAGES","ONE");incomplete.remove(Tag.ReferencedSOPInstanceUIDInFile);
        var missingIdentity=capture(pack(sources(directory(incomplete),Map.of("SET/IMAGES/ONE",source()))));
        assertEquals("invalid-reference",missingIdentity.references().getFirst().status());
    }
    private static byte[] patchRecord(byte[] bytes,int index,int tag,long value)throws Exception {
        var data=dataset(bytes);var records=data.getSequence(Tag.DirectoryRecordSequence);
        int start=(int)data.getLong(Tag.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity,0);
        for(int i=0;i<index;i++)start=(int)records.get(i).getLong(Tag.OffsetOfReferencedLowerLevelDirectoryEntity,records.get(i).getLong(Tag.OffsetOfTheNextDirectoryRecord,0));
        int end=bytes.length;
        byte[] copy=bytes.clone();ByteBuffer view=ByteBuffer.wrap(copy).order(ByteOrder.LITTLE_ENDIAN);
        for(int offset=start+8;offset<end-8;offset++)if(Short.toUnsignedInt(view.getShort(offset))==(tag>>>16)&&Short.toUnsignedInt(view.getShort(offset+2))==(tag&0xffff)) {
            if(copy[offset+4]=='U'&&copy[offset+5]=='L'){view.putInt(offset+8,(int)value);return copy;}
            if(copy[offset+4]=='U'&&copy[offset+5]=='S'){view.putShort(offset+8,(short)value);return copy;}
        }
        throw new AssertionError("Record attribute not found for patch");
    }
}
