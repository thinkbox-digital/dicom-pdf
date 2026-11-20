package digital.thinkbox.dicompdf;

import java.util.*;
import org.dcm4che3.data.*;

/** Explicit SOP references only; never infers absent teeth, studies or series members. */
final class ReferenceInventory {
    private ReferenceInventory() {}
    record Analysis(List<Manifest.Reference> references,Map<String,List<String>> duplicates) {}
    record Link(String path,String sopClass,String uid,List<Integer> frames,boolean incomplete) {}
    record Entry(String attachment,Map<String,String> fields,List<Link> links) {}

    static Analysis analyze(Map<String,?> originals) {
        var entries=new ArrayList<Entry>();
        for (var source:originals.entrySet()) {
            DicomInput.Dataset dataset;
            try { dataset=DicomInput.dataset(source.getValue()); }
            catch(Exception e){continue;} // Unreadable files are reported by the independent source checks.
            Map<String,String> fields;
            try { fields=DicomInput.fields(dataset); } catch(RuntimeException e){fields=Map.of();}
            entries.add(new Entry(source.getKey(),fields,links(dataset.attributes())));
        }
        return resolveEntries(entries);
    }
    static List<Manifest.Reference> resolve(Map<String,?> originals){return analyze(originals).references();}
    static Map<String,List<String>> duplicates(Map<String,?> originals){return analyze(originals).duplicates();}

    static Analysis resolveEntries(List<Entry> sources) {
        var ids=new TreeMap<String,List<String>>();
        var fields=new HashMap<String,Map<String,String>>();
        for(var source:sources){
            fields.put(source.attachment(),source.fields());
            String uid=source.fields().get("SOPInstanceUID");
            if(uid!=null && !uid.isBlank())ids.computeIfAbsent(uid,k->new ArrayList<>()).add(source.attachment());
        }
        ids.replaceAll((uid,attachments)->List.copyOf(attachments));
        var result=new ArrayList<Manifest.Reference>();
        for(var source:sources)for(var link:source.links()){
            List<String> matches=link.uid()==null?List.of():ids.getOrDefault(link.uid(),List.of());
            String status;
            if(link.incomplete())status="unassessed";
            else if(matches.isEmpty())status="missing";
            else if(matches.size()>1)status="ambiguous";
            else {
                var target=fields.get(matches.getFirst());
                status="resolved";
                try {
                    int count=Integer.parseInt(target.getOrDefault("NumberOfFrames","1"));
                    for(int frame:link.frames())if(frame<1 || frame>count){status="invalid-frame";break;}
                } catch(NumberFormatException e){status="invalid-frame";}
                if(link.sopClass()!=null && !link.sopClass().equals(target.get("SOPClassUID")))status="class-mismatch";
            }
            result.add(new Manifest.Reference(source.attachment(),link.path(),link.sopClass(),link.uid(),link.frames(),status,matches));
        }
        ids.entrySet().removeIf(item->item.getValue().size()<2);
        return new Analysis(List.copyOf(result),Collections.unmodifiableMap(ids));
    }
    static List<Link> links(Attributes data) {
        var links=new ArrayList<Link>();
        try {scan(data,"",links,0);}
        catch(RuntimeException e){links.add(new Link("/REFERENCE_SCAN_INCOMPLETE",null,null,List.of(),true));}
        return List.copyOf(links);
    }
    private static void scan(Attributes attrs,String path,List<Link> links,int depth){
        if(depth>64)throw new IllegalArgumentException("Reference sequence depth exceeds 64");
        if(attrs.contains(Tag.ReferencedSOPInstanceUID)){
            String uid=attrs.getString(Tag.ReferencedSOPInstanceUID);
            String sopClass=attrs.getString(Tag.ReferencedSOPClassUID);
            var frames=new ArrayList<Integer>();
            String[] values=attrs.getStrings(Tag.ReferencedFrameNumber);
            if(values!=null)for(String value:values){
                try {frames.add(Integer.parseInt(value.trim()));}catch(RuntimeException e){frames.add(0);}
            }
            links.add(new Link(path+"/ReferencedSOPInstanceUID(0008,1155)",sopClass,uid,List.copyOf(frames),false));
        }
        for(int tag:attrs.tags()){
            if(attrs.getVR(tag)!=VR.SQ)continue;
            Sequence sequence=attrs.getSequence(tag);
            if(sequence==null)continue;
            String name=ElementDictionary.keywordOf(tag,attrs.getPrivateCreator(tag));
            if(name==null || name.isBlank())name="Sequence";
            String tagged=name+String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff);
            for(int i=0;i<sequence.size();i++)scan(sequence.get(i),path+"/"+tagged+"["+i+"]",links,depth+1);
        }
    }
}
