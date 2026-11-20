# Independent local archive verification

This verifier does not import the Java creator or reuse PDFBox/dcm4che. It uses
pypdf 7.0.0, pydicom 3.0.2, jsonschema 4.26.0, defusedxml 0.7.1,
rfc8785 0.1.4 and asn1crypto 1.5.1. The complete
dependency set is pinned in scripts/archive-validator-requirements.txt. This is
local development tooling, not a published or certified validator.

## Setup and use

Linux/Python 3.12 is currently checked. Keep generated files under target/.

```sh
python3 -m venv target/archive-validator-env
env -u PYTHONPATH target/archive-validator-env/bin/python -m pip --isolated install -r scripts/archive-validator-requirements.txt
env -u PYTHONPATH target/archive-validator-env/bin/python scripts/archive_validator.py out/example.pdf --sources in/example --verapdf /path/to/verapdf --output target/example-independent-report.json
env -u PYTHONPATH target/archive-validator-env/bin/python -m unittest discover -s scripts -p test_archive_validator.py -v
```

The PYTHONPATH removal prevents workstation-injected Python packages from bypassing
the isolated pinned environment. The verifier never changes the PDF or supplied
sources, never uploads data, never fetches schemas, and refuses report overwrites.
Omit --sources when originals are no longer separately available; this makes
external-input reconciliation UNKNOWN, not an inferred success. Omit --verapdf
only when PDF/A validation is intentionally UNKNOWN. No validator is downloaded
or run from an attachment. Only a locally selected executable is used.

## Separate results

| Check | Evidence and scope |
| --- | --- |
| manifestSchema | Local draft-2020-12 schema; strict UTF-8 JSON; duplicate keys/nonfinite numbers refused |
| preservationIntegrity | All declared originals/artifacts, sizes, SHA-256, exact manifest sidecar, unique mappings and source attachment relationships |
| xmpConsistency | Exact manifest/full metadata attachment text and checksums reproduced in safe XML |
| inputReconciliation | Exact relative-path set and byte comparison with separately supplied input directory |
| dicomReadability | Independent pydicom reparse; this is not full SOP-class IOD validation |
| nativePixelStructure | Independent native encoded lengths, padding/packed frames, selected VR and encapsulated headers; external/deferred coverage gaps stay UNKNOWN |
| identityMetadata | Source SOP/study/series identity, transfer syntax and supplied image dimensions/frame count |
| explicitSopReferences | Independently found explicit referenced UIDs, classes, frames, occurrence counts and target resolution; path notation and DICOMDIR semantics are not independently checked yet |
| pdfa4f | Separate veraPDF execution explicitly requesting flavour 4f |
| dicomIodConformance | UNKNOWN; a readable source is not certified valid |
| manifest.signature / pdf.signature | Independent OpenSSL CMS verification against actual extracted bytes and bound issuer certificate |
| pdf.coverage | Byte ranges cover the entire PDF except its bound signature value |
| certificateTrust / revocation | Explicit external PEM trust anchors; local certificate path, validity and retained signed CRLs |
| capturedInventory | The signed ingestion receipt’s file count and canonical ordered source-inventory digest match the manifest |
| provenance | Authenticated export requires canonical signed manifest bytes, captured-inventory agreement, verified signatures, supported keys, explicit trust, revocation checks and PDF coverage |
| trustedTimestamps | Independent ASN.1 extraction plus OpenSSL checks of both tokens, imprint, signature, TSA trust/CRLs and time |

Full non-pixel metadata semantic equivalence is explicitly UNKNOWN. The XMP
check establishes index/attachment consistency, not that every indexed attribute
was decoded correctly. An unreadable original remains preserved and causes
partial parsing/identity/reference coverage. Disagreements demonstrated by the readable originals still fail their checks.

All check statuses are PASS, FAIL, UNKNOWN or NOT_APPLICABLE. Exit 1 means a
checked requirement failed; exit 2 means at least one check is UNKNOWN. Exit 0
means every applicable check is known and passed. Acquisition, full IOD conformance
and clinical completeness are never inferred from hashes or an inventory.
Reports do not include patient values in console diagnostics.

