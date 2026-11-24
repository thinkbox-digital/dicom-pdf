package digital.thinkbox.dicompdf;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.imageio.plugins.dcm.DicomImageReadParam;
import org.dcm4che3.imageio.plugins.dcm.DicomImageReader;
import org.dcm4che3.imageio.plugins.dcm.DicomImageReaderSpi;

final class DesktopViewerDocument implements AutoCloseable {
    record Display(BufferedImage image, String text, int frames, List<Window> windows, double rowRatio,
                   List<DesktopViewerSpecial.Surface> surfaces, DesktopViewerSpecial.Spectrum spectrum,
                   DesktopViewerOverlay.Detail overlay) {
        Display(BufferedImage image, String text, int frames, List<Window> windows, double rowRatio) {
            this(image, text, frames, windows, rowRatio, List.of(), null, null);
        }
    }
    record Window(String label, float center, float width) {
        @Override public String toString() { return label; }
    }

    static final Window INITIAL = new Window("Initial display", 0, 0);
    private final PackageTools.Package archive;
    private final PDFRenderer renderer;
    private final Manifest manifest;
    private final SourceContent localDicom;
    private final DicomInput.Dataset localDataset;
    private Manifest.Image cachedEntry;
    private SourceContent cachedOriginal;
    private Map<String, DicomMetadataInventory.Image> metadataInventory;
    final Path path;
    final List<Manifest.Image> entries;

