package digital.thinkbox.dicompdf;

import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.pades.PAdESUtils;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DssRevisionScanTest {
    @Test
    void preservesDssMarkerAndLookaheadRules() {
        var first = "%PDF-1.7\nx%%EOF\n%%EOF\n";
        var second = "%%EOF\rX";
        var third = "%%EOF\r\n";
        var fourth = "%%EOF!\n";
        var last = "%%EOF";
        int secondEnd = first.length() + second.length();
        int thirdEnd = secondEnd + third.length();
        assertEquals(List.of(first.length(), secondEnd - 1, thirdEnd,
                        thirdEnd + fourth.length() - 2, thirdEnd + fourth.length() + last.length()),
                revisionEnds(first + second + third + fourth + last));
    }

    @Test
    void findsMarkersAndCrLfAcrossBufferBoundaries() {
        int blockSize = 64 * 1024;
        var header = "%PDF-1.7\n";
        var eof = "%%EOF\r\n";
        for (int markerOffset = 1; markerOffset < eof.length(); markerOffset++) {
            var prefix = header + "x".repeat(blockSize - markerOffset - header.length() - 1) + "\n";
            var text = prefix + eof;
            assertEquals(List.of(text.length()), revisionEnds(text));
        }
    }

    private static List<Integer> revisionEnds(String pdf) {
        var document = new InMemoryDocument(pdf.getBytes(StandardCharsets.US_ASCII), "revisions.pdf");
        return PAdESUtils.extractRevisions(document).stream()
                .map(revision -> revision.getByteRange().getLength())
                .toList();
    }
}