For the optional signed extension, install OpenSSL separately (checked here with
OpenSSL 3.0.13). It is invoked locally with no network trust fetching. Add explicit
issuer trust certificates, selected independently of the PDF:

```sh
env -u PYTHONPATH target/archive-validator-env/bin/python scripts/archive_validator.py out/example-signed.pdf --sources in/example --trust /secure/root.pem --verapdf /path/to/verapdf --output target/example-signed-report.json
env -u PYTHONPATH target/archive-validator-env/bin/python -m unittest discover -s scripts -p 'test_archive*.py' -v
```

The verifier validates the actual CMS signer against the signed issuer hash, not
a declared issuer name. Public retained CRLs are not trusted until their issuer
and signature are checked. Missing/stale CRLs remain UNKNOWN. No private keys
are needed. It verifies signatures and trust with OpenSSL independently of the
Java signer/validator. It does not independently validate the exporter CMS ESS attribute policy,
PDF signature profile conformance or DICOM PS3.15 signatures. RFC 3161 token
verification uses OpenSSL ts with explicit anchors/CRLs and an independent ASN.1
parser. Both Java and Python verify the external evidence chain described below.
The Python verifier checks the original export CMS in a B-LTA PDF but reports
revision coverage and B-LTA protection UNKNOWN; it does not validate archival
timestamp chains. The Java validator delegates those checks to EU DSS. See
[security scope](SECURITY.md).

PDF size is not an eligibility cutoff. PDF hashing and external-source comparisons
are streamed. Because pypdf materializes decoded attachments, its decoding and
retained-payload budgets use one quarter of currently available system memory;
an operation that cannot fit fails explicitly. Source scans remain bounded and
reject symlinks. Java verification/recovery streams attachment contents through
disk-backed PDFBox filters and does not share pypdf's materialization requirement.
Each pydicom parse runs in a separate subprocess with a 2 GiB address-space cap,
25 CPU seconds and 30-second parent timeout; deflated inputs cannot bypass that
process bound. No pixels are decoded. The parent PDF process is not yet a complete
sandbox; hardening against every malformed PDF/filter and platform qualification
remain product acceptance work. Parser errors use codes, not patient values.

## Local conformance corpus

scripts/test_archive_validator.py generates synthetic DICOM with pydicom and
PDF packages with pypdf. Nine cases check byte recovery, wrong metadata despite
matching manifest/XMP, input omissions, undeclared attachments, duplicate IDs,
invented references, invalid associations, hostile XML, strict JSON and safe paths.
These are package checks; the synthetic PDFs deliberately do not claim PDF/A.

An existing creator-generated synthetic archive separately passes all implemented
checks with veraPDF and external originals. Evidence is under
target/archive-independent-second.json. The mixed corpus report under
target/archive-independent-corpus.json retains unresolved/partial outcomes rather
than treating every input as valid. Original report/CT PDFs and their sources
are not modified by this verification.

The signed synthetic demonstration is target/viewer-test-pdfs/synthetic-authenticated.pdf. All six
originals, schema, XMP, inventory, manifest/PDF signatures, explicit synthetic
issuer trust, fresh CRLs and PDF/A-4f pass independently. Evidence:
target/security-demo/independent-final.json and target/security-demo/java-final.json.
The fixture deliberately includes a non-DICOM source: Java reports a separate
source-subset FAIL while preserved bytes remain PASS; the independent parser
reports incomplete parsing coverage as UNKNOWN. Timestamps, acquisition and
clinical completeness remain UNKNOWN. These expected outcomes are not blanket
validation success. The synthetic identity is only a test fixture.

Three additional OpenSSL tests generate their own synthetic identity and check
actual signed bytes, changed content/signatures, missing trust and signer mismatch.
All twelve independent archive/signature tests pass.

## Independent timestamps and external evidence

