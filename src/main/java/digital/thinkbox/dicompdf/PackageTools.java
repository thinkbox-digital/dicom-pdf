package digital.thinkbox.dicompdf;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;
import javax.xml.XMLConstants;
import javax.xml.stream.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.filespecification.PDComplexFileSpecification;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** Offline inspection, recovery, and separate preservation/conformance checks. */
public final class PackageTools {
    private static final Gson JSON = new GsonBuilder().serializeNulls().setPrettyPrinting().disableHtmlEscaping().create();
    private static final String NS = "https://thinkbox.digital/ns/dicom/2.0/";
    private static final String PROFILE = "dicom-images", VERSION = "0.3.0";
    private PackageTools() {}

    public record Check(String status, List<String> details) {
        public Check { details = List.copyOf(details); }
    }
    public record Verification(Check pdfa4f, Check sourceBytes, Check externalSources,
                               Check metadataAccuracy, Check unresolvedReferences, Check dicomInputConformance,Check dicomStructure,Map<String,digital.thinkbox.pdfsecurity.SecurityReport.Check> c2pa) {
        public Verification(Check pdfa4f,Check sourceBytes,Check externalSources,Check metadataAccuracy,Check unresolvedReferences,Check dicomInputConformance,Check dicomStructure){this(pdfa4f,sourceBytes,externalSources,metadataAccuracy,unresolvedReferences,dicomInputConformance,dicomStructure,Map.of());}
        public Verification(Check pdfa4f,Check sourceBytes,Check externalSources,Check metadataAccuracy,Check unresolvedReferences,Check dicomInputConformance){
            this(pdfa4f,sourceBytes,externalSources,metadataAccuracy,unresolvedReferences,dicomInputConformance,new Check("NOT_CHECKED",List.of("No structural inventory assessed")));
        }
        public int exitCode() {
            if(c2pa.values().stream().anyMatch(c->c.status()==digital.thinkbox.pdfsecurity.SecurityReport.Status.FAIL))return 1;
            // Exit status describes container preservation. An unchanged invalid DICOM
            // source can be faithfully preserved; its separately reported input check
            // must not turn byte/metadata agreement into a preservation failure.
            for (Check check : List.of(pdfa4f, sourceBytes, externalSources, metadataAccuracy, unresolvedReferences))
                if (check.status().equals("FAIL")) return 1;
            if (!pdfa4f.status().equals("PASS") || !unresolvedReferences.status().equals("PASS")) return 2;
            return 0;
        }
        public String json() { return JSON.toJson(this) + "\n"; }
        public String readable() {
            StringBuilder text = new StringBuilder();
            append(text, "PDF/A-4f validation", pdfa4f);
            append(text, "Embedded source byte matches", sourceBytes);
            append(text, "External source byte matches", externalSources);
            append(text, "Metadata accuracy", metadataAccuracy);
            append(text, "Unresolved references", unresolvedReferences);
            append(text, "DICOM input checks (documented subset; not full IOD validation)", dicomInputConformance);
            append(text,"Additional DICOM structure (native payload and selected dcm4che module rules)",dicomStructure);
            for(var entry:c2pa.entrySet())text.append(entry.getKey()).append(": ").append(entry.getValue().status()).append(" — ").append(entry.getValue().code()).append('\n');
            return text.toString();
        }
        private static void append(StringBuilder text, String name, Check check) {
            text.append(name).append(": ").append(check.status()).append('\n');
            for (String detail : check.details()) text.append("  ").append(detail).append('\n');
        }
    }
    public record Extraction(int originals, int packageFiles, Path directory) {}

    private static final class Package implements AutoCloseable {
        final PDDocument pdf;
        final Map<String, PDComplexFileSpecification> files = new TreeMap<>();
        final byte[] manifestBytes;
        final JsonObject manifest;
        final JsonArray images;
        private Path decodedOriginals;
        private int decodedCount;
        private SourceContent metadataContent;
        Package(Path path) throws Exception {
            pdf = Loader.loadPDF(path.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache());
            try {
                var names = pdf.getDocumentCatalog().getNames();
                if (names == null || names.getEmbeddedFiles() == null) throw new IOException("PDF has no embedded-file inventory");
                collect(names.getEmbeddedFiles(), files, new HashSet<>(), 0);
                for (String name : files.keySet()) ArchivePath.checkAttachment(name);
                manifestBytes = payload(requireFile("manifest.json"));
                manifest = JsonParser.parseString(new String(manifestBytes, StandardCharsets.UTF_8)).getAsJsonObject();
                int version = manifest.get("schemaVersion").getAsInt();
                if (version != 1 && version != 2) throw new IOException("Unsupported manifest schemaVersion: " + version);
                images = manifest.getAsJsonArray("images");
                if (images == null || images.isEmpty()) throw new IOException("Invalid image inventory size");
            } catch (Exception e) { pdf.close(); throw e; }
        }
        PDComplexFileSpecification requireFile(String name) throws IOException {
            var file = files.get(name);
            if (file == null) throw new IOException("Missing attachment: " + name);
            return file;
        }
        SourceContent original(String name,Path sources)throws Exception{
            if(decodedOriginals==null)decodedOriginals=SourceContent.scratchDirectory("verified-originals-",sources);
            // Repeated metadata inventories and raster decoding use this one decoded copy.
            // Every verify() call creates a new private directory; nothing is reused across archives/runs.
            var original=content(requireFile(name));
            try {
                long available=Math.max(0,Files.getFileStore(decodedOriginals).getUsableSpace()-64L*1024*1024);
                return original.snapshot(decodedOriginals.resolve("original-"+(decodedCount++)+".dcm"),available);
            } catch (FileSystemException e) {
                throw new SourceContent.ScratchUnavailable("Cannot access local snapshot: "+e.getMessage(),e);
            }
        }
        SourceContent verifiedArtifact(String name) throws Exception {
            if (!"dicom-metadata.json".equals(name)) return content(requireFile(name));
            if (metadataContent == null) metadataContent = content(requireFile(name));
            return metadataContent;
        }
        @Override public void close() throws IOException {
            try{pdf.close();}finally{if(decodedOriginals!=null)deleteTree(decodedOriginals);}
        }
    }

