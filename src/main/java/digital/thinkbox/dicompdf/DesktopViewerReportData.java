package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.SecurityReport.Check;
import digital.thinkbox.pdfsecurity.SecurityReport.Status;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** The archive inventory and checksum checks displayed by the extension. */
final class DesktopViewerReportData {
    record FileCheck(String attachment, String kind, String status, String code, Long size) {}
    record Checksums(Map<String, Check> checks, List<FileCheck> files, Map<String, String> declarations,
                     Certificate manifestCertificate, int pdfSignatures, boolean archival, boolean timestamped) {
        long count(String kind) { return files.stream().filter(file -> kind.equals(file.kind())).count(); }
        long matches(String kind) { return files.stream().filter(file -> kind.equals(file.kind()) && "PASS".equals(file.status())).count(); }
        boolean pdfSigned() { return pdfSignatures > 0; }
    }
    record Certificate(String subject, String sha256, String notBefore, String notAfter) {}
    record Row(String category, String name, String status, String detail) {}
    record Report(String reportStatus, Map<String, Check> checks, List<FileCheck> files, long originals,
                  long matchedOriginals, List<Row> pdfSecurity, Map<String, String> signingEvidence) {}
    private static final Pattern HASH = Pattern.compile("[a-fA-F0-9]{64}");
    private static final Pattern MANIFEST_DIGEST = Pattern.compile("([a-f0-9]{64}) {2}manifest\\.json\n");

    private DesktopViewerReportData() {}

    static String integrity(Map<String, Check> checks) {
        var states = List.of("attachmentInventory", "manifestChecksum", "originalBytes", "generatedArtifacts").stream()
                .map(key -> checks.get(key).status()).toList();
        if (states.contains(Status.FAIL)) return "FAIL";
        return states.contains(Status.UNKNOWN) ? "UNKNOWN" : "PASS";
    }

    static String trustStatus(Report report) {
        var states = report.pdfSecurity().stream().filter(row -> row.category().equals("Certificate trust"))
                .map(Row::status).filter(status -> !status.isEmpty() && !status.equals("NOT_APPLICABLE")).toList();
        if (states.contains("FAIL")) return "FAIL";
        if (states.contains("UNKNOWN")) return "UNKNOWN";
        return states.isEmpty() ? "NOT_APPLICABLE" : "PASS";
    }

    static String pdfStatus(Report report) {
        var statuses = report.pdfSecurity().stream().filter(row -> !row.category().equals("Certificate trust"))
                .map(Row::status).filter(status -> !status.isEmpty() && !status.equals("NOT_APPLICABLE")).toList();
        if (statuses.contains("FAIL")) return "FAIL";
        if (statuses.contains("UNKNOWN")) return "UNKNOWN";
        return statuses.isEmpty() ? "NOT_APPLICABLE" : "PASS";
    }

    static Map<String, Object> export(Report report, Checksums inventory, List<?> selectedCertificates,
                                      String checkedAt, long fileSize, long milliseconds, long signatures) {
        var checks = new LinkedHashMap<String, Object>(report.checks());
        for (var group : Map.of("originalBytes", "original", "generatedArtifacts", "artifact").entrySet()) {
            var check = report.checks().get(group.getKey());
            checks.put(group.getKey(), Map.of("status", check.status(), "code", check.code(),
                    "checked", inventory.count(group.getValue()), "matched", inventory.matches(group.getValue())));
        }
        var declarations = new LinkedHashMap<String, String>();
        for (var entry : Map.of("Declared protection", "protection", "Manifest signature", "manifestSignature",
                "PDF signature", "pdfSignature", "PAdES B-LTA", "padesBLta", "Timestamps", "timestamps",
                "Declared signer certificate SHA-256", "issuerCertificateSha256").entrySet()) {
            if (report.signingEvidence().containsKey(entry.getKey()))
                declarations.put(entry.getValue(), report.signingEvidence().get(entry.getKey()));
        }
        var pdf = new LinkedHashMap<String, Object>();
        pdf.put("schemaVersion", 1);
        pdf.put("status", pdfStatus(report));
        pdf.put("trustStatus", trustStatus(report));
        pdf.put("trustSource", selectedCertificates.isEmpty() ? "NONE" : "SESSION");
        pdf.put("checks", report.pdfSecurity().stream().filter(row -> !row.status().isEmpty()).toList());
        pdf.put("checkedAt", checkedAt);
        pdf.put("fileSize", fileSize);
        pdf.put("scope", "DICOM archive export security");
        pdf.put("certificates", inventory.manifestCertificate() == null ? List.of() : List.of(inventory.manifestCertificate()));
        pdf.put("pdfSignaturesChecked", signatures);
        pdf.put("selectedCertificates", selectedCertificates);
        pdf.put("elapsedMilliseconds", milliseconds);
        var output = new LinkedHashMap<String, Object>();
        output.put("schemaVersion", 1);
        output.put("implementation", "java-offline-viewer");
        output.put("assurance", report.checks().getOrDefault("manifestSignature", check(Status.UNKNOWN, "")).status() == Status.PASS
                ? "MANIFEST_SIGNATURE_VALID_IDENTITY_UNVERIFIED" : "CHECKSUMS_ONLY");
        output.put("checks", checks);
        output.put("files", report.files());
        output.put("signingEvidence", declarations);
        output.put("integrity", integrity(report.checks()));
        output.put("originals", report.originals());
        output.put("matchedOriginals", report.matchedOriginals());
        output.put("pdfSecurity", pdf);
        output.put("reportStatus", report.reportStatus());
        return output;
    }

