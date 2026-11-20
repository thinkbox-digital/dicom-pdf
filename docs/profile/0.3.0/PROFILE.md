# DICOM-in-PDF archival profile: dicom-images 0.3.0

Local specification, revision 1. This documents the existing profile; it is not
an ISO/DICOM/IHE standard, certification or publication. MUST, MUST NOT and SHOULD
express requirements for an implementation claiming this project profile.
PDF/A-4f conformance is an additional, independently validated requirement.

## 1. Preservation boundary

The submitted set is the captured set of regular files under an input root.
Every submitted file MUST be represented exactly once by an original attachment
and manifest source row. The implementation MUST NOT discard a file because it
is empty, unreadable, non-DICOM, unsupported, has a duplicate UID, or cannot be
rendered. Sources MUST retain their exact bytes, including file meta, private
attributes, encoded pixel data, transfer syntax, all frames and existing signatures.
No transcoding, de-identification, tag repair or UID substitution is permitted.

An implementation MAY refuse the complete conversion on resource, path, safety
or read failures, but MUST NOT publish a successful partial archive. A source
read/display failure is distinct from a successful preservation of invalid bytes.
Source role is caller asserted; deidentified-copy is not a de-identification claim.
Archive containers are originals only if included in the submitted set. Expanding
an archive does not preserve the original container unless it is also submitted.

## 2. PDF and attachments

The PDF MUST be PDF 2.0 and satisfy PDF/A-4f, checked by a dedicated validator.
Identification XMP alone is not proof of conformance. Original attachments MUST
use associated-file relationship Source; generated package data uses Data or
Supplement as appropriate. Original names in the PDF MUST be unique flat recovery
keys; original relative paths are recorded separately and MUST NOT be rewritten
because SOP Instance UIDs or basenames repeat. Attachment names MUST NOT be used
as a claim that a supplied file is valid DICOM.

Required attachments: manifest.json, manifest.sha256, inventory.txt, profile.json,
field-mapping.json, dicom-xmp.rng, RECOVERY.txt and each original named by the manifest.
Versioned metadata extensions may require additional hashed attachments. A viewer
MAY be included but MUST NOT be required for recovery or verification.

File paths MUST be relative, slash-separated, nonempty and free of traversal,
empty components, backslashes, colons and control characters. Extraction MUST NOT
follow symbolic links, overwrite existing destinations or silently merge colliding
paths. If a target filesystem cannot represent paths distinctly, extraction MUST
refuse the conflict or require a separately documented explicit mapping.

## 3. Manifest

The manifest is UTF-8 JSON without duplicate object keys or non-finite numbers.
It declares schemaVersion 2, profile dicom-images, profileVersion 0.3.0, creator,
sourceRole, images, references, duplicateInstanceUIDs and artifactSha256.
The accompanying local manifest.schema.json specifies field types and constraints.
Unknown additive properties do not establish any additional verified capability.

Despite its legacy name, images contains ALL supplied originals. Every source row
MUST bind attachment, sourcePath, size and lowercase SHA-256 to the exact complete
original bytes. SOP Instance UID is the supplied identifier or null; absent fields
MUST NOT be invented. supplied and embedded MUST be true. Rendering status is
rendered or unrendered; unrendered requires an explicit reason and no source-frame
or preview-hash claim. Each row maps to a distinct one-based PDF reference page.

Rendered rows MUST identify the one-based source frame, effective display recipe
and previewSha256. The current creator selects frame 1; that image MUST NOT be
presented as representing all frames. Duplicate identifiers MUST remain separate
source rows; duplicateInstanceUIDs maps a UID to every corresponding attachment.
Generated artifact hashes MUST cover the actual attachment bytes. Self-referential
manifest hashes are forbidden; manifest.sha256 is a separate checksum sidecar.

## 4. JSON bytes, canonicalization and integrity

Existing profile manifests are not required to be canonical JSON. Their identity
is their exact UTF-8 attachment bytes, including whitespace. manifest.sha256 is
exactly lowercase SHA-256, two ASCII spaces, manifest.json, and LF. XMP inventoryJson
MUST reproduce the exact manifest text, not a reformatted equivalent JSON object.

