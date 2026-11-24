package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class JarPublicationTest {
    private static final String CLI = "digital.thinkbox.dicompdf.Main";
    private static final String DESKTOP = "digital.thinkbox.dicompdf.ArchiveDesktop";
    private static final String VIEWER = "digital.thinkbox.dicompdf.DesktopViewerLauncher";
    private static final String OLD = "1.1.0";
    private static final String NEW = "1.2.0";
    @TempDir Path root;

    @Test void failureOnViewerCandidatePreservesPreviousDistribution() throws IOException {
        Path distribution = Files.createDirectory(root.resolve("dist"));
        createDistribution(distribution, OLD, "old distribution");
        Path staging = Files.createDirectory(root.resolve("staging"));
        jar(staging.resolve(jarName(NEW, true)), DESKTOP, "new distribution");
        jar(staging.resolve(jarName(NEW, false)), CLI, "new distribution");
        Files.writeString(staging.resolve(viewerName(NEW)), "invalid JAR");
        assertThrows(IOException.class, () -> JarPublication.publish(staging, distribution, NEW));
        assertEquals(distributionNames(OLD), contents(distribution));
    }

    @Test void completeDistributionReplacesOldVersionsAndRefusesVersionReuse() throws IOException {
        Path distribution = Files.createDirectory(root.resolve("dist"));
        createDistribution(distribution, OLD, "old distribution");
        Path staging = Files.createDirectory(root.resolve("staging"));
        createDistribution(staging, NEW, "new distribution");
        JarPublication.publish(staging, distribution, NEW);
        assertEquals(distributionNames(NEW), contents(distribution));
        for (String name : contents(distribution))
            assertEquals(-1, Files.mismatch(staging.resolve(name), distribution.resolve(name)));
        assertThrows(IOException.class, () -> JarPublication.publish(staging, distribution, NEW));
    }

    @Test void rejectsAnObsoleteBrowserViewerResource() throws IOException {
        Path distribution = Files.createDirectory(root.resolve("dist"));
        createDistribution(distribution, OLD, "old distribution");
        Path staging = Files.createDirectory(root.resolve("staging"));
        createDistribution(staging, NEW, "new distribution");
        jar(staging.resolve(jarName(NEW, true)), DESKTOP, "new distribution", "viewer.html");
        var failure = assertThrows(IOException.class, () -> JarPublication.publish(staging, distribution, NEW));
        assertTrue(failure.getMessage().contains("Unexpected standalone browser viewer"));
        assertEquals(distributionNames(OLD), contents(distribution));
    }

    private static void createDistribution(Path directory, String version, String content) throws IOException {
        jar(directory.resolve(jarName(version, true)), DESKTOP, content);
        jar(directory.resolve(jarName(version, false)), CLI, content);
        jar(directory.resolve(viewerName(version)), VIEWER, content);
    }

    private static String viewerName(String version) { return "dicom-pdf-" + version + "-viewer.jar"; }

    private static List<String> distributionNames(String version) {
        return List.of(jarName(version, true), viewerName(version), jarName(version, false));
    }

    private static String jarName(String version, boolean desktop) {
        return "dicom-pdf-" + version + (desktop ? "-desktop" : "") + ".jar";
    }

    private static List<String> contents(Path directory) throws IOException {
        try (var files = Files.list(directory)) {
            return files.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private static void jar(Path destination, String mainClass, String content, String... extraEntries) throws IOException {
        var manifest = new Manifest();
        manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
        manifest.getMainAttributes().put(Attributes.Name.MAIN_CLASS, mainClass);
        try (var output = new JarOutputStream(Files.newOutputStream(destination), manifest)) {
            var entries = new java.util.ArrayList<>(List.of(mainClass.replace('.', '/') + ".class",
                    "com/google/gson/JsonParser.class", "org/apache/pdfbox/pdmodel/PDDocument.class"));
            if (mainClass.equals(VIEWER)) {
                entries.addAll(List.of("digital/thinkbox/dicompdf/DesktopViewer.class", "desktop-viewer.css",
                        "javafx/scene/control/Button.class", "icons/icon-128.png",
                                "digital/thinkbox/dicompdf/DesktopViewerReportText.class"));
                for (String platform : List.of("linux", "linux-aarch64", "mac", "mac-aarch64", "win"))
                        entries.add("META-INF/dicom-pdf/javafx/" + platform + ".jar");
            }
            entries.addAll(List.of(extraEntries));
            for (String entry : entries) {
                output.putNextEntry(new JarEntry(entry));
                output.write(content.getBytes(StandardCharsets.UTF_8));
                output.closeEntry();
            }
        }
    }
}