    static DesktopViewerDocument open(Path path) throws Exception {
        if (!Files.isRegularFile(path)) throw new IOException("Choose a DICOM file or DICOM PDF.");
        var localPath = path.toRealPath();
        var source = SourceContent.file(localPath);
        var prefix = new String(source.prefix(1024), StandardCharsets.ISO_8859_1);
        boolean part10 = prefix.startsWith("DICM", 128);
        if (!part10 && prefix.startsWith("%PDF-")) return new DesktopViewerDocument(path);
        DicomInput.Dataset dataset;
        try {
            dataset = viewerDataset(source);
        } catch (IOException | IllegalArgumentException invalid) {
            if (!part10 && (prefix.contains("%PDF-") || path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".pdf")))
                return new DesktopViewerDocument(path);
            throw new IOException("Could not read " + path.getFileName() + " as DICOM: " + invalid.getMessage(), invalid);
        }
        return new DesktopViewerDocument(path, source, dataset, Files.size(localPath));
    }

    private DesktopViewerDocument(Path path, SourceContent source, DicomInput.Dataset dataset, long size) {
        this.path = path;
        archive = null;
        renderer = null;
        manifest = null;
        localDicom = source;
        localDataset = dataset;
        var name = path.getFileName().toString();
        var fields = DicomInput.fields(dataset);
        entries = List.of(new Manifest.Image(name, name, fields.get("SOPInstanceUID"), null, size, 0,
                null, null, fields, true, false, false, null, null, null));
    }

    DesktopViewerDocument(Path path) throws Exception {
        this.path = path;
        localDicom = null;
        localDataset = null;
        archive = new PackageTools.Package(path);
        try {
            manifest = new Gson().fromJson(archive.manifest, Manifest.class);
            var sorted = new ArrayList<>(manifest.images());
            for (var entry : sorted) {
                ArchivePath.check(entry.sourcePath());
                ArchivePath.checkAttachment(entry.attachment());
            }
            sorted.sort(Comparator.comparing((Manifest.Image entry) -> field(entry, "StudyInstanceUID", ""))
                    .thenComparingInt(entry -> number(entry, "SeriesNumber", Integer.MAX_VALUE))
                    .thenComparing(entry -> field(entry, "SeriesInstanceUID", ""))
                    .thenComparingInt(entry -> number(entry, "InstanceNumber", Integer.MAX_VALUE)));
            entries = List.copyOf(sorted);
            renderer = new PDFRenderer(archive.pdf);
            renderer.setSubsamplingAllowed(true);
        } catch (Exception failure) {
            archive.close();
            throw failure;
        }
    }

    boolean isArchive() { return archive != null; }
    String profile() { return isArchive() ? manifest.profile() + " " + manifest.profileVersion() : "DICOM file"; }
    boolean hasInstitutionalEvidence() { return isArchive() && archive.manifest.has("security"); }
    int pages() { return isArchive() ? archive.pdf.getNumberOfPages() : 0; }
    long embeddedOriginalCount() {
        if (!isArchive()) return 0;
        return entries.stream().filter(entry -> archive.files.containsKey(entry.attachment())).count();
    }
    List<Manifest.Reference> references() { return !isArchive() || manifest.references() == null ? List.of() : manifest.references(); }
    boolean hasXmp() { return isArchive() && archive.pdf.getDocumentCatalog().getMetadata() != null; }

    void saveXmp(Path destination) throws Exception {
        if (!hasXmp()) throw new IOException("This PDF does not contain document XMP.");
        var metadata = archive.pdf.getDocumentCatalog().getMetadata();
        write(destination, output -> {
            try (var input = PdfStreams.open(metadata)) { input.transferTo(output); }
        });
    }

    private Map<String, DicomMetadataInventory.Image> metadataInventory() throws Exception {
        if (metadataInventory != null) return metadataInventory;
        String name = "dicom-metadata.json";
        Integer version = manifest.metadataXmpVersion();
        if (version == null && !archive.files.containsKey(name)) return metadataInventory = Map.of();
        String checksum = manifest.artifactSha256() == null ? null : manifest.artifactSha256().get(name);
        if (checksum == null) throw new IOException("Metadata inventory has no recorded SHA-256.");
        var source = checkedTechnical(name);
        if (source.digest().length() > Runtime.getRuntime().maxMemory() / 6)
            throw new IOException("The metadata inventory exceeds this viewer's available heap.");
        if (version != null) {
            if (version != 1 || !hasXmp()) throw new IOException("Unsupported or missing full metadata XMP.");
            var problems = new ArrayList<String>();
            try (var packet = PdfStreams.open(archive.pdf.getDocumentCatalog().getMetadata());
                 var sidecar = new java.io.InputStreamReader(source.open(), java.nio.charset.StandardCharsets.UTF_8.newDecoder())) {
                PackageTools.compareXmp(packet, Map.of(
                        "metadataVersion", new java.io.StringReader("1"),
                        "metadataSha256", new java.io.StringReader(checksum),
                        "inventoryJson", new java.io.InputStreamReader(new java.io.ByteArrayInputStream(archive.manifestBytes),
                                java.nio.charset.StandardCharsets.UTF_8.newDecoder()),
                        "metadataJson", sidecar), problems);
            }
            if (!problems.isEmpty()) throw new IOException(String.join("\n", problems));
        }
        try (var input = new java.io.InputStreamReader(source.open(), java.nio.charset.StandardCharsets.UTF_8.newDecoder())) {
            var inventory = new Gson().fromJson(input, DicomMetadataInventory.Inventory.class);
            if (inventory == null || inventory.schemaVersion() != 1 || inventory.images() == null
                    || inventory.images().size() != entries.size()) throw new IOException("Invalid metadata inventory or source count.");
            var records = new java.util.HashMap<String, DicomMetadataInventory.Image>();
            for (var record : inventory.images()) {
                if (record == null || record.attachment() == null || records.putIfAbsent(record.attachment(), record) != null)
                    throw new IOException("Metadata inventory contains an invalid or repeated source mapping.");
            }
            metadataInventory = Map.copyOf(records);
            return metadataInventory;
        }
    }

    DicomMetadataInventory.Image metadataRecord(Manifest.Image entry) throws Exception {
        if (!isArchive()) throw new IOException("Archive metadata export requires a DICOM PDF.");
        var original = checked(entry);
        var inventory = metadataInventory();
        if (inventory.isEmpty()) return DicomMetadataInventory.captureImage(entry.attachment(), entry.sourcePath(), original);
        var result = inventory.get(entry.attachment());
        if (result == null || !entry.sourcePath().equals(result.sourcePath()) || !entry.sha256().equals(result.sha256())
                || !java.util.Objects.equals(entry.sopInstanceUID(), result.sopInstanceUID()) || result.elements() == null)
            throw new IOException("Metadata source mapping differs for " + entry.attachment());
        return result;
    }
    Map<String, Object> selectedMetadata(Manifest.Image source) throws Exception {
        if (!isArchive()) {
            var values = new java.util.LinkedHashMap<String, Object>();
            values.put("Source file", source.sourcePath());
            values.put("File size", source.size());
            DesktopViewerMetadata.addDisplayFields(values, source);
            return values;
        }
        var values = DesktopViewerMetadata.sourceFacts(source);
        if (manifest.schemaVersion() == 1 && source.sourceFrame() == null && "rendered".equals(source.status()))
            values.put("Source frame", "1 (legacy)");
        var declaration = sourceDeclaration(archive.manifest, source);
        if (declaration != null) {
            if (declaration.get("parsing") instanceof JsonObject parsing) {
                values.put("Parsing mode", jsonValue(parsing, "mode"));
                values.put("Parsing transfer syntax", jsonValue(parsing, "transferSyntaxUID"));
                values.put("Transfer syntax source", jsonValue(parsing, "transferSyntaxSource"));
            }
            if (jsonValue(declaration, "kind") != null) values.put("Input kind", jsonValue(declaration, "kind"));
            if (jsonValue(declaration, "archiveStatus") != null)
                values.put("Archive expansion status", jsonValue(declaration, "archiveStatus"));
            addIssueText(values, "Input diagnostics", declaration, "diagnostics", ", ", issue -> jsonValue(issue, "code"));
        }
        String integrity = "Original attachment missing";
        if (archive.files.containsKey(source.attachment())) {
            try {
                checked(source);
                integrity = "Matches recorded checksum";
            } catch (IOException failure) {
                integrity = "Does not match recorded checksum";
            }
        }
        values.put("Original integrity", integrity);
        values.put("Interactive display", "Not checked");
        if (declaration != null && declaration.get("navigationFields") instanceof JsonObject navigation)
            navigation.keySet().forEach(key -> values.put(key, jsonValue(navigation, key)));
        DesktopViewerMetadata.addDisplayFields(values, source);
        addStoredMetadataChecks(values, source);
        return values;
    }

    private void addStoredMetadataChecks(Map<String, Object> values, Manifest.Image source) {
        var input = storedInventory("dicom-validation.json");
        var record = sourceDeclaration(input, source);
        if (record != null) {
            values.put("DICOM input checks", jsonValue(record, "status"));
            values.put("DICOM check scope", jsonValue(input, "standardEdition") + " documented subset; full IOD validation not established");
            addIssueText(values, "DICOM findings", record, "issues", "\n",
                    issue -> jsonValue(issue, "severity") + " · " + jsonValue(issue, "code") + ": " + jsonValue(issue, "message"));
        }
        var structure = storedInventory("dicom-structure.json");
        record = sourceDeclaration(structure, source);
        if (record == null) return;
        values.put("Stored structural checks", jsonValue(record, "status"));
        values.put("Structural check scope", jsonValue(structure, "standardEdition")
                + " · selected module rules and pixel structure; full IOD validity not established");
        if (record.get("checks") instanceof JsonObject checks && checks.get("pixelStructure") instanceof JsonObject pixel)
            values.put("Pixel structure check", jsonValue(pixel, "status") + " · " + jsonValue(pixel, "scope"));
        if (jsonValue(record, "suppliedPixelBytes") != null) values.put("Encoded pixel bytes", jsonValue(record, "suppliedPixelBytes"));
        if (jsonValue(record, "expectedPixelBytes") != null) values.put("Expected native pixel bytes", jsonValue(record, "expectedPixelBytes"));
        addIssueText(values, "Structural findings", record, "issues", "\n", issue ->
                jsonValue(issue, "severity") + " · " + jsonValue(issue, "code") + " · "
                        + jsonValue(issue, "path") + ": " + jsonValue(issue, "message"));
    }

    private JsonObject storedInventory(String name) {
        if (manifest.artifactSha256() == null || !manifest.artifactSha256().containsKey(name) || !archive.files.containsKey(name))
            return null;
        try {
            var content = checkedTechnical(name);
            if (content.digest().length() > Runtime.getRuntime().maxMemory() / 6) return null;
            try (var reader = new java.io.InputStreamReader(content.open(), java.nio.charset.StandardCharsets.UTF_8.newDecoder())) {
                if (JsonParser.parseReader(reader) instanceof JsonObject inventory) return inventory;
            }
        } catch (Exception unavailable) {
            // The optional viewer rows require a readable, checksum-verified inventory.
        }
        return null;
    }

    private static JsonObject sourceDeclaration(JsonObject inventory, Manifest.Image source) {
        if (inventory == null || !(inventory.get("images") instanceof com.google.gson.JsonArray images)) return null;
        for (var item : images) {
            if (item instanceof JsonObject image && source.attachment().equals(jsonValue(image, "attachment"))
                    && source.sourcePath().equals(jsonValue(image, "sourcePath")) && source.sha256().equals(jsonValue(image, "sha256")))
                return image;
        }
        return null;
    }

    private static void addIssueText(Map<String, Object> values, String label, JsonObject record, String key,
                                     String separator, java.util.function.Function<JsonObject, String> format) {
        if (!(record.get(key) instanceof com.google.gson.JsonArray issues) || issues.isEmpty()) return;
        var lines = new ArrayList<String>();
        for (var issue : issues) if (issue instanceof JsonObject details) lines.add(format.apply(details));
        if (!lines.isEmpty()) values.put(label, String.join(separator, lines));
    }

    private static String jsonValue(JsonObject object, String key) {
        return object.get(key) instanceof com.google.gson.JsonPrimitive value ? value.getAsString() : null;
    }

    List<String> technicalFiles() {
        if (!isArchive()) return List.of();
        var names = new LinkedHashSet<>(archive.files.keySet());
        entries.forEach(entry -> names.remove(entry.attachment()));
        return List.copyOf(names);
    }

    private SourceContent checkedTechnical(String name) throws Exception {
        if (!isArchive()) throw new IOException("There are no embedded files in a standalone DICOM file.");
        var content = PackageTools.content(archive.requireFile(name));
        var checksums = manifest.artifactSha256();
        String expected = checksums == null ? null : checksums.get(name);
        if (expected != null && !expected.equalsIgnoreCase(content.digest().sha256()))
            throw new IOException("Package file SHA-256 differs from the manifest: " + name);
        return content;
    }

    BufferedImage page(int page) throws IOException {
        if (!isArchive()) throw new IOException("There are no PDF pages in a standalone DICOM file.");
        return renderPage(renderer, archive.pdf, page);
    }

    BufferedImage thumbnail(int page) throws IOException {
        if (page < 1 || page > pages()) return null;
        var resources = archive.pdf.getPage(page - 1).getResources();
        if (resources == null) return null;
        for (var key : resources.getXObjectNames()) {
            if (resources.getXObject(key) instanceof org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject image) {
                int sampling = Math.max(1, Math.max(image.getWidth(), image.getHeight()) / 96);
                return image.getImage(null, sampling);
            }
        }
        return null;
    }

    private static BufferedImage renderPage(PDFRenderer renderer, org.apache.pdfbox.pdmodel.PDDocument pdf, int page)
            throws IOException {
        var crop = pdf.getPage(page - 1).getCropBox();
        float largest = Math.max(crop.getWidth(), crop.getHeight());
        if (!Float.isFinite(largest) || largest <= 0) throw new IOException("Invalid PDF page dimensions");
        return renderer.renderImage(page - 1, Math.min(2, 1600 / largest));
    }

    Display load(Manifest.Image entry, int frame, Window window) throws Exception {
        SourceContent original = checked(entry);
        DicomInput.Dataset dataset;
        try {
            dataset = isArchive() ? viewerDataset(original) : localDataset;
        } catch (IOException invalid) {
            if (field(entry, "SOPClassUID", "").isBlank()) return supporting(original, entry.size());
            throw invalid;
        }
        Attributes attributes = dataset.attributes();
        String instance = attributes.getString(Tag.SOPInstanceUID);
        if (entry.sopInstanceUID() != null && !entry.sopInstanceUID().isBlank() && !entry.sopInstanceUID().equals(instance))
            throw new IOException("DICOM SOP Instance UID differs from the manifest.");
        int frames = Math.max(1, attributes.getInt(Tag.NumberOfFrames, 1));
        var windows = windows(DicomInput.effectiveAttributes(attributes, frame - 1));
        String sop = attributes.getString(Tag.SOPClassUID, "");
        if (UID.SurfaceSegmentationStorage.equals(sop)) {
            var surfaces = DesktopViewerSpecial.surfaces(DesktopViewerSpecial.read(original));
            return new Display(null, "", 1, windows, 1, surfaces, null, null);
        }
        if (UID.MRSpectroscopyStorage.equals(sop)) {
            var spectrum = DesktopViewerSpecial.spectrum(DesktopViewerSpecial.read(original));
            return new Display(null, "", 1, windows, 1, List.of(), spectrum, null);
        }
        if (UID.EncapsulatedPDFStorage.equals(sop)) {
            if (!isArchive())
                return new Display(null, "This DICOM object contains an encapsulated PDF. Selected file metadata is available.",
                        1, windows, 1);
            byte[] bytes = DesktopViewerSpecial.read(original).getBytes(Tag.EncapsulatedDocument);
            if (bytes == null) throw new IOException("Missing encapsulated PDF");
            try (var embedded = org.apache.pdfbox.Loader.loadPDF(bytes)) {
                return new Display(renderPage(new PDFRenderer(embedded), embedded, 1), "Encapsulated PDF · First page", 1, windows, 1);
            }
        }
        if (UID.GrayscaleSoftcopyPresentationStateStorage.equals(sop)) {
            var link = references().stream()
                    .filter(reference -> entry.attachment().equals(reference.sourceAttachment()))
                    .filter(reference -> reference.resolvedAttachments() != null && reference.resolvedAttachments().size() == 1)
                    .findFirst();
            if (link.isPresent()) {
                var target = entries.stream().filter(candidate -> link.get().resolvedAttachments().contains(candidate.attachment())).findFirst();
                if (target.isPresent()) {
                    var targetOriginal = checked(target.get());
                    var targetDataset = DicomInput.dataset(targetOriginal);
                    var saved = DesktopViewerSpecial.read(original);
                    int referencedFrame = link.get().frames() == null || link.get().frames().isEmpty() ? 1 : link.get().frames().getFirst();
                    var image = readImage(targetOriginal, targetDataset.attributes(), targetDataset.syntax(), referencedFrame, INITIAL, saved);
                    return raster(image, "Grayscale presentation state", 1, windows, targetDataset.attributes(), referencedFrame, INITIAL, null);
                }
            }
        }
        if (UID.ParametricMapStorage.equals(sop)) {
            var complete = DesktopViewerSpecial.read(original);
            if (complete.containsValue(Tag.FloatPixelData) || complete.containsValue(Tag.DoubleFloatPixelData))
                return raster(DesktopViewerSpecial.floating(complete, frame, window), "", frames, windows, attributes, frame, window, null);
        }
        if (UID.RTDoseStorage.equals(sop) && (DicomCodecs.NATIVE.contains(dataset.syntax()) || UID.RLELossless.equals(dataset.syntax()))) {
            var dose = UID.RLELossless.equals(dataset.syntax()) ? DesktopViewerSpecial.rleDose(original, attributes, frame)
                    : DesktopViewerSpecial.dose(DesktopViewerSpecial.read(original), frame);
            return raster(dose.image(), dose.legend(), frames, windows, attributes, frame, window, null);
        }
        int stored = attributes.getInt(Tag.BitsStored, 0);
        int high = attributes.getInt(Tag.HighBit, -1);
        int rows = attributes.getInt(Tag.Rows, 0), columns = attributes.getInt(Tag.Columns, 0);
        int planar = attributes.getInt(Tag.PlanarConfiguration, -1);
        if ("RGB".equals(attributes.getString(Tag.PhotometricInterpretation)) && attributes.getInt(Tag.BitsAllocated, 0) == 16
                && attributes.getInt(Tag.SamplesPerPixel, 0) == 3 && attributes.getInt(Tag.PixelRepresentation, 0) == 0
                && stored > 0 && stored <= 16 && high >= stored - 1 && high < 16
                && planar >= 0 && planar <= 1 && rows > 0 && columns > 0 && (long) rows * columns <= 16_777_216
                && frame >= 1 && frame <= frames
                && (DicomCodecs.NATIVE.contains(dataset.syntax()) || UID.RLELossless.equals(dataset.syntax()))) {
            var pixels = Rgb32Reader.readWide(original, dataset.syntax(), frame - 1, frames, rows, columns, planar, stored, high, 2);
            return raster(pixels, "", frames, windows, attributes, frame, window, null);
        }
        if (attributes.getInt(Tag.Rows, 0) <= 0 || attributes.getInt(Tag.Columns, 0) <= 0)
            return new Display(null, attributes.toString(250, 160), frames, windows, 1);
        if (window == INITIAL) {
            var preview = DicomInput.inspectForPreview(original, frame, entry.displayAdjustments());
            if (preview.image() != null)
                return raster(preview.image(), "", frames, windows, attributes, frame, window, preview.displayAdjustments());
        }
        return raster(readImage(original, attributes, dataset.syntax(), frame, window, null), "", frames, windows,
                attributes, frame, window, null);
    }

    private static Display raster(BufferedImage image, String notes, int frames, List<Window> windows,
                                  Attributes attributes, int frame, Window window, Map<String, String> display) {
        return new Display(image, notes, frames, windows, ratio(attributes), List.of(), null,
                DesktopViewerOverlay.detail(attributes, frame, window, display));
    }

    private static DicomInput.Dataset viewerDataset(SourceContent original) throws IOException {
        try (var input = new org.dcm4che3.io.DicomInputStream(original.open())) {
            input.setIncludeBulkData(org.dcm4che3.io.DicomInputStream.IncludeBulkData.NO);
            input.readFileMetaInformation();
            String syntax = input.getTransferSyntax();
            var attributes = input.readDataset();
            if (!attributes.containsValue(Tag.SOPClassUID) && !attributes.containsValue(Tag.SOPInstanceUID)
                    && !attributes.contains(Tag.DirectoryRecordSequence)) throw new IOException("This attachment is not a DICOM dataset");
            return new DicomInput.Dataset(attributes, syntax);
        }
    }

    private static Display supporting(SourceContent source, long size) throws Exception {
        byte[] prefix = source.prefix(1024);
        if (new String(prefix, java.nio.charset.StandardCharsets.ISO_8859_1).contains("%PDF-")
                && size < 64L * 1024 * 1024) {
            try (var pdf = org.apache.pdfbox.Loader.loadPDF(source.array())) {
                return new Display(renderPage(new PDFRenderer(pdf), pdf, 1), "Supporting PDF · First page", 1, List.of(INITIAL), 1);
            }
        }
        try (var input = source.imageInput()) {
            var readers = javax.imageio.ImageIO.getImageReaders(input);
            if (readers.hasNext()) {
                var reader = readers.next();
                try {
                    reader.setInput(input);
                    if ((long) reader.getWidth(0) * reader.getHeight(0) > 16_777_216) throw new IOException("Supporting image exceeds preview limits");
                    return new Display(reader.read(0), "Supporting image", 1, List.of(INITIAL), 1);
                } finally { reader.dispose(); }
            }
        }
        if (size <= 1024 * 1024 && java.util.stream.IntStream.range(0, prefix.length).noneMatch(i -> prefix[i] == 0)) {
            try {
                String text = java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(source.array())).toString();
                return new Display(null, text, 1, List.of(INITIAL), 1);
            } catch (java.nio.charset.CharacterCodingException ignored) {}
        }
        return new Display(null, "Preview unavailable. Save the file to open it in another application.", 1, List.of(INITIAL), 1);
    }

    private static BufferedImage readImage(SourceContent content, Attributes attributes, String syntax, int frame, Window window,
                                           Attributes presentationState)
            throws Exception {
        long pixels = (long) attributes.getInt(Tag.Rows, 0) * attributes.getInt(Tag.Columns, 0);
        if (pixels <= 0 || pixels > 16_777_216) throw new IOException("Invalid or excessive DICOM dimensions");
        boolean highThroughput = DicomCodecs.HIGH_THROUGHPUT_JPEG_2000.contains(syntax);
        if (!highThroughput && !DicomCodecs.supported(syntax, true))
            throw new IOException("No Java decoder for transfer syntax " + syntax);
        DicomCodecs.ensureConfigured();
        if (highThroughput) DicomCodecs.configureViewerJpeg2000();
        boolean deflated = UID.DeflatedExplicitVRLittleEndian.equals(syntax);
        boolean extended = UID.JPEGExtended12Bit.equals(syntax) && attributes.getInt(Tag.BitsAllocated, 0) == 16;
        try (var reader = new DicomImageReader(new DicomImageReaderSpi());
             var input = deflated || extended ? null : content.imageInput();
             var stream = deflated ? new org.dcm4che3.io.DicomInputStream(content.open()) : null) {
            if (extended) {
                var effective = DicomInput.effectiveAttributes(attributes, frame - 1);
                reader.setInput(JpegExtended.unpack(content, effective, frame - 1,
                        attributes.getInt(Tag.Rows, 0), attributes.getInt(Tag.Columns, 0)));
            } else reader.setInput(deflated ? stream : input);
            var parameters = (DicomImageReadParam) reader.getDefaultReadParam();
            parameters.setOverlayActivationMask(0);
            if (presentationState != null) parameters.setPresentationState(presentationState);
            if (window != INITIAL) {
                parameters.setAutoWindowing(false);
                parameters.setPreferWindow(true);
                parameters.setWindowCenter(window.center());
                parameters.setWindowWidth(window.width());
            }
            CompressedDicomReader.VIEWER_JPEG_LS_COMPATIBILITY.set(true);
            return reader.read(extended ? 0 : frame - 1, parameters);
        } finally {
            CompressedDicomReader.VIEWER_JPEG_LS_COMPATIBILITY.remove();
        }
    }

    private static List<Window> windows(Attributes attributes) {
        var result = new ArrayList<Window>();
        result.add(INITIAL);
        var centers = attributes.getFloats(Tag.WindowCenter);
        var widths = attributes.getFloats(Tag.WindowWidth);
        var labels = attributes.getStrings(Tag.WindowCenterWidthExplanation);
        if (centers != null && widths != null) {
            for (int index = 0; index < Math.min(centers.length, widths.length); index++) {
                if (!Float.isFinite(centers[index]) || !Float.isFinite(widths[index]) || widths[index] <= 0) continue;
                String label = labels != null && index < labels.length && labels[index] != null
                        ? labels[index] : "Window " + (index + 1);
                result.add(new Window(label, centers[index], widths[index]));
            }
        }
        return List.copyOf(result);
    }

    private static double ratio(Attributes attributes) {
        var spacing = attributes.getDoubles(Tag.PixelSpacing);
        if (spacing == null || spacing.length != 2) {
            var aspect = attributes.getInts(Tag.PixelAspectRatio);
            if (aspect != null && aspect.length == 2) spacing = new double[]{aspect[0], aspect[1]};
        }
        if (spacing == null || spacing.length != 2 || spacing[0] <= 0 || spacing[1] <= 0) return 1;
        double ratio = spacing[0] / spacing[1];
        return Double.isFinite(ratio) && ratio >= 0.01 && ratio <= 100 ? ratio : 1;
    }

    SourceContent checked(Manifest.Image entry) throws Exception {
        if (!isArchive()) {
            if (entry != entries.getFirst()) throw new IOException("DICOM source does not belong to the open file.");
            return localDicom;
        }
        if (cachedEntry == entry) return cachedOriginal;
        SourceContent original = PackageTools.content(archive.requireFile(entry.attachment()));
        var digest = original.digest();
        if (digest.length() != entry.size() || !digest.sha256().equalsIgnoreCase(entry.sha256()))
            throw new IOException("Original does not match its recorded size and SHA-256: " + entry.sourcePath());
        cachedEntry = entry;
        cachedOriginal = original;
        return cachedOriginal;
    }

    void saveOriginal(Manifest.Image entry, Path destination) throws Exception {
        var source = checked(entry);
        write(destination, output -> {
            try (var input = source.open()) { input.transferTo(output); }
        });
    }

    void saveZip(List<Manifest.Image> scope, boolean all, Path destination) throws Exception {
        if (!isArchive()) throw new IOException("An originals ZIP export requires a DICOM PDF.");
        var paths = new java.util.TreeSet<String>();
        for (var entry : scope) {
            String normalized = java.text.Normalizer.normalize(entry.sourcePath(), java.text.Normalizer.Form.NFC)
                    .toLowerCase(java.util.Locale.ROOT);
            if (!paths.add(normalized)) throw new IOException("Originals have colliding ZIP recovery paths");
        }
        for (String name : paths) {
            String child = paths.ceiling(name + "/");
            if (child != null && child.startsWith(name + "/")) throw new IOException("A ZIP recovery path is both a file and a folder");
        }
        write(destination, output -> {
            try (var zip = new ZipOutputStream(output)) {
                var inventory = new ArrayList<Map<String, Object>>();
                for (var entry : scope) {
                    String name = "originals/" + entry.sourcePath();
                    zip.putNextEntry(new ZipEntry(name));
                    try (var input = checked(entry).open()) { input.transferTo(zip); }
                    zip.closeEntry();
                    inventory.add(Map.of("attachment", entry.attachment(), "sourcePath", entry.sourcePath(),
                            "zipPath", name, "size", entry.size(), "sha256", entry.sha256()));
                }
                if (all) {
                    for (String attachment : technicalFiles()) {
                        var content = checkedTechnical(attachment);
                        zip.putNextEntry(new ZipEntry("package/" + attachment));
                        try (var input = content.open()) { input.transferTo(zip); }
                        zip.closeEntry();
                    }
                }
                String manifestHash = SourceContent.of(archive.manifestBytes).digest().sha256();
                zip.putNextEntry(new ZipEntry("export-inventory.json"));
                zip.write(new Gson().toJson(Map.of("sourceManifestSha256", manifestHash, "originals", inventory))
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        });
    }

    @FunctionalInterface
    interface Writer { void write(OutputStream output) throws Exception; }

    static void write(Path destination, Writer writer) throws Exception {
        Path parent = destination.toAbsolutePath().getParent();
        Path staging = Files.createTempFile(parent, ".dicom-viewer-", ".tmp");
        try {
            try (var output = Files.newOutputStream(staging)) { writer.write(output); }
            Files.move(staging, destination, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(staging);
        }
    }

    static String field(Manifest.Image entry, String key, String fallback) {
        return (entry.fields() == null ? Map.<String, String>of() : entry.fields()).getOrDefault(key, fallback);
    }

    static int number(Manifest.Image entry, String key, int fallback) {
        try { return Integer.parseInt(field(entry, key, "")); }
        catch (NumberFormatException ignored) { return fallback; }
    }

    @Override public void close() throws IOException {
        if (isArchive()) archive.close();
    }
}