A verifier MUST NOT normalize existing manifest bytes before comparing their
hashes. Future canonical signed evidence requires an explicitly versioned
extension specifying its canonicalization and signature algorithms. Rewriting a
legacy manifest to canonical form creates different evidence and MUST NOT be
represented as preserving the old checksum/signature.

Checksums establish byte agreement only. A self-consistent replacement of the
manifest and contents is not authenticated provenance. The unsigned base profile provides no
issuer authentication, signature validation or trusted timestamp claim. The opt-in
security extension below defines separate, explicitly verified export evidence.

## 5. Metadata and XMP

The namespace is https://thinkbox.digital/ns/dicom/2.0/. Core properties include
schemaVersion, profile, profileVersion, sourceRole and inventoryJson. Their values
MUST agree with the manifest. field-mapping.json defines selected source fields;
absent/blank fields are omitted, not guessed. The attached schema/mappings MUST
be recoverable. They are data: validators MUST NOT execute fetched or embedded code.

When metadataXmpVersion is 1, dicom-metadata.json, metadata-mapping.json and full
XMP metadataVersion=1, metadataJson and metadataSha256 are required. metadataJson
MUST reproduce the exact UTF-8 metadata attachment bytes; its checksum and the
artifact hash MUST agree. All readable non-pixel attributes, including nested,
private and opaque values, MUST be retained or source parsing reported partial/
unreadable. Pixel payloads stay in originals and have explicit omission markers
in the metadata index. No silent metadata truncation is allowed.

Metadata paths use one-based SQ item indexes. Legacy reference sequencePath
strings use the existing zero-based traversal notation; they MUST NOT be
reinterpreted as metadata paths. Normalized decoded values are an index, not a
byte-preserving substitute for the original DICOM encoding.

## 6. Human-readable representation

The PDF MUST contain a study summary, readable supplied/embedded/displayed/rejected
inventory, reference or diagnostic pages, and independent recovery instructions.
Labels MUST use supplied data or state absence; they MUST NOT infer anatomy,
laterality, clinical findings, study completeness or device provenance.
Derivative images MUST be distinguishable from authoritative originals. Display
adjustments and incomplete multiframe coverage MUST be discoverable from the
page mapping/inventory. Unsupported references remain preserved with diagnostics.
Viewer support for a report is not evidence that the PDF itself contains a
human-readable rendering of that report.

## 7. Relationships and completeness

Explicit SOP references MUST distinguish resolved, missing, ambiguous,
class-mismatch, invalid-frame and unassessed cases. Resolution uses the supplied
set only; external filesystem/network searches and duplicate-ID merging are
forbidden. A failed reference scan MUST be explicit. A zero-missing count MUST
NOT imply that a clinical study is complete. Unknown relationship coverage MUST
remain distinguishable from verified absence of unresolved explicit references.
DICOMDIR File IDs require separate path/record/class/syntax checks. Reading a
DICOMDIR does not establish conforming DICOM media generation or IHE PDI conformance.

## 8. Validation and recovery

Verification MUST report separately: container/schema integrity, original bytes,
external-input reconciliation when supplied, metadata agreement, reference
coverage, PDF/A-4f validation, DICOM validity scope and authenticated provenance.
PASS, FAIL, NOT_CHECKED, UNRESOLVED and unknown coverage MUST NOT be collapsed into
a single unconditional validity/authenticity label. DICOM parsing is not full IOD
conformance validation. PDF/A validity says nothing about DICOM source validity.

Any ordinary attachment extractor MAY recover originals. Exact source-path
reconstruction uses the manifest; source bytes MUST match size and SHA-256 before
being reported verified. Recoverability MUST NOT depend on the embedded viewer,
proprietary services or this reference creator. A separate implementation SHOULD
verify extraction, schema, hashes and reparsing against a public-format test corpus.

## 9. Compatibility and local implementation bounds

Application version 0.4.0 is distinct from profile 0.3.0 and manifest schema 2.
The full-XMP marker is an explicit optional extension; an absent marker denotes
the older metadata contract, not a malformed new full-XMP archive. Legacy profiles
may be recovered without claiming conformance to this specification.

The creator and Java recovery/verification impose no preset file-size, total-byte
or file-count cutoff. Source capture, embedding, hashing and recovery use
disk-backed streams. Reference rendering, metadata, signatures and browser
allocations remain subject to available memory, disk, parser safeguards and
library/format constraints. Refusal MUST preserve an existing output and originals.
These resource constraints do not establish clinical study completeness.
Whole-PDF reproducibility and authenticated acquisition are not established by
this version. Viewer 0.5.0 is independent of the archive profile version.

