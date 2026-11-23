package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Locale;

/** Loads the JavaFX native libraries for the current platform. */
public final class DesktopViewerLauncher {
    private DesktopViewerLauncher() {}

    public static void main(String[] args) {
        String usage = "Usage: java -jar dicom-pdf-" + ApplicationVersion.VERSION + "-viewer.jar [archive.pdf]";
        if (args.length == 1 && ("--help".equals(args[0]) || "-h".equals(args[0]))) {
            System.out.println("DICOM PDF Viewer\n" + usage);
            return;
        }
        if (args.length > 1) {
            System.err.println(usage);
            System.exit(1);
            return;
        }
        if (java.awt.GraphicsEnvironment.isHeadless()) {
            System.err.println("The DICOM viewer needs a graphical desktop.");
            System.exit(1);
            return;
        }
        launch(args);
    }

    private static void launch(String[] args) {
        try {
            String platform = platform();
            try (var input = DesktopViewerLauncher.class.getResourceAsStream("/META-INF/dicom-pdf/javafx/" + platform + ".jar")) {
                if (input == null) throw new IOException("Missing JavaFX runtime for " + platform);
                var graphics = Files.createTempFile("dicom-pdf-javafx-", ".jar");
                try {
                    Files.copy(input, graphics, StandardCopyOption.REPLACE_EXISTING);
                    var application = DesktopViewerLauncher.class.getProtectionDomain().getCodeSource().getLocation();
                    try (var loader = new URLClassLoader(new URL[]{graphics.toUri().toURL(), application},
                            ClassLoader.getPlatformClassLoader())) {
                        var thread = Thread.currentThread();
                        var previous = thread.getContextClassLoader();
                        thread.setContextClassLoader(loader);
                        try {
                            loader.loadClass("digital.thinkbox.dicompdf.DesktopViewer")
                                    .getMethod("main", String[].class).invoke(null, (Object) args);
                        } finally {
                            thread.setContextClassLoader(previous);
                        }
                    }
                } finally {
                    Files.deleteIfExists(graphics);
                }
            }
        } catch (InvocationTargetException error) {
            throw new IllegalStateException("Could not start the DICOM viewer", error.getCause());
        } catch (ReflectiveOperationException | IOException error) {
            throw new IllegalStateException("Could not start the DICOM viewer", error);
        }
    }

    private static String platform() {
        var os = System.getProperty("os.name");
        var architecture = System.getProperty("os.arch").toLowerCase(Locale.ROOT);
        boolean x64 = architecture.equals("amd64") || architecture.equals("x86_64");
        boolean arm64 = architecture.equals("aarch64") || architecture.equals("arm64");
        if (os.equals("Linux") && (x64 || arm64)) return arm64 ? "linux-aarch64" : "linux";
        if (os.startsWith("Mac") && (x64 || arm64)) return arm64 ? "mac-aarch64" : "mac";
        if (os.startsWith("Windows") && x64) return "win";
        throw new UnsupportedOperationException("JavaFX is unavailable for " + os + " (" + architecture + ")");
    }
}