    public static String inspect(Path pdf) throws Exception {
        try (var pack = new Package(pdf)) {
            StringBuilder text = new StringBuilder("DICOM package inventory\n");
            text.append("Profile: ").append(string(pack.manifest, "profile", "legacy pilot"))
                .append(" / ").append(string(pack.manifest, "profileVersion", "0.1.0"))
                .append("; manifest schemaVersion ").append(pack.manifest.get("schemaVersion")).append('\n');
            text.append("Source role: ").append(string(pack.manifest, "sourceRole", "unspecified legacy package")).append('\n');
            int embedded = 0, displayed = 0, rejected = 0;
            text.append("Displayed means a PDF preview was generated; it does not claim a recipient opened it.\n\n");
            for (var value : pack.images) {
                JsonObject image = value.getAsJsonObject();
                String attachment = required(image, "attachment"), source = required(image, "sourcePath");
                boolean present = pack.files.containsKey(attachment), rendered = "rendered".equals(required(image, "status"));
                if (present) embedded++;
                if (rendered) displayed++; else rejected++;
                text.append("SUPPLIED ").append(source).append('\n')
                    .append("  Embedded: ").append(present ? "yes" : "MISSING").append(" as ").append(attachment)
                    .append("; displayed: ").append(rendered ? "yes" : "no")
                    .append("; rejected for display: ").append(rendered ? "no" : "yes").append('\n')
                    .append("  Preview/diagnostic page: ").append(required(image, "referencePage"))
                    .append("; source frame: ").append(string(image, "sourceFrame", rendered ? "1 (legacy)" : "none"))
                    .append("; SOP Instance UID: ").append(string(image, "sopInstanceUID", "not supplied")).append('\n')
                    .append("  SHA-256: ").append(required(image, "sha256")).append("; bytes: ").append(required(image, "size")).append('\n');
                if (!rendered) text.append("  Rejection: ").append(string(image, "reason", "unspecified")).append('\n');
                if (image.has("displayAdjustments")) text.append("  Display adjustments: ").append(image.get("displayAdjustments")).append('\n');
            }
            text.append("\nTotals: supplied ").append(pack.images.size()).append("; embedded ").append(embedded)
                .append("; displayed ").append(displayed).append("; rejected for display ").append(rejected).append(".\n");
            text.append("\nExplicit DICOM references declared by the originals\n");
            JsonArray references = pack.manifest.getAsJsonArray("references");
            if (references == null || references.isEmpty()) text.append("  No explicit references inventoried; this does not prove a study is complete.\n");
            else for (var reference : references) {
                JsonObject row = reference.getAsJsonObject();
                text.append("  ").append(string(row, "status", "unknown").toUpperCase(Locale.ROOT))
                    .append(" from ").append(string(row, "sourceAttachment", "unknown source"))
                    .append(" to SOP ").append(string(row, "sopInstanceUID", "not supplied"))
                    .append("; frame(s) ").append(row.get("frames")).append('\n')
                    .append("    Sequence: ").append(string(row, "sequencePath", "unknown"))
                    .append("; candidate attachments: ").append(row.get("resolvedAttachments")).append('\n');
            }
            if (pack.manifest.has("duplicateInstanceUIDs")) text.append("Duplicate instance IDs: ").append(pack.manifest.get("duplicateInstanceUIDs")).append('\n');
            if (pack.files.containsKey("dicom-validation.json")) {
                var input=JsonParser.parseString(new String(payload(pack.requireFile("dicom-validation.json")),StandardCharsets.UTF_8)).getAsJsonObject();
                text.append("\nStored DICOM input checks (2026d documented subset; full IOD validation not established)\n");
                for (var value:input.getAsJsonArray("images")) {
                    var row=value.getAsJsonObject();text.append("  ").append(required(row,"sourcePath")).append(": ").append(required(row,"status")).append('\n');
                    for (var finding:row.getAsJsonArray("issues")) {
                        var issue=finding.getAsJsonObject();text.append("    ").append(required(issue,"severity")).append(' ').append(required(issue,"code"))
                            .append(" at ").append(required(issue,"path")).append(": ").append(required(issue,"message")).append('\n');
                    }
                }
            }
            if(pack.files.containsKey("dicom-structure.json")){
                var structure=JsonParser.parseString(new String(payload(pack.requireFile("dicom-structure.json")),StandardCharsets.UTF_8)).getAsJsonObject();
                text.append("\nStored additional DICOM structure (not full IOD conformance)\n");
                for(var value:structure.getAsJsonArray("images")){
                    var row=value.getAsJsonObject();text.append("  ").append(required(row,"attachment")).append(": ").append(required(row,"status"))
                        .append("; encoded pixel bytes ").append(row.get("suppliedPixelBytes")).append("; expected native bytes ").append(row.get("expectedPixelBytes")).append('\n');
                    for(var finding:row.getAsJsonArray("issues"))text.append("    ").append(finding).append('\n');
                }
            }
            if (pack.files.containsKey("dicom-directory.json")) {
                var directory=JsonParser.parseString(new String(payload(pack.requireFile("dicom-directory.json")),StandardCharsets.UTF_8)).getAsJsonObject();
                text.append("\nStored DICOMDIR File ID references\n");
                for(var value:directory.getAsJsonArray("references")) {
                    var row=value.getAsJsonObject();text.append("  ").append(required(row,"status")).append(" from ").append(required(row,"sourceAttachment"))
                        .append(" File ID ").append(string(row,"fileID","not supplied")).append(" -> ").append(string(row,"targetSourcePath","unresolved")).append('\n');
                }
            }
            text.append("\nAttachments\n");
            for (var file : pack.files.entrySet()) text.append("  ").append(file.getKey()).append(" [")
                .append(file.getValue().getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship"))).append("]\n");
            text.append("\nRecover without the viewer: extract --input <package.pdf> --output <new-directory>\n")
                .append("Originals are written under originals/ with their supplied relative paths.\n")
                .append("Read package/RECOVERY.txt and package/manifest.json; verify before using recovered data.\n");
            return text.toString();
        }
    }

