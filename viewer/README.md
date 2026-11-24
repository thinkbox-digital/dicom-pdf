# Chrome extension viewer — 0.89.0

The file integrity report opens at the top on every visit. Its close × stays in
the top-right header while the report scrolls; Save report remains at the bottom.
The lower-right status bar shows the running viewer version at every window width.
The sidebar follows the same slice order as the wheel, Previous/Next and image
slider, with sequential row numbers and unchanged original filenames. Inventory
and references follow the supplied-files section without unused vertical space;
inventory counts are separated into readable lines. Selected file metadata is the
first action below the right-pane heading and opens a separate scrolling dialog
at the top each time.
The Save menu combines Original file, Originals ZIP… and Image copy (PNG).
Selected-file, series and exam ZIPs include a scoped inventory and the source
manifest digest. Only the all-files ZIP includes the full manifest and supplements.
Image copies use the current DICOM or raster image adjustments. Choose
**Open PDF…** or drop one converted DICOM PDF onto the viewer.
The extension does not register as the
browser's PDF handler. The Loading… dialog follows PDF indexing and first-image
display. Full metadata and archive integrity checks continue after opening.
Raster previews keep brightness, contrast, zoom, rotation, invert, Fit, Reset,
and fullscreen controls below a separately scrollable image area.
DICOM display supports unsigned 16-bit RGB in native and RLE encodings and
segmented color palettes. A Modality LUT in an image maps its stored samples
before grayscale windowing. Parametric Maps open in grayscale with their
frame-specific windows, including maps with 32-bit or 64-bit floating-point
pixels. The viewer also displays HTJ2K, verified headerless Explicit VR
Little Endian CT, RGB with an empty ICC profile, and sampled grayscale VOI
LUTs. Select a grayscale presentation state to view its saved settings on
a referenced frame. Select an MR spectroscopy object to choose a voxel
and switch between its acquired signal and Fourier spectrum.
RT Dose opens in a Cornerstone stack with a grid-wide color scale, source
slice navigation and scaled voxel values. RT Plan opens as a read-only summary
of the recorded plan attributes. Surface Segmentation opens in a vtk.js 3D
preview with rotation, pan, zoom and reset. [Supported encodings and Big Endian word order](../docs/GUIDE.md#image-support)
An original with two zero PixelSpacing values or
an invalid PixelAspectRatio opens with square display pixels and an aspect
ratio warning in both image panes.
When a grayscale original has a single top-level LINEAR window with center
and width both zero, interactive display uses the non-padding pixel range
and reports the automatic window in the status bar.
DICOM images open centered on the image area, excluding complete zero-filled
outer strips that are black in the initial display. Fit and Reset use the same
area, including in comparison views; original pixels and PDF previews stay intact.

This version opens C2PA profile 0.4.0 archives, including institutionally signed
and timestamped exports, alongside profiles 0.3.0 and legacy intraoral 0.2.0.
Use the updated viewer to check existing PDFs. The report verifies supported
CMS/PDF signatures, timestamp imprints, C2PA binding and DICOM archival
revisions. The report can automatically load public timestamp CA certificates.
Add the signer’s CA from a file or an approved HTTPS site. See [browser security verification](../docs/SECURITY.md#viewer-results).

The first supported image opens automatically. A package with no supported images shows its source list and a status message. Viewing and signature verification run locally. The extension bundles the runtime code, PDF.js worker, native pixel decoder and third-party notices. Optional network access retrieves public CA certificates from approved sites.

PDF.js reads `manifest.json` and the original attachments. The viewer checks each original's SHA-256 and instance identifier before displaying it. For a mapped PDF preview, version 2 applies its recorded display baseline from `displayAdjustments`; Reset restores the initial effective PDF/decoder window and camera. File-provided LINEAR, LINEAR_EXACT and SIGMOID alternatives can be explored without rewriting that baseline. Browser interactions do not modify the original, manifest or PDF preview. The viewer shows the package profile and adds a label when the manifest declares a de-identified copy. That label records the creator's declaration. Cornerstone3D handles grayscale/color display, windowing, zoom, pan, and reset through its CPU stack viewport. `dicom-parser` reads the DICOM attributes; `native-dicom.mjs` decodes the native and compressed transfer syntaxes listed in the [guide format matrix](../docs/GUIDE.md#image-support). Native, deflated, RLE, JPEG, JPEG Lossless, JPEG-LS and JPEG2000 codecs are bundled locally; no external runtime codec download is needed. The wheel steps through frames/slices; Ctrl+wheel zooms. Display coordinates are unitless; the pilot provides no calibrated measurement tools.

DWV Simplistic was evaluated: it already provides a small toolbar, but [its GPL-3.0 distribution terms](https://github.com/ivmartel/dwv-simplistic/blob/main/license.txt) were not selected for this pilot. The chosen [Cornerstone3D path is MIT licensed](https://github.com/cornerstonejs/cornerstone3D/blob/v2.19.16/LICENSE). PDF.js is Apache-2.0 and dicom-parser is MIT. `THIRD_PARTY_NOTICES.txt` is generated from installed license and notice files and is bundled with the extension.

Build and test with Node.js 24 and npm 11.

```sh
npm ci --prefix viewer
npm run build --prefix viewer
npm test --prefix viewer
npm run test:extension --prefix viewer
```

Every rebuild advances the viewer's minor version and resets patch to zero,
updating the package, lockfile, extension manifest and documented ZIP filename.
`npm run build` and its `npm run build:extension` alias produce the same extension artifacts.

The node tests use the checked-in synthetic fixtures. Dependencies and compatible patched transitive overrides are pinned in `package.json` and `package-lock.json`. Normal Java builds do not require Node.js or npm. Build-generated notice and version updates accompany source changes.

Profile 0.2.0 adds attached `inventory.txt`, `profile.json`, `field-mapping.json`, `RECOVERY.txt` and `manifest.sha256`. Recovery and command-line verification do not depend on this web viewer. See the [guide](../docs/GUIDE.md) for `inspect`, `extract` and `verify`. Keep archival masters and approved deidentified derivatives in separate packages and directories.

Load `target/chrome-extension` in Chrome or extract the files from
`target/dicom-pdf-chrome-0.89.0.zip`.
[Extension installation instructions](extension/README.md)

Archive integrity checks run automatically. The PDF worker hashes decoded
attachments and returns only their sizes and SHA-256 values for comparison.
Attachments using a single Flate filter can use native browser decompression.
The filename turns green for matching recorded files
or red for a mismatch or failed manifest signature; click it for the report.
PKI.js/WebCrypto check supported SHA-256 manifest CMS signatures locally, with
explicitly unverified results when unsupported or unavailable. A valid signature
does not establish signer identity or historical validity. Initial image display, navigation and cine take priority over
background checks. The viewer reads local PDFs in byte ranges, lists attachment
names first and opens the manifest and selected source on demand. Recent
attachment bytes and their computed digests can be reused by viewing and
background checks. On devices with sufficient CPU and memory, a separate worker
prepares small nearby images and thumbnails while the foreground decoder remains
available for the selected image.

There is no fixed PDF/source size cutoff. Runtime allocation headroom, cache and
queue budgets, compression-ratio and metadata-structure safeguards still apply.
An oversized DICOM can use one transient source slot outside the normal 128 MiB
source cache, provided available browser memory permits decoding it.
