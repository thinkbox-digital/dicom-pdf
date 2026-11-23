package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class DesktopViewerMetadata {
    private static final String CONTEXT = "package-context";
    private static final String DIAGNOSTIC = "incomplete-dataset";
    private static final Pattern FORMULA = Pattern.compile("^[\\p{javaWhitespace}\\p{Zs}]*[=+@-]");
    private static final List<String> SOURCE_HEADERS = List.of("Source file", "Attachment", "SOP Instance UID", "SHA-256",
            "Metadata status", "Metadata diagnostics");
    private static final List<String> TAG_HEADERS = List.of("Source file", "Attachment", "SOP Instance UID", "SHA-256",
            "Path", "Tag", "Keyword", "VR", "Value", "Encoding");

    private DesktopViewerMetadata() {}

    static DicomMetadataInventory.Image record(DesktopViewerDocument doc, Manifest.Image source) throws Exception {
        var record = doc.metadataRecord(source);
        var entries = new ArrayList<>(record.elements());
        if (!"readable".equals(record.status()) && entries.stream().noneMatch(item -> DIAGNOSTIC.equals(item.encoding()))) {
            entries.add(new DicomMetadataInventory.Element("[parse-error]", "", "", "",
                    "Metadata unavailable: " + java.util.Objects.toString(record.reason(), "DICOM metadata could not be read"), DIAGNOSTIC));
        }
        selectedFileFields(source).forEach((key, value) -> entries.add(new DicomMetadataInventory.Element("package/selected-original/" + key,
                "", key, "", java.util.Objects.toString(value, "Not supplied"), CONTEXT)));
        return new DicomMetadataInventory.Image(source.attachment(), source.sourcePath(), source.sopInstanceUID(),
                source.sha256(), record.status(), record.reason(), List.copyOf(entries));
    }

    static Map<String, Object> selectedFileFields(Manifest.Image source) {
        var context = sourceFacts(source);
        context.put("Original integrity", "Matches recorded checksum");
        addDisplayFields(context, source);
        return context;
    }

    static Map<String, Object> sourceFacts(Manifest.Image source) {
        var context = new LinkedHashMap<String, Object>();
        context.put("Source file", source.sourcePath());
        context.put("Attachment", source.attachment());
        context.put("PDF preview status", "rendered".equals(source.status()) ? "Available" : "Unavailable");
        if (source.reason() != null && !source.reason().isBlank()) context.put("PDF preview details", source.reason());
        context.put("PDF reference page", source.referencePage());
        context.put("Source frame", source.sourceFrame() == null ? "None" : source.sourceFrame());
        context.put("SHA-256", source.sha256());
        context.put("Original bytes", source.size());
        return context;
    }

    static void addDisplayFields(Map<String, Object> context, Manifest.Image source) {
        if (source.fields() != null) context.putAll(source.fields());
        if (source.displayAdjustments() != null)
            source.displayAdjustments().forEach((key, value) -> context.put("Display: " + key, value));
    }

    static Map<String, DicomMetadataInventory.Element> fields(List<DicomMetadataInventory.Image> records) {
        var fields = new LinkedHashMap<String, DicomMetadataInventory.Element>();
        for (var record : records)
            for (var field : record.elements()) fields.putIfAbsent(field.path(), field);
        return fields;
    }

    static void export(Path destination, List<DicomMetadataInventory.Image> records, Set<String> selected, boolean detailed)
            throws Exception {
        if (selected != null && selected.isEmpty()) throw new IOException("Select one or more metadata fields.");
        DesktopViewerDocument.write(destination, stream -> {
            var output = new java.io.BufferedWriter(new java.io.OutputStreamWriter(stream, StandardCharsets.UTF_8));
            output.write('\ufeff');
            if (detailed) writeTags(output, records, selected);
            else writeColumns(output, records, selected);
            output.flush();
        });
    }

    private static void writeTags(Writer output, List<DicomMetadataInventory.Image> records, Set<String> selected)
            throws IOException {
        line(output, TAG_HEADERS);
        for (var record : records)
            for (var field : record.elements())
                if (selected == null || selected.contains(field.path()) || DIAGNOSTIC.equals(field.encoding()))
                    line(output, Arrays.asList(record.sourcePath(), record.attachment(), record.sopInstanceUID(), record.sha256(),
                            field.path(), field.tag(), field.keyword(), field.vr(), field.value(), field.encoding()));
    }

    private static void writeColumns(Writer output, List<DicomMetadataInventory.Image> records, Set<String> selected)
            throws IOException {
        var fields = fields(records);
        var ordered = fields.values().stream().filter(field -> !DIAGNOSTIC.equals(field.encoding())
                        && (selected == null || selected.contains(field.path())))
                .sorted(java.util.Comparator.comparing(field -> !CONTEXT.equals(field.encoding()))).toList();
        var headers = new ArrayList<>(SOURCE_HEADERS);
        var used = new HashSet<>(headers);
        var paths = new ArrayList<String>();
        for (var field : ordered) {
            boolean context = CONTEXT.equals(field.encoding());
            if (context && List.of("Source file", "Attachment", "SHA-256").contains(field.keyword())) continue;
            String name = firstText(field.keyword(), field.tag(), field.path());
            String base = context ? name : name + " [" + field.path() + "]";
            String label = base;
            if (!used.add(label)) {
                label = base + " [" + field.path() + "]";
                for (int i = 2; !used.add(label); i++) label = base + " [" + field.path() + "] (" + i + ")";
            }
            headers.add(label);
            paths.add(field.path());
        }
        if ((long) headers.size() * (records.size() + 1L) > 5_000_000L)
            throw new IOException("Choose fewer fields or use Detailed tag rows for this export.");
        line(output, headers);
        for (var record : records) {
            var byPath = new LinkedHashMap<String, DicomMetadataInventory.Element>();
            var diagnostics = new LinkedHashSet<String>();
            if (record.reason() != null && !record.reason().isBlank()) diagnostics.add(record.reason());
            for (var field : record.elements()) {
                if (DIAGNOSTIC.equals(field.encoding())) {
                    if (field.value() != null && !field.value().isBlank()) diagnostics.add(field.value());
                } else if (byPath.putIfAbsent(field.path(), field) != null) {
                    throw new IOException("Repeated metadata path " + field.path() + " in " + record.attachment());
                }
            }
            var row = new ArrayList<>(Arrays.asList(record.sourcePath(), record.attachment(), record.sopInstanceUID(),
                    record.sha256(), record.status(), String.join("\n", diagnostics)));
            for (String path : paths) row.add(value(byPath.get(path)));
            line(output, row);
        }
    }

    private static String firstText(String... alternatives) {
        return Arrays.stream(alternatives).filter(text -> text != null && !text.isBlank()).findFirst().orElse("");
    }

    private static String value(DicomMetadataInventory.Element field) {
        if (field == null) return "";
        String encoding = java.util.Objects.toString(field.encoding(), "");
        String value = field.value();
        if (value == null) return encoding.isEmpty() ? "" : "[" + encoding + "]";
        if (encoding.contains("base64") || encoding.matches("^(?:omitted-|unreadable-|undecodable-|unsupported-|ambiguous-).*")
                || encoding.equals("sequence-item-count")) return "[" + encoding + "]" + (value.isEmpty() ? "" : " " + value);
        return value;
    }

    private static void line(Writer writer, List<String> values) throws IOException {
        for (int index = 0; index < values.size(); index++) {
            if (index != 0) writer.write(',');
            String value = java.util.Objects.toString(values.get(index), "");
            if (FORMULA.matcher(value).find() || (!value.isEmpty() && "\t\r\n".indexOf(value.charAt(0)) >= 0)) value = "'" + value;
            writer.write('"');
            writer.write(value.replace("\"", "\"\""));
            writer.write('"');
        }
        writer.write("\r\n");
    }
}
