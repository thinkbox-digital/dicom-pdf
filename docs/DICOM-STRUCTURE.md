# Additional DICOM source checks

Preserved bytes, readable datasets, selected structural checks, full IOD validity
and authenticated acquisition are separate results. New conversions attach a
hashed `dicom-structure.json` in addition to the existing input-check inventory.
This extends the pilot without claiming comprehensive DICOM conformance.

## Current implementation

No new Java dependency is required. dcm4che 5.33.1 parses datasets, classifies
transfer syntaxes and evaluates the selected rules through `Attributes.validate(IOD)`.
The rules were reviewed against edition 2026d of the [DICOM Standard](https://dicom.nema.org/medical/dicom/current/output/chtml/).

| Check | Scope |
| --- | --- |
| Native encoded pixel length | Rows × Columns × stored samples × Bits Allocated × Number of Frames, rounded to bytes and one final even-length pad |
| One-bit multiframe | Frames are concatenated as bits; no per-frame padding is assumed |
| Native YBR_FULL_422 | Two stored samples per pixel despite nominal Samples per Pixel=3; Planar Configuration=0 |
| Native integer VR | OB/OW; more than 8 allocated bits requires OW |
| Float/Double Float Pixel Data | OF/32-bit and OD/64-bit respectively, including encoded lengths |
| Encapsulated pixel header | Pixel Data tag, OB VR and undefined length; compressed codestream is not validated |
| Repeated/exclusive pixel elements | Detects repeated or multiple top-level integer/float pixel elements |
| Classic CT/MR image plane | Required Pixel Spacing, Image Position/Orientation Patient; present but possibly empty Slice Thickness |
| Classic CT selected attributes | Image Type VM and required Rescale Slope/Intercept |
| Classic MR selected attributes | Image Type, Scanning Sequence, Sequence Variant, Scan Options and MR Acquisition Type; selected enumerated values |
| Secondary Capture equipment | Required Conversion Type; its Defined Terms remain extensible |
| Selected optional image fields | Patient Sex, Burned In Annotation and Lossy Image Compression VR/VM/enumerated values |

The module rules apply only to classic CT, classic MR and five Secondary Capture
storage classes. Enhanced CT/MR, CR/DX/MG and other storage classes do not receive
an unsupported full-module validity claim. Pixel-header checks can still apply
when a top-level payload is present. Missing preambles, unknown transfer syntaxes,
uncovered modules and external pixel providers remain UNKNOWN where applicable.
External provider URLs are retained as metadata and never retrieved. Native
YBR_PARTIAL_420/422 sizing is not assessed by this implementation.

Sources with invalid dimensions, overflowing length calculations, truncated data,
inconsistent headers or failed selected rules receive explicit findings. Every
original is preserved unchanged even when its structural status is FAIL.
No missing medical metadata is added to source files. New findings contain rule
codes/paths and generic descriptions rather than copying patient values into
diagnostic messages.

## Versioned evidence and verification

The additional inventory has schemaVersion=1, rulesVersion="1", standardEdition
2026d, validator identity and fullIodValidation=false. It maps each attachment,
source path and SHA-256 to independent check statuses, native expected/supplied
byte counts and issues. See the [machine schema](profile/0.3.0/dicom-structure.schema.json).
The manifest hashes the exact inventory bytes, and its mapping remains available
through XMP inventoryJson. A signed export authenticates the exporter statement;
verification still recomputes results from originals rather than trusting it.

`inspect` labels the results as stored. `verify` reparses original bytes and
compares the complete structural inventory, reporting `dicomStructure` separately
from source byte matches and metadata agreement. A faithful archive containing
invalid DICOM can pass preservation checks while structural checks FAIL.
`verify-security` includes the separate `source.dicomStructure` result; a source
failure is not silently treated as invalid export cryptography or dropped to
make signing succeed.

The existing dicom-validation.json is now schemaVersion=2. It corrects two rules:
Secondary Capture Modality is Type 3 under the SC Equipment override, and a
present Pixel Data Provider URL is not automatically treated as missing native
Pixel Data. Version 1 inventories are recomputed with the original rules, so old
stored evidence is not retrospectively rewritten or falsely flagged as tampered.
The original inventory remains a documented subset, not full IOD validation.

In the viewer, expand **Selected file metadata**. **Stored structural checks**,
**Pixel structure check**, byte counts and findings come from the verified hashed
inventory. The viewer checks the source mapping, rule version and status shapes;
it does not run dcm4che or validate the IOD itself. File checksum PASS and stored
structural FAIL can correctly appear together.

The independent pydicom subprocess also checks native/header structure from its
own raw data elements, without Java imports or pixel_array. Its report includes
`nativePixelStructure` and per-source evidence. Deferred uncompressed values are
bounded against actual file length; deferred deflated values remain UNKNOWN when
the same check cannot be established. It does not independently reproduce the
selected dcm4che module rules or establish complete IOD conformance.

## Bounds and remaining gaps

The added Java scan limits depth to 64, elements/items to 200,000, individual
declared values to 128 MiB and parsed positions/value ranges to 256 MiB. These
are additional limits, not a claim that every creator/parser operation has been
fully sandboxed. The independent subprocess retains its documented memory/CPU/
wall-time limits. No new pixel decoding or background network retrieval is used.

Complete SOP-class IOD/conditional validation, compressed codestream validation,
private dictionary semantics, pixel correctness, clinical calibration, signing
of acquisition evidence and clinical completeness remain outside these checks.
Passing this subset must never be presented as "valid DICOM" without qualification.

Synthetic tests cover native LE/BE/deflated encodings, packed frames, subsampled
color, float headers, truncation, module type/VR/VM/enumerations, remote providers,
preservation despite failures and the versioned SC correction. Browser checks
use a new synthetic archive and never modify supplied samples or earlier PDFs.
