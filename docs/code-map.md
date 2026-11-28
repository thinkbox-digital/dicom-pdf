# IntelliJ code map

Find a feature below, then open the linked file in IntelliJ or use Search
Everywhere with the listed symbol. Maven writes a copy with current line numbers
to `target/code-map.md` during JAR publication. To update that copy without a
build, run `java scripts/RefreshCodeMap.java` from the repository root.

## Desktop DICOM viewer

Open file, standalone DICOM, image display, selected-file metadata, series pane.

- [Viewer entry point](../src/main/java/digital/thinkbox/dicompdf/DesktopViewerLauncher.java) · `main` <!-- locate: public static void main( -->
- [Viewer document loading](../src/main/java/digital/thinkbox/dicompdf/DesktopViewerDocument.java) · `DesktopViewerDocument` <!-- locate: class DesktopViewerDocument -->
- [Metadata pane](../src/main/java/digital/thinkbox/dicompdf/DesktopViewer.java) · `buildDetails` <!-- locate: private void buildDetails( -->
- [Metadata dialog](../src/main/java/digital/thinkbox/dicompdf/DesktopViewer.java) · `showSelectedMetadata` <!-- locate: private void showSelectedMetadata( -->
- [Metadata dialog styles](../src/main/resources/desktop-viewer.css) · `.selected-metadata-dialog` <!-- locate: .selected-metadata-dialog { -->
- [Series card styles](../src/main/resources/desktop-viewer.css) · `.series-card` <!-- locate: .series-card { -->

## README desktop screenshots

Screenshot refresh, `greg.pdf`, left series pane, security report image.

- [Capture and metadata dialog check](../src/test/java/digital/thinkbox/dicompdf/DesktopViewerScreenshot.java) · `Capture.start` <!-- locate: void start(Stage stage) -->
- [Maven capture configuration](../app/pom.xml) · `screenshot.archive` <!-- locate: <property name="screenshot.archive" -->
- [README images](../README.md) · gallery starts at the viewer screenshot <!-- locate: ](docs/desktop-viewer.png) -->

## Creator, CLI, and archive conversion

Create PDF/A-4f, input folders and ZIPs, DICOM reference images, manifest, archive
inspection, original-file recovery.

- [Swing creator](../src/main/java/digital/thinkbox/dicompdf/ArchiveDesktop.java) · `main` <!-- locate: public static void main( -->
- [CLI dispatch](../src/main/java/digital/thinkbox/dicompdf/Main.java) · `run` <!-- locate: int run( -->
- [PDF creation](../src/main/java/digital/thinkbox/dicompdf/DicomPdf.java) · `create` <!-- locate: public static Manifest create(Path input, Path output) -->
- [DICOM input](../src/main/java/digital/thinkbox/dicompdf/DicomInput.java) · `capture` <!-- locate: static Capture capture(SourceContent source) -->
- [Inspect, extract, and verify](../src/main/java/digital/thinkbox/dicompdf/PackageTools.java) · `PackageTools` <!-- locate: class PackageTools -->
- [Conversion tests](../src/test/java/digital/thinkbox/dicompdf/DicomPdfTest.java) · `DicomPdfTest` <!-- locate: class DicomPdfTest -->
- [Recovery tests](../src/test/java/digital/thinkbox/dicompdf/PackageToolsTest.java) · `PackageToolsTest` <!-- locate: class PackageToolsTest -->

## Chrome extension

Extension UI, image rendering, selected-file metadata, original
export, bundle and ZIP output.

- [Extension viewer entry point](../viewer/app.js) · `openSelected` <!-- locate: async function openSelected( -->
- [Extension viewer template](../viewer/extension/viewer.html) · selected-file metadata control <!-- locate: id="selectedMetadata" -->
- [Extension build](../viewer/build.mjs) <!-- locate: import  -->
- [Extension verification](../scripts/check_extension.py) <!-- locate: def main( -->

## Archive security and verification

Signature or integrity report, C2PA credentials, PAdES B-LTA, timestamps, signer
trust, independent validation.

- [Archive security orchestration](../src/main/java/digital/thinkbox/dicompdf/ArchiveSecurity.java) · `ArchiveSecurity` <!-- locate: class ArchiveSecurity -->
- [Desktop report session](../src/main/java/digital/thinkbox/dicompdf/DesktopViewerSecurityReport.java) · `Session` <!-- locate: class Session -->
- [Browser report verification](../viewer/archive-verification.mjs) · `verifyArchivePlan` <!-- locate: function verifyArchivePlan( -->
- [Reusable PDF security library](../docs/PDF_SECURITY_LIBRARY.md) <!-- locate: # Reusable -->
- [Independent archive validator](../scripts/archive_validator.py) <!-- locate: def main( -->

## Runnable JAR distribution

Version bump, Maven verify, creator, viewer, CLI, distribution checks.

- [Advance the application version](../scripts/bump_application_version.py) · `advance_application_version` <!-- locate: def advance_application_version( -->
- [Maven publication execution](../app/pom.xml) · `publish-runnable-jars` <!-- locate: <id>publish-runnable-jars</id> -->
- [Verify and publish JARs](../src/main/java/digital/thinkbox/dicompdf/JarPublication.java) · `publish` <!-- locate: static void publish( -->
- [Distribution smoke check](../scripts/check_desktop_distribution.py) <!-- locate: def main( -->
