package digital.thinkbox.dicompdf;

import com.google.gson.GsonBuilder;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;

/** Explicitly scoped DICOM 2026d input checks; preservation never rewrites a failing source. */
final class DicomValidation {
    private DicomValidation() {}
    static final String EDITION = "2026d";
    private static final String FILE_SPEC = "PS3.10 7.1/Table 7.1-1", VALUE_SPEC = "PS3.5 6.2/6.4/9.1";
    private static final Set<String> IMAGE_CLASSES = imageClasses();
    private static final int MAX_ELEMENTS = 200_000, MAX_DEPTH = 64;
    record Issue(String severity, String code, String path, String message, String specification) {}
    record Image(String attachment, String sourcePath, String sha256, String sopInstanceUID, String status, List<Issue> issues) {}
    record Inventory(int schemaVersion, String standardEdition, boolean fullIodValidation, List<String> checked,
                     List<String> notAssessed, List<Image> images) {}
    private record RawMeta(VR vr, int offset, int length) {}

    static Inventory capture(List<Manifest.Image> images, Map<String,?> originals) throws Exception {
        return capture(images,originals,false);
    }
    static Inventory captureLegacy(List<Manifest.Image> images,Map<String,?> originals)throws Exception{return capture(images,originals,true);}
    private static Inventory capture(List<Manifest.Image> images,Map<String,?> originals,boolean legacy)throws Exception{
        List<Image> result = new ArrayList<>();
        for (var image : images) result.add(inspect(image.attachment(), image.sourcePath(), originals.get(image.attachment()),legacy));
        return new Inventory(legacy?1:2, EDITION, false,
                List.of("Part 10 prefix, file-meta encoding/required attributes/group length and identities",
                        "Common Patient/General Study/General Series mandatory attributes for recognized composite image classes",
                        "SOP/Study/Series and supplied nested UID lexical syntax; selected VR/VM and numeric value constraints",
                        "Integer/float Image Pixel structure, pixel dimensions, spacing and supplied patient-plane geometry",
                        "Shared/per-frame functional-group item counts and mutual exclusion"),
                List.of("Complete SOP-class IOD/module/conditional requirements and coded terminology",
                        "All VR syntax/VM constraints, private dictionaries and semantic UID registration",
                        "Compressed codestream conformance, clinical correctness, calibration and de-identification"), List.copyOf(result));
    }
    static byte[] bytes(Inventory inventory) throws IOException {
        byte[] bytes = new GsonBuilder().serializeNulls().setPrettyPrinting().disableHtmlEscaping().create()
                .toJson(inventory).getBytes(StandardCharsets.UTF_8);
        return bytes;
    }
    static Image inspect(String attachment, String sourcePath, Object content) throws Exception {
        return inspect(attachment,sourcePath,content,false);
    }
    private static Image inspect(String attachment,String sourcePath,Object content,boolean legacy)throws Exception{
        var source=SourceContent.of(content);
        if (source == null) throw new IOException("Original bytes unavailable for DICOM validation: " + attachment);
        String hash = source.digest().sha256();
        byte[] bytes=fileMetaPrefix(source);
        List<Issue> issues = new ArrayList<>();
        boolean prefix = bytes.length >= 132 && bytes[128]=='D' && bytes[129]=='I' && bytes[130]=='C' && bytes[131]=='M';
        boolean recognizable = prefix || bytes.length >= 136 && u16(bytes,132)==2 || bytes.length>=8 && u16(bytes,0)==2;
        if (!recognizable) {
            issue(issues,"WARNING","NOT_PART10","file", "No recognizable DICOM Part 10 header; original retained and not assessed as a DICOM instance",FILE_SPEC);
            return new Image(attachment,sourcePath,hash,null,"NOT_DICOM",List.copyOf(issues));
        }
        if (!prefix) issue(issues,"ERROR","MISSING_DICM_PREFIX","file/prefix","A Part 10 file requires its 128-byte preamble followed by DICM",FILE_SPEC);
        if (prefix && executablePreamble(bytes)) issue(issues,"WARNING","EXECUTABLE_LIKE_PREAMBLE","file/preamble",
                "Preamble begins with an executable signature; preserved unchanged and never executed","PS3.10 7.5");
        Map<Integer,RawMeta> rawMeta = rawMeta(bytes,prefix?132:u16(bytes,0)==2?0:132,issues);
        validateRawMeta(bytes,rawMeta,issues);
        String uid = null;
        try (var input = new DicomInputStream(source.open())) {
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            if(!legacy)input.setBulkDataDescriptor((items,creator,tag,vr,length)->tag!=Tag.PixelDataProviderURL&&BulkDataDescriptor.DEFAULT.isBulkData(items,creator,tag,vr,length));
            Map<Attributes,Set<Integer>> pixelOwners = new IdentityHashMap<>();
            input.setDicomInputHandler(new PixelPresence(pixelOwners));
            Attributes meta = input.readFileMetaInformation();
            if (meta == null) throw new IOException("File-meta information cannot be read");
            Attributes data = input.readDataset(); uid = data.getString(Tag.SOPInstanceUID);
            boolean directory = UID.MediaStorageDirectoryStorage.equals(meta.getString(Tag.MediaStorageSOPClassUID));
            if (!directory) {
                required(data,Tag.SOPClassUID,1,"dataset",issues,"PS3.3 C.12.1 SOP Common Module");
                required(data,Tag.SOPInstanceUID,1,"dataset",issues,"PS3.3 C.12.1 SOP Common Module");
                same(meta,Tag.MediaStorageSOPClassUID,data,Tag.SOPClassUID,issues);
                same(meta,Tag.MediaStorageSOPInstanceUID,data,Tag.SOPInstanceUID,issues);
            }
            String sop = meta.getString(Tag.MediaStorageSOPClassUID);
            if (IMAGE_CLASSES.contains(sop)) commonImageModules(data,issues,legacy);
            else if (!directory) issue(issues,"WARNING","IOD_SCOPE_NOT_ASSESSED","dataset",
                    "Common image module requirements are not assessed for this non-image or unrecognized SOP class", "PS3.3/PS3.4");
            int[] count = {0}; walk(meta,"fileMeta",issues,0,count); walk(data,"dataset",issues,0,count);
            if (IMAGE_CLASSES.contains(sop) || data.contains(Tag.Rows) || data.contains(Tag.Columns)) imagePixel(data,pixelOwners.getOrDefault(data,Set.of()),issues,legacy);
            functionalGroups(data,issues);
        } catch (Exception e) {
            issue(issues,"ERROR","DATASET_PARSE_FAILURE","dataset",e.getMessage()==null?e.getClass().getSimpleName():e.getMessage(),"PS3.5 7/PS3.10 7.2");
        }
        return new Image(attachment,sourcePath,hash,uid,issues.stream().anyMatch(i->i.severity().equals("ERROR"))?"FAIL":"PASS",List.copyOf(issues));
    }
    private static void commonImageModules(Attributes attrs,List<Issue> issues,boolean legacy) {
        for (int tag : new int[]{Tag.PatientName,Tag.PatientID,Tag.PatientBirthDate,Tag.PatientSex}) required(attrs,tag,2,"dataset",issues,"PS3.3 C.7.1.1/Table C.7-1");
        required(attrs,Tag.StudyInstanceUID,1,"dataset",issues,"PS3.3 C.7.2.1/Table C.7-3");
        for (int tag : new int[]{Tag.StudyDate,Tag.StudyTime,Tag.ReferringPhysicianName,Tag.StudyID,Tag.AccessionNumber}) required(attrs,tag,2,"dataset",issues,"PS3.3 C.7.2.1/Table C.7-3");
        String sop=attrs.getString(Tag.SOPClassUID,"");
        boolean secondaryCapture=Set.of(UID.SecondaryCaptureImageStorage,UID.MultiFrameSingleBitSecondaryCaptureImageStorage,UID.MultiFrameGrayscaleByteSecondaryCaptureImageStorage,UID.MultiFrameGrayscaleWordSecondaryCaptureImageStorage,UID.MultiFrameTrueColorSecondaryCaptureImageStorage).contains(sop);
        if(legacy||!secondaryCapture)required(attrs,Tag.Modality,1,"dataset",issues,"PS3.3 C.7.3.1/Table C.7-5a");
        required(attrs,Tag.SeriesInstanceUID,1,"dataset",issues,"PS3.3 C.7.3.1/Table C.7-5a");
        required(attrs,Tag.SeriesNumber,2,"dataset",issues,"PS3.3 C.7.3.1/Table C.7-5a");
    }
    private static void required(Attributes attrs,int tag,int type,String parent,List<Issue> issues,String specification) {
        if (!attrs.contains(tag)) issue(issues,"ERROR","MISSING_TYPE_"+type,parent+"/"+tag(tag),"Required Type "+type+" attribute "+keyword(tag)+" is absent",specification);
        else if (type==1 && !attrs.containsValue(tag)) issue(issues,"ERROR","EMPTY_TYPE_1",parent+"/"+tag(tag),"Type 1 "+keyword(tag)+" requires a nonempty value",specification);
    }
    private static void same(Attributes meta,int headerTag,Attributes data,int datasetTag,List<Issue> issues) {
        String a=meta.getString(headerTag), b=data.getString(datasetTag);
        if (a!=null && b!=null && !a.equals(b)) issue(issues,"ERROR","FILE_META_IDENTITY_MISMATCH","fileMeta/"+tag(headerTag),
                keyword(headerTag)+" differs from dataset "+keyword(datasetTag),FILE_SPEC);
    }
    private static final int MAX_FILE_META_PREFIX=1024*1024;
    private static final Set<String> LONG_VRS=Set.of("OB","OD","OF","OL","OV","OW","SQ","UC","UN","UR","UT","SV","UV");
    private static boolean longHeader(VR vr,String encoded){return vr==null || LONG_VRS.contains(encoded);}
    private static byte[] fileMetaPrefix(SourceContent source)throws IOException {
        try(var stream=new BufferedInputStream(source.open())){
            stream.mark(136);
            byte[] preamble=stream.readNBytes(136);
            boolean prefix=preamble.length>=132 && preamble[128]=='D' && preamble[129]=='I' && preamble[130]=='C' && preamble[131]=='M';
            int start;
            if(prefix)start=132;
            else if(preamble.length>=8 && u16(preamble,0)==2)start=0;
            else if(preamble.length>=136 && u16(preamble,132)==2)start=132;
            else return preamble;
            stream.reset();
            var bytes=new ByteArrayOutputStream();
            bytes.write(stream.readNBytes(start));
            while(bytes.size()<MAX_FILE_META_PREFIX){
                byte[] header=stream.readNBytes(Math.min(8,MAX_FILE_META_PREFIX-bytes.size()));
                bytes.write(header);
                if(header.length<8 || u16(header,0)!=2)break;
                String encoded=new String(header,4,2,StandardCharsets.US_ASCII);
                VR vr;
                try{vr=VR.valueOf(encoded);}catch(IllegalArgumentException e){vr=null;}
                long length;
                if(longHeader(vr,encoded)){
                    byte[] extra=stream.readNBytes(Math.min(4,MAX_FILE_META_PREFIX-bytes.size()));
                    bytes.write(extra);
                    if(extra.length<4)break;
                    length=u32(extra,0);
                }else length=u16(header,6);
                int requested=(int)Math.min(length,MAX_FILE_META_PREFIX-bytes.size());
                byte[] value=stream.readNBytes(requested);
                bytes.write(value);
                if(value.length!=length)break;
            }
            return bytes.toByteArray();
        }
    }
    private static Map<Integer,RawMeta> rawMeta(byte[] bytes,int at,List<Issue> issues) {
        Map<Integer,RawMeta> result = new LinkedHashMap<>(); int last = -1;
        try {
            while (at+8<=bytes.length && u16(bytes,at)==2) {
                int tag = u16(bytes,at)<<16 | u16(bytes,at+2);
                String encoded = new String(bytes,at+4,2,StandardCharsets.US_ASCII); VR vr;
                try { vr=VR.valueOf(encoded); } catch (IllegalArgumentException e) { vr=null; }
                boolean longLength = longHeader(vr,encoded);
                int header = longLength?12:8;
                if (at+header>bytes.length) throw new IOException("Truncated file-meta element header");
                long length = longLength?u32(bytes,at+8):u16(bytes,at+6);
                if (length>Integer.MAX_VALUE || at+(long)header+length>bytes.length) throw new IOException("Truncated or invalid file-meta element length");
                if ((length&1)!=0) issue(issues,"ERROR","ODD_VALUE_LENGTH","fileMeta/"+tag(tag),"File-meta value length must be even","PS3.5 7.1.2");
                if (longLength && (bytes[at+6]!=0 || bytes[at+7]!=0)) issue(issues,"ERROR","RESERVED_BYTES","fileMeta/"+tag(tag),"Explicit-VR reserved bytes must be zero","PS3.5 7.1.2");
                if (vr==VR.UN) issue(issues,"ERROR","UNKNOWN_VR_IN_FILE_META","fileMeta/"+tag(tag),"UN is prohibited in File Meta Information",FILE_SPEC);
                if (last>=tag) issue(issues,"ERROR","FILE_META_TAG_ORDER","fileMeta/"+tag(tag),"File-meta tags must be unique and in increasing order","PS3.5 7.1");
                last=tag; result.put(tag,new RawMeta(vr,at+header,(int)length)); at+=header+(int)length;
            }
            RawMeta group=result.get(Tag.FileMetaInformationGroupLength);
            if (group!=null && group.length()==4 && u32(bytes,group.offset())!=at-group.offset()-4L) issue(issues,"ERROR","FILE_META_GROUP_LENGTH","fileMeta/"+tag(Tag.FileMetaInformationGroupLength),"Declared group length differs from the actual encoded group 0002 bytes",FILE_SPEC);
        } catch (Exception e) { issue(issues,"ERROR","FILE_META_ENCODING","fileMeta",e.getMessage(),FILE_SPEC); }
        return result;
    }
    private static void validateRawMeta(byte[] bytes,Map<Integer,RawMeta> meta,List<Issue> issues) {
        Map<Integer,VR> required = new LinkedHashMap<>();
        required.put(Tag.FileMetaInformationGroupLength,VR.UL); required.put(Tag.FileMetaInformationVersion,VR.OB);
        for (int tag : new int[]{Tag.MediaStorageSOPClassUID,Tag.MediaStorageSOPInstanceUID,Tag.TransferSyntaxUID,Tag.ImplementationClassUID}) required.put(tag,VR.UI);
        for (var entry : required.entrySet()) {
            RawMeta raw=meta.get(entry.getKey()); String path="fileMeta/"+tag(entry.getKey());
            if (raw==null) {issue(issues,"ERROR","MISSING_FILE_META_ATTRIBUTE",path,"Required file-meta "+keyword(entry.getKey())+" is absent",FILE_SPEC);continue;}
            if (raw.vr()!=entry.getValue()) issue(issues,"ERROR","FILE_META_VR",path,"Expected explicit VR "+entry.getValue(),FILE_SPEC);
            if (raw.length()==0) issue(issues,"ERROR","EMPTY_TYPE_1",path,"Required file-meta attribute must have a value",FILE_SPEC);
            if (entry.getValue()==VR.UI) {
                String value=new String(bytes,raw.offset(),raw.length(),StandardCharsets.US_ASCII).replaceAll("\\x00$","");
                if (!validUid(value)) issue(issues,"ERROR","INVALID_UID",path,"Invalid UID syntax, component padding or length",VALUE_SPEC);
            }
        }
        RawMeta group=meta.get(Tag.FileMetaInformationGroupLength);
        if (group!=null && group.length()!=4) issue(issues,"ERROR","FILE_META_GROUP_LENGTH","fileMeta/"+tag(Tag.FileMetaInformationGroupLength),"File-meta group length must contain one 32-bit UL",FILE_SPEC);
        RawMeta version=meta.get(Tag.FileMetaInformationVersion);
        if (version!=null && (version.length()!=2 || (bytes[version.offset()+1]&1)==0)) issue(issues,"ERROR","UNSUPPORTED_FILE_META_VERSION","fileMeta/"+tag(Tag.FileMetaInformationVersion),"File-meta version must be two bytes with bit 0 of its second byte set",FILE_SPEC);
    }
    private static void walk(Attributes attrs,String parent,List<Issue> issues,int depth,int[] count) throws IOException {
        if (depth>MAX_DEPTH) throw new IOException("Validation sequence depth exceeds 64; remaining attributes are unassessed");
        for (int number : attrs.tags()) {
            if (++count[0]>MAX_ELEMENTS) throw new IOException("Validation element limit exceeded; remaining attributes are unassessed");
            String path=parent+"/"+tag(number); VR vr=attrs.getVR(number);
            if (vr==VR.SQ) {
                var sequence=attrs.getSequence(number);
                if (sequence!=null) for (int i=0;i<sequence.size();i++) walk(sequence.get(i),path+"["+(i+1)+"]",issues,depth+1,count);
                continue;
            }
            if (vr==VR.UI) for (String value : strings(attrs,number)) if (!value.isEmpty() && !validUid(value)) issue(issues,"ERROR","INVALID_UID",path,"Invalid UID syntax, component padding or length",VALUE_SPEC);
            if (vr==VR.DS) for (String value : strings(attrs,number)) if (!value.isEmpty() && (value.length()>16 || !decimal(value))) issue(issues,"ERROR","INVALID_DS",path,"DS values require decimal syntax and at most 16 characters",VALUE_SPEC);
            if (vr==VR.IS) for (String value : strings(attrs,number)) if (!value.isEmpty()) {
                if (value.length()>12 || !value.matches(" *[+\\-]?[0-9]+ *")) issue(issues,"ERROR","INVALID_IS",path,"IS values require signed integer syntax and at most 12 characters",VALUE_SPEC);
                else {
                    long integer=Long.parseLong(value.trim());
                    if (integer<Integer.MIN_VALUE || integer>Integer.MAX_VALUE) issue(issues,"ERROR","IS_VALUE_RANGE",path,"IS value is outside the signed 32-bit range",VALUE_SPEC);
                }
            }
            if (vr==VR.CS) for (String value : strings(attrs,number)) if (value.length()>16 || !value.matches("[A-Z0-9 _]*")) issue(issues,"ERROR","INVALID_CS",path,"CS values allow uppercase letters, digits, spaces and underscores, maximum 16 characters",VALUE_SPEC);
            if (!parent.startsWith("fileMeta") && number>>>16==2) issue(issues,"ERROR","FILE_META_IN_DATASET",path,"Group 0002 file-meta attributes are prohibited inside a dataset","PS3.10 7.2");
            selectedVrVm(attrs,number,path,issues);
        }
    }
    private static void selectedVrVm(Attributes attrs,int tag,String path,List<Issue> issues) {
        int min=1,max=1; VR expected=null;
        if (Set.of(Tag.PatientName,Tag.ReferringPhysicianName).contains(tag)) expected=VR.PN;
        else if (Set.of(Tag.PatientID,Tag.StudyID,Tag.AccessionNumber).contains(tag)) expected=tag==Tag.PatientID?VR.LO:VR.SH;
        else if (Set.of(Tag.PatientBirthDate,Tag.StudyDate).contains(tag)) expected=VR.DA;
        else if (tag==Tag.StudyTime) expected=VR.TM;
        else if (Set.of(Tag.PatientSex,Tag.Modality,Tag.PhotometricInterpretation).contains(tag)) expected=VR.CS;
        else if (Set.of(Tag.Rows,Tag.Columns,Tag.SamplesPerPixel,Tag.PlanarConfiguration,Tag.BitsAllocated,Tag.BitsStored,Tag.HighBit,Tag.PixelRepresentation).contains(tag)) expected=VR.US;
        else if (Set.of(Tag.SeriesNumber,Tag.InstanceNumber,Tag.NumberOfFrames).contains(tag)) expected=VR.IS;
        else if (Set.of(Tag.StudyInstanceUID,Tag.SeriesInstanceUID,Tag.SOPClassUID,Tag.SOPInstanceUID,Tag.FrameOfReferenceUID,Tag.ReferencedSOPClassUID,Tag.ReferencedSOPInstanceUID,Tag.MediaStorageSOPClassUID,Tag.MediaStorageSOPInstanceUID,Tag.TransferSyntaxUID,Tag.ImplementationClassUID).contains(tag)) expected=VR.UI;
        else if (Set.of(Tag.PixelSpacing,Tag.ImagerPixelSpacing,Tag.NominalScannedPixelSpacing).contains(tag)) {expected=VR.DS;min=max=2;}
        else if (tag==Tag.PixelAspectRatio) {expected=VR.IS;min=max=2;}
        else if (tag==Tag.ImagePositionPatient) {expected=VR.DS;min=max=3;}
        else if (tag==Tag.ImageOrientationPatient) {expected=VR.DS;min=max=6;}
        else if (Set.of(Tag.WindowCenter,Tag.WindowWidth).contains(tag)) {expected=VR.DS;max=Integer.MAX_VALUE;}
        else if (Set.of(Tag.RescaleSlope,Tag.RescaleIntercept).contains(tag)) expected=VR.DS;
        else if (tag==Tag.ImageType) {expected=VR.CS;min=2;max=Integer.MAX_VALUE;}
        if (expected==null) return;
        if (attrs.getVR(tag)!=expected) issue(issues,"ERROR","VR_MISMATCH",path,"Expected "+expected+" for "+keyword(tag),"PS3.6 2026d registry");
        if (attrs.containsValue(tag)) {
            int vm;
            try {vm=attrs.getStrings(tag).length;} catch (RuntimeException e) {issue(issues,"ERROR","VALUE_DECODE",path,"Value cannot be decoded with its VR",VALUE_SPEC);return;}
            if (vm<min || vm>max) issue(issues,"ERROR","VM_MISMATCH",path,"Expected VM "+min+(max==min?"":"-n"),"PS3.6 2026d registry");
        }
    }
    private static void imagePixel(Attributes attrs,Set<Integer> pixels,List<Issue> issues,boolean legacy) {
        String spec="PS3.3 C.7.6.3/Table C.7-11";
        for (int tag : new int[]{Tag.SamplesPerPixel,Tag.PhotometricInterpretation,Tag.Rows,Tag.Columns,Tag.BitsAllocated}) required(attrs,tag,1,"dataset",issues,spec);
        boolean floating=pixels.contains(Tag.FloatPixelData)||pixels.contains(Tag.DoubleFloatPixelData);
        if (!floating) for (int tag : new int[]{Tag.BitsStored,Tag.HighBit,Tag.PixelRepresentation}) required(attrs,tag,1,"dataset",issues,spec);
        if (pixels.isEmpty()&&(legacy||!attrs.containsValue(Tag.PixelDataProviderURL))) issue(issues,"ERROR","MISSING_PIXEL_DATA","dataset", "Image has no supplied Pixel Data, Float Pixel Data or Double Float Pixel Data element",spec);
        if (pixels.size()>1) issue(issues,"ERROR","MULTIPLE_PIXEL_DATA_ELEMENTS","dataset","Pixel Data, Float Pixel Data and Double Float Pixel Data are mutually exclusive",spec);
        int rows=integer(attrs,Tag.Rows,-1),columns=integer(attrs,Tag.Columns,-1),allocated=integer(attrs,Tag.BitsAllocated,-1),stored=integer(attrs,Tag.BitsStored,-1),high=integer(attrs,Tag.HighBit,-1),signed=integer(attrs,Tag.PixelRepresentation,-1),samples=integer(attrs,Tag.SamplesPerPixel,-1);
        if (rows<=0 || columns<=0) issue(issues,"ERROR","INVALID_DIMENSIONS","dataset","Rows and Columns must both be positive",spec);
        if (!(allocated==1 || allocated>0 && allocated%8==0)) issue(issues,"ERROR","INVALID_BITS_ALLOCATED","dataset/"+tag(Tag.BitsAllocated),"Bits Allocated must be 1 or a positive multiple of 8","PS3.5 8.1.1");
        if (!floating && (stored<1 || stored>allocated || high!=stored-1 || signed<0 || signed>1)) issue(issues,"ERROR","INVALID_PIXEL_BIT_LAYOUT","dataset","Bits Stored/High Bit/Pixel Representation are inconsistent","PS3.5 8.1.1");
        if (samples>1) {required(attrs,Tag.PlanarConfiguration,1,"dataset",issues,spec);int planar=integer(attrs,Tag.PlanarConfiguration,-1);if(planar<0||planar>1)issue(issues,"ERROR","INVALID_PLANAR_CONFIGURATION","dataset/"+tag(Tag.PlanarConfiguration),"Planar Configuration must be 0 or 1",spec);}
        String photo=attrs.getString(Tag.PhotometricInterpretation,"");
        if (Set.of("MONOCHROME1","MONOCHROME2","PALETTE COLOR").contains(photo) && samples!=1 || Set.of("RGB","YBR_FULL","YBR_FULL_422","YBR_PARTIAL_422","YBR_PARTIAL_420","YBR_ICT","YBR_RCT","HSV").contains(photo) && samples!=3) issue(issues,"ERROR","PHOTOMETRIC_SAMPLES","dataset/"+tag(Tag.PhotometricInterpretation),"Photometric Interpretation and Samples per Pixel disagree",spec);
        for (int tag : new int[]{Tag.PixelSpacing,Tag.ImagerPixelSpacing,Tag.NominalScannedPixelSpacing,Tag.PixelAspectRatio}) {
            double[] values=values(attrs,tag); if(values==null)continue;
            for(int i=0;i<values.length;i++) if (!Double.isFinite(values[i]) || values[i]<0 || values[i]==0 && (tag==Tag.PixelAspectRatio || i==0&&rows!=1 || i==1&&columns!=1)) issue(issues,"ERROR","INVALID_SPACING","dataset/"+tag(tag),"Spacing/aspect values must be positive, except zero spacing along a single-pixel dimension","PS3.3 10.7.1.3/C.7.6.3.1.7");
        }
        double[] orientation=values(attrs,Tag.ImageOrientationPatient);
        if (orientation!=null && orientation.length==6) {
            double a=0,b=0,dot=0;for(int i=0;i<3;i++){a+=orientation[i]*orientation[i];b+=orientation[i+3]*orientation[i+3];dot+=orientation[i]*orientation[i+3];}
            if (!Double.isFinite(a+b+dot)||Math.abs(a-1)>0.0001||Math.abs(b-1)>0.0001||Math.abs(dot)>0.0001) issue(issues,"ERROR","INVALID_ORIENTATION","dataset/"+tag(Tag.ImageOrientationPatient),"Direction-cosine vectors must be orthogonal unit vectors","PS3.3 C.7.6.2.1.1");
        }
    }
    private static void functionalGroups(Attributes attrs,List<Issue> issues) {
        String spec="PS3.3 C.7.6.16.1.1/C.7.6.16.1.2";
        Sequence shared=attrs.getSequence(Tag.SharedFunctionalGroupsSequence), per=attrs.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        if (shared!=null || per!=null) {
            for (int tag : new int[]{Tag.SharedFunctionalGroupsSequence,Tag.NumberOfFrames,Tag.InstanceNumber,Tag.ContentDate,Tag.ContentTime}) required(attrs,tag,1,"dataset",issues,"PS3.3 Table C.7.6.16-1");
        }
        if (shared!=null && shared.size()!=1) issue(issues,"ERROR","SHARED_FUNCTIONAL_GROUP_COUNT","dataset/"+tag(Tag.SharedFunctionalGroupsSequence),"Shared Functional Groups Sequence requires exactly one Item",spec);
        long frames=1;
        if (attrs.contains(Tag.NumberOfFrames)) try {frames=Long.parseLong(attrs.getString(Tag.NumberOfFrames));if(frames<1)throw new NumberFormatException();}catch(RuntimeException e){issue(issues,"ERROR","INVALID_NUMBER_OF_FRAMES","dataset/"+tag(Tag.NumberOfFrames),"Number of Frames must be a positive integer",spec);frames=-1;}
        if (per!=null && per.size()!=frames) issue(issues,"ERROR","PER_FRAME_FUNCTIONAL_GROUP_COUNT","dataset/"+tag(Tag.PerFrameFunctionalGroupsSequence),"Per-frame Item count must equal Number of Frames",spec);
        Set<Integer> sharedTags=new HashSet<>();
        if (shared!=null) for (Attributes item:shared) for (int tag:item.tags()) {
            sharedTags.add(tag);checkFunctionalGroup(item,tag,"dataset/"+tag(Tag.SharedFunctionalGroupsSequence)+"[1]",issues,spec);
        }
        if (per!=null) for (int i=0;i<per.size();i++) {
            Attributes item=per.get(i);String path="dataset/"+tag(Tag.PerFrameFunctionalGroupsSequence)+"["+(i+1)+"]";
            for(int tag:item.tags()) {
                if(sharedTags.contains(tag))issue(issues,"ERROR","SHARED_PER_FRAME_GROUP_OVERLAP",path+"/"+tag(tag),"The same functional group cannot occur in both Shared and Per-Frame Functional Groups",spec);
                checkFunctionalGroup(item,tag,path,issues,spec);
            }
        }
    }
    private static void checkFunctionalGroup(Attributes attrs,int tag,String parent,List<Issue> issues,String spec) {
        if ((tag&0xffff)==0 || (tag>>>16&1)!=0 && (tag&0xffff)<0x1000) return;
        if (attrs.getVR(tag)!=VR.SQ) issue(issues,"ERROR","FUNCTIONAL_GROUP_NOT_SEQUENCE",parent+"/"+tag(tag),"A functional group must be represented by a Sequence",spec);
        else {
            Sequence sequence=attrs.getSequence(tag);
            boolean single=Set.of(Tag.PixelMeasuresSequence,Tag.FrameContentSequence,Tag.PlanePositionSequence,Tag.PlaneOrientationSequence,Tag.PixelValueTransformationSequence,Tag.FrameVOILUTSequence,Tag.FrameAnatomySequence).contains(tag);
            if(single&&sequence!=null&&sequence.size()!=1)issue(issues,"ERROR","FUNCTIONAL_GROUP_ITEM_COUNT",parent+"/"+tag(tag),"This functional-group macro requires exactly one Item",spec);
            if (sequence!=null && sequence.size()==1 && tag==Tag.PixelValueTransformationSequence)
                for (int child : new int[]{Tag.RescaleSlope,Tag.RescaleIntercept,Tag.RescaleType}) required(sequence.getFirst(),child,1,parent+"/"+tag(tag)+"[1]",issues,"PS3.3 C.7.6.16.2.9/Table C.7.6.16-10");
            if (sequence!=null && sequence.size()==1 && tag==Tag.FrameVOILUTSequence)
                for (int child : new int[]{Tag.WindowCenter,Tag.WindowWidth}) required(sequence.getFirst(),child,1,parent+"/"+tag(tag)+"[1]",issues,"PS3.3 C.7.6.16.2.10/Table C.7.6.16-11");
        }
    }
    static boolean validUid(String uid) {
        if (uid==null || uid.isEmpty() || uid.length()+(uid.length()&1)>64 || !uid.matches("[012](\\.(0|[1-9][0-9]*))+")) return false;
        String[] parts=uid.split("\\.");
        return parts[0].equals("2") || parts[1].length()<3 && Integer.parseInt(parts[1])<=39;
    }
    private static List<String> strings(Attributes attrs,int tag) {String[] values=attrs.getStrings(tag);return values==null?List.of():Arrays.asList(values);}
    private static boolean decimal(String text) {return text.matches(" *[+\\-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+\\-]?[0-9]+)? *");}
    private static double[] values(Attributes attrs,int tag) {try{String[] strings=attrs.getStrings(tag);if(strings==null||strings.length==0)return null;double[] result=new double[strings.length];for(int i=0;i<strings.length;i++)result[i]=Double.parseDouble(strings[i]);return result;}catch(RuntimeException e){return new double[]{Double.NaN};}}
    private static int integer(Attributes attrs,int tag,int fallback) {try{return attrs.getInt(tag,fallback);}catch(RuntimeException e){return fallback;}}
    private static String tag(int tag) {return String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff);}
    private static String keyword(int tag) {String value=ElementDictionary.keywordOf(tag,null);return value==null?tag(tag):value;}
    private static void issue(List<Issue> issues,String severity,String code,String path,String message,String specification) {issues.add(new Issue(severity,code,path,message,specification));}
    private static int u16(byte[] bytes,int offset) {return (bytes[offset]&255)|(bytes[offset+1]&255)<<8;}
    private static long u32(byte[] bytes,int offset) {return Integer.toUnsignedLong(u16(bytes,offset)|(u16(bytes,offset+2)<<16));}
    private static boolean executablePreamble(byte[] bytes) {return bytes[0]=='M'&&bytes[1]=='Z'||bytes[0]==0x7f&&bytes[1]=='E'&&bytes[2]=='L'&&bytes[3]=='F';}
    private static Set<String> imageClasses() {Set<String> result=new HashSet<>();for(var field:UID.class.getFields())if(field.getType()==String.class&&(field.getName().contains("ImageStorage")||field.getName().equals("SegmentationStorage")))try{result.add((String)field.get(null));}catch(IllegalAccessException e){throw new ExceptionInInitializerError(e);}return Set.copyOf(result);}
    private static final class PixelPresence implements DicomInputHandler {
        private final Map<Attributes,Set<Integer>> owners;
        PixelPresence(Map<Attributes,Set<Integer>> owners){this.owners=owners;}
        @Override public void readValue(DicomInputStream input,Attributes attrs)throws IOException {int tag=input.tag();if(tag==Tag.PixelData||tag==Tag.FloatPixelData||tag==Tag.DoubleFloatPixelData)owners.computeIfAbsent(attrs,k->new HashSet<>()).add(tag);input.readValue(input,attrs);}
        @Override public void readValue(DicomInputStream input,Sequence sequence)throws IOException {input.readValue(input,sequence);}
        @Override public void readValue(DicomInputStream input,Fragments fragments)throws IOException {input.readValue(input,fragments);}
        @Override public void startDataset(DicomInputStream input){}
        @Override public void endDataset(DicomInputStream input){}
    }
}