## 10. Optional security extension, schema version 1

An archive with security.schemaVersion=1 MUST satisfy [the security contract](../../SECURITY.md).
Its manifest MUST be RFC 8785 JCS canonical UTF-8. security declares protection,
canonicalization, manifestSignature, provenance and issuerCertificateSha256.
The current implementation accepts CMS_AND_PDF, CMS_AND_PDF_TIMESTAMPED and
PADES_B_LTA. The last requires EU DSS validation, retained validation evidence and
a final archival document timestamp; incomplete protection MUST fail without
downgrade. A schema-valid declaration
is not evidence that a requested protection level has been achieved.

manifest.p7s MUST be a detached CMS signature over the exact manifest bytes. The
actual signing certificate MUST match issuerCertificateSha256 and its SHA-256
ESS SigningCertificateV2 attribute. provenance.json MUST be hashed in artifactSha256.
Optional revocation.json contains hashed public CRL evidence and optional base64
DER OCSPResponse evidence in `ocsps`. manifest.p7s MUST NOT
be hashed in the manifest it signs: that would introduce a circular dependency.
The export PDF signature MUST cover the completed package including manifest, CMS,
originals and initial evidence, excluding only its own bound Contents value.
For PADES_B_LTA, later revisions MUST be validated archival extensions, with a
valid final document timestamp covering the complete current PDF.

The current creator also writes standard DSS Certs/CRLs/OCSPs streams before the
export PDF signature. The store MUST contain public validation material only and
MUST be covered by that signature. Embedded roots MUST NOT become trust anchors.
DSS parsing and the cryptographic use of retained evidence MUST be reported
separately. VRI dictionaries are not emitted. EU DSS implements document timestamps,
B-LTA validation and renewal; ordinary content changes MUST NOT be accepted as
archival extensions. PDF CMS uses DER encoding and
omits CMS signingTime; the PDF signature dictionary retains its local-clock /M.

Trust anchors MUST be selected by the verifier outside the archive. Embedded
certificates and CRLs MUST NOT be trusted merely because they are present.
Local-clock observations MUST NOT be reported as trusted timestamps. Verification
checks MUST use PASS, FAIL, UNKNOWN or NOT_APPLICABLE; each signature's mathematical
validity, certificate validity/trust, revocation, timestamp and PDF coverage MUST
be separate. Signing/validation failures MUST NOT silently produce a lesser
protection level. Existing unsigned behavior remains an explicit separate mode.

EXPORT_AUTHENTICATED means the supported export signature, issuer trust and
revocation requirements passed. It MUST NOT imply SOURCE_AUTHENTICATED,
authenticated acquisition, medical accuracy or clinical completeness. The current
implementation preserves but does not cryptographically verify DICOM PS3.15
signatures, and MUST NOT report SOURCE_AUTHENTICATED.

CMS_AND_PDF_TIMESTAMPED additionally requires verified RFC 3161 signature timestamps
on both detached manifest CMS and completed PDF CMS. A missing/unverified token
MUST NOT satisfy this protection level. The opt-in TSA URL belongs to operator
configuration and MUST NOT be used by verification. External evidence schema 1 is
separate from the PDF profile: it binds the immutable complete PDF and prior
evidence entries without rewriting original bytes or claiming PAdES renewal.

## 11. Optional additional DICOM structure inventory

New creators attach hashed dicom-structure.json, schema/rules version 1. It MUST
map every original by attachment/path/hash, state fullIodValidation=false and
report native/header and selected module results independently of preservation.
Its [machine schema](dicom-structure.schema.json) defines types and statuses.
No source MUST be dropped or rewritten because a structural check fails.
A verifier supporting this extension MUST recompute its results from originals;
matching the attachment checksum alone does not validate its diagnostic claims.
Older archives without this extension remain unassessed for it.

The existing input-check inventory now supports schemaVersion=2 with the SC
Modality override and external-provider correction. Stored schemaVersion=1
inventories MUST be interpreted using their original rule semantics. Neither
version establishes full SOP-class IOD conformance. The viewer labels additional
results as stored diagnostics, not browser-computed DICOM validity.
