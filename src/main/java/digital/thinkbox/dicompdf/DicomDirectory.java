package digital.thinkbox.dicompdf;

import com.google.gson.GsonBuilder;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.dcm4che3.data.*;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputHandler;

/** Resolves only supplied DICOMDIR File IDs; never searches the host filesystem. */
final class DicomDirectory {
    private DicomDirectory() {}
    private static final String ASSESSMENT = "File IDs, referenced identities and record offsets checked; full Basic Directory IOD and media-profile conformance are not assessed";
    record Inventory(int schemaVersion, List<Directory> directories, List<Reference> references) {}
    record Directory(String sourceAttachment, String sourcePath, String status, String reason,
                     List<String> problems, String assessment) {}
    record Reference(String sourceAttachment, String sequencePath, String fileID, String targetSourcePath,
                     String referencedSopClassUID, String referencedSopInstanceUID, String referencedTransferSyntaxUID,
                     String status, List<String> resolvedAttachments, String reason) {}
    private record Target(Attributes fileMeta, Attributes dataset, String syntax) {}

    static byte[] bytes(Inventory inventory) {
        return new GsonBuilder().serializeNulls().disableHtmlEscaping().create().toJson(inventory).getBytes(StandardCharsets.UTF_8);
    }

    static Inventory capture(List<Manifest.Image> images, Map<String,?> originals) {
        Map<String,List<Manifest.Image>> byPath = new LinkedHashMap<>();
        for (var image : images) byPath.computeIfAbsent(image.sourcePath(), key -> new ArrayList<>()).add(image);
        List<Directory> directories = new ArrayList<>(); List<Reference> references = new ArrayList<>();
        for (var source : images) {
            var bytes = SourceContent.of(originals.get(source.attachment()));
            if (bytes == null) {
                if (namedDirectory(source.sourcePath())) directories.add(directory(source,"unreadable",List.of("DICOMDIR original attachment is unavailable")));
                continue;
            }
            Attributes fileMeta;
            try { fileMeta = fileMeta(bytes); }
            catch (Exception e) {
                if (namedDirectory(source.sourcePath())) directories.add(directory(source,"unreadable",List.of("DICOMDIR cannot be parsed: " + message(e))));
                continue;
            }
            if (!UID.MediaStorageDirectoryStorage.equals(fileMeta.getString(Tag.MediaStorageSOPClassUID))) {
                if (namedDirectory(source.sourcePath())) directories.add(directory(source,"issues",List.of("File named DICOMDIR does not identify Media Storage Directory Storage in file-meta information")));
                continue;
            }
            Target data;
            try { data=read(bytes); }
            catch (Exception e) {directories.add(directory(source,"unreadable",List.of("DICOMDIR cannot be parsed: "+message(e))));continue;}
            List<String> problems = structureProblems(data.dataset());
            if (!namedDirectory(source.sourcePath())) problems.add("Media Storage Directory Storage file does not have the reserved DICOMDIR filename");
            if (!UID.ExplicitVRLittleEndian.equals(data.syntax())) problems.add("DICOMDIR is not encoded with Explicit VR Little Endian");
            Sequence records = data.dataset().getSequence(Tag.DirectoryRecordSequence);
            int firstReference = references.size();
            if (records != null) for (int index=0;index<records.size();index++) {
                Attributes record = records.get(index);
                if (!record.contains(Tag.ReferencedFileID)) {
                    if (record.containsValue(Tag.MRDRDirectoryRecordOffset)) {
                        references.add(reference(source,index,record,null,null,"unassessed",List.of(),"Retired MRDR indirect reference is not resolved"));
                        problems.add("Directory record " + (index+1) + " contains an unsupported retired MRDR indirect reference");
                    } else if (record.contains(Tag.ReferencedSOPClassUIDInFile) || record.contains(Tag.ReferencedSOPInstanceUIDInFile)
                            || record.contains(Tag.ReferencedTransferSyntaxUIDInFile)) {
                        references.add(reference(source,index,record,null,null,"invalid-file-id",List.of(),"Referenced identity exists without Referenced File ID"));
                    }
                    continue;
                }
                references.add(resolve(source,index,record,byPath,originals));
            }
            Map<String,List<Integer>> repeated = new LinkedHashMap<>();
            for (int i=firstReference;i<references.size();i++) {
                var reference = references.get(i);
                if (reference.targetSourcePath()!=null) repeated.computeIfAbsent(reference.targetSourcePath(), key -> new ArrayList<>()).add(i);
            }
            for (var duplicate : repeated.entrySet()) if (duplicate.getValue().size()>1) {
                String reason = "The same file is referenced by more than one Directory Record: " + duplicate.getKey();
                problems.add(reason);
                for (int i : duplicate.getValue()) {
                    Reference old=references.get(i);
                    references.set(i,new Reference(old.sourceAttachment(),old.sequencePath(),old.fileID(),old.targetSourcePath(),
                            old.referencedSopClassUID(),old.referencedSopInstanceUID(),old.referencedTransferSyntaxUID(),
                            old.status().equals("resolved")?"duplicate-reference":old.status(),old.resolvedAttachments(),
                            old.reason()==null?reason:old.reason()+"; "+reason));
                }
            }
            directories.add(directory(source,problems.isEmpty()?"checked":"issues",problems));
        }
        return new Inventory(1,List.copyOf(directories),List.copyOf(references));
    }

