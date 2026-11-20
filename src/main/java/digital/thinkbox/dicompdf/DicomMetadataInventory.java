package digital.thinkbox.dicompdf;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonIOException;
import com.google.gson.stream.JsonWriter;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.*;
import org.dcm4che3.util.TagUtils;

/** Versioned source metadata inventory, independent of selected presentation fields. */
final class DicomMetadataInventory {
    private DicomMetadataInventory() {}
    static final int MAX_BINARY_BYTES = 4096;
    private static final int MAX_DEPTH = 64, MAX_ELEMENTS = 200_000;
    private static final long MAX_SIDECAR_BYTES = Runtime.getRuntime().maxMemory()/8; // Parser working-memory headroom, not an input-file cap.
    private static final Gson JSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private static final Set<VR> OPAQUE_BINARY = Set.of(VR.OB,VR.OW,VR.OF,VR.OD,VR.OL,VR.OV,VR.UN);
    record Inventory(int schemaVersion, List<Image> images) {}
    record Image(String attachment, String sourcePath, String sopInstanceUID, String sha256,
                 String status, String reason, List<Element> elements) {}
    record Element(String path, String tag, String keyword, String vr, String value, String encoding) {}
    private record GroupLength(int tag, VR vr, String value) {}

    private static final class MetadataLimit extends IllegalArgumentException {
        MetadataLimit(String message) { super(message); }
    }
    private static final class Budget {
        long used;
        void base64(long length) {
            if (length < 0 || ((length + 2) / 3) * 4 > MAX_SIDECAR_BYTES - used)
                throw new MetadataLimit("Non-pixel metadata needs more available Java heap");
        }
        void add(Element element) {
            if (element.value()!=null && element.value().length()>MAX_SIDECAR_BYTES-used)
                throw new MetadataLimit("Non-pixel metadata needs more available Java heap");
            used += JSON.toJson(element).getBytes(StandardCharsets.UTF_8).length;
            if (used>MAX_SIDECAR_BYTES) throw new MetadataLimit("Non-pixel metadata needs more available Java heap");
        }
    }

    static Inventory capture(List<Manifest.Image> images, Map<String,?> originals) throws Exception {
        return capture(images,originals,true);
    }
    /** Preserve the exact bounded-omission semantics used by already published packages. */
    static Inventory captureLegacy(List<Manifest.Image> images, Map<String,?> originals) throws Exception {
        return capture(images,originals,false);
    }
    private static Inventory capture(List<Manifest.Image> images,Map<String,?> originals,boolean complete)throws Exception {
        List<Image> result = new ArrayList<>();
        for (var image : images) result.add(captureImage(image.attachment(),image.sourcePath(),originals.get(image.attachment()),complete?new Budget():null));
        return new Inventory(1,List.copyOf(result));
    }

