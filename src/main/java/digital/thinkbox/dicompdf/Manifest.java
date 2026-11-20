package digital.thinkbox.dicompdf;

import java.util.List;
import java.util.Map;

/** Profile 0.3.0: page/frame numbers are one-based; source identifiers are never synthesized. */
public record Manifest(int schemaVersion, String profile, String profileVersion, String creator,
                       String sourceRole, Integer metadataXmpVersion, List<Image> images, List<Reference> references,
                       Map<String, List<String>> duplicateInstanceUIDs, Map<String, String> artifactSha256) {
    public record Image(String attachment, String sourcePath, String sopInstanceUID, String sha256,
                        long size, int referencePage, String status, String reason, Map<String, String> fields,
                        boolean supplied, boolean embedded, boolean displayRejected, Integer sourceFrame,
                        Map<String, String> displayAdjustments, String previewSha256) {}
    public record Reference(String sourceAttachment, String sequencePath, String sopClassUID,
                            String sopInstanceUID, List<Integer> frames, String status,
                            List<String> resolvedAttachments) {}
}