    private static Reference resolve(Manifest.Image source,int index,Attributes record,
                                     Map<String,List<Manifest.Image>> byPath,Map<String,?> originals) {
        String[] components=record.getStrings(Tag.ReferencedFileID);
        String fileID=components==null?"":String.join("\\",components);
        if (!safePackagePath(source.sourcePath())) return reference(source,index,record,fileID,null,"unsafe-file-id",List.of(),"DICOMDIR source path is not a safe relative package path");
        if (components==null || components.length==0) return reference(source,index,record,fileID,null,"invalid-file-id",List.of(),"Referenced File ID is empty");
        for (String component : components) if (component==null || component.isEmpty() || component.equals(".") || component.equals("..")
                || component.indexOf('/')>=0 || component.indexOf('\\')>=0 || component.indexOf(':')>=0 || component.indexOf('\0')>=0)
            return reference(source,index,record,fileID,null,"unsafe-file-id",List.of(),"Unsafe or empty File ID component; no filesystem access attempted");
        String parent=parent(source.sourcePath());
        String targetPath=(parent.isEmpty()?"":parent+"/")+String.join("/",components);
        List<Manifest.Image> matches=byPath.getOrDefault(targetPath,List.of());
        List<String> names=matches.stream().map(Manifest.Image::attachment).toList();
        if (components.length>8 || Arrays.stream(components).anyMatch(component -> !component.matches("[A-Z0-9_]{1,8}")))
            return reference(source,index,record,fileID,targetPath,"invalid-file-id",names,"DICOM File IDs require one to eight uppercase A-Z/0-9/_ components of one to eight characters; matching supplied paths are reported without case guessing");
        if (matches.isEmpty()) return reference(source,index,record,fileID,targetPath,"missing",names,"Referenced file is not among the supplied files in this File-set");
        if (matches.size()>1) return reference(source,index,record,fileID,targetPath,"ambiguous",names,"More than one supplied attachment maps to this exact File ID path");
        var bytes=SourceContent.of(originals.get(matches.getFirst().attachment()));
        if (bytes==null) return reference(source,index,record,fileID,targetPath,"unreadable-target",names,"Referenced original attachment is unavailable");
        Target target;
        try { target=read(bytes); }
        catch (Exception e) { return reference(source,index,record,fileID,targetPath,"unreadable-target",names,"Referenced file is not readable DICOM Part 10: " + message(e)); }
        List<String> issues=new ArrayList<>(); String status="resolved";
        String sopClass=record.getString(Tag.ReferencedSOPClassUIDInFile),sopInstance=record.getString(Tag.ReferencedSOPInstanceUIDInFile),syntax=record.getString(Tag.ReferencedTransferSyntaxUIDInFile);
        if (blank(sopClass)||blank(sopInstance)||blank(syntax)) {status="invalid-reference";issues.add("Referenced class, instance and transfer syntax UIDs are required for a referenced SOP Instance");}
        String actualClass=target.dataset().getString(Tag.SOPClassUID),actualInstance=target.dataset().getString(Tag.SOPInstanceUID);
        String metaClass=target.fileMeta().getString(Tag.MediaStorageSOPClassUID),metaInstance=target.fileMeta().getString(Tag.MediaStorageSOPInstanceUID);
        if (sopClass!=null && (!sopClass.equals(metaClass) || actualClass!=null && !sopClass.equals(actualClass))) {if(status.equals("resolved"))status="class-mismatch";issues.add("Referenced SOP Class UID differs from target file-meta/dataset class");}
        if (sopInstance!=null && (!sopInstance.equals(metaInstance) || actualInstance!=null && !sopInstance.equals(actualInstance))) {if(status.equals("resolved"))status="instance-mismatch";issues.add("Referenced SOP Instance UID differs from target file-meta/dataset instance");}
        if (syntax!=null && !syntax.equals(target.syntax())) {if(status.equals("resolved"))status="transfer-syntax-mismatch";issues.add("Referenced Transfer Syntax UID differs from target file-meta transfer syntax");}
        if (record.getInt(Tag.RecordInUseFlag,0xffff)==0) {if(status.equals("resolved"))status="inactive-record";issues.add("Record In-use Flag is retired inactive value 0000H");}
        return reference(source,index,record,fileID,targetPath,status,names,issues.isEmpty()?null:String.join("; ",issues));
    }