    static Checksums verify(Path path, java.util.function.BiConsumer<Integer, Integer> progress) throws Exception {
        try (var pack = new PackageTools.Package(path)) {
            var checks = new LinkedHashMap<String, Check>();
            var declared = new LinkedHashSet<>(List.of("manifest.json", "manifest.sha256"));
            var files = new ArrayList<FileCheck>();
            var artifacts = pack.manifest.getAsJsonObject("artifactSha256");
            var sidecar = pack.files.get("manifest.sha256");
            int total = pack.images.size() + (artifacts == null ? 0 : artifacts.size()) + (sidecar == null ? 0 : 1);
            progress.accept(0, total);
            for (var item : pack.images) {
                var source = item.getAsJsonObject();
                String name = string(source, "attachment");
                var size = source.get("size").getAsBigDecimal();
                if (size.signum() < 0 || size.stripTrailingZeros().scale() > 0 || size.compareTo(java.math.BigDecimal.valueOf(9_007_199_254_740_991L)) > 0)
                    throw invalidInventory();
                files.add(checkDeclared(pack, declared, name, "original", string(source, "sha256"), size.longValueExact()));
                progress.accept(files.size(), total);
            }
            if (artifacts != null) for (var artifact : artifacts.entrySet()) {
                files.add(checkDeclared(pack, declared, artifact.getKey(), "artifact", artifact.getValue().getAsString(), null));
                progress.accept(files.size(), total);
            }
            var security = pack.manifest.getAsJsonObject("security");
            boolean signedManifest = security != null && "1".equals(string(security, "schemaVersion"))
                    && "manifest.p7s".equals(string(security, "manifestSignature"));
            boolean c2pa = "0.4.0".equals(string(pack.manifest, "profileVersion")) && artifacts != null
                    && artifacts.has(ArchiveC2pa.POLICY);
            if (signedManifest) declared.add("manifest.p7s");
            if (c2pa) declared.add(ArchiveC2pa.FILE);
            boolean sameInventory = declared.equals(pack.files.keySet());
            checks.put("attachmentInventory", check(artifacts == null ? Status.UNKNOWN : sameInventory ? Status.PASS : Status.FAIL,
                    "DECLARED_ATTACHMENT_SET"));
            if (sidecar == null) {
                checks.put("manifestChecksum", check("2".equals(string(pack.manifest, "schemaVersion")) ? Status.FAIL : Status.UNKNOWN,
                        "MANIFEST_SIDECAR_UNAVAILABLE"));
            } else {
                var bytes = PackageTools.content(sidecar).prefix(257);
                var matcher = MANIFEST_DIGEST.matcher(new String(bytes, StandardCharsets.US_ASCII));
                if (!matcher.matches()) throw invalidInventory();
                var digest = checkFile(pack, "manifest.json", "manifest", matcher.group(1), null);
                files.add(digest);
                progress.accept(files.size(), total);
                checks.put("manifestChecksum", check(Status.valueOf(digest.status()), digest.code()));
            }
            checks.put("originalBytes", group(files, "original", "AGREEMENT_WITH_RECORDED_MANIFEST_ONLY"));
            checks.put("generatedArtifacts", group(files, "artifact", "HASHED_PACKAGE_ARTIFACTS"));
            String mode = signedManifest ? string(security, "protection") : "";
            var signatures = pack.pdf.getSignatureDictionaries();
            boolean archival = "PADES_B_LTA".equals(mode) || signatures.stream().anyMatch(s -> "ETSI.RFC3161".equals(s.getSubFilter()));
            var declarations = new LinkedHashMap<String, String>();
            declarations.put("Declared protection", switch (mode) {
                case "CMS_AND_PDF" -> "Manifest and PDF signatures";
                case "CMS_AND_PDF_TIMESTAMPED" -> "Manifest and PDF signatures with timestamps";
                case "PADES_B_LTA" -> "PAdES B-LTA archival signing";
                default -> security == null ? "No export signing declared" : "Unrecognized signing declaration";
            });
            declarations.put("PDF signature", mode.isEmpty() ? "Not declared" : "Requested by archive");
            declarations.put("PAdES B-LTA", switch (mode) {
                case "PADES_B_LTA" -> "Archival protection requested";
                case "CMS_AND_PDF", "CMS_AND_PDF_TIMESTAMPED" -> "B-LTA was not requested";
                default -> "Not declared";
            });
            declarations.put("Timestamps", switch (mode) {
                case "PADES_B_LTA" -> "Signature and archival timestamps requested";
                case "CMS_AND_PDF_TIMESTAMPED" -> "Signature timestamp requested";
                case "CMS_AND_PDF" -> "Trusted timestamps were not requested";
                default -> "Not declared";
            });
            String fingerprint = security == null ? "" : string(security, "issuerCertificateSha256");
            if (HASH.matcher(fingerprint).matches()) declarations.put("Declared signer certificate SHA-256", fingerprint);
            return new Checksums(java.util.Collections.unmodifiableMap(checks), List.copyOf(files),
                    java.util.Collections.unmodifiableMap(declarations), signedManifest ? certificate(pack) : null,
                    signatures.size(), archival,
                    archival || "CMS_AND_PDF_TIMESTAMPED".equals(mode));
        }
    }