    /** Fully stages and hash-checks recovery before publishing a new directory; never overwrites an existing directory. */
    public static Extraction extract(Path pdf, Path output) throws Exception {
        Path destination = output.toAbsolutePath().normalize();
        Path parent = destination.getParent();
        if (parent == null || destination.getFileName() == null) throw new IOException("Choose a new recovery directory");
        Files.createDirectories(parent);
        parent = parent.toRealPath(); destination = parent.resolve(destination.getFileName());
        if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Recovery output must be a new directory; existing paths are never overwritten");
        Path staged = Files.createTempDirectory(parent, ".dicompdf-recovery-");
        int originals = 0, packageFiles = 0; boolean published = false;
        try (var pack = new Package(pdf)) {
            Set<String> names = new HashSet<>(); Set<Path> paths = new HashSet<>(); long total = 0;
            for (var item : pack.images) {
                JsonObject image = item.getAsJsonObject();
                String name = required(image, "attachment");
                if (!names.add(name)) throw new IOException("Duplicate original attachment mapping: " + name);
                Path target = ArchivePath.resolve(staged.resolve("originals"), required(image, "sourcePath"));
                if (!paths.add(target)) throw new IOException("Duplicate original recovery path: " + target);
                long expectedSize = image.get("size").getAsLong();
                if (expectedSize < 0) throw new IOException("Invalid original size: " + name);
                Files.createDirectories(target.getParent());
                var copy = content(pack.requireFile(name)).snapshot(target,expectedSize);
                if (!matches(image, copy)) throw new IOException("Original checksum/size mismatch: " + name);
                total = Math.addExact(total,copy.digest().length());
                if(!matches(image,SourceContent.file(target)))throw new IOException("Recovered original checksum mismatch");
                originals++;
            }
            for (var item : pack.files.entrySet()) {
                if (names.contains(item.getKey())) continue;
                content(item.getValue()).writeTo(ArchivePath.resolve(staged.resolve("package"), item.getKey())); packageFiles++;
            }
            // Files are recoverable even for the old pilot where RECOVERY.txt was absent.
            String recovery = "Recovered original bytes are under originals/ using manifest sourcePath values.\n"
                + "Package attachments are under package/. Verify all original SHA-256 values in package/manifest.json.\n"
                + "No source was de-identified or modified by extraction. Keep any de-identified derivatives in a separate directory/package.\n";
            writeNew(staged.resolve("RECOVERED.txt"), recovery.getBytes(StandardCharsets.UTF_8));
            try { Files.move(staged, destination, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException e) { Files.move(staged, destination); }
            published = true;
            return new Extraction(originals, packageFiles, destination);
        } finally { if (!published) deleteTree(staged); }
    }

    public static Verification verify(Path pdf, Path sources, String verapdf) {
        return verify(pdf, sources, verapdf, null);
    }
    static Verification verify(Path pdf, Path sources, String verapdf, Map<String,Long> lengths) {
        Check pdfa = validatePdfa(pdf, verapdf);
        List<String> byteProblems = new ArrayList<>(), metadataProblems = new ArrayList<>(), externalProblems = new ArrayList<>();
        Check sourceCheck = new Check("NOT_CHECKED", List.of("Source inventory not yet read"));
        Check externalCheck = new Check("NOT_CHECKED", List.of("External comparison not yet run"));
        Check metadataCheck;
        Check referenceCheck;
        Check inputCheck = new Check("NOT_CHECKED", List.of("No versioned DICOM input-check inventory was supplied; source validity is separate from preservation"));
        Check structureCheck=new Check("NOT_CHECKED",List.of("No versioned additional DICOM structural inventory supplied"));
        try (var pack = new Package(pdf)) {
            Map<String, SourceContent> originalBytes = new LinkedHashMap<>(); Set<String> seenNames = new HashSet<>(), seenPaths = new HashSet<>();
            var pages = new ArrayList<PDPage>();
            try {
                pack.pdf.getPages().forEach(pages::add);
                if (pages.size() != pack.pdf.getNumberOfPages()) metadataProblems.add("PDF page tree count differs from enumerated pages");
            } catch (RuntimeException failure) { pages.clear(); metadataProblems.add("Cannot enumerate PDF reference pages"); }
            Set<Integer> seenPages = new HashSet<>(); long originalTotal = 0;
            for (var item : pack.images) {
                JsonObject image = item.getAsJsonObject();
                String name = required(image, "attachment"), relative = required(image, "sourcePath");
                if (!seenNames.add(name)) byteProblems.add("Repeated attachment mapping: " + name);
                try { ArchivePath.check(relative); } catch (IOException invalid) { metadataProblems.add("Unsafe manifest sourcePath for " + name); }
                if (!seenPaths.add(relative)) byteProblems.add("Repeated sourcePath mapping: " + relative);
                SourceContent data;
                try {
                    data = pack.original(name,sources); originalTotal = Math.addExact(originalTotal,data.digest().length()); originalBytes.put(name, data);
                    if (!matches(image, data)) byteProblems.add("SHA-256/size mismatch: " + relative);
                    else if (lengths != null) lengths.put(name,data.digest().length());
                } catch (SourceContent.ScratchUnavailable e) {
                    throw e;
                } catch (Exception e) {
                    byteProblems.add(relative + ": " + e.getMessage());
                    metadataProblems.add("Cannot check metadata for unavailable source " + relative);
                    if (sources != null) externalProblems.add("Cannot compare unavailable source: " + relative);
                    continue;
                }
                try { checkImage(pack, image, data, pages, seenPages, metadataProblems); }
                catch (Exception e) { metadataProblems.add("Metadata/preview cannot be checked for " + relative + ": " + e.getMessage()); }
                if (sources != null) {
                    try {
                        Path expected = safeSource(sources, relative);
                        if (!Files.isRegularFile(expected, LinkOption.NOFOLLOW_LINKS) || !sameBytes(expected, data))
                            externalProblems.add("External bytes differ or source missing: " + relative);
                    } catch (Exception e) { externalProblems.add(relative + ": " + e.getMessage()); }
                }
            }
            sourceCheck = check(byteProblems, "All " + pack.images.size() + " original attachments match the manifest SHA-256 and byte sizes");
            if (sources == null) externalCheck = new Check("NOT_CHECKED", List.of("No --sources directory supplied; embedded/manifest agreement is not an external-input comparison"));
            else {
                try (var walk = Files.walk(sources.toRealPath())) {
                    Set<String> externalPaths = new TreeSet<>();
                    for (Path file : walk.toList()) {
                        if (Files.isSymbolicLink(file)) externalProblems.add("Symbolic link in external sources: " + file);
                        else if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) externalPaths.add(sources.toRealPath().relativize(file).toString().replace(File.separatorChar, '/'));
                    }
                    if (!externalPaths.equals(seenPaths)) externalProblems.add("External source file inventory differs from manifest sourcePath inventory");
                } catch (Exception e) { externalProblems.add("Cannot inventory external sources: " + e.getMessage()); }
                externalCheck = check(externalProblems, "All supplied external sources match recovered original bytes and file inventory");
            }
            if (pack.manifest.get("schemaVersion").getAsInt() != 2) metadataProblems.add("Legacy v1 lacks the v2 profile/frame/display mapping; metadata accuracy is not certified");
            else {
                try { checkXmpAndProfile(pack, metadataProblems); }
                catch (Exception e) { metadataProblems.add("XMP/profile cannot be checked: " + e.getMessage()); }
                try { checkArtifactDigests(pack, seenNames, metadataProblems, lengths); }
                catch (Exception e) { metadataProblems.add("Artifact inventory cannot be checked: " + e.getMessage()); }
                try { checkDisplayMapping(pack, metadataProblems); }
                catch (Exception e) { metadataProblems.add("Display extension mapping cannot be checked: " + e.getMessage()); }
            }
            try {
                var analysis = ReferenceInventory.analyze(originalBytes);
                if (pack.manifest.get("schemaVersion").getAsInt() == 2
                        && !JSON.toJsonTree(analysis.duplicates()).equals(pack.manifest.get("duplicateInstanceUIDs")))
                    metadataProblems.add("Duplicate instance ID inventory differs from original DICOM bytes");
                List<Manifest.Reference> actualReferences = analysis.references();
                JsonElement declaredReferences = pack.manifest.get("references");
                if (pack.manifest.get("schemaVersion").getAsInt() == 2 && !JSON.toJsonTree(actualReferences).equals(declaredReferences))
                    metadataProblems.add("Reference inventory differs from explicit references in original DICOM bytes");
                List<String> unresolved = new ArrayList<>();
                for (var reference : actualReferences) if (!reference.status().equals("resolved")) unresolved.add(JSON.toJson(reference));
                if (pack.files.containsKey("dicom-directory.json")) {
                    var directory = checkDirectory(pack, originalBytes, metadataProblems);
                    for (var reference : directory.references())
                        if (!Set.of("resolved", "inactive-record").contains(reference.status())) unresolved.add("DICOMDIR: " + JSON.toJson(reference));
                    for (var source : directory.directories())
                        if (!source.status().equals("checked")) unresolved.add("DICOMDIR structure: " + JSON.toJson(source));
                }
                long unreadable = originalBytes.values().stream().filter(bytes -> DicomInput.fields(bytes).isEmpty()).count();
                String coverage = unreadable + " original(s) have unreadable DICOM metadata; their references cannot be assessed. Study completeness is not inferred.";
                if (!unresolved.isEmpty()) {
                    unresolved.add(coverage);
                    referenceCheck = new Check("UNRESOLVED", unresolved);
                } else if (originalBytes.size() != seenNames.size() || unreadable > 0) {
                    referenceCheck = new Check("NOT_CHECKED", List.of("Reference coverage is incomplete", coverage));
                } else {
                    referenceCheck = new Check("PASS", List.of("No unresolved explicit DICOM references in readable originals", coverage));
                }
            } catch (Exception e) {
                metadataProblems.add("Reference inventory cannot be checked: " + e.getMessage());
                referenceCheck = new Check("NOT_CHECKED", List.of("Reference resolution failed: " + e.getMessage()));
            }
            if (pack.files.containsKey("dicom-metadata.json")) {
                try { checkFullMetadata(pack, originalBytes, metadataProblems); }
                catch (Exception e) { metadataProblems.add("Full DICOM metadata cannot be checked: " + e.getMessage()); }
            }
            if (pack.files.containsKey("dicom-validation.json")) {
                try { inputCheck = checkDicomValidation(pack, originalBytes, metadataProblems); }
                catch (Exception e) {
                    metadataProblems.add("DICOM input-check inventory cannot be checked: " + e.getMessage());
                    inputCheck = new Check("NOT_CHECKED", List.of("DICOM input checks could not be completed: " + e.getMessage()));
                }
            }
            if(pack.files.containsKey("dicom-structure.json")){
                try{structureCheck=checkStructure(pack,originalBytes,metadataProblems);}
                catch(Exception failure){metadataProblems.add("DICOM structural inventory cannot be checked");structureCheck=new Check("NOT_CHECKED",List.of("Additional structural checks could not be completed"));}
            }
            metadataCheck = check(metadataProblems, "Profile, XMP, selected source fields, preview/frame/display mapping, page associations, duplicates and reference inventory agree with embedded originals");
        } catch (SourceContent.ScratchUnavailable e) {
            var incomplete=new Check("NOT_CHECKED",List.of(e.getMessage()));
            sourceCheck=byteProblems.isEmpty()?incomplete:check(byteProblems,"");
            externalCheck=externalProblems.isEmpty()?incomplete:check(externalProblems,"");
            metadataCheck=metadataProblems.isEmpty()?incomplete:check(metadataProblems,"");
            referenceCheck=incomplete;
            inputCheck=incomplete;
            structureCheck=incomplete;
        } catch (Exception e) {
            if (sourceCheck.status().equals("NOT_CHECKED")) sourceCheck = new Check("FAIL", List.of("Package cannot be read: " + e.getMessage()));
            if (sources != null && externalCheck.status().equals("NOT_CHECKED")) externalCheck = new Check("FAIL", List.of("External comparison unavailable because package cannot be read"));
            metadataCheck = new Check("FAIL", List.of("Metadata cannot be checked: " + e.getMessage()));
            referenceCheck = new Check("NOT_CHECKED", List.of("Explicit references cannot be resolved because package cannot be read"));
        }
        return new Verification(pdfa, sourceCheck, externalCheck, metadataCheck, referenceCheck, inputCheck,structureCheck,ArchiveC2pa.verify(pdf));
    }
    private static Check checkStructure(Package pack,Map<String,?> originals,List<String> problems)throws Exception{
        Manifest.Image[] sources=JSON.fromJson(pack.images,Manifest.Image[].class);
        var actual=DicomStructure.capture(Arrays.asList(sources),originals);
        var stored=JsonParser.parseString(new String(payload(pack.requireFile("dicom-structure.json")),StandardCharsets.UTF_8));
        if(!JSON.toJsonTree(actual).equals(stored))problems.add("Additional DICOM structural inventory differs from freshly parsed original bytes");
        var details=new ArrayList<String>();details.add("Native byte length and selected dcm4che module rules only; full IOD and compressed codestream validity are not established.");
        for(var source:actual.images()){
            details.add(source.attachment()+": "+source.status());
            for(var issue:source.issues())details.add(JSON.toJson(issue));
        }
        boolean fail=actual.images().stream().anyMatch(source->source.status().equals("FAIL"));
        boolean unknown=actual.images().stream().anyMatch(source->source.status().equals("UNKNOWN"));
        return new Check(fail?"FAIL":unknown?"UNKNOWN":"PASS",details);
    }

