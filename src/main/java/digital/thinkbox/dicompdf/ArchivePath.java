package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.Path;

/** The slash-separated source path and flat attachment name rules shared by both archive profiles. */
final class ArchivePath {
    private ArchivePath() {}

    static void check(String name) throws IOException {
        if (name == null || name.isEmpty() || name.indexOf('\\') >= 0 || name.indexOf(':') >= 0 ||
                name.chars().anyMatch(c -> c < 32 || c == 127)) {
            throw new IOException("Invalid archive path character or empty name");
        }
        for (String part : name.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                throw new IOException("Invalid archive path component");
            }
        }
    }

    static void checkAttachment(String name) throws IOException {
        check(name);
        if (name.contains("/")) throw new IOException("Attachment names must be flat");
    }

    static Path resolve(Path root, String name) throws IOException {
        check(name);
        Path target = root.resolve(name).normalize();
        if (!target.startsWith(root) || target.equals(root)) throw new IOException("Unsafe archive path");
        return target;
    }
}