    private static Certificate certificate(PackageTools.Package pack) {
        try {
            var signature = PackageTools.content(pack.requireFile("manifest.p7s")).prefix(1024 * 1024 + 1);
            if (signature.length > 1024 * 1024) return null;
            var cms = new org.bouncycastle.cms.CMSSignedData(signature);
            if (cms.getSignerInfos().size() != 1) return null;
            var signer = cms.getSignerInfos().getSigners().iterator().next();
            var candidates = cms.getCertificates().getMatches(signer.getSID());
            if (candidates.size() != 1) return null;
            if (!(candidates.iterator().next() instanceof org.bouncycastle.cert.X509CertificateHolder selected)) return null;
            return new Certificate(selected.getSubject().toString(), SourceContent.of(selected.getEncoded()).digest().sha256(),
                    selected.getNotBefore().toInstant().toString(), selected.getNotAfter().toInstant().toString());
        } catch (Exception unavailable) { return null; }
    }

    static Report report(Checksums inventory, Map<String, Check> authentication) {
        var checks = new LinkedHashMap<>(inventory.checks());
        var rows = new ArrayList<Row>();
        var declarations = new LinkedHashMap<>(inventory.declarations());
        var manifest = authentication.get("manifest.cryptographicSignature");
        if (manifest == null) manifest = authentication.get("securityStructure");
        if (manifest != null) {
            checks.put("manifestSignature", manifest);
            declarations.put("Manifest signature", manifest.status() == Status.PASS
                    ? "Verified against the included certificate" : manifest.status() == Status.FAIL
                    ? "Manifest signature is invalid" : "Verification incomplete");
            if (manifest.status() == Status.PASS) checks.put("signerCertificateBinding",
                    check(Status.PASS, "SIGNED_CERTIFICATE_REFERENCE_AND_RECORDED_FINGERPRINT_MATCH"));
            var validity = authentication.get("manifest.certificateValidity");
            if (validity != null) checks.put("signerCertificateValidity", validity);
            var signer = inventory.manifestCertificate();
            if (signer != null && manifest.status() == Status.PASS) {
                declarations.put("Included signer certificate SHA-256", signer.sha256());
                declarations.put("Certificate valid from", signer.notBefore());
                declarations.put("Certificate valid until", signer.notAfter());
                rows.add(new Row("Certificate trust", signer.subject(), "", "Included signing certificate\nSHA-256: " + signer.sha256()
                        + "\nValid from " + signer.notBefore() + " to " + signer.notAfter()));
            }
        } else declarations.put("Manifest signature", "No manifest signature declared");

        add(rows, authentication, "c2pa.presence", "C2PA", "Declared C2PA credentials");
        add(rows, authentication, "c2pa.validation", "C2PA", "C2PA validation");
        add(rows, authentication, "c2pa.signature", "C2PA", "C2PA claim signature");
        add(rows, authentication, "c2pa.binding", "C2PA", "C2PA file binding");
        add(rows, authentication, "c2pa.trust", "Certificate trust", "C2PA export signer trust");
        add(rows, authentication, "c2pa.revocation", "Certificate trust", "C2PA export signer revocation");
        String pdfCategory = inventory.archival() || inventory.pdfSigned() ? "PAdES" : "CMS";
        var signature = authentication.get("pdf.cryptographicSignature");
        var coverage = authentication.get("pdf.coverage");
        if (coverage != null && coverage.status() == Status.FAIL) signature = coverage;
        if (signature != null) rows.add(new Row(pdfCategory, "PDF signature 1", signature.status().name(),
                signature.status() == Status.PASS ? "The PDF signature and its signed byte ranges verified." : detail(signature)));
        if (inventory.timestamped()) {
            if (!inventory.archival()) add(rows, authentication, "pdf.timestamp", pdfCategory, "PDF signature 1 trusted signing time");
            add(rows, authentication, "manifest.timestamp", "CMS", "Manifest signature trusted time");
        }
        if (inventory.archival()) {
            var trustedTimes = new ArrayList<Row>();
            authentication.forEach((key, value) -> {
                if (key.matches("pdf\\.timestamp\\.\\d+")) {
                    String number = key.substring("pdf.timestamp.".length());
                    boolean embedded = value.code().contains("_SIGNATURE_TIMESTAMP_");
                    String title = embedded ? "PDF signature 1" : "Document timestamp " + number;
                    if (embedded) add(rows, authentication, "pdf.timestampImprint." + number, "PAdES", title + " timestamp imprint");
                    else add(rows, authentication, "pdf.timestampSignature." + number, "PAdES", title);
                    trustedTimes.add(new Row("PAdES", title + (embedded ? " trusted signing time" : " trusted time"),
                            value.status().name(), value.status() == Status.PASS
                            ? "The timestamp signature, imprint and trust checks verified at the recorded time." : detail(value)));
                    add(rows, authentication, "pdf.timestampTrust." + number, "Certificate trust",
                            title + (embedded ? " timestamp trust" : " trust"));
                }
            });
            add(rows, authentication, "pdf.allowedChanges", "PAdES", "DICOM archival revision history");
            add(rows, authentication, "pdf.issuerBinding", "PAdES", "DICOM archival signer binding");
            add(rows, authentication, "padesBLta", "PAdES", "PAdES B-LTA and permitted revisions");
            rows.addAll(trustedTimes);
            if (authentication.containsKey("c2pa.binding"))
                add(rows, authentication, "pdf.allowedChanges", "C2PA + PAdES", "DICOM archival credentials");
        }
        for (String prefix : List.of("pdf", "manifest")) {
            String title = prefix.equals("pdf") ? "PDF signature 1" : "Manifest signer";
            add(rows, authentication, prefix + ".certificateTrust", "Certificate trust", title + " trust");
            add(rows, authentication, prefix + ".certificateValidity", "Certificate trust", title + " certificate dates");
            add(rows, authentication, prefix + ".revocation", "Certificate trust", title + " revocation");
        }
        if (rows.isEmpty()) rows.add(new Row("Other checks", "Export protection", "NOT_APPLICABLE",
                "No PDF signature or C2PA export credentials were found."));
        rows.add(new Row("Other checks", "Verification scope", "NOT_APPLICABLE",
                "Signature, timestamp and revocation checks use the PDF and its retained evidence on this device. "
                        + "Online downloads supply public CA certificates. Export signer trust uses the selected signing CA policy."));
        boolean failed = checks.values().stream().anyMatch(check -> check.status() == Status.FAIL)
                || rows.stream().anyMatch(row -> !row.category().equals("Certificate trust") && row.status().equals("FAIL"));
        boolean incomplete = checks.entrySet().stream().anyMatch(entry -> !entry.getKey().startsWith("signerCertificate")
                && entry.getValue().status() == Status.UNKNOWN)
                || rows.stream().anyMatch(row -> !row.category().equals("Certificate trust") && row.status().equals("UNKNOWN"));
        return new Report(failed ? "FAIL" : incomplete ? "UNKNOWN" : "PASS", java.util.Collections.unmodifiableMap(checks),
                inventory.files(), inventory.count("original"), inventory.matches("original"), List.copyOf(rows),
                java.util.Collections.unmodifiableMap(declarations));
    }

