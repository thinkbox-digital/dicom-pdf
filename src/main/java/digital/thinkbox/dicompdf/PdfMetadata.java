package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.awt.color.ColorSpace;
import java.awt.color.ICC_Profile;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.sax.SAXSource;
import javax.xml.transform.stream.StreamResult;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.XMLFilterImpl;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.List;
import java.util.HexFormat;
import java.util.TimeZone;
import java.util.UUID;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.PDMetadata;
import org.apache.pdfbox.pdmodel.graphics.color.PDOutputIntent;
import org.apache.xmpbox.XMPMetadata;
import org.apache.xmpbox.schema.XMPSchema;
import org.apache.xmpbox.xml.XmpSerializer;

/** PDF/A-4f publication metadata, independent of the EA-PDF email profile. */
final class PdfMetadata {
    static final String NAMESPACE = "https://thinkbox.digital/ns/dicom/2.0/";
    private static final String PRODUCT = "DICOM PDF pilot " + ApplicationVersion.VERSION;

    private PdfMetadata() {}

    static void apply(PDDocument document, String inventoryJson) throws Exception {
        apply(document,inventoryJson,null);
    }

    /** Full source metadata is an additive property; older packets remain supported. */
    static void apply(PDDocument document,String inventoryJson,byte[] metadataBytes)throws Exception {
        applyStream(document,inventoryJson,SourceContent.of(metadataBytes));
    }
    static void applyStream(PDDocument document,String inventoryJson,SourceContent metadata)throws Exception {
        document.setVersion(2.0f);
        document.getDocument().setVersion(2.0f);
        var catalog = document.getDocumentCatalog();
        catalog.getCOSObject().setName(COSName.VERSION, "2.0");
        catalog.setLanguage("en-US");
        // PDF/A-4 uses XMP. Omitting Info also avoids inconsistent parallel values.
        document.getDocument().getTrailer().removeItem(COSName.INFO);

        XMPMetadata xmp = XMPMetadata.createXMPMetadata();
        xmp.setEndXPacket("w");
        var dc = xmp.createAndAddDublinCoreSchema();
        dc.setTitle("DICOM study reference");
        dc.setDescription("Reference images with byte-preserved DICOM originals. "
                + "Missing source fields remain absent; reference images are not calibrated measurements.");
        dc.setFormat("application/pdf");
        dc.addCreator(PRODUCT);
        var pdf = xmp.createAndAddAdobePDFSchema();
        pdf.setProducer(PRODUCT + " / Apache PDFBox");
        var basic = xmp.createAndAddXMPBasicSchema();
        Calendar now = new GregorianCalendar(TimeZone.getTimeZone("UTC"));
        basic.setCreateDate(now);
        basic.setModifyDate(now);
        basic.setMetadataDate(now);
        basic.setCreatorTool(PRODUCT);
        XMPSchema pdfa = xmp.createAndAddDefaultSchema("pdfaid", "http://www.aiim.org/pdfa/ns/id/");
        text(pdfa, "part", "4");
        text(pdfa, "rev", "2020");
        text(pdfa, "conformance", "F");
        var management = xmp.createAndAddXMPMediaManagementSchema();
        management.setDocumentID("uuid:" + UUID.randomUUID());
        management.setInstanceID("uuid:" + UUID.randomUUID());
        XMPSchema dicom = xmp.createAndAddDefaultSchema("dicom", NAMESPACE);
        var manifest = JsonParser.parseString(inventoryJson).getAsJsonObject();
        text(dicom, "schemaVersion", "2");
        for (String name : List.of("profile", "profileVersion", "sourceRole")) {
            text(dicom, name, manifest.get(name).getAsString());
        }
        // One lossless JSON literal keeps the selected study/image fields and
        // attachment/page/hash mapping identical to the versioned manifest.
        text(dicom, "inventoryJson", inventoryJson);
        if(metadata!=null){
            text(dicom,"metadataVersion","1");
            text(dicom,"metadataSha256",metadata.digest().sha256());
            text(dicom,"metadataJson","");
        }
        PDMetadata stream = new PDMetadata(document);
        try(var compressed=stream.createOutputStream(COSName.FLATE_DECODE)){
            if(metadata==null)new XmpSerializer().serialize(xmp,compressed,true);
            else writeFullPacket(xmp,metadata,compressed);
        }
        catalog.setMetadata(stream);

        // Java supplies the standard sRGB profile; no machine-specific file path.
        byte[] profile = ICC_Profile.getInstance(ColorSpace.CS_sRGB).getData();
        try (var input = new ByteArrayInputStream(profile)) {
            PDOutputIntent intent = new PDOutputIntent(document, input);
            intent.setInfo("sRGB IEC61966-2.1");
            intent.setOutputCondition("sRGB IEC61966-2.1");
            intent.setOutputConditionIdentifier("sRGB IEC61966-2.1");
            intent.setRegistryName("http://www.color.org");
            catalog.setOutputIntents(List.of(intent));
        }
    }

    /** XmpBox models literals as a single String. Stream the external literal into its empty element. */
    private static void writeFullPacket(XMPMetadata xmp,SourceContent metadata,OutputStream destination)throws Exception {
        var template=new ByteArrayOutputStream();
        new XmpSerializer().serialize(xmp,template,true);
        var parsers=SAXParserFactory.newInstance();
        parsers.setNamespaceAware(true);
        var filter=new XMLFilterImpl(parsers.newSAXParser().getXMLReader()){
            @Override public void startElement(String uri,String local,String name,Attributes attributes)throws SAXException {
                super.startElement(uri,local,name,attributes);
                if(!NAMESPACE.equals(uri) || !"metadataJson".equals(local))return;
                var decoder=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT);
                try(var reader=new InputStreamReader(metadata.open(),decoder)){
                    char[] buffer=new char[8193];
                    for(int count;(count=reader.read(buffer,0,buffer.length-1))!=-1;){
                        if(count>0 && Character.isHighSurrogate(buffer[count-1])){
                            int low=reader.read();
                            if(low<0 || !Character.isLowSurrogate((char)low))throw new IOException("Incomplete Unicode character in metadata");
                            buffer[count++]=(char)low;
                        }
                        super.characters(buffer,0,count);
                    }
                }catch(IOException e){throw new SAXException(e);}
            }
        };
        var serializer=TransformerFactory.newInstance().newTransformer();
        serializer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION,"yes");
        serializer.transform(new SAXSource(filter,new InputSource(new ByteArrayInputStream(template.toByteArray()))),new StreamResult(destination));
    }

    private static void text(XMPSchema schema, String name, String value) {
        schema.addProperty(schema.createTextType(name, value));
    }
}