    private static Check checkDicomValidation(Package pack, Map<String,?> originals, List<String> problems) throws Exception {
        Manifest.Image[] images = JSON.fromJson(pack.images, Manifest.Image[].class);
        var stored = JsonParser.parseString(new String(payload(pack.requireFile("dicom-validation.json")), StandardCharsets.UTF_8));
        int version=stored.getAsJsonObject().get("schemaVersion").getAsInt();
        if(version!=1&&version!=2)throw new IOException("Unsupported DICOM input-check inventory version");
        var expected=version==1?DicomValidation.captureLegacy(Arrays.asList(images),originals):DicomValidation.capture(Arrays.asList(images),originals);
        if (!JSON.toJsonTree(expected).equals(stored)) problems.add("DICOM input-check inventory differs from independently reparsed source bytes");
        List<String> details = new ArrayList<>();
        details.add("DICOM 2026d documented subset only; full SOP-class IOD/conditional conformance is not established. Source validity does not change preservation exit status.");
        for (var image : expected.images()) if (!image.status().equals("PASS")) {
            details.add(image.sourcePath() + ": " + image.status());
            for (var issue : image.issues()) details.add(JSON.toJson(issue));
        }
        long checked = expected.images().stream().filter(image -> !image.status().equals("NOT_DICOM")).count();
        details.add(checked + " DICOM inputs checked; " + (expected.images().size()-checked) + " non-DICOM or unrecognized files retained without an input-validity claim");
        return new Check(expected.images().stream().anyMatch(image -> image.status().equals("FAIL")) ? "FAIL" : checked == 0 ? "NOT_CHECKED" : "PASS", details);
    }
    private static void checkDisplayMapping(Package pack,List<String> problems)throws Exception {
        boolean extended = false;
        for (var item : pack.images) {
            var image=item.getAsJsonObject();
            if (!image.has("displayAdjustments") || !image.get("displayAdjustments").isJsonObject()) continue;
            var display=image.getAsJsonObject("displayAdjustments");
            if (display.has("geometryMethod") || string(display,"windowMethod","").contains("padding")) extended=true;
        }
        if (pack.files.containsKey("display-mapping.json")) {
            try (InputStream input=PackageTools.class.getResourceAsStream("/display-mapping.json")) {
                if (input==null || !Arrays.equals(input.readAllBytes(),payload(pack.requireFile("display-mapping.json")))) problems.add("Display extension mapping differs from the supported schema");
            }
        } else if (extended) problems.add("Extended display recipe requires display-mapping.json");
    }
    private static DicomDirectory.Inventory checkDirectory(Package pack, Map<String,?> originals, List<String> problems) throws Exception {
        Manifest.Image[] images = JSON.fromJson(pack.images, Manifest.Image[].class);
        var expected = DicomDirectory.capture(Arrays.asList(images), originals);
        var stored = JsonParser.parseString(new String(payload(pack.requireFile("dicom-directory.json")), StandardCharsets.UTF_8));
        if (!JSON.toJsonTree(expected).equals(stored)) problems.add("DICOMDIR inventory differs from independently reparsed source bytes and paths");
        return expected;
    }

