package digital.thinkbox.dicompdf;

import com.google.gson.GsonBuilder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;

/** Reproducible mathematical pixels and invented metadata; no patient data. */
public final class FullMetadataSyntheticFixtures {
    private FullMetadataSyntheticFixtures(){}
    static byte[] binary(int count){byte[] result=new byte[count];for(int i=0;i<count;i++)result[i]=(byte)(i*31+7);return result;}
    public static void main(String[] args)throws Exception{
        if(args.length!=2)throw new IllegalArgumentException("Use input-directory and expectations-json paths");
        write(Path.of(args[0]),Path.of(args[1]));
    }
    static Path write(Path directory,Path expectations)throws Exception{
        Files.createDirectories(directory);Attributes attrs;
        try(var input=new DicomInputStream(Path.of("fixtures/expanded/sc-native-gray8.dcm").toFile())){attrs=input.readDataset();}
        attrs.setSpecificCharacterSet("ISO_IR 192");
        attrs.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150001");
        attrs.setString(Tag.PatientName,VR.PN,"Synthetic^Metadata 山田");attrs.setString(Tag.PatientID,VR.LO,"SYNTHETIC-NO-PATIENT");
        attrs.setString(Tag.PatientBirthDate,VR.DA,"19000101");attrs.setString(Tag.PatientSex,VR.CS,"O");
        attrs.setString(Tag.AccessionNumber,VR.SH,"SYNTHETIC-2026");
        attrs.setString(Tag.Manufacturer,VR.LO,"Synthetic <equipment> & Unicode Müller");
        attrs.setString(Tag.ManufacturerModelName,VR.LO,"Synthetic model");attrs.setString(Tag.ProtocolName,VR.LO,"Synthetic protocol");
        attrs.setString(Tag.KVP,VR.DS,"70.0");attrs.setString(Tag.ContrastBolusAgent,VR.LO,"Synthetic contrast metadata only");
        attrs.setString(Tag.WindowCenterWidthExplanation,VR.LO,"Synthetic source preset");
        attrs.setString(Tag.PatientComments,VR.LT,"Synthetic XML <tag> & \"quotes\" > text; Unicode 山田 / Müller\nsecond line");
        attrs.setString(0x00110010,VR.LO,"DICOM_PDF_TEST");attrs.setString(0x00111001,VR.LO,"Synthetic private <value> & 山田");
        attrs.setBytes(0x00111002,VR.OB,new byte[]{1,2,3,4});attrs.setBytes(0x00111003,VR.OB,binary(8192));attrs.setBytes(0x00111004,VR.OW,binary(12000));
        var requests=attrs.newSequence(Tag.RequestAttributesSequence,1);var request=new Attributes();
        request.setString(Tag.RequestedProcedureDescription,VR.LO,"Synthetic nested <procedure> & 山田");
        request.setString(0x00130010,VR.LO,"NESTED_TEST");request.setString(0x00131001,VR.UT,"Synthetic nested private \"value\" & 山田\nsecond line");requests.add(request);
        var waveform=attrs.newSequence(Tag.WaveformSequence,1);var wave=new Attributes();wave.setBytes(Tag.WaveformData,VR.OW,binary(6000));waveform.add(wave);
        var references=attrs.newSequence(Tag.ReferencedImageSequence,1);var reference=new Attributes();
        reference.setString(Tag.ReferencedSOPInstanceUID,VR.UI,attrs.getString(Tag.SOPInstanceUID));reference.setString(Tag.ReferencedSOPClassUID,VR.UI,attrs.getString(Tag.SOPClassUID));references.add(reference);
        Path result=directory.resolve("metadata.dcm");
        try(var output=new DicomOutputStream(result.toFile())){output.writeDataset(attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian),attrs);}
        Map<String,Object> wanted=new LinkedHashMap<>();
        expected(wanted,"dataset/(0010,0030)","DA","19000101","dicom-value-string");
        expected(wanted,"dataset/(0010,0040)","CS","O","dicom-value-string");
        expected(wanted,"dataset/(0008,0050)","SH","SYNTHETIC-2026","dicom-value-string");
        expected(wanted,"dataset/(0008,0070)","LO",attrs.getString(Tag.Manufacturer),"dicom-value-string");
        expected(wanted,"dataset/(0018,1030)","LO","Synthetic protocol","dicom-value-string");
        expected(wanted,"dataset/(0010,4000)","LT",attrs.getString(Tag.PatientComments),"dicom-value-string");
        expected(wanted,"dataset/(0011,1001)","LO","Synthetic private <value> & 山田","dicom-value-string");
        expected(wanted,"dataset/(0011,1002)","OB","AQIDBA==","base64");
        expected(wanted,"dataset/(0011,1003)","OB",Base64.getEncoder().encodeToString(binary(8192)),"base64");
        expected(wanted,"dataset/(0011,1004)","OW",Base64.getEncoder().encodeToString(binary(12000)),"base64");
        expected(wanted,"dataset/(0040,0275)","SQ","1","sequence-item-count");
        expected(wanted,"dataset/(0040,0275)[1]/(0032,1060)","LO",request.getString(Tag.RequestedProcedureDescription),"dicom-value-string");
        expected(wanted,"dataset/(0040,0275)[1]/(0013,1001)","UT",request.getString(0x00131001),"dicom-value-string");
        expected(wanted,"dataset/(5400,0100)[1]/(5400,1010)","OW",Base64.getEncoder().encodeToString(binary(6000)),"base64");
        Map<String,Object> pixel=new LinkedHashMap<>();pixel.put("vr","OB");pixel.put("value",null);pixel.put("encoding","omitted-pixel-data");wanted.put("dataset/(7FE0,0010)",pixel);
        byte[] bytes=Files.readAllBytes(result);Map<String,Object> report=new LinkedHashMap<>();report.put("synthetic",true);
        report.put("sourceSha256",HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));report.put("sourceSize",bytes.length);report.put("expectedElements",wanted);
        Files.createDirectories(expectations.toAbsolutePath().getParent());
        Files.writeString(expectations,new GsonBuilder().serializeNulls().setPrettyPrinting().disableHtmlEscaping().create().toJson(report)+"\n",StandardCharsets.UTF_8);
        return result;
    }
    private static void expected(Map<String,Object> rows,String path,String vr,String value,String encoding){rows.put(path,Map.of("vr",vr,"value",value,"encoding",encoding));}
}
