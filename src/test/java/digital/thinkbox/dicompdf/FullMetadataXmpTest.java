package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FullMetadataXmpTest {
    @TempDir Path temporary;
    private static final Gson JSON=new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private Path source()throws Exception{return FullMetadataSyntheticFixtures.write(temporary.resolve("sources"),temporary.resolve("expectations.json"));}
    private static byte[] data(PDComplexFileSpecification file)throws Exception{return file.getEmbeddedFileUnicode().toByteArray();}
    private static String sha(byte[] value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
    private static JsonObject json(byte[] value){return JsonParser.parseString(new String(value,StandardCharsets.UTF_8)).getAsJsonObject();}
    private static org.w3c.dom.Document xmp(PDDocument pdf)throws Exception{
        var factory=DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,"");factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(pdf.getDocumentCatalog().getMetadata().toByteArray()));
    }
    private static String property(org.w3c.dom.Document xml,String name){var values=xml.getElementsByTagNameNS(PdfMetadata.NAMESPACE,name);assertEquals(1,values.getLength(),name);return values.item(0).getTextContent();}
    private static void replace(PDDocument pdf,PDComplexFileSpecification file,byte[] value)throws Exception{
        String mime=file.getEmbeddedFileUnicode().getSubtype();var stream=new PDEmbeddedFile(pdf,new ByteArrayInputStream(value),COSName.FLATE_DECODE);
        stream.setSubtype(mime);stream.setSize(value.length);file.setEmbeddedFile(stream);file.setEmbeddedFileUnicode(stream);
    }
    private static void manifest(PDDocument pdf,Map<String,PDComplexFileSpecification> files,JsonObject value,boolean full)throws Exception{
        String text=JSON.toJson(value);byte[] bytes=text.getBytes(StandardCharsets.UTF_8);replace(pdf,files.get("manifest.json"),bytes);
        replace(pdf,files.get("manifest.sha256"),(sha(bytes)+"  manifest.json\n").getBytes(StandardCharsets.US_ASCII));
        if(full)PdfMetadata.apply(pdf,text,data(files.get("dicom-metadata.json")));else PdfMetadata.apply(pdf,text);
    }
    @Test void fullXmpIsExactSidecarAndIncludesUnselectedNestedPrivateAndLargeBinaryValues()throws Exception{
        Path source=source(),output=temporary.resolve("full.pdf");byte[] master=Files.readAllBytes(source);DicomPdf.create(source.getParent(),output);
        var expected=JsonParser.parseString(Files.readString(temporary.resolve("expectations.json"))).getAsJsonObject().getAsJsonObject("expectedElements");
        try(var pdf=Loader.loadPDF(output.toFile())){
            var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();byte[] sidecar=data(files.get("dicom-metadata.json"));var manifest=json(data(files.get("manifest.json")));
            assertEquals(1,manifest.get("metadataXmpVersion").getAsInt());var xml=xmp(pdf);
            assertEquals("1",property(xml,"metadataVersion"));assertEquals(sha(sidecar),property(xml,"metadataSha256"));
            assertArrayEquals(sidecar,property(xml,"metadataJson").getBytes(StandardCharsets.UTF_8));assertEquals('}',sidecar[sidecar.length-1]);
            assertTrue(property(xml,"metadataJson").contains("<equipment> & Unicode Müller"));
            var record=json(sidecar).getAsJsonArray("images").get(0).getAsJsonObject();assertEquals("readable",record.get("status").getAsString());
            var image=manifest.getAsJsonArray("images").get(0).getAsJsonObject();
            for(String key:List.of("attachment","sourcePath","sopInstanceUID","sha256"))assertEquals(image.get(key),record.get(key));
            var rows=new HashMap<String,JsonObject>();for(var value:record.getAsJsonArray("elements")){var row=value.getAsJsonObject();assertNull(rows.put(row.get("path").getAsString(),row));}
            for(var wanted:expected.entrySet()){
                assertTrue(rows.containsKey(wanted.getKey()));var actual=rows.get(wanted.getKey());
                for(var field:wanted.getValue().getAsJsonObject().entrySet())assertEquals(field.getValue(),actual.get(field.getKey()),wanted.getKey()+" "+field.getKey());
            }
            for(String absent:List.of("PatientBirthDate","PatientSex","AccessionNumber","Manufacturer","ProtocolName"))assertFalse(image.getAsJsonObject("fields").has(absent));
            assertFalse(rows.values().stream().anyMatch(row->Set.of("omitted-binary-data","omitted-bulk-data").contains(row.get("encoding").getAsString())));
        }
        assertArrayEquals(master,Files.readAllBytes(source));assertEquals("PASS",PackageTools.verify(output,source.getParent(),null).metadataAccuracy().status());
        Path recovery=temporary.resolve("recovery");PackageTools.extract(output,recovery);
        assertArrayEquals(master,Files.readAllBytes(recovery.resolve("originals/metadata.dcm")));assertTrue(Files.size(recovery.resolve("package/dicom-metadata.json"))>20000);
    }
    @Test void strippingAllFullMetadataPropertiesCannotFallBackToLegacyWhenMarkerRequiresThem()throws Exception{
        Path source=source(),original=temporary.resolve("full.pdf"),changed=temporary.resolve("stripped.pdf");DicomPdf.create(source.getParent(),original);
        try(var pdf=Loader.loadPDF(original.toFile())){var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();PdfMetadata.apply(pdf,new String(data(files.get("manifest.json")),StandardCharsets.UTF_8));pdf.save(changed.toFile());}
        var result=PackageTools.verify(changed,source.getParent(),null);assertEquals("PASS",result.sourceBytes().status());assertEquals("FAIL",result.metadataAccuracy().status());
        assertTrue(result.metadataAccuracy().details().stream().anyMatch(value->value.contains("XMP metadataJson")));
    }
    @Test void explicitNullMetadataVersionCannotBecomeLegacyFallback()throws Exception{
        Path source=source(),original=temporary.resolve("full.pdf"),changed=temporary.resolve("null-version.pdf");DicomPdf.create(source.getParent(),original);
        try(var pdf=Loader.loadPDF(original.toFile())){
            var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();var recorded=json(data(files.get("manifest.json")));
            recorded.add("metadataXmpVersion",JsonNull.INSTANCE);manifest(pdf,files,recorded,true);pdf.save(changed.toFile());
        }
        var result=PackageTools.verify(changed,source.getParent(),null);assertEquals("PASS",result.sourceBytes().status());assertEquals("FAIL",result.metadataAccuracy().status());
        assertTrue(result.metadataAccuracy().details().stream().anyMatch(value->value.contains("Unsupported full metadata XMP version")));
    }
    @Test void coherentInventedNonselectedMetadataStillFailsIndependentSourceComparison()throws Exception{
        Path source=source(),original=temporary.resolve("full.pdf"),changed=temporary.resolve("invented.pdf");DicomPdf.create(source.getParent(),original);
        try(var pdf=Loader.loadPDF(original.toFile())){
            var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();var metadata=json(data(files.get("dicom-metadata.json")));var recorded=json(data(files.get("manifest.json")));
            boolean modified=false;for(var item:metadata.getAsJsonArray("images").get(0).getAsJsonObject().getAsJsonArray("elements")){
                var row=item.getAsJsonObject();if("dataset/(0010,0030)".equals(row.get("path").getAsString())){row.addProperty("value","19000102");modified=true;}
            }
            assertTrue(modified);byte[] bytes=JSON.toJson(metadata).getBytes(StandardCharsets.UTF_8);replace(pdf,files.get("dicom-metadata.json"),bytes);
            recorded.getAsJsonObject("artifactSha256").addProperty("dicom-metadata.json",sha(bytes));manifest(pdf,files,recorded,true);pdf.save(changed.toFile());
        }
        var result=PackageTools.verify(changed,source.getParent(),null);assertEquals("PASS",result.sourceBytes().status());assertEquals("PASS",result.externalSources().status());assertEquals("FAIL",result.metadataAccuracy().status());
        assertTrue(result.metadataAccuracy().details().stream().anyMatch(value->value.contains("Full DICOM metadata sidecar differs")));
    }
    @Test void oldProfileWithLegacyLargeBinaryOmissionStillVerifies()throws Exception{
        Path source=source(),original=temporary.resolve("full.pdf"),older=temporary.resolve("older.pdf");DicomPdf.create(source.getParent(),original,"archival-master",false);
        try(var pdf=Loader.loadPDF(original.toFile())){
            var files=pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();var recorded=json(data(files.get("manifest.json")));recorded.remove("metadataXmpVersion");
            var images=JSON.fromJson(recorded.get("images"),Manifest.Image[].class);var originals=new LinkedHashMap<String,byte[]>();for(var image:images)originals.put(image.attachment(),data(files.get(image.attachment())));
            byte[] metadata=DicomMetadataInventory.bytes(DicomMetadataInventory.captureLegacy(Arrays.asList(images),originals));replace(pdf,files.get("dicom-metadata.json"),metadata);recorded.getAsJsonObject("artifactSha256").addProperty("dicom-metadata.json",sha(metadata));
            for(String name:List.of("dicom-xmp.rng","field-mapping.json","metadata-mapping.json")){
                byte[] bytes=Files.readAllBytes(Path.of("src/main/resources/legacy-metadata-v1",name));replace(pdf,files.get(name),bytes);recorded.getAsJsonObject("artifactSha256").addProperty(name,sha(bytes));
            }
            assertTrue(new String(metadata,StandardCharsets.UTF_8).contains("omitted-binary-data"));manifest(pdf,files,recorded,false);pdf.save(older.toFile());
        }
        assertEquals("PASS",PackageTools.verify(older,source.getParent(),null).metadataAccuracy().status());
    }
    @Test void streamingXmpPreservesSupplementaryCharactersAndXmlDelimiters()throws Exception {
        String json=JSON.toJson(Map.of("value","x".repeat(8179)+"🌈 ]]> & < ü "+"𐐀".repeat(5000)));
        try(var pdf=new PDDocument()){
            PdfMetadata.apply(pdf,"{\"profile\":\"d\",\"profileVersion\":\"2\",\"sourceRole\":\"fixture\"}",json.getBytes(StandardCharsets.UTF_8));
            assertEquals(json,property(xmp(pdf),"metadataJson"));
        }
    }
    @Test void allPixelPayloadFamiliesStayExplicitlyOmitted()throws Exception{
        var attrs=new Attributes();attrs.setString(Tag.SOPClassUID,VR.UI,UID.SecondaryCaptureImageStorage);attrs.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150002");
        attrs.setBytes(Tag.PixelData,VR.OB,new byte[8]);attrs.setBytes(Tag.FloatPixelData,VR.OF,new byte[8]);attrs.setBytes(Tag.DoubleFloatPixelData,VR.OD,new byte[16]);
        var output=new ByteArrayOutputStream();try(var dicom=new DicomOutputStream(output,UID.ExplicitVRLittleEndian)){dicom.writeDataset(attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian),attrs);}
        var image=DicomMetadataInventory.captureImage("synthetic.dcm","synthetic.dcm",output.toByteArray());assertEquals("readable",image.status());
        assertEquals(3,image.elements().stream().filter(row->row.encoding().equals("omitted-pixel-data")&&row.value()==null).count());
    }
    @Test void nonpixelMetadataCanExceedTheFormerSidecarByteLimit()throws Exception{
        Path source=source(),directory=temporary.resolve("oversized");Files.createDirectories(directory);Attributes attrs;
        try(var input=new DicomInputStream(source.toFile())){attrs=input.readDataset();}attrs.setBytes(0x00111003,VR.OB,new byte[48*1024*1024]);
        try(var output=new DicomOutputStream(directory.resolve("oversized.dcm").toFile())){output.writeDataset(attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian),attrs);}
        Path destination=temporary.resolve("existing.pdf");byte[] sentinel="Unchanged existing destination".getBytes(StandardCharsets.UTF_8);Files.write(destination,sentinel);
        DicomPdf.create(directory,destination);
        var checked=PackageTools.verify(destination,directory,null);assertEquals("PASS",checked.metadataAccuracy().status(),checked.json());
        Path recovered=temporary.resolve("recovered-large-metadata");PackageTools.extract(destination,recovered);
        assertEquals(-1,Files.mismatch(directory.resolve("oversized.dcm"),recovered.resolve("originals/oversized.dcm")));
    }
}
