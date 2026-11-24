package digital.thinkbox.dicompdf;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.common.filespecification.PDEmbeddedFile;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Cross-checks source bytes and metadata independently of the creation manifest. */
class PackageToolsTest {
    @TempDir Path temporary;

    @Test void independentlyRecoversReferencesAndDuplicateIdentifiersWithoutLosingOriginals() throws Exception {
        Path sources = temporary.resolve("masters");
        SyntheticFixtures.writeReferences(sources);
        Path pdf = temporary.resolve("references.pdf");
        DicomPdf.create(sources, pdf);
        JsonObject manifest = manifest(pdf);
        assertEquals(5, manifest.getAsJsonArray("images").size());
        JsonObject duplicates = manifest.getAsJsonObject("duplicateInstanceUIDs");
        assertEquals(3, duplicates.getAsJsonArray(SyntheticFixtures.STUDY_UID + ".203").size());
        var statusCounts = new HashMap<String,Integer>();
        for (JsonElement reference : manifest.getAsJsonArray("references")) statusCounts.merge(reference.getAsJsonObject().get("status").getAsString(), 1, Integer::sum);
        assertEquals(Map.of("resolved", 1, "missing", 2, "ambiguous", 1, "invalid-frame", 1), statusCounts);
        var checked = PackageTools.verify(pdf, sources, null);
        assertEquals("NOT_CHECKED", checked.pdfa4f().status());
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("PASS", checked.externalSources().status());
        assertEquals("PASS", checked.metadataAccuracy().status());
        assertEquals("UNRESOLVED", checked.unresolvedReferences().status());
        assertEquals(2, checked.exitCode());
        String inspection = PackageTools.inspect(pdf).toLowerCase(Locale.ROOT);
        for (String fact : List.of("supplied", "embedded", "display", "reject", "missing", "ambiguous")) assertTrue(inspection.contains(fact), fact);
        Path recovered = temporary.resolve("recovery");
        var extraction = PackageTools.extract(pdf, recovered);
        assertEquals(5, extraction.originals());
        try (var files = Files.walk(sources)) {
            for (Path original : files.filter(Files::isRegularFile).toList()) assertArrayEquals(Files.readAllBytes(original), Files.readAllBytes(recovered.resolve("originals").resolve(sources.relativize(original))));
        }
        assertTrue(Files.isRegularFile(recovered.resolve("package/RECOVERY.txt")));
        assertThrows(Exception.class, () -> PackageTools.extract(pdf, recovered), "Recovery never overwrites an existing directory");
    }

    @Test void detectsAlteredMetadataEvenWhenManifestAndXmpAgree() throws Exception {
        Path sources = temporary.resolve("input");
        SyntheticFixtures.writeDeidentifiedCopy(sources);
        Path original = temporary.resolve("original.pdf");
        DicomPdf.create(sources, original, "deidentified-copy");
        JsonObject changed = manifest(original);
        changed.getAsJsonArray("images").get(0).getAsJsonObject().getAsJsonObject("fields").addProperty("PatientID", "INVENTED");
        Path tampered = temporary.resolve("altered-metadata.pdf");
        writeManifest(original, tampered, changed);
        var checked = PackageTools.verify(tampered, sources, null);
        assertEquals("PASS", checked.sourceBytes().status(), "Metadata alteration must not be confused with original-byte loss");
        assertEquals("PASS", checked.externalSources().status());
        assertEquals("FAIL", checked.metadataAccuracy().status(), "Compare fields with original DICOM rather than trusting agreeing XMP and JSON");
        assertEquals("PASS", checked.unresolvedReferences().status());
        assertEquals(1, checked.exitCode());
    }

