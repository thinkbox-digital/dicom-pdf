package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.awt.color.ColorSpace;
import java.awt.color.ICC_Profile;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
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
        dc.setDescription("Reference images with byte-preserved DICOM originals and an offline viewer. "
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
        if(metadataBytes!=null){
            String sourceMetadata=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(metadataBytes)).toString();
            text(dicom,"metadataVersion","1");
            text(dicom,"metadataSha256",HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(metadataBytes)));
            text(dicom,"metadataJson",sourceMetadata);
        }
        PDMetadata stream = new PDMetadata(document);
        try(var compressed=stream.createOutputStream(COSName.FLATE_DECODE)){new XmpSerializer().serialize(xmp,compressed,true);}
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

    private static void text(XMPSchema schema, String name, String value) {
        schema.addProperty(schema.createTextType(name, value));
    }
}
