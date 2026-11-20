package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DicomMetadataInventoryTest {
    @TempDir Path temporary;
    private static final Gson JSON=new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private Path source() throws Exception {
        Attributes attrs;
        try(var in=new DicomInputStream(Path.of("fixtures/expanded/sc-native-gray8.dcm").toFile())) { attrs=in.readDataset(); }
        attrs.setSpecificCharacterSet("ISO_IR 192");
        attrs.setString(Tag.PatientName,VR.PN,"山田^Müller");
        attrs.setNull(Tag.PatientID,VR.LO);
        attrs.setString(Tag.ImageType,VR.CS,"ORIGINAL","","PRIMARY");
        attrs.setString(0x00110010,VR.LO,"PILOT_PRIVATE");
        attrs.setString(0x00111001,VR.LO,"私有, value","second");
        attrs.setBytes(0x00111002,VR.OB,new byte[]{1,2,3,4});
        attrs.setBytes(0x00111003,VR.OB,new byte[5000]);
        var sequence=attrs.newSequence(Tag.ReferencedImageSequence,2);
        for(int i=0;i<2;i++) {var item=new Attributes();item.setString(Tag.ReferencedSOPInstanceUID,VR.UI,"2.25.987654321."+(i+1));item.setString(Tag.SeriesDescription,VR.LO,"Nested, Unicode 山田");sequence.add(item);}
        Path folder=temporary.resolve("sources");Files.createDirectories(folder);Path path=folder.resolve("metadata.dcm");
        try(var out=new DicomOutputStream(path.toFile())) {out.writeDataset(attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian),attrs);}
        return path;
    }
    private static Map<String,DicomMetadataInventory.Element> rows(DicomMetadataInventory.Image image) {
        Map<String,DicomMetadataInventory.Element> result=new HashMap<>();
        for(var element:image.elements()) assertNull(result.put(element.path(),element),"Duplicate metadata path");
        return result;
    }
    @Test void capturesUnicodePrivateMultiplicityNestedEmptyAndBulkMarkers()throws Exception {
        Path source=source();byte[] bytes=Files.readAllBytes(source),snapshot=bytes.clone();
        var captured=DicomMetadataInventory.captureImage("original-0001.dcm","metadata.dcm",bytes);
        assertEquals("readable",captured.status());assertNull(captured.reason());var rows=rows(captured);
        assertEquals("山田^Müller",rows.get("dataset/(0010,0010)").value());
        assertEquals("",rows.get("dataset/(0010,0020)").value());
        assertEquals("ORIGINAL\\\\PRIMARY",rows.get("dataset/(0008,0008)").value());
        assertEquals("私有, value\\second",rows.get("dataset/(0011,1001)").value());
        assertEquals("LO",rows.get("dataset/(0011,1001)").vr());
        assertEquals("AQIDBA==",rows.get("dataset/(0011,1002)").value());
        assertEquals("base64",rows.get("dataset/(0011,1002)").encoding());
        assertArrayEquals(new byte[5000],Base64.getDecoder().decode(rows.get("dataset/(0011,1003)").value()));assertEquals("base64",rows.get("dataset/(0011,1003)").encoding());
        assertEquals("2",rows.get("dataset/(0008,1140)").value());assertEquals("sequence-item-count",rows.get("dataset/(0008,1140)").encoding());
        assertEquals("2.25.987654321.1",rows.get("dataset/(0008,1140)[1]/(0008,1155)").value());
        assertEquals("2.25.987654321.2",rows.get("dataset/(0008,1140)[2]/(0008,1155)").value());
        assertEquals("Nested, Unicode 山田",rows.get("dataset/(0008,1140)[2]/(0008,103E)").value());
        assertEquals("UI",rows.get("fileMeta/(0002,0010)").vr());assertEquals(UID.ExplicitVRLittleEndian,rows.get("fileMeta/(0002,0010)").value());
        assertNotNull(rows.get("fileMeta/(0002,0000)"),"Actual file-meta group length must be retained");
        assertEquals("omitted-pixel-data",rows.get("dataset/(7FE0,0010)").encoding());assertNull(rows.get("dataset/(7FE0,0010)").value());
        assertEquals(sha(bytes),captured.sha256());assertArrayEquals(snapshot,bytes);
        assertEquals(captured,DicomMetadataInventory.captureImage("original-0001.dcm","metadata.dcm",bytes));
    }
    @Test void selectedFieldMapMatchesDictionaryAndFullSourceValues()throws Exception {
        var mapping=JsonParser.parseString(Files.readString(Path.of("src/main/resources/field-mapping.json"))).getAsJsonObject();
        for(var value:mapping.getAsJsonArray("sourceFields")) {
            var item=value.getAsJsonObject();String tag=item.get("dicomTag").getAsString();
            if(!tag.matches("\\([0-9A-F]{4},[0-9A-F]{4}\\)"))continue;
            int number=(int)Long.parseLong(tag.replaceAll("[(),]",""),16);
            assertEquals(ElementDictionary.keywordOf(number,null),item.get("dicomKeyword").getAsString(),tag+" has wrong source keyword");
        }
        byte[] source=Files.readAllBytes(source());var full=rows(DicomMetadataInventory.captureImage("source.dcm","source.dcm",source));var selected=DicomInput.fields(source);
        assertEquals(full.get("dataset/(0010,0010)").value(),selected.get("PatientName"));
        assertEquals(full.get("dataset/(0008,0008)").value(),selected.get("ImageType"));
        assertFalse(selected.containsKey("PatientID"),"Selected blank omission is distinct from an actual empty full-metadata tag");
    }
    @Test void deflatedAndCompressedInventoriesOmitPixelsWithoutChangingBytes()throws Exception {
        for(String name:List.of("ct-deflated-16.dcm","sc-jpeg-baseline-gray8.dcm","sc-rle-gray8.dcm")) {
            byte[] bytes=Files.readAllBytes(Path.of("fixtures/expanded",name));byte[] before=bytes.clone();
            var image=DicomMetadataInventory.captureImage("source.dcm",name,bytes);
            assertEquals("readable",image.status(),image.reason());assertEquals("omitted-pixel-data",rows(image).get("dataset/(7FE0,0010)").encoding());
            assertArrayEquals(before,bytes);
        }
        var invalid=DicomMetadataInventory.captureImage("readme.txt","readme.txt","Not DICOM".getBytes(StandardCharsets.UTF_8));
        assertEquals("unreadable",invalid.status());assertNotNull(invalid.reason());assertTrue(invalid.elements().isEmpty());
    }
    @Test void verifiesFullSidecarAgainstSourcesEvenWhenItsHashIsUpdated()throws Exception {
        Path source=source(),original=temporary.resolve("original.pdf");DicomPdf.create(source.getParent(),original);
        assertEquals("PASS",PackageTools.verify(original,source.getParent(),null).metadataAccuracy().status());
        Path altered=temporary.resolve("altered.pdf");
        try(var pdf=Loader.loadPDF(original.toFile())) {
            var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            var sidecar=JsonParser.parseString(new String(data(files.get("dicom-metadata.json")),StandardCharsets.UTF_8)).getAsJsonObject();
            var manifest=JsonParser.parseString(new String(data(files.get("manifest.json")),StandardCharsets.UTF_8)).getAsJsonObject();
            boolean changed=false;
            for(var row:sidecar.getAsJsonArray("images").get(0).getAsJsonObject().getAsJsonArray("elements")) {
                var element=row.getAsJsonObject();if(element.get("path").getAsString().equals("dataset/(0010,0010)")){element.addProperty("value","INVENTED");changed=true;}
            }
            assertTrue(changed);byte[] sidecarBytes=JSON.toJson(sidecar).getBytes(StandardCharsets.UTF_8);replace(pdf,files.get("dicom-metadata.json"),sidecarBytes);
            manifest.getAsJsonObject("artifactSha256").addProperty("dicom-metadata.json",sha(sidecarBytes));publishManifest(pdf,files,manifest);pdf.save(altered.toFile());
        }
        var checked=PackageTools.verify(altered,source.getParent(),null);
        assertEquals("PASS",checked.sourceBytes().status());assertEquals("PASS",checked.externalSources().status());assertEquals("FAIL",checked.metadataAccuracy().status());
        assertTrue(checked.metadataAccuracy().details().stream().anyMatch(s->s.contains("Full DICOM metadata sidecar differs")));
    }
    @Test void olderProfileWithoutOptionalFullSidecarRemainsVerifiable()throws Exception {
        Path source=source(),original=temporary.resolve("new.pdf");DicomPdf.create(source.getParent(),original,"archival-master",false);Path older=temporary.resolve("older.pdf");
        try(var pdf=Loader.loadPDF(original.toFile())) {
            var tree=pdf.getDocumentCatalog().getNames().getEmbeddedFiles();var files=new TreeMap<>(tree.getNames());
            var manifest=JsonParser.parseString(new String(data(files.get("manifest.json")),StandardCharsets.UTF_8)).getAsJsonObject();
            manifest.remove("metadataXmpVersion");
            for(String resource:List.of("dicom-xmp.rng","field-mapping.json")){
                byte[] old=Files.readAllBytes(Path.of("src/main/resources/legacy-metadata-v1",resource));
                replace(pdf,files.get(resource),old);manifest.getAsJsonObject("artifactSha256").addProperty(resource,sha(old));
            }
            var remove=Set.of("dicom-metadata.json","metadata-mapping.json");
            for(String name:remove){files.remove(name);manifest.getAsJsonObject("artifactSha256").remove(name);}
            tree.setNames(files);COSArray originalAF=(COSArray)pdf.getDocumentCatalog().getCOSObject().getDictionaryObject(COSName.getPDFName("AF"));COSArray newAF=new COSArray();
            for(int i=0;i<originalAF.size();i++){COSDictionary dictionary=(COSDictionary)originalAF.getObject(i);if(!remove.contains(dictionary.getString(COSName.UF)))newAF.add(originalAF.get(i));}
            pdf.getDocumentCatalog().getCOSObject().setItem(COSName.getPDFName("AF"),newAF);publishManifest(pdf,files,manifest);pdf.save(older.toFile());
        }
        assertEquals("PASS",PackageTools.verify(older,source.getParent(),null).metadataAccuracy().status());
    }
    private static byte[] data(PDComplexFileSpecification file)throws Exception{return file.getEmbeddedFileUnicode().toByteArray();}
    private static String sha(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static void replace(PDDocument pdf,PDComplexFileSpecification file,byte[] bytes)throws Exception{
        String mime=file.getEmbeddedFileUnicode().getSubtype();
        var embedded=new PDEmbeddedFile(pdf,new ByteArrayInputStream(bytes),COSName.FLATE_DECODE);embedded.setSubtype(mime);embedded.setSize(bytes.length);file.setEmbeddedFile(embedded);file.setEmbeddedFileUnicode(embedded);
    }
    private static void publishManifest(PDDocument pdf,Map<String,PDComplexFileSpecification> files,JsonObject manifest)throws Exception{
        String json=JSON.toJson(manifest);byte[] bytes=json.getBytes(StandardCharsets.UTF_8);replace(pdf,files.get("manifest.json"),bytes);replace(pdf,files.get("manifest.sha256"),(sha(bytes)+"  manifest.json\n").getBytes(StandardCharsets.US_ASCII));
        if(manifest.has("metadataXmpVersion"))PdfMetadata.apply(pdf,json,data(files.get("dicom-metadata.json")));else PdfMetadata.apply(pdf,json);
    }
}