    @Test void detectsRemovedReferenceRecordsByReparsingSources() throws Exception {
        Path sources = temporary.resolve("input"); SyntheticFixtures.writeReferences(sources);
        Path original = temporary.resolve("original.pdf"); DicomPdf.create(sources, original);
        JsonObject changed = manifest(original); changed.add("references", new JsonArray());
        Path altered = temporary.resolve("altered-references.pdf"); writeManifest(original, altered, changed);
        var checked = PackageTools.verify(altered, null, null);
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("FAIL", checked.metadataAccuracy().status());
        assertEquals("UNRESOLVED", checked.unresolvedReferences().status(), "Missing references must be independently discovered");
    }

    @Test void comparesExternalSourcesSeparatelyAndRejectsRecoveryPathTraversal() throws Exception {
        Path sources = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(sources);
        Path pdf = temporary.resolve("master.pdf"); DicomPdf.create(sources, pdf);
        Files.writeString(sources.resolve("derived-copy.dcm"), "Different external bytes");
        var checked = PackageTools.verify(pdf, sources, null);
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("FAIL", checked.externalSources().status());
        assertEquals("PASS", checked.metadataAccuracy().status());
        JsonObject malicious = manifest(pdf);
        malicious.getAsJsonArray("images").get(0).getAsJsonObject().addProperty("sourcePath", "../../escaped.dcm");
        Path altered = temporary.resolve("unsafe.pdf"); writeManifest(pdf, altered, malicious);
        assertThrows(Exception.class, () -> PackageTools.extract(altered, temporary.resolve("unsafe-recovery")));
        assertFalse(Files.exists(temporary.resolve("escaped.dcm")));
    }

    @Test void archivalMastersAndDeclaredDeidentifiedCopiesRemainSeparate() throws Exception {
        Path masters = temporary.resolve("masters"); SyntheticFixtures.writeReferences(masters);
        Path masterSource = masters.resolve("resolved-target.dcm"); byte[] before = Files.readAllBytes(masterSource);
        Path derived = temporary.resolve("derived"); SyntheticFixtures.writeDeidentifiedCopy(derived);
        Path masterPdf = temporary.resolve("master.pdf"), derivedPdf = temporary.resolve("derived.pdf");
        DicomPdf.create(masters, masterPdf);
        DicomPdf.create(derived, derivedPdf, "deidentified-copy");
        JsonObject archival = manifest(masterPdf), copy = manifest(derivedPdf);
        assertEquals("archival-master", archival.get("sourceRole").getAsString());
        assertEquals("deidentified-copy", copy.get("sourceRole").getAsString());
        assertEquals(1, copy.getAsJsonArray("images").size());
        JsonObject copyFields = copy.getAsJsonArray("images").get(0).getAsJsonObject().getAsJsonObject("fields");
        assertFalse(copyFields.has("PatientID")); assertFalse(copyFields.has("PatientName"));
        assertArrayEquals(before, Files.readAllBytes(masterSource), "Creating a derived package must never alter master files");
        assertEquals("PASS", PackageTools.verify(derivedPdf, derived, null).metadataAccuracy().status());
        assertThrows(IllegalArgumentException.class, () -> DicomPdf.create(derived, temporary.resolve("invalid.pdf"), "automatically-deidentified"));
    }