    private static void add(List<Row> rows, Map<String, Check> authentication, String key, String group, String title) {
        var check = authentication.get(key);
        if (check != null && check.status() != Status.NOT_APPLICABLE)
            rows.add(new Row(group, title, check.status().name(), detail(check)));
    }

    private static String detail(Check check) {
        return switch (check.code()) {
            case "COSE_CLAIM_SIGNATURE_VALID" -> "The included certificate verified the C2PA claim signature.";
            case "PDF_AND_ARCHIVE_MANIFEST_BOUND" -> "The C2PA claim binds the PDF and its archive manifest.";
            case "SIGNER_REQUIRES_EXTERNAL_C2PA_TRUST_POLICY", "NO_EXPLICIT_TRUST_ANCHORS" ->
                    "Add the signing organization’s trusted CA certificate to verify who signed the archive.";
            case "NO_VALIDATED_CERTIFICATE_PATH" -> "Revocation status requires a validated certificate path.";
            case "PDF_SIGNER_CERTIFICATE_MATCHES_MANIFEST" -> "The signing certificate matches the fingerprint declared in the manifest.";
            case "EU_DSS_ONLY_SECURE_PDF_EXTENSION_CHANGES_ALLOWED" -> "Only permitted changes were found across the saved PDF revisions.";
            case "EU_DSS_BASELINE_LTA_AND_ARCHIVE_CHANGE_POLICY" -> check.status() == Status.PASS
                    ? "The export signature, archival timestamps and permitted revisions verified."
                    : "Archival protection depends on completing the signature, timestamp, retained evidence and trust checks.";
            case "CERTIFICATE_VALID_AT_VERIFICATION_TIME" -> "The certificate was within its validity dates at the verification time.";
            case "EU_DSS_TIMESTAMP_IMPRINT" -> check.status() == Status.PASS ? "The timestamp imprint matches the data it covers."
                    : "The timestamp imprint could not be verified against the data it covers.";
            case "EU_DSS_TIMESTAMP_SIGNATURE" -> check.status() == Status.PASS ? "The timestamp token signature verified."
                    : "The timestamp token signature could not be verified.";
            case "EU_DSS_TIMESTAMP_CERTIFICATE_PATH" -> check.status() == Status.PASS
                    ? "The timestamp certificate chains to a trusted CA." : "A trusted timestamp certificate path was not established.";
            default -> check.code();
        };
    }