    private static Reference reference(Manifest.Image source,int index,Attributes record,String fileID,String targetPath,
                                       String status,List<String> attachments,String reason) {
        return new Reference(source.attachment(),"dataset/(0004,1220)["+(index+1)+"]/(0004,1500)",fileID,targetPath,
                record.getString(Tag.ReferencedSOPClassUIDInFile),record.getString(Tag.ReferencedSOPInstanceUIDInFile),
                record.getString(Tag.ReferencedTransferSyntaxUIDInFile),status,List.copyOf(attachments),reason);
    }
    private static Directory directory(Manifest.Image source,String status,List<String> problems) {
        return new Directory(source.attachment(),source.sourcePath(),status,problems.isEmpty()?null:String.join("; ",problems),List.copyOf(problems),ASSESSMENT);
    }
    private static Target read(Object bytes) throws Exception {
        try (var input=new DicomInputStream(SourceContent.of(bytes).open())) {
            input.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            input.setDicomInputHandler(new ItemPositions());
            Attributes fileMeta=input.readFileMetaInformation();
            if (fileMeta==null) throw new IllegalArgumentException("File meta information is required");
            return new Target(fileMeta,input.readDataset(),input.getTransferSyntax());
        }
    }
    /** Generic dcm4che SQ parsing does not retain Item positions by default. */
    private static final class ItemPositions implements DicomInputHandler {
        @Override public void readValue(DicomInputStream input,Attributes attrs)throws IOException {input.readValue(input,attrs);}
        @Override public void readValue(DicomInputStream input,Sequence sequence)throws IOException {
            long position=input.getTagPosition();int index=sequence.size();input.readValue(input,sequence);
            if(sequence.size()>index)sequence.get(index).setItemPosition(position);
        }
        @Override public void readValue(DicomInputStream input,Fragments fragments)throws IOException {input.readValue(input,fragments);}
        @Override public void startDataset(DicomInputStream input) {}
        @Override public void endDataset(DicomInputStream input) {}
    }
    private static Attributes fileMeta(Object bytes) throws Exception {
        try (var input=new DicomInputStream(SourceContent.of(bytes).open())) {
            Attributes result=input.readFileMetaInformation();
            if(result==null)throw new IllegalArgumentException("File meta information is required");
            return result;
        }
    }
    private static List<String> structureProblems(Attributes dataset) {
        List<String> problems=new ArrayList<>(); Sequence sequence=dataset.getSequence(Tag.DirectoryRecordSequence);
        if (sequence==null && !dataset.contains(Tag.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity)
                && !dataset.contains(Tag.OffsetOfTheLastDirectoryRecordOfTheRootDirectoryEntity) && !dataset.contains(Tag.FileSetConsistencyFlag)) return problems;
        for (int tag : new int[]{Tag.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity,Tag.OffsetOfTheLastDirectoryRecordOfTheRootDirectoryEntity,Tag.FileSetConsistencyFlag})
            if (!dataset.containsValue(tag)) problems.add("Directory Information attribute is missing: "+String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff));
        if (dataset.getInt(Tag.FileSetConsistencyFlag,0)!=0) problems.add("File-set Consistency Flag is not 0000H");
        if (sequence==null) {problems.add("Directory Information is present without Directory Record Sequence");return problems;}
        Map<Long,Attributes> positions=new LinkedHashMap<>();
        for (int i=0;i<sequence.size();i++) {
            Attributes record=sequence.get(i);long position=record.getItemPosition();
            if (position<132 || positions.put(position,record)!=null) problems.add("Directory record "+(i+1)+" has an unavailable or duplicate item offset");
            for (int tag : new int[]{Tag.OffsetOfTheNextDirectoryRecord,Tag.OffsetOfReferencedLowerLevelDirectoryEntity,Tag.RecordInUseFlag,Tag.DirectoryRecordType})
                if (!record.containsValue(tag)) problems.add("Directory record "+(i+1)+" lacks required attribute "+String.format(Locale.ROOT,"(%04X,%04X)",tag>>>16,tag&0xffff));
            if (record.getInt(Tag.RecordInUseFlag,0xffff)==0) problems.add("Directory record "+(i+1)+" uses the retired inactive Record In-use Flag");
        }
        long first=dataset.getLong(Tag.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity,0),last=dataset.getLong(Tag.OffsetOfTheLastDirectoryRecordOfTheRootDirectoryEntity,0);
        if (sequence.isEmpty()) {if(first!=0||last!=0)problems.add("Empty Directory Record Sequence has nonzero root offsets");return problems;}
        if (first==0 || last==0) problems.add("Nonempty Directory Record Sequence has a zero root offset");
        if (first!=0&&!positions.containsKey(first)) problems.add("First root offset does not identify a Directory Record item");
        if (last!=0&&!positions.containsKey(last)) problems.add("Last root offset does not identify a Directory Record item");
        Map<Long,List<Long>> edges=new LinkedHashMap<>();
        for (var item : positions.entrySet()) {
            List<Long> links=new ArrayList<>();
            for (int tag : new int[]{Tag.OffsetOfTheNextDirectoryRecord,Tag.OffsetOfReferencedLowerLevelDirectoryEntity}) {
                long offset=item.getValue().getLong(tag,0);
                if(offset!=0){links.add(offset);if(!positions.containsKey(offset))problems.add("Directory record offset "+item.getKey()+" points to nonexistent item "+offset);}
            }
            edges.put(item.getKey(),links);
        }
        Map<Long,Integer> incoming=new HashMap<>();for(long position:positions.keySet())incoming.put(position,0);
        for(var links:edges.values())for(long next:links)if(incoming.containsKey(next))incoming.merge(next,1,Integer::sum);
        Deque<Long> ready=new ArrayDeque<>();for(var item:incoming.entrySet())if(item.getValue()==0)ready.add(item.getKey());
        int acyclic=0;while(!ready.isEmpty()){long node=ready.removeFirst();acyclic++;for(long next:edges.getOrDefault(node,List.of()))if(incoming.containsKey(next)&&incoming.merge(next,-1,Integer::sum)==0)ready.add(next);}
        if(acyclic<positions.size())problems.add("Directory record next/lower offsets contain a cycle");
        Set<Long> reached=new HashSet<>();Deque<Long> pending=new ArrayDeque<>();if(first!=0)pending.add(first);
        while(!pending.isEmpty()){long at=pending.removeFirst();if(reached.add(at))pending.addAll(edges.getOrDefault(at,List.of()));}
        for(var item:positions.entrySet())if(!reached.contains(item.getKey())&&item.getValue().getInt(Tag.RecordInUseFlag,0xffff)!=0)problems.add("In-use directory record offset "+item.getKey()+" is unreachable from the first root record");
        Set<Long> roots=new HashSet<>();long at=first,rootEnd=0;
        while(at!=0&&roots.add(at)&&positions.containsKey(at)){rootEnd=at;at=positions.get(at).getLong(Tag.OffsetOfTheNextDirectoryRecord,0);}
        if(rootEnd!=last)problems.add("Last root offset differs from the last record reached through root next pointers");
        return problems;
    }
    private static boolean safePackagePath(String path) {
        return path!=null&&!path.isEmpty()&&!path.startsWith("/")&&path.indexOf('\\')<0&&path.indexOf(':')<0
                &&Arrays.stream(path.split("/",-1)).noneMatch(value->value.isEmpty()||value.equals(".")||value.equals(".."));
    }
    private static String parent(String path) {int slash=path.lastIndexOf('/');return slash<0?"":path.substring(0,slash);}
    private static boolean namedDirectory(String path) {return path.equals("DICOMDIR")||path.endsWith("/DICOMDIR");}
    private static boolean blank(String value) {return value==null||value.isBlank();}
    private static String message(Exception e) {return e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();}
}
