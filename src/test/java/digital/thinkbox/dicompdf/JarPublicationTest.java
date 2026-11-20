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
    private static final String OLD = "1.1.0";
    private static final String NEW = "1.2.0";
    @TempDir Path root;

    @Test void failureOnSecondCandidatePreservesPreviousPair() throws IOException {
        Path distribution = Files.createDirectory(root.resolve("dist"));
        createPair(distribution, OLD, "old viewer");
        Path staging = Files.createDirectory(root.resolve("staging"));
        jar(staging.resolve(jarName(NEW, true)), DESKTOP, "new viewer");
        Files.writeString(staging.resolve(jarName(NEW, false)), "invalid JAR");
        assertThrows(IOException.class, () -> JarPublication.publishPair(staging, distribution, NEW));
        assertEquals(List.of(jarName(OLD, true), jarName(OLD, false)), contents(distribution));
    }

    @Test void aCompletePairReplacesOldVersionsAndRefusesVersionReuse() throws IOException {
        Path distribution = Files.createDirectory(root.resolve("dist"));
        createPair(distribution, OLD, "old viewer");
        Path staging = Files.createDirectory(root.resolve("staging"));
        createPair(staging, NEW, "new viewer");
        JarPublication.publishPair(staging, distribution, NEW);
        assertEquals(List.of(jarName(NEW, true), jarName(NEW, false)), contents(distribution));
        for (String name : contents(distribution))
            assertEquals(-1, Files.mismatch(staging.resolve(name), distribution.resolve(name)));
        assertThrows(IOException.class, () -> JarPublication.publishPair(staging, distribution, NEW));
    }

    private static void createPair(Path directory, String version, String viewer) throws IOException {
        jar(directory.resolve(jarName(version, true)), DESKTOP, viewer);
        jar(directory.resolve(jarName(version, false)), CLI, viewer);
    }

    private static String jarName(String version, boolean desktop) {
        return "dicom-pdf-" + version + (desktop ? "-desktop" : "") + ".jar";
    }

    private static List<String> contents(Path directory) throws IOException {
        try (var files = Files.list(directory)) {
            return files.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private static void jar(Path destination, String mainClass, String viewer) throws IOException {
        var manifest = new Manifest();
        manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
        manifest.getMainAttributes().put(Attributes.Name.MAIN_CLASS, mainClass);
        try (var output = new JarOutputStream(Files.newOutputStream(destination), manifest)) {
            for (String entry : List.of(mainClass.replace('.', '/') + ".class", "com/google/gson/JsonParser.class",
                    "org/apache/pdfbox/pdmodel/PDDocument.class", "viewer.html")) {
                output.putNextEntry(new JarEntry(entry));
                output.write(viewer.getBytes(StandardCharsets.UTF_8));
                output.closeEntry();
            }
        }
    }
}