    private static void checkFullMetadata(Package pack, Map<String,?> originals, List<String> problems) throws Exception {
        var images = Arrays.asList(JSON.fromJson(pack.images, Manifest.Image[].class));
        boolean full = fullMetadataRequired(pack);
        var stored = pack.verifiedArtifact("dicom-metadata.json");
        if (!DicomMetadataInventory.capturedSha256(images, originals, full).equals(stored.digest().sha256())) {
            // Packages can use an equivalent JSON serialization, such as different whitespace or member order.
            var expected = JSON.toJsonTree(full ? DicomMetadataInventory.capture(images, originals)
                    : DicomMetadataInventory.captureLegacy(images, originals));
            var actual = JsonParser.parseString(new String(stored.array(), StandardCharsets.UTF_8));
            if (!expected.equals(actual)) problems.add("Full DICOM metadata sidecar differs from reparsed original bytes");
        }
        if (pack.files.containsKey("metadata-mapping.json")) {
            try (InputStream input = PackageTools.class.getResourceAsStream(full?"/metadata-mapping.json":"/legacy-metadata-v1/metadata-mapping.json")) {
                if (input == null || !Arrays.equals(input.readAllBytes(), payload(pack.requireFile("metadata-mapping.json"))))
                    problems.add("Full DICOM metadata mapping differs from the supported schema");
            }
        }else if(full)problems.add("Full XMP metadata requires metadata-mapping.json");
    }
    private static boolean fullMetadataRequired(Package pack){return pack.manifest.has("metadataXmpVersion");}

