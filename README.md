# Archival DICOM in PDF/A

Medical imaging is increasingly digital, yet patients often receive images that require specialized software, proprietary viewers, or access to systems that may not remain available.

This project creates portable, self-contained PDF/A-4f archives for long-term preservation and patient access. Original DICOM files and metadata remain unchanged, alongside readable reference images, organized study information, and instructions for recovering the original medical data. The PDF pages work in an ordinary reader; an optional offline viewer provides interactive access.

To view a converted DICOM archive, choose **Open PDF…** or drop the PDF onto the
viewer. Use the desktop creator or command-line converter for loose DICOM files,
folders, and ZIP archives.

Cryptographic hashes, C2PA Content Credentials, optional institutional digital signatures (including PAdES B-LTA), trusted timestamps, and independent validation provide evidence of integrity and authenticated export provenance. Signed, timestamped evidence-renewal files can extend that evidence without changing the original archive. The long-term goal is to keep records verifiable as technology and cryptographic standards evolve.

The goal is a standards-based, vendor-neutral solution for medical imaging manufacturers and healthcare organizations, allowing patients to retain, verify, view, and share their original records for decades without depending on proprietary software, obsolete viewers, or continued access to the originating institution.

**Archive features:**

- **Unchanged originals:** Preserve every supplied file, including unsupported or damaged objects, with recovery independent of the viewer.
- **Readable context:** Labeled reference images link to their original sources and frames; metadata is indexed without inventing missing information.
- **Verifiable inventory:** A manifest records what was preserved and how the archive's reference images relate to the originals.
- **Independent checks:** Verify recovered bytes, metadata mappings, PDF/A conformance, and available signature, timestamp, and trust evidence separately.
- **[C2PA Content Credentials](docs/SECURITY.md#c2pa-content-credentials):** Signed export provenance and tamper evidence accompany the archive, with signer trust assessed separately.
- **[PAdES B-LTA signatures](docs/SECURITY.md#eu-dss-pades-b-lta):** Optional institutional PDF signing retains validation evidence and trusted archival timestamps, with renewal for long-term verification.

**Preservation scope:**

Archives preserve the supplied records, with verification of integrity and available export provenance. See the [security documentation](docs/SECURITY.md) for supported protection and the [user guide](docs/GUIDE.md) for privacy and handling guidance.

**Documentation:**

- [Desktop creator and validator](docs/GUIDE.md#desktop-creator-and-validator)
- [Standalone Java DICOM viewer](docs/GUIDE.md#desktop-dicom-viewer)
- [User guide, conversion and recovery](docs/GUIDE.md)
- [Supported formats](docs/GUIDE.md#image-support) and [known limitations](UNSUPPORTED_FORMATS)
- [Run the tests](docs/VERIFICATION.md)
- [Archival profile specification](docs/profile/0.3.0/PROFILE.md)
- [Content Credentials profile](docs/profile/0.4.0/PROFILE.md)
- [Independent verification](docs/INDEPENDENT-VALIDATION.md)
- [Signing, timestamps, renewal and trust](docs/SECURITY.md)
- [Signing configuration and certificate setup](docs/SIGNING_CONFIGURATION.md)
- [Reusable PDF security library](docs/PDF_SECURITY_LIBRARY.md)
- [DICOM specification review](docs/SPEC-REVIEW.md) and [source validation scope](docs/DICOM-STRUCTURE.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

During desktop creation, **Activity** reports file counts, reference-page
generation, signing, timestamping and validation. The app also displays elapsed
time and periodic updates while a step has no new output.

To view an existing archive, [launch the Java desktop viewer](docs/GUIDE.md#desktop-dicom-viewer) or open
[the standalone viewer](src/main/resources/viewer.html) in your browser and choose
**Open PDF…**. The standalone browser viewer and Chrome
extension are built together and show their shared version in the status bar.
The viewer can display the first image while
archive checks run in the background. New archives embed a copy of the browser viewer.

![DICOM PDF Viewer showing an axial chest CT image with the left series pane open](docs/desktop-viewer.png?v=0.56.0&rev=e8e17efe)

*heartscan.pdf open in desktop viewer `0.56.0`.*

Click the PDF filename to open the archive security report. It checks supported
PDF signatures, RFC 3161 timestamps, C2PA credentials and DICOM PAdES B-LTA
revisions on this device. Both viewers can use approved public timestamp CAs and the bundled DigiCert
timestamp CA. Select the signer’s CA certificate from a
file or an approved HTTPS site. The extension shows signature-by-signature hashing progress, and the desktop
shows the verification stage. Changing the CA selection for an open
archive rechecks certificate trust using the completed integrity checks.
See [browser security verification](docs/SECURITY.md#viewer-results).

![Desktop archive security report for heartscan.pdf](docs/desktop-security-report.png?v=0.60.0)

*Archive security report in desktop viewer `0.60.0`.*