    @Test void detectsAlteredPreviewWithoutConfusingItWithSourceLoss() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(input);
        Path original = temporary.resolve("original.pdf"); DicomPdf.create(input, original);
        JsonObject manifest = manifest(original);
        int referencePage = manifest.getAsJsonArray("images").get(0).getAsJsonObject().get("referencePage").getAsInt();
        Path changed = temporary.resolve("altered-preview.pdf");
        try (PDDocument pdf = Loader.loadPDF(original.toFile())) {
            var page = pdf.getPage(referencePage - 1);
            boolean edited = false;
            for (COSName name : page.getResources().getXObjectNames()) {
                if (page.getResources().getXObject(name) instanceof org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject image) {
                    var pixels = image.getImage();
                    pixels.setRGB(0, 0, pixels.getRGB(0, 0) ^ 0x00ffffff);
                    page.getResources().put(name, org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory.createFromImage(pdf, pixels));
                    edited = true;
                    break;
                }
            }
            assertTrue(edited, "Fixture has no preview to tamper");
            pdf.save(changed.toFile());
        }
        var checked = PackageTools.verify(changed, input, null);
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("PASS", checked.externalSources().status());
        assertEquals("FAIL", checked.metadataAccuracy().status(), "Preview pixels must match recorded source/frame/display rendering");
    }

    @Test void invalidManifestPathsAndUnreadableReferenceCoverageAreExplicit() throws Exception {
        Path input = temporary.resolve("input");
        SyntheticFixtures.writeDeidentifiedCopy(input);
        Files.createFile(input.resolve("empty.dcm"));
        Path pdf = temporary.resolve("mixed.pdf");
        DicomPdf.create(input, pdf);
        assertEquals("NOT_CHECKED", PackageTools.verify(pdf, null, null).unresolvedReferences().status());
        for (String path : List.of("a//b", "dir/", "/dir", "a/./b", "a/../b", "a\tb", "a\nb", "a\u007fb", "a:b", "a\\b")) {
            assertThrows(java.io.IOException.class, () -> ArchivePath.check(path), path);
        }
        JsonObject changed = manifest(pdf);
        changed.getAsJsonArray("images").get(0).getAsJsonObject().addProperty("sourcePath", "a\tb");
        Path altered = temporary.resolve("invalid-path.pdf");
        writeManifest(pdf, altered, changed);
        var report = PackageTools.verify(altered, null, null);
        assertTrue(report.metadataAccuracy().details().stream().anyMatch(d -> d.contains("Unsafe manifest sourcePath")));
        assertThrows(java.io.IOException.class, () -> PackageTools.extract(altered, temporary.resolve("invalid-recovery")));
        try (PDDocument document = Loader.loadPDF(pdf.toFile())) {
            var attachment = document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("RECOVERY.txt");
            String recovery = new String(attachment.getEmbeddedFileUnicode().toByteArray(), StandardCharsets.UTF_8);
            assertTrue(recovery.startsWith("DICOM image preservation profile 0.4.0"));
            assertTrue(recovery.contains("content-credentials.c2pa"));
        }
    }

    @Test void profileVerificationAndRecoveryStillHandleLegacyViewerAttachments() throws Exception {
        Path input = temporary.resolve("inputs");
        SyntheticFixtures.writeDeidentifiedCopy(input);
        Path generated = temporary.resolve("generated.pdf");
        DicomPdf.create(input, generated, "archival-master", false);
        String attachmentName = "viewer.html";
        byte[] viewerBytes = "<!doctype html><title>Historical viewer fixture</title>".getBytes(StandardCharsets.UTF_8);
        Path staged = temporary.resolve("staged.pdf");
        try (var document = Loader.loadPDF(generated.toFile())) {
            var catalog = document.getDocumentCatalog();
            var tree = catalog.getNames().getEmbeddedFiles();
            var names = new TreeMap<>(tree.getNames());
            var viewer = new Attachments(document).add(attachmentName, viewerBytes, "text/html", "Supplement", "Historical viewer fixture");
            assertNull(names.putIfAbsent(attachmentName, viewer));
            catalog.getCOSObject().getCOSArray(COSName.getPDFName("AF")).add(viewer);
            tree.setNames(names);
            document.save(staged.toFile());
        }
        var manifest = manifest(generated);
        var artifacts = manifest.getAsJsonObject("artifactSha256");
        artifacts.addProperty(attachmentName, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(viewerBytes)));
        Path archive = temporary.resolve("legacy-viewer.pdf");
        writeManifest(staged, archive, manifest);
        assertEquals("PASS", PackageTools.verify(archive, input, null).metadataAccuracy().status());
        Path recovered = temporary.resolve("recovered");
        assertEquals(1, PackageTools.extract(archive, recovered).originals());
        assertArrayEquals(Files.readAllBytes(input.resolve("derived-copy.dcm")),
                Files.readAllBytes(recovered.resolve("originals/derived-copy.dcm")));
        assertArrayEquals(viewerBytes, Files.readAllBytes(recovered.resolve("package").resolve(attachmentName)));

        artifacts.addProperty(attachmentName, "0".repeat(64));
        Path mismatched = temporary.resolve("legacy-viewer-wrong-digest.pdf");
        writeManifest(staged, mismatched, manifest);
        var checked = PackageTools.verify(mismatched, input, null);
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("FAIL", checked.metadataAccuracy().status());
        assertTrue(checked.metadataAccuracy().details().contains("Artifact SHA-256 mismatch: " + attachmentName));
    }

    @Test void malformedXmpDoesNotInvalidateIndependentSourceByteChecks() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(input);
        Path original = temporary.resolve("original.pdf"); DicomPdf.create(input, original);
        Path changed = temporary.resolve("malformed-xmp.pdf");
        try (PDDocument pdf = Loader.loadPDF(original.toFile())) {
            pdf.getDocumentCatalog().getMetadata().importXMPMetadata("<x:xmpmeta>malformed".getBytes(StandardCharsets.UTF_8));
            pdf.save(changed.toFile());
        }
        var checked = PackageTools.verify(changed, input, null);
        assertEquals("PASS", checked.sourceBytes().status());
        assertEquals("PASS", checked.externalSources().status());
        assertEquals("FAIL", checked.metadataAccuracy().status());
        assertEquals("PASS", checked.unresolvedReferences().status());
    }

    @Test void cliCannotOverwritePdfOrExternalMasterFilesWithVerificationReport() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(input);
        Path pdf = temporary.resolve("package.pdf"); DicomPdf.create(input, pdf);
        byte[] packageBefore = Files.readAllBytes(pdf), sourceBefore = Files.readAllBytes(input.resolve("derived-copy.dcm"));
        var out = new PrintStream(new ByteArrayOutputStream()); var err = new PrintStream(new ByteArrayOutputStream());
        assertEquals(1, Main.run(new String[]{"verify", "--input", pdf.toString(), "--output", pdf.toString()}, out, err));
        assertArrayEquals(packageBefore, Files.readAllBytes(pdf));
        assertEquals(1, Main.run(new String[]{"verify", "--input", pdf.toString(), "--sources", input.toString(), "--output", input.resolve("derived-copy.dcm").toString()}, out, err));
        assertArrayEquals(sourceBefore, Files.readAllBytes(input.resolve("derived-copy.dcm")));
        assertEquals(1, Main.run(new String[]{"verify", "--input", pdf.toString(), "--sources", input.toString(), "--output", input.resolve("unexpected-report.json").toString()}, out, err));
        assertFalse(Files.exists(input.resolve("unexpected-report.json")));
    }

    @Test void incompleteReferenceScanRemainsUnassessedAndCompleteMetadataCreationRefusesTruncation() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeepReferences(input);
        var originals = new LinkedHashMap<String,byte[]>();
        try (var files = Files.walk(input)) {
            for (Path source : files.filter(Files::isRegularFile).toList())
                originals.put(input.relativize(source).toString(), Files.readAllBytes(source));
        }
        var references = ReferenceInventory.resolve(originals);
        assertTrue(references.stream().anyMatch(reference -> reference.status().equals("unassessed")), "A reference scan depth limit cannot imply that no references are missing");
        Path pdf = temporary.resolve("deep-references.pdf");
        var failure = assertThrows(IllegalArgumentException.class, () -> DicomPdf.create(input, pdf));
        assertTrue(failure.getMessage().contains("depth exceeds 64"));
        assertFalse(Files.exists(pdf), "A complete-metadata package must not be published after truncation");
        for (var source : originals.entrySet()) assertArrayEquals(source.getValue(), Files.readAllBytes(input.resolve(source.getKey())));
    }

    @Test void recordsEffectiveAutoWindowAndLinearRescaleFromOriginalPixels() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeAutoWindow(input);
        byte[] pixels;
        try (var dicom = new org.dcm4che3.io.DicomInputStream(input.resolve("auto-window.dcm").toFile())) {
            pixels = dicom.readDataset().getBytes(org.dcm4che3.data.Tag.PixelData);
        }
        int min = 255, max = 0;
        for (byte pixel : pixels) { min = Math.min(min, pixel & 255); max = Math.max(max, pixel & 255); }
        double low = min * 2 - 10, high = max * 2 - 10;
        Path pdf = temporary.resolve("auto.pdf"); DicomPdf.create(input, pdf);
        JsonObject entry = manifest(pdf).getAsJsonArray("images").get(0).getAsJsonObject();
        assertEquals("rendered", entry.get("status").getAsString());
        JsonObject display = entry.getAsJsonObject("displayAdjustments");
        assertEquals("auto-min-max-v1", display.get("windowMethod").getAsString());
        assertEquals(high - low + 1, Double.parseDouble(display.get("windowWidth").getAsString()), 0.0001);
        assertEquals((low + high + 1) / 2, Double.parseDouble(display.get("windowCenter").getAsString()), 0.0001);
        assertEquals(2, Double.parseDouble(display.get("rescaleSlope").getAsString()));
        assertEquals(-10, Double.parseDouble(display.get("rescaleIntercept").getAsString()));
        assertEquals("PASS", PackageTools.verify(pdf, input, null).metadataAccuracy().status());
    }

    @Test void recoveryCommandUpdatesPreserveExactHistoricalCompatibilityAndResourceDigests() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(input);
        Path original = temporary.resolve("current-recovery.pdf"); DicomPdf.create(input, original, "archival-master", false);
        byte[] current = Files.readAllBytes(Path.of("src/main/resources/RECOVERY.txt"));
        byte[] previous = Files.readAllBytes(Path.of("src/main/resources/legacy-application-0.3.0/RECOVERY.txt"));
        String text = new String(current, StandardCharsets.UTF_8);
        assertTrue(text.startsWith("DICOM image preservation profile 0.3.0"));
        assertTrue(text.contains("DICOM_PDF_JAR=")); assertTrue(text.contains("java -jar \"$DICOM_PDF_JAR\""));
        assertFalse(text.contains("dicom-pdf-0.3.0.jar"));
        assertTrue(new String(previous, StandardCharsets.UTF_8).contains("dicom-pdf-0.3.0.jar"));
        try (PDDocument pdf = Loader.loadPDF(original.toFile())) {
            assertArrayEquals(current, pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("RECOVERY.txt").getEmbeddedFileUnicode().toByteArray());
        }
        assertEquals("PASS", PackageTools.verify(original, input, null).metadataAccuracy().status());
        record RecoveryCase(String name, byte[] bytes, boolean updateDigest, boolean accepted) {}
        byte[] arbitrary = (new String(previous, StandardCharsets.UTF_8) + "Unapproved replacement instructions.\n").getBytes(StandardCharsets.UTF_8);
        for (var item : List.of(new RecoveryCase("historical", previous, true, true),
                new RecoveryCase("unapproved", arbitrary, true, false), new RecoveryCase("wrong-digest", previous, false, false))) {
            Path staged = temporary.resolve(item.name() + "-staged.pdf"), changed = temporary.resolve(item.name() + ".pdf");
            try (PDDocument pdf = Loader.loadPDF(original.toFile())) {
                var specification = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("RECOVERY.txt");
                var stream = new PDEmbeddedFile(pdf, new ByteArrayInputStream(item.bytes()), COSName.FLATE_DECODE);
                stream.setSubtype("text/plain"); stream.setSize(item.bytes().length);
                specification.setEmbeddedFile(stream); specification.setEmbeddedFileUnicode(stream); pdf.save(staged.toFile());
            }
            JsonObject recorded = manifest(original);
            recorded.addProperty("creator", "dicom-pdf 0.3.0");
            if (item.updateDigest()) recorded.getAsJsonObject("artifactSha256").addProperty("RECOVERY.txt",
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(item.bytes())));
            writeManifest(staged, changed, recorded);
            var checked = PackageTools.verify(changed, input, null);
            assertEquals("PASS", checked.sourceBytes().status()); assertEquals("PASS", checked.externalSources().status());
            assertEquals(item.accepted() ? "PASS" : "FAIL", checked.metadataAccuracy().status(), item.name());
            if (item.name().equals("unapproved")) assertTrue(checked.metadataAccuracy().details().stream().anyMatch(detail -> detail.contains("different profile resource: RECOVERY.txt")));
            if (item.name().equals("wrong-digest")) assertTrue(checked.metadataAccuracy().details().stream().anyMatch(detail -> detail.contains("Artifact SHA-256 mismatch: RECOVERY.txt")));
        }
    }

    @Test void cliExposesSeparateVerificationOutcomesWithoutAViewer() throws Exception {
        Path input = temporary.resolve("input"); SyntheticFixtures.writeDeidentifiedCopy(input);
        Path pdf = temporary.resolve("test.pdf"); DicomPdf.create(input, pdf);
        var out = new ByteArrayOutputStream(); var err = new ByteArrayOutputStream();
        Path missingValidator = temporary.resolve("missing-verapdf");
        int status = Main.run(new String[]{"verify", "--input", pdf.toString(), "--verapdf", missingValidator.toString()},
                new PrintStream(out), new PrintStream(err));
        assertEquals(2, status, "No veraPDF execution means conformance remains unchecked");
        assertTrue(out.toString(StandardCharsets.UTF_8).contains("NOT_CHECKED"));
        out.reset();
        assertEquals(0, Main.run(new String[]{"inspect", "--input", pdf.toString()}, new PrintStream(out), new PrintStream(err)));
        assertTrue(out.toString(StandardCharsets.UTF_8).contains("derived-copy.dcm"));
    }

    private static JsonObject manifest(Path path) throws Exception {
        try (PDDocument pdf = Loader.loadPDF(path.toFile())) {
            var file = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("manifest.json");
            return JsonParser.parseString(new String(file.getEmbeddedFileUnicode().toByteArray(), StandardCharsets.UTF_8)).getAsJsonObject();
        }
    }
    private static void writeManifest(Path input, Path output, JsonObject changed) throws Exception {
        try (PDDocument pdf = Loader.loadPDF(input.toFile())) {
            String json = new GsonBuilder().serializeNulls().setPrettyPrinting().disableHtmlEscaping().create().toJson(changed);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            var specification = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("manifest.json");
            var replacement = new PDEmbeddedFile(pdf, new ByteArrayInputStream(bytes), COSName.FLATE_DECODE);
            replacement.setSubtype("application/json"); replacement.setSize(bytes.length);
            specification.setEmbeddedFile(replacement); specification.setEmbeddedFileUnicode(replacement);
            var sidecar = pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("manifest.sha256");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            byte[] checksum = (digest + "  manifest.json\n").getBytes(StandardCharsets.UTF_8);
            var checksumFile = new PDEmbeddedFile(pdf, new ByteArrayInputStream(checksum), COSName.FLATE_DECODE);
            checksumFile.setSubtype("text/plain"); checksumFile.setSize(checksum.length);
            sidecar.setEmbeddedFile(checksumFile); sidecar.setEmbeddedFileUnicode(checksumFile);
            if(changed.has("metadataXmpVersion"))PdfMetadata.apply(pdf,json,pdf.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().get("dicom-metadata.json").getEmbeddedFileUnicode().toByteArray());
            else PdfMetadata.apply(pdf, json);
            pdf.save(output.toFile());
        }
    }
}