    private static void checkImage(Package pack, JsonObject image, SourceContent data, List<PDPage> pages, Set<Integer> seenPages, List<String> problems) throws Exception {
        String name = required(image, "attachment");
        Map<String,String> recordedDisplay = new LinkedHashMap<>();
        if (image.has("displayAdjustments") && image.get("displayAdjustments").isJsonObject())
            for (var item : image.getAsJsonObject("displayAdjustments").entrySet()) recordedDisplay.put(item.getKey(), item.getValue().getAsString());
        String creator = string(pack.manifest,"creator","");
        var actual = DicomInput.inspectForPreview(data, 1, recordedDisplay,
                supportsExpandedReferenceFormats(creator), supportsWideReferenceFormats(creator),
                !creator.matches("dicom-pdf 0\\.(?:[0-9]|1[0-9]|2[01])\\.[0-9]+"));
        if ("dicom-2d-intraoral".equals(string(pack.manifest,"profile",""))) {
            var old = LegacyDicomInput.inspect(data.array());
            actual = new DicomInput.Result(old.fields(),old.image(),old.reason(),old.displayAdjustments());
        }
        var specification = pack.requireFile(name);
        if (!name.equals(specification.getFileUnicode()) || !name.equals(specification.getFile())) problems.add("Original attachment filename differs from manifest key: " + name);
        if (!JSON.toJsonTree(actual.fields()).equals(image.get("fields"))) problems.add("Selected source fields differ: " + name);
        if (!Objects.equals(actual.fields().get("SOPInstanceUID"), string(image, "sopInstanceUID", null))) problems.add("Instance UID differs: " + name);
        boolean rendered = actual.image() != null;
        if (rendered != "rendered".equals(required(image, "status"))) problems.add("Render acceptance differs: " + name);
        int page = image.get("referencePage").getAsInt();
        if (page < 1 || page > pages.size() || !seenPages.add(page)) { problems.add("Invalid/repeated reference page: " + name); return; }
        PDPage preview = pages.get(page - 1); List<PDImageXObject> rasters = new ArrayList<>();
        if (preview.getResources() != null) for (COSName key : preview.getResources().getXObjectNames()) if (preview.getResources().getXObject(key) instanceof PDImageXObject raster) rasters.add(raster);
        if (rasters.size() != (rendered ? 1 : 0)) problems.add("Preview raster count differs: " + name);
        if (rendered && rasters.size() == 1 && pack.manifest.get("schemaVersion").getAsInt() == 2) {
            PDImageXObject raster = rasters.get(0);
            if (raster.getWidth() != actual.image().getWidth() || raster.getHeight() != actual.image().getHeight()) problems.add("Preview dimensions differ from original: " + name);
            String expected = DicomInput.previewSha256(actual.image());
            if (!expected.equals(string(image, "previewSha256", null))) problems.add("Recorded preview digest differs from re-rendered original: " + name);
            if (raster.getWidth() == actual.image().getWidth() && raster.getHeight() == actual.image().getHeight()
                    && !expected.equals(DicomInput.previewSha256(raster.getImage()))) problems.add("PDF preview pixels differ from re-rendered original: " + name);
        } else if (!rendered && image.has("previewSha256") && !image.get("previewSha256").isJsonNull()) problems.add("Unrendered file has a preview digest: " + name);
        COSBase pageAssociated = preview.getCOSObject().getDictionaryObject(COSName.getPDFName("AF"));
        if (!(pageAssociated instanceof COSArray array) || !contains(array, pack.requireFile(name).getCOSObject())) problems.add("Reference page is not associated with its original: " + name);
        if (!"Source".equals(pack.requireFile(name).getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship")))) problems.add("Original lacks Source relationship: " + name);
        if (pack.manifest.get("schemaVersion").getAsInt() == 2) {
            if (!image.has("supplied") || !image.get("supplied").getAsBoolean() || !image.has("embedded") || !image.get("embedded").getAsBoolean()) problems.add("Original inventory supplied/embedded flags differ: " + name);
            if (!image.has("displayRejected") || image.get("displayRejected").getAsBoolean() == rendered) problems.add("Display rejection flag differs: " + name);
            if (rendered ? !image.has("sourceFrame") || image.get("sourceFrame").isJsonNull() || image.get("sourceFrame").getAsInt() != 1
                         : image.has("sourceFrame") && !image.get("sourceFrame").isJsonNull()) problems.add("Source frame mapping differs: " + name);
            if (!JSON.toJsonTree(actual.displayAdjustments()).equals(image.get("displayAdjustments"))) problems.add("Display adjustments differ: " + name);
            if (!rendered && !Objects.equals(actual.reason(), string(image, "reason", null))) problems.add("Display rejection reason differs: " + name);
        }
    }

    private static boolean supportsExpandedReferenceFormats(String creator) {
        // Releases before 0.15 recorded diagnostics for these source formats.
        return !creator.matches("dicom-pdf 0\\.(?:[0-9]|1[0-4])\\.[0-9]+");
    }

    private static boolean supportsWideReferenceFormats(String creator) {
        // Releases before 0.17 used the earlier RGB and JPEG Extended paths.
        return !creator.matches("dicom-pdf 0\\.(?:[0-9]|1[0-6])\\.[0-9]+");
    }

    private static void checkXmpAndProfile(Package pack, List<String> problems) throws Exception {
        boolean legacy = "dicom-2d-intraoral".equals(string(pack.manifest,"profile",""));
        boolean full=fullMetadataRequired(pack);
        if(full){
            var version=pack.manifest.get("metadataXmpVersion");
            if(!version.isJsonPrimitive()||!version.getAsJsonPrimitive().isNumber()
                    ||version.getAsBigDecimal().compareTo(java.math.BigDecimal.ONE)!=0)problems.add("Unsupported full metadata XMP version");
            if(legacy)problems.add("Full metadata XMP requires the DICOM image profile");
            if(!pack.files.containsKey("dicom-metadata.json"))problems.add("Required full XMP metadata attachment is missing");
            if(!pack.files.containsKey("metadata-mapping.json"))problems.add("Required full XMP metadata mapping is missing");
        }
        boolean c2pa=pack.files.containsKey(digital.thinkbox.dicompdf.ArchiveC2pa.POLICY);
        String expectedProfile = legacy ? "dicom-2d-intraoral" : PROFILE, expectedVersion = legacy ? "0.2.0" : c2pa?"0.4.0":VERSION;
        for (var expected : Map.of("profile", expectedProfile, "profileVersion", expectedVersion).entrySet())
            if (!expected.getValue().equals(string(pack.manifest, expected.getKey(), null))) problems.add("Unknown manifest " + expected.getKey());
        if (!Set.of("archival-master", "deidentified-copy").contains(string(pack.manifest, "sourceRole", ""))) problems.add("Invalid source role");
        var metadata = pack.pdf.getDocumentCatalog().getMetadata();
        if (metadata == null) problems.add("Document XMP is missing");
        else {
            var sidecar = full ? pack.verifiedArtifact("dicom-metadata.json") : null;
            try (var sidecarReader = full ? new InputStreamReader(sidecar.openDigesting(), StandardCharsets.UTF_8.newDecoder()) : null;
                 var input = PdfStreams.open(metadata)) {
                Map<String,Reader> expected = new LinkedHashMap<>();
                for (String name : List.of("profile", "profileVersion", "sourceRole", "schemaVersion"))
                    expected.put(name, new StringReader(required(pack.manifest, name)));
                expected.put("inventoryJson", new InputStreamReader(new ByteArrayInputStream(pack.manifestBytes), StandardCharsets.UTF_8));
                if (full) {
                    expected.put("metadataVersion", new StringReader("1"));
                    expected.put("metadataJson", sidecarReader);
                    var artifacts = pack.manifest.getAsJsonObject("artifactSha256");
                    expected.put("metadataSha256", new StringReader(artifacts == null ? "" : string(artifacts,"dicom-metadata.json","")));
                }
                compareXmp(input, expected, problems);
                if (full) {
                    var artifacts = pack.manifest.getAsJsonObject("artifactSha256");
                    if (artifacts == null || !sidecar.digest().sha256().equals(string(artifacts,"dicom-metadata.json","")))
                        problems.add("Full XMP metadata differs from manifest artifact SHA-256");
                }
            }
        }
        for (String resource : List.of("dicom-xmp.rng", "profile.json", "field-mapping.json", "RECOVERY.txt")) {
            String directory=legacy?"/legacy-v2/":!full&&Set.of("dicom-xmp.rng","field-mapping.json").contains(resource)?"/legacy-metadata-v1/":"/";
            try (InputStream input = PackageTools.class.getResourceAsStream(c2pa&&Set.of("profile.json","dicom-xmp.rng","RECOVERY.txt").contains(resource)?"/c2pa-"+resource:directory + resource)) {
                byte[] attached = payload(pack.requireFile(resource));
                boolean matches = input != null && Arrays.equals(input.readAllBytes(), attached);
                // Application-specific example commands changed independently of the preservation profile.
                // Only these exact historical bytes are an alternative; artifact SHA-256 checks still apply.
                if (!matches && !legacy && resource.equals("RECOVERY.txt")) {
                    for (String version : List.of("0.21.0", "0.3.0")) {
                        try (InputStream previous = PackageTools.class.getResourceAsStream("/legacy-application-" + version + "/RECOVERY.txt")) {
                            if (previous != null && Arrays.equals(previous.readAllBytes(), attached)) { matches = true; break; }
                        }
                    }
                }
                if (!matches) problems.add("Missing or different profile resource: " + resource);
            } catch (Exception e) { problems.add("Cannot check profile resource " + resource + ": " + e.getMessage()); }
        }
        if (!"Schema".equals(pack.requireFile("dicom-xmp.rng").getCOSObject().getNameAsString(COSName.getPDFName("AFRelationship")))) problems.add("XMP schema lacks Schema relationship");
        COSBase associated = pack.pdf.getDocumentCatalog().getCOSObject().getDictionaryObject(COSName.getPDFName("AF"));
        if (!(associated instanceof COSArray array)) problems.add("Document associated-file array is missing");
        else {
            Set<COSBase> associatedFiles = Collections.newSetFromMap(new IdentityHashMap<>());
            for (int i = 0; i < array.size(); i++) associatedFiles.add(array.getObject(i));
            for (var file : pack.files.entrySet())
                if (!associatedFiles.contains(file.getValue().getCOSObject())) problems.add("Attachment missing from document AF: " + file.getKey());
        }
    }

    /** Compare XML character data, including escaped text and split CDATA, against streamed UTF-8 sidecars. */
    private static void compareXmp(InputStream input, Map<String,Reader> expected, List<String> problems) throws Exception {
        var factory = XMLInputFactory.newDefaultFactory();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        var seen = new HashSet<String>();
        var xml = factory.createXMLStreamReader(input);
        char[] buffer = new char[8192];
        try {
            while (xml.hasNext()) {
                int event = xml.next();
                if (event == XMLStreamConstants.DTD) throw new IOException("The XMP packet is not well-formed safe XML");
                if (event != XMLStreamConstants.START_ELEMENT || !NS.equals(xml.getNamespaceURI())) continue;
                String name = xml.getLocalName();
                Reader reference = expected.get(name);
                if (reference == null) {
                    if (Set.of("metadataJson","metadataVersion","metadataSha256").contains(name))
                        problems.add("Full XMP metadata properties require an explicit manifest metadataXmpVersion");
                    continue;
                }
                if (!seen.add(name) || !equalProperty(xml, reference, buffer)) problems.add("XMP " + name + " differs from archive metadata");
            }
            for (String name : expected.keySet())
                if (!seen.contains(name)) problems.add("XMP " + name + " is missing");
        } finally { xml.close(); }
    }

    private static boolean equalProperty(XMLStreamReader xml, Reader expected, char[] buffer) throws Exception {
        boolean equal = true;
        while (xml.hasNext()) {
            switch (xml.next()) {
                case XMLStreamConstants.END_ELEMENT -> { return equal && expected.read() == -1; }
                case XMLStreamConstants.START_ELEMENT -> throw new IOException("Nested element in an XMP text property");
                case XMLStreamConstants.CHARACTERS, XMLStreamConstants.CDATA, XMLStreamConstants.SPACE -> {
                    char[] text = xml.getTextCharacters();
                    int start = xml.getTextStart(), end = start + xml.getTextLength();
                    while (equal && start < end) {
                        int count = expected.read(buffer, 0, Math.min(end - start, buffer.length));
                        if (count <= 0 || !Arrays.equals(text,start,start+count,buffer,0,count)) equal = false;
                        else start += count;
                    }
                }
            }
        }
        throw new IOException("Unterminated XMP text property");
    }

    private static void checkArtifactDigests(Package pack, Set<String> originals, List<String> problems, Map<String,Long> lengths) throws Exception {
        String expectedSidecar = sha256(pack.manifestBytes) + "  manifest.json\n";
        try {
            if (!expectedSidecar.equals(new String(payload(pack.requireFile("manifest.sha256")), StandardCharsets.US_ASCII))) problems.add("manifest.sha256 differs from exact manifest bytes");
        } catch (Exception e) { problems.add("Manifest SHA-256 sidecar missing/unreadable: " + e.getMessage()); }
        JsonObject artifacts = pack.manifest.getAsJsonObject("artifactSha256");
        if (artifacts == null) { problems.add("Artifact SHA-256 inventory is missing"); return; }
        Set<String> expectedNames = new TreeSet<>(pack.files.keySet());
        if(pack.files.containsKey(digital.thinkbox.dicompdf.ArchiveC2pa.POLICY)){
            if(!Arrays.equals(digital.thinkbox.dicompdf.ArchiveC2pa.POLICY_BYTES,payload(pack.requireFile(digital.thinkbox.dicompdf.ArchiveC2pa.POLICY))))problems.add("Unsupported C2PA policy");
            pack.requireFile(digital.thinkbox.dicompdf.ArchiveC2pa.FILE);
            expectedNames.remove(digital.thinkbox.dicompdf.ArchiveC2pa.FILE);
        }
        expectedNames.removeAll(originals); expectedNames.remove("manifest.json"); expectedNames.remove("manifest.sha256");
        if(pack.manifest.has("security")){
            try{
                var security=pack.manifest.getAsJsonObject("security");
                if(security.get("schemaVersion").getAsInt()!=1||!"manifest.p7s".equals(security.get("manifestSignature").getAsString()))throw new IOException("Unsupported security extension");
                var checked=digital.thinkbox.pdfsecurity.CmsVerification.verify(new ByteArrayInputStream(pack.manifestBytes),payload(pack.requireFile("manifest.p7s")),
                    digital.thinkbox.pdfsecurity.CertificatePolicy.untrusted(java.time.Instant.now()),security.get("issuerCertificateSha256").getAsString());
                if(!checked.containsKey("cryptographicSignature")||checked.get("cryptographicSignature").status()!=digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS)
                    problems.add("Detached manifest CMS signature is invalid");
                if(!artifacts.has("provenance.json"))problems.add("Signed manifest lacks hashed provenance");
                expectedNames.remove("manifest.p7s");
            }catch(Exception invalid){problems.add("Missing or invalid manifest signature evidence");}
        }
        if (!expectedNames.equals(artifacts.keySet())) problems.add("Artifact SHA-256 inventory differs from actual package attachments");
        for (var artifact : artifacts.entrySet()) {
            try {
                var digest = pack.verifiedArtifact(artifact.getKey()).digest();
                if (!digest.sha256().equals(artifact.getValue().getAsString())) problems.add("Artifact SHA-256 mismatch: " + artifact.getKey());
                else if (lengths != null) lengths.put(artifact.getKey(),digest.length());
            } catch (Exception e) { problems.add("Artifact cannot be checked: " + artifact.getKey() + ": " + e.getMessage()); }
        }
        for (String name : List.of("inventory.txt", "dicom-xmp.rng", "profile.json", "field-mapping.json", "RECOVERY.txt"))
            if (!artifacts.has(name)) problems.add("Required profile artifact missing from manifest: " + name);
    }

    private static Check validatePdfa(Path pdf, String executable) {
        Path log = null;
        try {
            log = Files.createTempFile("dicompdf-verapdf-", ".json");
            Process process;
            try { process = new ProcessBuilder(executable == null ? "verapdf" : executable, "--format", "json", "--flavour", "4f", pdf.toAbsolutePath().toString())
                .redirectErrorStream(true).redirectOutput(log.toFile()).start(); }
            catch (IOException e) { return new Check("NOT_CHECKED", List.of("veraPDF could not be started: " + e.getMessage(), "PDF/A XMP identification alone is not validation; supply --verapdf <executable>")); }
            if (!process.waitFor(60, TimeUnit.SECONDS)) { process.destroyForcibly(); return new Check("NOT_CHECKED", List.of("veraPDF timed out after 60 seconds")); }
            JsonObject output = JsonParser.parseString(Files.readString(log)).getAsJsonObject();
            JsonArray jobs = output.getAsJsonObject("report").getAsJsonArray("jobs");
            if (jobs == null || jobs.size() != 1) return new Check("NOT_CHECKED", List.of("veraPDF did not return exactly one validation job"));
            JsonArray results = jobs.get(0).getAsJsonObject().getAsJsonArray("validationResult");
            if (results == null || results.isEmpty()) return new Check("NOT_CHECKED", List.of("veraPDF returned no validation result"));
            for (var result : results) if (!result.getAsJsonObject().get("compliant").getAsBoolean()) return new Check("FAIL", List.of("veraPDF explicitly validated --flavour 4f and reported noncompliance", results.toString()));
            if (process.exitValue() != 0) return new Check("NOT_CHECKED", List.of("veraPDF exited " + process.exitValue() + " despite a compliant result"));
            return new Check("PASS", List.of("veraPDF explicitly validated --flavour 4f", results.toString()));
        } catch (Exception e) { return new Check("NOT_CHECKED", List.of("veraPDF result unavailable: " + e.getMessage())); }
        finally { if (log != null) try { Files.deleteIfExists(log); } catch (IOException ignored) { } }
    }

    private static Check check(List<String> problems, String success) { return problems.isEmpty() ? new Check("PASS", List.of(success)) : new Check("FAIL", problems); }
    private static boolean matches(JsonObject image, SourceContent source)throws Exception{
        return source!=null&&source.digest().length()==image.get("size").getAsLong()&&source.digest().sha256().equals(required(image,"sha256"));
    }
    private static boolean sameBytes(Path source,SourceContent content)throws Exception{return SourceContent.file(source).digest().equals(content.digest());}
    private static String sha256(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    static SourceContent content(PDComplexFileSpecification specification)throws IOException{
        var unicode=specification.getEmbeddedFileUnicode();var embedded=unicode==null?specification.getEmbeddedFile():unicode;
        if(embedded==null)throw new IOException("Attachment has no embedded file stream");
        return new SourceContent(()->PdfStreams.open(embedded));
    }
    private static byte[] payload(PDComplexFileSpecification specification)throws IOException{
        try{return content(specification).array();}catch(IOException failure){throw failure;}catch(Exception failure){throw new IOException("Could not read package metadata",failure);}
    }
    private static void collect(PDEmbeddedFilesNameTreeNode node, Map<String, PDComplexFileSpecification> files, Set<COSDictionary> visited, int depth) throws IOException {
        if (depth > 32 || !visited.add(node.getCOSObject())) throw new IOException("Invalid embedded-file name tree");
        if (node.getNames() != null) for (var entry : node.getNames().entrySet()) if (files.put(entry.getKey(), entry.getValue()) != null) throw new IOException("Duplicate attachment name: " + entry.getKey());
        if (node.getKids() != null) for (var child : node.getKids()) collect((PDEmbeddedFilesNameTreeNode) child, files, visited, depth + 1);
    }
    private static boolean contains(COSArray array, COSDictionary object) { for (int i = 0; i < array.size(); i++) if (array.getObject(i) == object) return true; return false; }
    private static String required(JsonObject value, String key) throws IOException {
        if (!value.has(key) || value.get(key).isJsonNull()) throw new IOException("Required manifest field is missing: " + key);
        return value.get(key).getAsString();
    }
    private static String string(JsonObject value, String key, String fallback) { return value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsString() : fallback; }
    private static Path safeSource(Path input, String relative) throws IOException {
        Path root = input.toRealPath(); Path candidate = ArchivePath.resolve(root, relative);
        Path current = root;
        for (Path part : root.relativize(candidate)) { current = current.resolve(part); if (Files.isSymbolicLink(current)) throw new IOException("Symbolic link in source path: " + relative); }
        return candidate;
    }
    private static void writeNew(Path target, byte[] data) throws IOException { Files.createDirectories(target.getParent()); Files.write(target, data, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE); }
    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return;
        try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path); }
    }
}
