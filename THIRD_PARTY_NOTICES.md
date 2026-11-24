# Third-party notices

The runnable JAR includes component license/notice files under `META-INF/` and
this project's notices under `META-INF/dicom-pdf/`. The Chrome extension also
contains its own license inventory, identical to
`viewer/THIRD_PARTY_NOTICES.txt`. No dependency on the adjacent EA-PDF
checkout is required at build or runtime.

## Java runtime components

- DBus-Java **5.2.2**, core and native Unix socket transport, ships with the
  desktop viewer to access the Linux file chooser portal. MIT license,
  `third_party_licenses/DBus-Java-MIT.txt`.
  Source: <https://github.com/hypfvieh/dbus-java/tree/dbus-java-parent-5.2.2>.
- The desktop viewer's portal adapter is adapted from the Apache-2.0 EA-PDF
  Desktop Viewer. Copyright 2026 ThinkBox Digital.
- COSE-JAVA **1.1.0**: BSD-3-Clause, copyright Jim Schaad;
  `third_party_licenses/COSE-Java-BSD-3-Clause.txt`.
  Source: <https://github.com/cose-wg/COSE-JAVA>.
- PeterO CBOR **4.5.6**, Numbers **1.8.2**, and DataUtilities **1.1.0**:
  Unlicense; `third_party_licenses/PeterO-Unlicense.txt`.
  Sources: <https://github.com/peteroupc/CBOR-Java>,
  <https://github.com/peteroupc/Numbers-Java>, and
  <https://github.com/peteroupc/DataUtilities>.
- COSE-JAVA's optional EdDSA-Java provider is excluded from the distribution.
  This application supports RSA-PSS and P-256 COSE signing, with Bouncy Castle;
  the vulnerable EdDSA-Java 0.3.0 implementation is not included.
- EU DSS **6.5**, PDFBox backend and offline validation/policy/CMS providers:
  LGPL-2.1-or-later, copyright European Commission and contributors.
  Exact license: `third_party_licenses/EU-DSS-LGPL-2.1.txt`.
  Source: <https://github.com/esig/dss/tree/6.5>. The runnable application
  replaces the DSS 6.5 `PAdESUtils` revision scanner with a block-based
  implementation. Its modified LGPL source is under
  `META-INF/dicom-pdf/src/main/java/eu/europa/esig/dss/pades/PAdESUtils.java`.
  Upstream source JARs are bundled under `META-INF/dicom-pdf/eu-dss-sources/`.
  The application source and Maven build permit rebuilding with other DSS
  modules. Rebase or remove the application patch when changing `dss.version`.
  Reverse engineering for debugging modifications to these LGPL components
  is permitted. No OpenPDF backend or DSS online-service module is included.
- DSS transitive Apache Commons Lang **3.20.0**, Collections **4.6.0**, Codec
  **1.23.0**, IO **2.22.0** and JSpecify **1.0.0**: Apache-2.0;
  upstream JAR license/notice files are retained.
- Jakarta XML Binding API **3.0.1**, Activation **2.0.1**, JAXB runtime/core/TXW
  **3.0.2** and istack runtime **4.0.1**: Eclipse Distribution License 1.0
  (BSD-3-Clause distribution option). Exact upstream license and copyright
  notices are retained in the combined `META-INF/LICENSE.md` / `NOTICE.md`.
- Apache PDFBox, FontBox, PDFBox IO and XMPBox **3.0.8**: Apache License 2.0.
  Upstream: <https://pdfbox.apache.org/>. License and PDFBox notice are in
  `third_party_licenses/Apache-2.0.txt` and `PDFBox-NOTICE.txt`; upstream JAR
  notices are preserved when shading.
- Bouncy Castle PKIX, provider and utility modules **1.87**: MIT license,
  upstream copyright/license retained as `META-INF/LICENSE.md` in the shaded JAR.
  Source: <https://github.com/bcgit/bc-java/tree/r1rv87>.
- Java JSON Canonicalization **1.1**: Apache License 2.0; exact text in
  `third_party_licenses/JSON-Canonicalization-Apache-2.0.txt`.
  Source: <https://github.com/erdtman/java-json-canonicalization>.