    static String capturedSha256(List<Manifest.Image> images, Map<String,?> originals, boolean complete) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        try (var output = new DigestOutputStream(OutputStream.nullOutputStream(), digest);
             var writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8))) {
            writer.beginObject().name("schemaVersion").value(1).name("images").beginArray();
            for (var image : images) {
                var captured = captureImage(image.attachment(), image.sourcePath(), originals.get(image.attachment()),
                        complete ? new Budget() : null);
                JSON.toJson(captured, Image.class, writer);
            }
            writer.endArray().endObject();
        }
        return HexFormat.of().formatHex(digest.digest());
    }
    static byte[] bytes(Inventory inventory) throws IOException {
        var output=new ByteArrayOutputStream();
        OutputStream bounded=new OutputStream(){
            int size;
            @Override public void write(int value)throws IOException{check(1);output.write(value);}
            @Override public void write(byte[] value,int offset,int length)throws IOException{check(length);output.write(value,offset,length);}
            void check(int length)throws IOException{if((long)size+length>Runtime.getRuntime().maxMemory()/3)throw new IOException("Metadata serialization needs more available Java heap");size+=length;}
        };
        try(var writer=new OutputStreamWriter(bounded,StandardCharsets.UTF_8)) {
            JSON.toJson(inventory,writer);writer.flush();
        } catch(JsonIOException error) {
            if(error.getCause() instanceof IOException cause)throw cause;
            throw new IOException("Full DICOM metadata inventory could not be serialized",error);
        }
        return output.toByteArray();
    }
    static Image captureImage(String attachment,String sourcePath,Object content) throws Exception {
        return captureImage(attachment,sourcePath,content,new Budget());
    }
    private static Image captureImage(String attachment,String sourcePath,Object content,Budget budget)throws Exception {
        var bytes=SourceContent.of(content);
        if (bytes==null) throw new IOException("Original bytes unavailable for full metadata inventory: " + attachment);
        String sha256=bytes.digest().sha256();
        List<Element> elements=new ArrayList<>(); String uid=null;
        try (var input=new DicomInputStream(bytes.open())) {
            input.setURI("urn:dicom-pdf:source");
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            input.setBulkDataDescriptor((pointers,creator,tag,vr,length) -> {
                if(isPixel(tag))return true;
                if(budget!=null){if(OPAQUE_BINARY.contains(vr)&&length>=0)budget.base64(length);return false;}
                return OPAQUE_BINARY.contains(vr)&&(length<0||length>MAX_BINARY_BYTES)
                    || BulkDataDescriptor.DEFAULT.isBulkData(pointers,creator,tag,vr,length);
            });
            // Unlike dcm4che's default deflated-bulk handler, skip payloads in
            // place instead of creating decompressed temporary pixel files.
            input.setBulkDataCreator(stream -> {
                long position=stream.getPosition(),length=stream.unsignedLength();
                stream.skipFully(length);
                return new BulkData("urn:dicom-pdf:omitted",position,length,stream.bigEndian());
            });
            Map<Attributes,List<GroupLength>> groupLengths=new IdentityHashMap<>();
            input.setDicomInputHandler(new PreserveGroupLengths(groupLengths));
            Attributes fileMeta=input.readFileMetaInformation();
            if (fileMeta==null) throw new IOException("DICOM Part 10 file meta information is required");
            flatten(fileMeta,"fileMeta",elements,0,groupLengths,budget);
            Attributes dataset=input.readDataset();
            uid=dataset.getString(Tag.SOPInstanceUID);
            flatten(dataset,"dataset",elements,0,groupLengths,budget);
            return new Image(attachment,sourcePath,uid,sha256,"readable",null,List.copyOf(elements));
        } catch (MetadataLimit e) { throw e;
        } catch (Exception e) {
            String reason=e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();
            return new Image(attachment,sourcePath,uid,sha256,elements.isEmpty()?"unreadable":"partial",reason,List.copyOf(elements));
        }
    }
    private static void flatten(Attributes attrs,String parent,List<Element> result,int depth,
                                Map<Attributes,List<GroupLength>> groupLengths,Budget budget) throws IOException {
        for (var group : groupLengths.getOrDefault(attrs,List.of())) {
            String label=String.format(Locale.ROOT,"(%04X,%04X)",group.tag()>>>16,group.tag()&0xffff);
            String keyword=ElementDictionary.keywordOf(group.tag(),null);
            add(result,new Element(parent+"/"+label,label,keyword==null?"":keyword,group.vr().name(),group.value(),"dicom-value-string"),budget);
        }
        if (depth>MAX_DEPTH) {
            if(budget!=null)throw new MetadataLimit("Complete metadata sequence depth exceeds 64");
            throw new IOException("Full metadata sequence depth exceeds 64; remaining tags are unassessed");
        }
        for (int tag : attrs.tags()) {
            if (result.size()>=MAX_ELEMENTS) {
                if(budget!=null)throw new MetadataLimit("Complete metadata inventory exceeds 200000 elements");
                throw new IOException("Full metadata inventory exceeds 200000 elements; remaining tags are unassessed");
            }
            String label=String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff),path=parent+"/"+label;
            VR vr=attrs.getVR(tag); Object raw=attrs.getValue(tag);
            String keyword=ElementDictionary.keywordOf(tag,attrs.getPrivateCreator(tag));
            if (keyword==null) keyword="";
            String value,encoding;
            if (isPixel(tag)) { value=null;encoding="omitted-pixel-data"; }
            else if (raw instanceof Sequence sequence) {
                value=Integer.toString(sequence.size());encoding="sequence-item-count";
                add(result,new Element(path,label,keyword,vr.name(),value,encoding),budget);
                for (int i=0;i<sequence.size();i++) flatten(sequence.get(i),path+"["+(i+1)+"]",result,depth+1,groupLengths,budget);
                continue;
            } else if (raw instanceof BulkData bulk) {
                if(budget!=null)throw new MetadataLimit("Non-pixel bulk metadata could not be retained completely");
                value=null;encoding=OPAQUE_BINARY.contains(vr)&&bulk.longLength()>MAX_BINARY_BYTES?"omitted-binary-data":"omitted-bulk-data";
            } else if (raw instanceof Fragments fragments) {
                if(budget==null){value=null;encoding="omitted-bulk-data";}
                else {
                    List<String> encoded=new ArrayList<>();long total=0;
                    for(Object fragment:fragments){
                        if(!(fragment instanceof byte[] payload))throw new MetadataLimit("Non-pixel metadata fragments could not be retained completely");
                        total+=payload.length;budget.base64(total);encoded.add(Base64.getEncoder().encodeToString(payload));
                    }
                    value=JSON.toJson(encoded);encoding="base64-fragments-json";
                }
            }
            else if (!attrs.containsValue(tag)) { value="";encoding="dicom-value-string"; }
            else if (OPAQUE_BINARY.contains(vr)) {
                byte[] payload=attrs.getBytes(tag);
                if (payload==null) {value="";encoding="base64";}
                else if (budget!=null||payload.length<=MAX_BINARY_BYTES) {if(budget!=null)budget.base64(payload.length);value=Base64.getEncoder().encodeToString(payload);encoding="base64";}
                else {value=null;encoding="omitted-binary-data";}
            } else {
                String[] values=attrs.getStrings(tag);
                value=values==null?"":String.join("\\",values);encoding="dicom-value-string";
            }
            add(result,new Element(path,label,keyword,vr==null?"UN":vr.name(),value,encoding),budget);
        }
    }
    private static void add(List<Element> result,Element element,Budget budget){
        if(budget!=null){if(result.size()>=MAX_ELEMENTS)throw new MetadataLimit("Complete metadata inventory exceeds 200000 elements");budget.add(element);}
        result.add(element);
    }
    private static boolean isPixel(int tag) { return tag==Tag.PixelData||tag==Tag.FloatPixelData||tag==Tag.DoubleFloatPixelData; }

    /** dcm4che normally discards group lengths; keep their actual source values. */
    private static final class PreserveGroupLengths implements DicomInputHandler {
        private final Map<Attributes,List<GroupLength>> values;
        PreserveGroupLengths(Map<Attributes,List<GroupLength>> values) { this.values=values; }
        @Override public void readValue(DicomInputStream input,Attributes attrs)throws IOException {
            if (TagUtils.isGroupLength(input.tag())) {
                int tag=input.tag();VR vr=input.vr();byte[] value=input.readValue();
                if (tag==Tag.FileMetaInformationGroupLength) input.setFileMetaInformationGroupLength(value);
                Object decoded=vr.toStrings(value,input.bigEndian(),attrs.getSpecificCharacterSet(vr));
                String text=decoded instanceof String[] strings?String.join("\\",strings):String.valueOf(decoded);
                values.computeIfAbsent(attrs,key->new ArrayList<>()).add(new GroupLength(tag,vr,text));
            } else input.readValue(input,attrs);
        }
        @Override public void readValue(DicomInputStream input,Sequence sequence)throws IOException {input.readValue(input,sequence);}
        @Override public void readValue(DicomInputStream input,Fragments fragments)throws IOException {input.readValue(input,fragments);}
        @Override public void startDataset(DicomInputStream input) {}
        @Override public void endDataset(DicomInputStream input) {}
    }
}
