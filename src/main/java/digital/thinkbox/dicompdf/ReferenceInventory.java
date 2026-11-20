package digital.thinkbox.dicompdf;

import java.util.*;
import org.dcm4che3.data.*;

/** Explicit SOP references only; never infers absent teeth, studies or series members. */
final class ReferenceInventory {
    private ReferenceInventory() {}
    static Map<String,List<String>> duplicates(Map<String,?> originals) {
        Map<String,List<String>> ids = index(originals);
        ids.entrySet().removeIf(e -> e.getValue().size() < 2);
        return Collections.unmodifiableMap(ids);
    }
    private static Map<String,List<String>> index(Map<String,?> originals) {
        Map<String,List<String>> ids = new TreeMap<>();
        for (var file : originals.entrySet()) {
            String uid = DicomInput.fields(file.getValue()).get("SOPInstanceUID");
            if (uid != null && !uid.isBlank()) ids.computeIfAbsent(uid, k -> new ArrayList<>()).add(file.getKey());
        }
        return ids;
    }
    static List<Manifest.Reference> resolve(Map<String,?> originals) {
        var ids = index(originals); List<Manifest.Reference> result = new ArrayList<>();
        for (var file : originals.entrySet()) {
            DicomInput.Dataset dataset;
            try { dataset = DicomInput.dataset(file.getValue()); }
            catch (Exception e) { continue; } // Unreadable originals are counted separately by verification.
            try { scan(file.getKey(), dataset.attributes(), "", ids, originals, result, 0); }
            catch (Exception e) {
                // This is a coverage diagnostic, not an invented SOP reference. Never claim a complete scan after a failure.
                result.add(new Manifest.Reference(file.getKey(), "/REFERENCE_SCAN_INCOMPLETE", null, null,
                        List.of(), "unassessed", List.of()));
            }
        }
        return List.copyOf(result);
    }
    private static void scan(String source, Attributes attrs, String path, Map<String,List<String>> ids,
                             Map<String,?> originals, List<Manifest.Reference> result, int depth) {
        if (depth > 64) throw new IllegalArgumentException("Reference sequence depth exceeds 64");
        if (attrs.contains(Tag.ReferencedSOPInstanceUID)) {
            String uid = attrs.getString(Tag.ReferencedSOPInstanceUID);
            String sopClass = attrs.getString(Tag.ReferencedSOPClassUID);
            List<Integer> frames = new ArrayList<>(); boolean badFrame = false;
            String[] frameValues = attrs.getStrings(Tag.ReferencedFrameNumber);
            if (frameValues != null) for (String value : frameValues) {
                try { int frame = Integer.parseInt(value.trim()); frames.add(frame); if (frame < 1) badFrame = true; }
                catch (RuntimeException e) { frames.add(0); badFrame = true; }
            }
            var matches = uid == null ? List.<String>of() : ids.getOrDefault(uid, List.of());
            String status = matches.isEmpty() ? "missing" : matches.size() > 1 ? "ambiguous" : "resolved";
            if (status.equals("resolved")) {
                Map<String,String> fields = DicomInput.fields(originals.get(matches.getFirst()));
                int count = 1;
                try { count = Integer.parseInt(fields.getOrDefault("NumberOfFrames", "1")); }
                catch (RuntimeException e) { badFrame = true; }
                for (int frame : frames) if (frame > count) { badFrame = true; break; }
                if (badFrame) status = "invalid-frame";
                if (sopClass != null && !sopClass.equals(fields.get("SOPClassUID"))) status = "class-mismatch";
            }
            result.add(new Manifest.Reference(source, path + "/ReferencedSOPInstanceUID(0008,1155)", sopClass, uid,
                    List.copyOf(frames), status, List.copyOf(matches)));
        }
        for (int tag : attrs.tags()) {
            if (attrs.getVR(tag) != VR.SQ) continue;
            Sequence sequence = attrs.getSequence(tag);
            if (sequence == null) continue;
            String name = ElementDictionary.keywordOf(tag, attrs.getPrivateCreator(tag));
            if (name == null || name.isBlank()) name = "Sequence";
            String tagged = name + String.format(Locale.ROOT, "(%04X,%04X)", tag >>> 16, tag & 0xffff);
            for (int i = 0; i < sequence.size(); i++) scan(source, sequence.get(i), path + "/" + tagged + "[" + i + "]", ids, originals, result, depth + 1);
        }
    }
}
