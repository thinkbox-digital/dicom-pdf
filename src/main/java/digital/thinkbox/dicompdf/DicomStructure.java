package digital.thinkbox.dicompdf;

import com.google.gson.GsonBuilder;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.dcm4che3.imageio.codec.TransferSyntaxType;

/** Additional versioned source checks. Never decodes pixels, rewrites sources or claims full IOD conformance. */
final class DicomStructure {
    private DicomStructure(){}
    private static final Set<String> SC=Set.of(UID.SecondaryCaptureImageStorage,UID.MultiFrameSingleBitSecondaryCaptureImageStorage,
        UID.MultiFrameGrayscaleByteSecondaryCaptureImageStorage,UID.MultiFrameGrayscaleWordSecondaryCaptureImageStorage,UID.MultiFrameTrueColorSecondaryCaptureImageStorage);
    private static final Set<String> CLASSIC=Set.of(UID.CTImageStorage,UID.MRImageStorage);
    record Issue(String severity,String code,String path,String message,String specification){}
    record Check(String status,String scope){}
    record Image(String attachment,String sourcePath,String sha256,String sopInstanceUID,String status,
                 Map<String,Check> checks,Long expectedPixelBytes,Long suppliedPixelBytes,List<Issue> issues){}
    record Inventory(int schemaVersion,String standardEdition,String rulesVersion,String validator,boolean fullIodValidation,List<String> notAssessed,List<Image> images){}
    private record Pixel(int tag,VR vr,long length){}
    static Inventory capture(List<Manifest.Image> images,Map<String,?> originals)throws Exception{
        var result=new ArrayList<Image>();
        for(var source:images)result.add(inspect(source.attachment(),source.sourcePath(),originals.get(source.attachment())));
        return new Inventory(1,"2026d","1","dcm4che 5.33.1 Attributes.validate + DICOM native pixel structure checks",false,
            List.of("Full SOP-class IOD/module/conditional conformance and coded terminology","Compressed codestream validity and decoded pixel correctness",
                "Clinical correctness, calibration, authenticity, de-identification and clinical completeness"),List.copyOf(result));
    }
    static byte[] bytes(Inventory value)throws IOException{
        byte[] bytes=new GsonBuilder().serializeNulls().disableHtmlEscaping().setPrettyPrinting().create().toJson(value).getBytes(StandardCharsets.UTF_8);
        return bytes;
    }
    static Image inspect(String attachment,String sourcePath,Object content)throws Exception{
        var source=SourceContent.of(content);
        if(source==null)throw new IOException("Original bytes unavailable for structural checks");
        var issues=new ArrayList<Issue>();var checks=new LinkedHashMap<String,Check>();String uid=null;Long expected=null,supplied=null;
        String sha=source.digest().sha256();
        byte[] bytes=source.prefix(132);
        boolean prefix=bytes.length>=132&&bytes[128]=='D'&&bytes[129]=='I'&&bytes[130]=='C'&&bytes[131]=='M';
        if(!prefix){checks.put("readability",new Check("UNKNOWN","Part 10 header not present; no structural validity claim"));
            return new Image(attachment,sourcePath,sha,null,"UNKNOWN",checks,null,null,List.of());}
        try(var input=new DicomInputStream(source.open())){
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            input.setBulkDataDescriptor((items,creator,tag,vr,length)->tag!=Tag.PixelDataProviderURL&&BulkDataDescriptor.DEFAULT.isBulkData(items,creator,tag,vr,length));
            var headers=new Headers();input.setDicomInputHandler(headers);
            var meta=input.readFileMetaInformation();var data=input.readDataset();uid=data.getString(Tag.SOPInstanceUID);
            checks.put("readability",new Check("PASS","dcm4che dataset parse; no pixel decoding"));
            String sop=data.getString(Tag.SOPClassUID,"");
            if(CLASSIC.contains(sop)||SC.contains(sop)){
                IOD rules=rules(sop);var result=data.validate(rules);
                checks.put("selectedModuleRules",new Check(result.isValid()?"PASS":"FAIL","dcm4che VR/VM/type/value rules for selected classic CT/MR or Secondary Capture attributes"));
                findings(issues,result.tagsOfMissingAttributes(),"MISSING_MODULE_ATTRIBUTE","Required selected-module attribute is absent");
                findings(issues,result.tagsOfMissingAttributeValues(),"EMPTY_MODULE_ATTRIBUTE","Required selected-module value is empty");
                findings(issues,result.tagsOfInvalidAttributeValues(),"INVALID_MODULE_VALUE","Selected-module VR, multiplicity or enumerated value is invalid");
                findings(issues,result.tagsOfNotAllowedAttributes(),"PROHIBITED_MODULE_ATTRIBUTE","Selected-module attribute is not permitted");
            }else checks.put("selectedModuleRules",new Check("UNKNOWN","No selected SOP-specific rule set; full IOD conformance not assessed"));
            List<Pixel> pixels=headers.pixels.getOrDefault(data,List.of());
            if(pixels.isEmpty()){
                if(data.containsValue(Tag.PixelDataProviderURL))checks.put("pixelStructure",new Check("UNKNOWN","Referenced pixel provider was not retrieved; supplied objects remain unchanged"));
                else if(data.contains(Tag.Rows)||data.contains(Tag.Columns)){
                    problem(issues,"MISSING_PIXEL_ELEMENT","dataset","Image dimensions are supplied without a top-level pixel element","PS3.3 C.7.6.3/C.7.6.24/C.7.6.25");
                    checks.put("pixelStructure",new Check("FAIL","No supplied pixel element"));
                }else checks.put("pixelStructure",new Check("NOT_APPLICABLE","No top-level image pixel payload"));
            }else if(pixels.size()!=1){
                problem(issues,"DUPLICATE_PIXEL_ELEMENT","dataset","Multiple or repeated top-level pixel elements are not a single authoritative pixel payload","PS3.5 7.1/8.1");
                checks.put("pixelStructure",new Check("FAIL","Repeated or mutually exclusive pixel elements"));
            }else{
                Pixel pixel=pixels.getFirst();supplied=pixel.length()<0?null:pixel.length();
                String syntax=meta==null?input.getTransferSyntax():meta.getString(Tag.TransferSyntaxUID,input.getTransferSyntax());
                TransferSyntaxType type=TransferSyntaxType.forUID(syntax);int before=issues.size();
                if(type==TransferSyntaxType.UNKNOWN||type==TransferSyntaxType.JPIP){
                    checks.put("pixelStructure",new Check("UNKNOWN","Transfer syntax not covered by these pixel-structure checks"));
                }else if(type.isPixeldataEncapsulated()){
                    if(pixel.tag()!=Tag.PixelData||pixel.vr()!=VR.OB||pixel.length()!=-1)
                        problem(issues,"ENCAPSULATED_PIXEL_HEADER","dataset/"+tag(pixel.tag()),"Encapsulated Pixel Data requires tag 7FE00010, OB VR and undefined value length","PS3.5 8.2/A.4");
                    checks.put("pixelStructure",new Check(issues.size()==before?"PASS":"FAIL","Encapsulated header only; compressed codestream not assessed"));
                }else{
                    if(pixel.length()<0)problem(issues,"NATIVE_UNDEFINED_PIXEL_LENGTH","dataset/"+tag(pixel.tag()),"Native Pixel Data must have an explicit value length","PS3.5 8.1");
                    int bits=data.getInt(Tag.BitsAllocated,-1);
                    if(pixel.tag()==Tag.FloatPixelData&&(pixel.vr()!=VR.OF||bits!=32)||pixel.tag()==Tag.DoubleFloatPixelData&&(pixel.vr()!=VR.OD||bits!=64))
                        problem(issues,"FLOAT_PIXEL_ENCODING","dataset/"+tag(pixel.tag()),"Float and Double Float Pixel Data require OF/32-bit and OD/64-bit respectively","PS3.5 8.1/C.7.6.24/C.7.6.25");
                    if(pixel.tag()==Tag.PixelData&&(bits>8?pixel.vr()!=VR.OW:pixel.vr()!=VR.OB&&pixel.vr()!=VR.OW))
                        problem(issues,"NATIVE_PIXEL_VR","dataset/"+tag(pixel.tag()),"Native integer pixels require OB or OW; samples greater than 8 bits require OW","PS3.5 8.1.1");
                    expected=nativeLength(data,issues);
                    if(expected!=null&&pixel.length()>=0&&pixel.length()!=expected)
                        problem(issues,"NATIVE_PIXEL_LENGTH_MISMATCH","dataset/"+tag(pixel.tag()),"Encoded native pixel length differs from dimensions, samples, allocated bits and frame count (including final even-length padding)","PS3.5 8.1.1; PS3.3 C.7.6.3.1.2");
                    checks.put("pixelStructure",new Check(issues.size()>before?"FAIL":expected==null?"UNKNOWN":"PASS","Native encoded length and VR; no decoded-image or calibration claim"));
                }
            }
        }catch(Exception failure){
            checks.put("readability",new Check("FAIL","Dataset parse or bounded structural scan failed"));
            problem(issues,"STRUCTURAL_PARSE_FAILURE","dataset","Dataset could not be parsed within structural scan limits","PS3.5 7/PS3.10 7");
        }
        String status=checks.values().stream().anyMatch(c->c.status().equals("FAIL"))?"FAIL":checks.values().stream().anyMatch(c->c.status().equals("UNKNOWN"))?"UNKNOWN":"PASS";
        return new Image(attachment,sourcePath,sha,uid,status,Collections.unmodifiableMap(checks),expected,supplied,List.copyOf(issues));
    }
    private static Long nativeLength(Attributes attrs,List<Issue> issues){
        try{
            long rows=attrs.getInt(Tag.Rows,-1),columns=attrs.getInt(Tag.Columns,-1),samples=attrs.getInt(Tag.SamplesPerPixel,-1),bits=attrs.getInt(Tag.BitsAllocated,-1);
            long frames=attrs.contains(Tag.NumberOfFrames)?Long.parseLong(attrs.getString(Tag.NumberOfFrames).trim()):1;
            if(rows<1||columns<1||samples<1||frames<1||!(bits==1||bits>=8&&bits%8==0))throw new IllegalArgumentException();
            String photo=attrs.getString(Tag.PhotometricInterpretation,"");
            if(photo.equals("YBR_FULL_422")){
                if(samples!=3||attrs.getInt(Tag.PlanarConfiguration,-1)!=0||bits==1)throw new IllegalArgumentException();
                samples=2;
            }else if(photo.equals("YBR_PARTIAL_420")||photo.equals("YBR_PARTIAL_422"))return null;
            long bitCount=Math.multiplyExact(Math.multiplyExact(Math.multiplyExact(Math.multiplyExact(rows,columns),samples),bits),frames);
            long count=Math.addExact(bitCount,7)/8;
            return Math.addExact(count,count&1);
        }catch(RuntimeException invalid){
            problem(issues,"INVALID_NATIVE_PIXEL_DIMENSIONS","dataset","Native byte length cannot be computed safely from the supplied dimensions, frame count and bit allocation","PS3.5 8.1.1; PS3.3 C.7.6.3");return null;
        }
    }
    private static IOD rules(String sop){
        IOD result=new IOD();
        optional(result,Tag.PatientSex,VR.CS,1,1).setValues("M","F","O");
        optional(result,Tag.BurnedInAnnotation,VR.CS,1,1).setValues("YES","NO");
        optional(result,Tag.LossyImageCompression,VR.CS,1,1).setValues("00","01");
        if(SC.contains(sop)){required(result,Tag.ConversionType,VR.CS,1,1,1);return result;}
        required(result,Tag.ImageType,VR.CS,1,2,-1);
        required(result,Tag.PixelSpacing,VR.DS,1,2,2);required(result,Tag.ImagePositionPatient,VR.DS,1,3,3);required(result,Tag.ImageOrientationPatient,VR.DS,1,6,6);required(result,Tag.SliceThickness,VR.DS,2,1,1);
        if(sop.equals(UID.CTImageStorage)){
            required(result,Tag.RescaleSlope,VR.DS,1,1,1);required(result,Tag.RescaleIntercept,VR.DS,1,1,1);
        }else{
            required(result,Tag.ScanningSequence,VR.CS,1,1,-1).setValues("SE","IR","GR","EP","RM");
            required(result,Tag.SequenceVariant,VR.CS,1,1,-1);required(result,Tag.ScanOptions,VR.CS,2,1,-1);
            required(result,Tag.MRAcquisitionType,VR.CS,2,1,1).setValues("2D","3D");
        }
        return result;
    }
    private static IOD.DataElement optional(IOD rules,int tag,VR vr,int min,int max){var element=new IOD.DataElement(tag,vr,IOD.DataElementType.TYPE_3,min,max,0);rules.add(element);return element;}
    private static IOD.DataElement required(IOD rules,int tag,VR vr,int type,int min,int max){var element=new IOD.DataElement(tag,vr,type==1?IOD.DataElementType.TYPE_1:IOD.DataElementType.TYPE_2,min,max,0);rules.add(element);return element;}
    private static void findings(List<Issue> issues,int[] tags,String code,String message){for(int tag:tags)problem(issues,code,"dataset/"+tag(tag),message,"Selected PS3.3 C.7.6.2/C.8.2.1/C.8.3.1/C.8.6.1 rules; dcm4che Attributes.validate");}
    private static void problem(List<Issue> issues,String code,String path,String message,String spec){issues.add(new Issue("ERROR",code,path,message,spec));}
    private static String tag(int tag){return String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff);}
    private static final class Headers implements DicomInputHandler {
        final Map<Attributes,List<Pixel>> pixels=new IdentityHashMap<>();int count;
        private void bound(DicomInputStream input)throws IOException{
            long length=input.unsignedLength(),position=input.getPosition();
            if(++count>200000||input.level()>64)throw new IOException("Structural scan limit");
        }
        @Override public void readValue(DicomInputStream input,Attributes attrs)throws IOException{
            bound(input);int tag=input.tag();
            if(tag==Tag.PixelData||tag==Tag.FloatPixelData||tag==Tag.DoubleFloatPixelData)pixels.computeIfAbsent(attrs,key->new ArrayList<>()).add(new Pixel(tag,input.vr(),input.length()==-1?-1:input.unsignedLength()));
            input.readValue(input,attrs);
        }
        @Override public void readValue(DicomInputStream input,Sequence sequence)throws IOException{bound(input);input.readValue(input,sequence);}
        @Override public void readValue(DicomInputStream input,Fragments fragments)throws IOException{bound(input);input.readValue(input,fragments);}
        @Override public void startDataset(DicomInputStream input){}
        @Override public void endDataset(DicomInputStream input){}
    }
}