    private static FileCheck checkDeclared(PackageTools.Package pack, LinkedHashSet<String> declared,
                                          String name, String kind, String hash, Long length) throws Exception {
        if (name.isEmpty() || !declared.add(name) || !HASH.matcher(hash).matches()) throw invalidInventory();
        return checkFile(pack, name, kind, hash, length);
    }

    private static FileCheck checkFile(PackageTools.Package pack, String name, String kind, String hash, Long size) throws Exception {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
        var file = pack.files.get(name);
        if (file == null) return new FileCheck(name, kind, "FAIL", "ATTACHMENT_MISSING", null);
        try {
            var digest = PackageTools.content(file).digest();
            if (size != null && size != digest.length()) return new FileCheck(name, kind, "FAIL", "BYTE_LENGTH_MISMATCH", digest.length());
            boolean valid = hash.equalsIgnoreCase(digest.sha256());
            return new FileCheck(name, kind, valid ? "PASS" : "FAIL", valid ? "RECORDED_SHA256_MATCH" : "SHA256_MISMATCH", digest.length());
        } catch (IOException error) {
            return new FileCheck(name, kind, "FAIL", "ATTACHMENT_UNREADABLE", null);
        }
    }

    private static Check group(List<FileCheck> files, String kind, String code) {
        var group = files.stream().filter(file -> file.kind().equals(kind)).toList();
        if (group.isEmpty()) return check(Status.UNKNOWN, "NO_ARTIFACT_HASH_INVENTORY");
        return check(group.stream().allMatch(file -> "PASS".equals(file.status())) ? Status.PASS : Status.FAIL, code);
    }

    private static Check check(Status status, String code) { return new Check(status, code); }

    private static String string(com.google.gson.JsonObject object, String name) {
        var value = object.get(name);
        return value == null || !value.isJsonPrimitive() ? "" : value.getAsString();
    }

    private static IOException invalidInventory() { return new IOException("The archive inventory could not be checked safely."); }
}
