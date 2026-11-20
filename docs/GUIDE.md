# DICOM PDF user guide

Use the desktop app to create and check PDF archives of medical imaging records.
The PDF keeps the supplied files unchanged and adds readable reference pages.
Use an ordinary PDF reader for the pages, or the offline viewer to browse images
and reports.

- [Open the desktop app](#desktop-creator-and-validator)
- [Create an archive](#create-an-archive)
- [Add signatures and timestamps](#add-signatures-and-timestamps)
- [Validate an archive](#validate-an-archive)
- [View images and reports](#view-images-and-reports)
- [Save original files](#save-original-files)
- [Solve common problems](#solve-common-problems)

## Desktop creator and validator

You need Java 21 and a graphical desktop. Launch the desktop JAR in `dist/`:

```sh
java -jar dist/dicom-pdf-0.23.0-desktop.jar
```

If you use IntelliJ, the **Archival DICOM Desktop** run configuration opens the
same app. To build the JAR yourself, see [Building from source](#building-from-source).
Restart the app after installing a new build. The running version appears at
the lower right of the window.

### Create an archive

1. Open **Create**.
2. Beside **File, directory or ZIP**, click **Browse…** and select your input.
   Folders include their subfolders. For a selected ZIP, the PDF includes the
   extracted members and a receipt with the ZIP's filename, byte size, SHA-256
   and member count. Keep the ZIP if you need to recover the container itself.
3. Choose an **Output PDF** outside the source folder.
4. Leave **Include C2PA Content Credentials** checked for export provenance.
   Signing and timestamp options are explained below.
5. Click **Create archive**. Follow progress and messages in **Activity**.
6. When creation succeeds, use **Open PDF** or **Open folder**.

The app preserves supplied files even when it cannot display them. The completion
message lists how many files were preserved and how many reference images were
created. A display failure does not mean an original was discarded.

If the output already exists, choose **Replace** or **Cancel**. Replacement happens
only after creation succeeds; a failed or cancelled conversion keeps the old PDF.
The app will not overwrite source files.

**Stop** ends the current operation. A stopped run is not a successful archive.
Browse dialogs remember their folders between launches.

During creation, **Activity** shows file counts, reference-page generation,
metadata checks, signing, timestamp requests and final validation. The current
step and elapsed time remain visible. A step with no new output for ten seconds
gets a periodic elapsed-time message; this does not claim that validation has
passed or estimate a completion percentage.

The creator prepares reference images with up to four workers, limited by CPU
and available Java heap. Original bytes, reference pixels, metadata, PDF/A and
the requested signature/timestamp protection are still checked before a signed
archive is published. Version `0.5.0` reduces repeated decoding and validation;
its direct use of the generated lossless PNGs can produce slightly larger PDFs.

## Add signatures and timestamps

These options serve different purposes:

| Feature | What it provides |
| --- | --- |
| C2PA Content Credentials | Signed information about the export and evidence of later changes. |
| Institutional signature | A signature made with your organization's certificate. Verifying the organization requires a trusted certificate chain. |
| Trusted timestamp | Signed evidence from a timestamp service that the signed data existed at a particular time. |
| PAdES B-LTA | PDF signatures with retained validation records and archival timestamps for long-term verification. |

These features describe the preserved export. They do not prove how the original
scan was acquired or that the supplied records form a complete clinical study.

### Sign with a certificate

1. In **Create**, use **Signing identity or JSON policy (optional)** to choose
   your `.p12` or `.pfx` certificate file.
2. Leave **Passphrase file (optional)** blank to enter the certificate's password
   when prompted. Alternatively, select a file containing its password.
3. Review the signing description below the fields, then click **Create archive**.

A directly selected certificate must contain one signing key. Keep certificates
and password files outside the input folder. The password prompt does not save
the entered password.

Selecting a certificate alone does not add trusted timestamps or establish trust
in its issuer.

### Use a signing policy

For timestamps or PAdES B-LTA, select a JSON policy in the same signing picker.
The policy specifies the certificate, trusted authorities, timestamp service and
certificate status records. Use a policy prepared by your organization, or follow
the [signing configuration guide](SIGNING_CONFIGURATION.md).

A policy with a timestamp service turns **Add trusted timestamps** on automatically.
Review the description below the picker. Required protection cannot be silently
removed. Missing settings or a failed timestamp stop creation.

Timestamping contacts the configured service with cryptographic hashes; it does
not upload the medical files. Validation and original-file recovery work offline.
Archival timestamp renewal uses the [renewal tools](SECURITY.md#eu-dss-pades-b-lta);
it is not automatic.

### C2PA Content Credentials

**Include C2PA Content Credentials** starts checked. Without an institutional
certificate, the app creates a temporary local signing identity for that archive.
It provides tamper evidence, but does not verify an institution's identity.

With a certificate selected, C2PA uses that certificate. It must meet the supported
C2PA signing requirements. If setup fails, check **Activity** and the
[certificate requirements](SIGNING_CONFIGURATION.md#checks-before-creation).
Uncheck the option if you want to create an archive without C2PA.

C2PA also works with PAdES B-LTA. Signer trust, trusted time and file integrity
are checked separately.

### Missing certificate status records

A certificate can be cancelled before its expiry date. This is called revocation.
The app needs a signed status record from its issuer to check whether that happened.
**UNKNOWN** means the record is missing, out of date or unsupported; it does not
mean the certificate has been cancelled.

Ask your certificate provider or CA administrator for current **CRLs** (lists of
cancelled certificates) or **OCSP responses** (individual status records).
The records must cover your signing chain as well as the timestamp service's chain.
Your administrator adds the files to the JSON policy. The app does not download
them automatically, and required missing evidence blocks B-LTA creation.

If you run your own CA, generating its CRL needs that CA's private key and
certificate records. Your signing certificate alone is not enough. See
[revocation evidence setup](SIGNING_CONFIGURATION.md#revocation-evidence-is-required-too).

## Validate an archive

1. Open **Validate** and select the **Archive PDF**.
2. If available, select the **Original file, directory or ZIP (optional)**.
   This lets the app compare the archive with the supplied originals.
3. To check signatures, timestamps and signer trust, select a JSON policy in
   **Verification configuration (optional)**. Verification needs public trust
   and status records, not a private signing key.
4. Click **Validate archive**.
5. Review **Summary**. Select a check to read its evidence. **Details** shows
   the underlying tool output.
6. Use **Save report…** to save the JSON results to a new file under `target/`
   or another folder outside the originals and `out/`.

Successful creation fills in the validation fields for you. Validation never
changes the archive. Without originals, the external comparison remains **UNKNOWN**.

The desktop uses the veraPDF executable set in the selected JSON policy, then
falls back to the `VERAPDF` environment variable and `verapdf` on PATH. The CLI
`verify` command also accepts `--verapdf /path/to/verapdf`.

Conversion and verification use Java's temporary directory for working copies.
Set `DICOMPDF_SCRATCH_DIR` to choose another writable directory outside the
originals and converted PDFs. For source builds, use a directory under `target/`.

### Read the results

| Result | Meaning |
| --- | --- |
| PASS | This check passed. |
| FAIL | This check found a problem. Read its evidence. |
| UNKNOWN | There is not enough supported evidence to decide. |
| NOT_APPLICABLE | This check does not apply to this archive. |
| INFO | Additional context, such as the authentication assurance reached. |

Review the individual checks even when the operation completes. Preserving a
malformed source correctly can pass integrity checks while source diagnostics
still report a problem. No result proves clinical completeness.

## View images and reports

The desktop's **Open PDF** uses your usual PDF reader. For interactive DICOM
viewing, use the Chrome extension or save the attached `viewer.html` and open it
in a browser. The viewer runs locally with its code and codecs included.

### Install the Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `target/chrome-extension`.
3. Click the extension toolbar icon to open the viewer, then drop a converted
   DICOM PDF onto it or choose **Open PDF…**. A Loading… dialog remains visible while
   the PDF and its first image open. PDFs opened elsewhere use normal browser
   handling; this extension does not register as the browser's PDF handler.

The packaged extension is `target/dicom-pdf-chrome-0.68.0.zip`. After updating,
click **Reload** on the extension page and open a new viewer tab. Opening a local
PDF through the toolbar may require **Enable local PDF access** and Chrome's
file-URL access setting.

The running viewer version appears in the lower-right status bar, including
narrow windows. It identifies the viewer code currently open, separately from
the archive profile version shown beside it on wider windows.
If an update appears to have no effect, compare it with the **DICOM PDF Viewer**
version on `chrome://extensions`, close existing viewer tabs and open the PDF again.
The current unpacked extension is in `target/chrome-extension`; an extension
installed from a separately extracted older ZIP keeps that older code.
Restart the creator after updating its JAR so newly created PDFs embed the new
viewer. Existing PDFs keep their attached viewer; the current extension can open
them without rewriting the archive.

See the [extension instructions](../viewer/extension/README.md) for installation
and access details. An older viewer embedded in a PDF keeps its original version;
use the current extension to view it without changing the PDF.

### Choose records

Use the left **Data** pane to select images, series and reports. **Choose an exam**
appears when the supplied records identify multiple exams. The right **Metadata**
pane shows file information, other supplied files and references.

Switch between **DICOM image** and **PDF reference** to explore the source image
or read its archive page. The PDF reference keeps its original baseline frame.
Encapsulated PDF and structured reports open from the data list. **Page text**
shows selectable text from a PDF report; it does not perform OCR.
Raster image attachments open fitted to the available width and height, including
very tall images. Their image controls stay in a permanent row below the viewing
area: brightness, contrast, zoom, rotation, invert, Fit, Reset and fullscreen.
Zoomed images scroll or pan inside the viewing area; the controls stay visible.
Ctrl+scroll zooms, and dragging pans. **Save → Image copy (PNG)** produces an
adjusted PNG marked as a viewing copy; **Save → Original file** recovers the
unchanged supplied file. **Save → Originals ZIP…** opens the file-scope dialog.

Drag a pane divider to resize it. Double-click the divider to restore its default
width. Narrow windows start with Metadata collapsed; use its pane button to reopen it.

### Adjust the image

| Action | Control |
| --- | --- |
| Move through images or frames | Scroll over the image, use Previous/Next, or drag the position slider. |
| Zoom | Ctrl+scroll or the +/− buttons. |
| Pan | Drag the image. |
| Adjust brightness and contrast | Use the image controls; **Window** lists valid presets supplied by the file. |
| Restore the initial display | **Reset**. |
| Show image information | **Info**. Missing orientation data leaves direction markers hidden. |
| Play a multiframe image | **Play/Pause** and the playback-rate control. |
| Compare images | Pin an image for comparison, then select another image or open another PDF. |

With the image focused, arrow keys navigate, Shift+arrows pan, +/− zoom, 0 fits,
[ and ] rotate, I inverts, and R resets. Space starts or pauses multiframe playback.
These controls change the display, not the original files. Comparison provides
independent 2D views, without image registration or synchronized stacks.

**Save → Image copy (PNG)** exports the current view as a labeled PNG. Visible Info overlays
are included; turn Info off to omit them. Playback pauses before capture.
A PNG copy does not replace the original DICOM or remove identifiers from its pixels.

Use the desktop's **Create** tab to convert loose DICOM files, folders, or ZIP
archives to PDFs for interactive viewing.

## Save original files

Click **Save original** to download the selected file unchanged. Use its adjacent
arrow to choose a ZIP containing one file, a series, the current exam or all files.
The viewer checks available recorded checksums during recovery.

**Current exam** includes files with the selected record's supplied exam ID.
Current-exam, selected-series and selected-file ZIPs include the selected
originals, their recovery inventory and the SHA-256 of the source manifest.
Choose **All supplied files** to include the full manifest and package supplements.

Originals keep their metadata and pixels. None of these exports de-identifies
medical records. If ZIP recovery reports conflicting paths, save files
individually or choose a non-conflicting subset.

You can also save attachments with an ordinary PDF reader. The attached
`RECOVERY.txt` explains recovery without the viewer.

## Check files and export metadata

The viewer checks original and package hashes in the background. Click the
filename to open the security report and use **Save report** to download the
individual results. Green means the completed integrity checks passed, amber
means checking was incomplete, and red means a check failed. Certificate trust
has its own result.

The report groups supported CMS, PDF signatures and timestamp checks, C2PA,
and PAdES B-LTA revision history. **Archive declarations** shows the protection
requested by the creator. Timestamp CA certificates can be retrieved from
approved public sources. Add the signer’s CA from a file or an approved
HTTPS URL in the report. See [browser security verification](SECURITY.md#viewer-results)
for offline use and approved certificate sites.

Under **Selected file metadata**, **Stored structural checks** shows source
findings recorded during creation. A matching checksum does not mean the source
is valid DICOM. See the [source validation scope](DICOM-STRUCTURE.md).

Choose **Export metadata…** to export selected files or all files as CSV.
**One row per file (spreadsheet)** puts fields in columns; **Detailed tag rows**
uses one row per metadata element. You can search and select fields.
**Save document XMP** saves the PDF's extracted metadata packet when available.
These exports do not change the archive.

## Protect personal data

Images, descriptions, reports and metadata may identify a patient. Hiding Info,
saving a PNG or selecting fewer files does not anonymize them. Keep original
archives and approved de-identified copies separate.

Viewing and validation are local. Timestamp creation contacts only the configured
service. Validation details, exported metadata and saved reports may contain
sensitive source information; choose their destinations deliberately.

## Image support

The app handles supported 2D images from CT, MR, X-ray, ultrasound and other DICOM
image-storage classes. PDF references use frame 1; the viewer can explore other
frames. Unsupported files remain embedded with an explanation.

| Encoding | PDF reference | Interactive viewer |
| --- | --- | --- |
| Implicit/Explicit Little Endian, Explicit Big Endian | Yes | Yes |
| Deflated Explicit Little Endian | Yes | Yes |
| DICOM RLE | Yes | Yes |
| JPEG Baseline 8-bit | Yes | Yes |
| JPEG Lossless processes 14 / 14 SV1 | Yes | Yes |
| JPEG Extended, Process 2/4 | 8-bit provider support and unsigned 12-bit grayscale | 8-bit browser decoder and bundled 12-bit unsigned grayscale decoder |
| Retired JPEG spectral selection and progressive transfer syntaxes | Depends on the installed Java provider | Outside current viewer support |
| JPEG-LS lossless / near-lossless | Yes, with a bundled native decoder | Yes |
| JPEG 2000 Part 1 lossless / lossy | Yes, with a bundled native decoder | Yes |
| HTJ2K (.201, .202, .203) | Original preserved | Yes |

The converter generates references for grayscale images with `LINEAR` or
`LINEAR_EXACT` windowing. `LINEAR_EXACT` uses the source window, rescale and
polarity for the selected frame. The JARs bundle JPEG Extended 12-bit, JPEG-LS
and JPEG 2000 Part 1 decoders for Linux and macOS on x86-64 and ARM64, and
Windows on x86-64. These decoders accept up to 64 MiB of encoded data per
frame. The converter limits each frame to 16,777,216 pixels.

The converter and interactive viewer display unsigned 32-bit RGB in native and
RLE encodings by scaling each channel from its stored range to 8-bit display.
The interactive viewer also displays unsigned 16-bit RGB in these encodings.
The viewer also expands segmented color palettes and applies image Modality
LUTs before grayscale windowing. Originals with two zero PixelSpacing values or
an invalid PixelAspectRatio display with square pixels and an unverified
aspect ratio warning.

The interactive viewer displays DICOM Parametric Maps in grayscale, including
16-bit integer maps in supported encodings and native 32-bit and 64-bit
floating-point maps. It uses the selected frame’s DICOM window and retains
fractional pixel values during windowing. The converter preserves the original
map for recovery and records a diagnostic PDF page.

The converter and viewer retain 12-bit JPEG Extended grayscale sample precision
for windowing. Both read older single-component sequential scans whose header
uses zero for the end of spectral selection. The archived source bytes remain
available for recovery.

Headerless Explicit VR Little Endian CT opens after the viewer verifies
the dataset and the full native pixel length. Enhanced RGB with an empty
ICC profile uses the stored RGB values. Grayscale images can use the first
sampled VOI LUT when they have no valid source window. The viewer also applies
sampled Presentation LUTs stored in images, including in existing archives.
The converter preserves images with sampled grayscale LUTs and records a
diagnostic PDF page. Larger frames are subject to the browser's working-memory
and canvas limits.

The converter and viewer use a labeled automatic window when a supported
grayscale image supplies a single top-level LINEAR window with center and
width both zero. The calculation excludes padding pixels. Open an existing
archive with the current viewer to use the fallback for interactive display.

Choose a grayscale presentation state in the source list to open its
referenced image and apply the saved contrast, scale-to-fit crop, rotation,
flip, and supported pixel-relative or display-relative annotations. The
preview supports text, points, polylines, circles, and ellipses. It does not
apply shutters, masks, bitmap overlays, or sampled presentation LUTs.
MR spectroscopy previews support one-dimensional voxels. For complex
time-domain data, the controls show real and imaginary samples in
milliseconds or the Fourier magnitude by frequency offset in hertz.

Select **RT Dose** in the source list to browse the stored dose slices in a
Cornerstone viewport. The color scale uses the range of the entire grid.
Choose a voxel row and column to read its scaled dose in the source units.
The viewer reads native and RLE grids with 16-bit or 32-bit samples.
For 32-bit Explicit VR Big Endian grids, select the source’s word order to
display the slice. DICOM OW stores the low word first. Some legacy exports,
including the Big Endian samples in this repository, store the high word
first.

Select **RT Plan** for a read-only summary of the recorded plan, fraction
groups, beams, initial control-point settings, dose references, brachytherapy
application setups and referenced object UIDs. Use **Save → Original file**
to recover the full DICOM object.

Select a source marked **3D surface** in the source list to open its mesh.
Drag to rotate, hold Shift while dragging to pan, or scroll to zoom. Use
**Reset view** to restore the starting orientation and fit. For objects with
multiple surfaces, use the **Surface** menu to inspect them individually.
The preview needs WebGL and reads the stored geometry, including legacy 16-bit
and current 32-bit point indices. Surfaces with zero recommended opacity are shown opaque
so they can be inspected. The 3D tab works with existing archives and leaves
the PDF reference and downloadable original intact.

Some pixel types, video and waveforms require other viewers.
The viewer does not provide 3D reconstruction or calibrated measurements.
See [known format limitations](../UNSUPPORTED_FORMATS).

There are no preset desktop input-size or file-count limits. Large conversions
still need enough memory and temporary disk space. Browser viewing and ZIP
expansion must fit available memory; archive safety limits also apply.

## Solve common problems

| Problem | What to do |
| --- | --- |
| Creation stops before processing files | Read **Activity**. Correct the listed signing settings, certificate or password. |
| Certificate trust or revocation is UNKNOWN | Ask your certificate administrator to supply the trusted issuer and current signed status records in the JSON policy. |
| A timestamp request fails | Check the service address and connection named in the error. See [timestamp troubleshooting](SIGNING_CONFIGURATION.md#timestamp-connection-failures). |
| PDF/A conformance is not checked | Check that the local veraPDF installation is available. |
| The viewer cannot display a file | Save its unchanged original and open it with a suitable application. |
| An older PDF fails to open in its embedded viewer | Use the current extension or standalone viewer. |
| A missing-class error appears after a rebuild | Close the desktop and launch the current JAR again. |

## Building from source

Use Java 21 and Maven. Run the Java tests from the repository root.

```sh
mvn test
```

The Maven reactor builds the reusable `pdf-security` library and the `app`
module. Application intermediates and test reports are in `target/app/`, and
library artifacts are in `target/pdf-security/`. See the
[library reuse guide](PDF_SECURITY_LIBRARY.md) for using signing in another project.

For a local release build, use Python 3 to advance the application version and
update distribution references. Maven's `verify` phase publishes the checked
JAR pair to `dist/` and retires superseded JARs. Set `VERAPDF` to the executable
path to run the conformance checks below.

```sh
python3 scripts/bump_application_version.py
mvn "-Ddicompdf.test.verapdf=$VERAPDF" verify
python3 scripts/check_desktop_distribution.py --verapdf "$VERAPDF"
```

Viewer builds need Node/npm and Python 3:

```sh
npm ci --prefix viewer
npm --prefix viewer run build
```

That viewer command stages the standalone viewer and extension together before
publishing the pair and advancing their minor version. GitHub runs both version
updaters after each branch push, verifies the runnable JARs, and commits the
updated versions and standalone viewer back to the branch. Download the
JARs, standalone viewer, extension ZIP and SHA-256 checksums from the workflow
run's artifacts. Pull the automated commit with `git pull --rebase` before
pushing again. Branch rules must allow GitHub Actions to write that commit.

Keep build intermediates, reports, screenshots and recovered files in `target/`.
Reserve `out/` for converted PDFs. Keep supplied inputs in `in/` and synthetic
fixtures in `fixtures/`. See [repository build rules](../AGENTS.md).

The desktop and command-line converters use PDFBox Flate level 1 to reduce
conversion time. To favor smaller archives, pass
`-Dorg.apache.pdfbox.filter.deflatelevel=-1` before `-jar` to use the PDFBox
default compression level. Both settings preserve the original attachment bytes.

For command-line options, run `java -jar dist/dicom-pdf-0.23.0.jar --help`.
The project uses Apache-2.0 with retained [third-party notices](../THIRD_PARTY_NOTICES.md).

## Further reading

- [Archival overview](../README.md)
- [Signing configuration and certificate setup](SIGNING_CONFIGURATION.md)
- [Signature verification and renewal](SECURITY.md)
- [Independent validation](INDEPENDENT-VALIDATION.md)
- [Archival format and metadata](profile/0.3.0/PROFILE.md)
- [C2PA archive profile](profile/0.4.0/PROFILE.md)
- [Test instructions](VERIFICATION.md)