- Gson **2.15.0**: Apache License 2.0.
  Source: <https://github.com/google/gson>.
- dcm4che **5.33.1** core, dictionary and ImageIO components: distributed under
  **Mozilla Public License 1.1**, one of upstream's MPL-1.1 / GPL-2.0-or-later /
  LGPL-2.1-or-later alternatives. These components are unmodified. Exact license:
  `third_party_licenses/dcm4che-MPL-1.1.txt`. Corresponding original source,
  copyright notices and build instructions are available at
  <https://github.com/dcm4che/dcm4che/tree/5.33.1> and
  <https://github.com/dcm4che/dcm4che/archive/refs/tags/5.33.1.tar.gz>.
  Initial developer: Agfa Healthcare; see individual source headers for
  additional contributors.
- Weasis Core Img **4.9.0.1** and its matching OpenCV **4.9.0-dcm** binaries
  provide the converter's JPEG Extended 12-bit, JPEG 2000 Part 1 and JPEG-LS
  decoders. The Java binding and native DICOM extensions are redistributed
  under Apache 2.0.
  The decoder libraries retain their OpenJPEG BSD-2-Clause and CharLS
  BSD-3-Clause notices. See `third_party_licenses/OpenCV-4.9-LICENSE.txt`,
  `OpenJPEG-BSD-2-Clause.txt`, `CharLS-BSD-3-Clause.txt`, and Weasis's
  [native library attributions](https://github.com/nroduit/Weasis/blob/master/3rd-party-licenses.md#native-library-based-on-opencv-for-dicom-image-processing-and-compression).
  Java source: <https://github.com/nroduit/weasis-core-img>.
  Native binary distribution: <https://github.com/nroduit/mvn-repo/tree/a08885785964549f1147da917a7ca2ae6241e53e/org/weasis/thirdparty/org/opencv>.
- SLF4J API and Simple **2.0.17**: MIT License. Exact notice:
  `third_party_licenses/SLF4J-MIT.txt`.
- Error Prone annotations **2.50.0** (Gson transitive dependency): Apache
  License 2.0; source <https://github.com/google/error-prone>.
- Apache Commons Logging **1.4.0** (PDFBox transitive dependency): Apache License 2.0;
  upstream license and notice retained in the JAR.
- DejaVu Sans: Bitstream Vera license, DejaVu changes in the public domain;
  Arev contributions retain their notice. The unmodified font and exact
  `third_party_licenses/DejaVu-LICENSE.txt` are redistributed. Font source:
  <https://dejavu-fonts.github.io/>.

JUnit and Maven plugins are build/test dependencies and are not included in
the runnable JAR. The sRGB output intent is supplied by the recipient's Java
runtime through `ICC_Profile.getInstance(ColorSpace.CS_sRGB)`.

## Independent local verification tooling

The optional independent Python verifier uses pypdf 7.0.0 (BSD-3-Clause),
pydicom 3.0.2 (MIT), jsonschema 4.26.0 (MIT) and defusedxml 0.7.1 (PSF license).
Its complete dependency versions are pinned in
`scripts/archive-validator-requirements.txt`. Dependencies are installed locally
from their open-source distributions; this repository does not redistribute the
virtual environment. Their upstream license/copyright files remain in the
installed distributions. No Python dependency is required for the Maven build. RFC 8785 canonicalization
uses rfc8785 0.1.4 (Apache-2.0). Independent timestamp extraction uses
asn1crypto 1.5.1 (MIT); exact copyright/license is in
`third_party_licenses/asn1crypto-MIT.txt`. Optional independent signature verification invokes
the locally installed OpenSSL executable; OpenSSL is not redistributed.

## Chrome extension

The pilot chooses Cornerstone3D Core and Tools **2.19.16** (MIT), instead of DWV Simplistic
(GPL-3.0), to avoid introducing GPL-3.0 viewer distribution requirements.
dicom-parser **1.8.21** is MIT; PDF.js **4.10.38** is Apache License 2.0.
Incremental background SHA-256 uses **@noble/hashes 1.8.0** (MIT);
its exact upstream copyright and license accompany the extension.
Local manifest-signature verification uses **PKI.js 3.4.0** and
**ASN1.js 3.0.6** (BSD-3-Clause), with their transitive license texts included
in the extension. Sources: <https://github.com/PeculiarVentures/PKI.js>
and <https://github.com/PeculiarVentures/ASN1.js>.
The Chrome extension includes the transitive components and their exact
license and copyright texts in `THIRD_PARTY_NOTICES.txt` and its GUI.
PDF.js's unmodified standard-font files are bundled locally: Foxit/PDFium fonts
under BSD-3-Clause and Liberation Sans under SIL Open Font License 1.1.
Their exact licenses are retained in `third_party_licenses/PDFJS-Foxit-BSD.txt`
and `PDFJS-Liberation-OFL.txt`, and in the generated extension notices.
Font names and original font bytes are unchanged; fonts are not sold separately.
The metadata exporter also includes a generated dcm4che 5.33.1 standard-tag
dictionary under MPL-1.1. Its complete generated JSON source, upstream source
availability notice and MPL text are included in the extension notices. The
extension ships `dicom-dictionary.json` unchanged.

## Reference implementation

Browser security verification adapts Apache-2.0 code from EA-PDF Generator
(Copyright 2026 ThinkBox Digital), including CMS, C2PA, offline certificate
validation and historical PDF inspection.

The viewer includes the public DigiCert Trusted Root G4 certificate used by
DigiCert’s timestamp service. It is distributed in DER format and pinned to
SHA-256 `33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941`.
[DigiCert timestamp certificate downloads](https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server).

EA-PDF was inspected read-only for PDFBox/XMPBox versions and implementation
patterns (including PDFBox CMS signing): associated-file relationships and name trees, original-byte
fingerprints, PDF 2.0, XMP PDF/A identification, and sRGB output intents. The
browser viewer was also inspected read-only for its toolbar, navigation, reading
surface and collapsible detail-panel layout. View/download and pane-chevron path
geometry is adapted under Apache-2.0 with attribution in
`third_party_licenses/EA-PDF-ICONS-NOTICE.txt`. The application icon is original.
No patched PDF.js code is included. The
dicom implementation is independent and contains no EA-PDF email parsers,
profile declarations, patched HTML renderer or release automation.

## Expanded image codecs (0.3.0)

- TwelveMonkeys ImageIO JPEG and its common/image metadata dependencies **3.12.0**:
  BSD-3-Clause, exact text in `third_party_licenses/TwelveMonkeys-BSD.txt`.
  Source: https://github.com/haraldk/TwelveMonkeys/tree/twelvemonkeys-3.12.0.
- dcm4che RLE **5.33.1** uses the same MPL-1.1 terms/source availability as the
  other unmodified dcm4che modules above.
- fflate **0.8.3** and jpeg-lossless-decoder-js **2.1.2**: MIT; full installed
  licenses are included in the generated viewer notice inventory.
- @cornerstonejs/codec-openjpeg **1.3.6**: MIT wrapper/build, OpenJPEG BSD-2-Clause.
- @cornerstonejs/codec-charls **1.2.7**: MIT wrapper/build, CharLS BSD-3-Clause.
  Both use their bundled pure-JavaScript decode-only builds, not runtime downloads
  or proprietary/native codec binaries. Exact upstream commits, full notices and
  Emscripten runtime license are in `Codec-SOURCES.txt`, `Cornerstone-Codecs-MIT.txt`,
  `OpenJPEG-BSD-2-Clause.txt`, `CharLS-BSD-3-Clause.txt`, and `Emscripten-LICENSE.txt`
  under `third_party_licenses/`, appended inside the viewer and extension notices.
- @cornerstonejs/codec-libjpeg-turbo-12bit **0.4.7** supplies the bundled JavaScript
  grayscale JPEG Extended decoder. The wrapper uses MIT and libjpeg-turbo
  uses the IJG and Modified BSD licenses. Source and notices are in
  `Codec-SOURCES.txt`, `libjpeg-turbo-LICENSE.md`, and `libjpeg-turbo-README.ijg`
  under `third_party_licenses/`. This software is based in part on the work
  of the Independent JPEG Group.