Both signatures in the timestamped synthetic archive now pass independent RFC
3161 verification. The verifier extracts the token using asn1crypto, checks that
its SHA-256 imprint binds the actual CMS signature value, rejects duplicate token
attributes and future times, and runs OpenSSL timestamp signature/TSA trust/CRL
validation. Trust anchors are always external. TSA certificate/CRL evaluation
uses the token generation time; a local reference time alone is not trusted time.
OpenSSL ts is given an explicit CA file/store and empty auxiliary CA directory
to avoid implicit system trust. See [OpenSSL timestamp verification](https://docs.openssl.org/3.0/man1/openssl-ts/).
Missing anchors/revocation evidence remain UNKNOWN. Required missing tokens fail.

```sh
env -u PYTHONPATH target/archive-validator-env/bin/python scripts/archive_evidence_validator.py out/example-signed.pdf --evidence target/evidence-2.json --trust /secure/root.pem --output target/independent-evidence.json
```

The separate evidence verifier checks the local external-evidence schema, exact
JCS bytes, complete PDF hash/length, every predecessor hash, timestamp ordering,
CMS signatures, bound exporter certificates, explicit trust and retained CRLs.
Historical exporter-certificate evaluation is permitted only after a trusted
timestamp has been verified for that exact signature. It never modifies the PDF
or evidence. It verifies the evidence chain, not PDF/A, DICOM validity or clinical
completeness: use the archive verifier separately. Exit 2 can still be expected
for unknown acquisition/completeness while every evidence check passes.

Evidence: target/timestamp-demo-final/independent-timestamps.json and
target/timestamp-demo-final/independent-evidence.json. Six originals and both
renewal entries remain accounted for. Sixteen independent tests pass, including
OpenSSL-generated synthetic TSA tokens and chains. Negative cases cover altered
imprints/signatures, duplicate timestamp attributes, revoked TSA certificates,
wrong time reference, missing trust/CRLs, changed PDFs/bindings and removed
predecessors. No Java creator code or real patient files are used in those tests.

External envelope rollback detection requires a trusted record of the latest
envelope hash, as documented in SECURITY.md. Full historical revocation policy,
algorithm migration and independent OCSP/B-LTA revision policy remain outside
this Python verifier. Java/EU DSS implements B-LTA and PDF renewal separately.
DSS parsing and retained CRL use are implemented as described below.

## Standard PDF validation store

New signed exports retain public certificate chains and CRL/OCSP evidence in
standard PDF DSS streams covered by the export PDF signature. The independent
`archive_dss.py` parser applies entry/decoded-size bounds and strict DER structure
checks with asn1crypto. Retained CRLs are passed to the existing offline OpenSSL
checks; embedded certificates do not become trust anchors. `pdf.validationStore`
reports structural parsing separately from signature, trust and revocation results.

Independent OCSP policy evaluation is not implemented: an OCSP-containing archive
reports `pdf.ocspPolicy: UNKNOWN`. In particular, a correctly signed OCSP-only
archive is not reported as independently export-authenticated without independently
validated revocation evidence. Java supports the documented offline OCSP subset.

The fresh synthetic DSS demonstration, `target/viewer-test-pdfs/pades-dss-synthetic.pdf`, passes
independent OpenSSL manifest/PDF signatures, both RFC 3161 signature timestamps,
external-root trust, retained CRLs and veraPDF PDF/A-4f checks. Its OCSP-only
counterpart, `target/viewer-test-pdfs/pades-ocsp-synthetic.pdf`, passes signatures and PDF/A-4f while
independent OCSP policy/revocation remains UNKNOWN. Both recover five originals
exactly with Poppler and display all eight pages in an ordinary PDF renderer.
Evidence is under `target/pades-dss-fixtures/`. These test credentials and sources
are synthetic and do not authenticate any real institution or acquisition.

The pydicom probe now records per-source native pixel structure under sourceEvidence
and a separate nativePixelStructure aggregate. It uses raw/deferred element
lengths without decoding pixels; absent external providers are never fetched.
Four additional synthetic tests bring the independent total to 20. This does
not independently reproduce the dcm4che module rules or full DICOM IOD validation.
See [structural scope](DICOM-STRUCTURE.md).
