import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.regex.Pattern;

/** Resolves the source anchors in the IntelliJ code map from the repository root. */
class RefreshCodeMap {
    private static final Path TEMPLATE = Path.of("docs", "code-map.md");
    private static final Path OUTPUT = Path.of("target", "code-map.md");
    private static final Pattern LOCATION = Pattern.compile(
            "^(- \\[[^]]+]\\(\\.\\./([^\\s)]+)\\).*?) <!-- locate: (.+) -->$");

    public static void main(String[] args) throws IOException {
        var map = new ArrayList<String>();
        map.add("<!-- Generated from docs/code-map.md. Edit that file to change the map. -->");
        int resolved = 0;
        for (String line : Files.readAllLines(TEMPLATE)) {
            var location = LOCATION.matcher(line);
            if (!location.matches()) {
                map.add(line);
                continue;
            }
            String file = location.group(2);
            String anchor = location.group(3);
            int sourceLine = findLine(Path.of(file), anchor);
            if (sourceLine > 0) {
                map.add(location.group(1) + " · line " + sourceLine);
                resolved++;
            } else {
                System.err.printf("Code map location needs an update in %s for %s: %s%n", TEMPLATE, file, anchor);
                map.add(location.group(1));
            }
        }
        Files.createDirectories(OUTPUT.getParent());
        Path temporary = Files.createTempFile(OUTPUT.getParent(), "code-map-", ".md");
        try {
            Files.write(temporary, map);
            try {
                Files.move(temporary, OUTPUT, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ex) {
                Files.move(temporary, OUTPUT, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
        System.out.printf("Refreshed %s with %d source locations.%n", OUTPUT, resolved);
    }

    private static int findLine(Path source, String anchor) throws IOException {
        if (!Files.isRegularFile(source)) return 0;
        var lines = Files.readAllLines(source);
        int match = 0;
        for (int index = 0; index < lines.size(); index++) {
            if (lines.get(index).contains(anchor)) {
                if (match != 0) return 0;
                match = index + 1;
            }
        }
        return match;
    }
}
