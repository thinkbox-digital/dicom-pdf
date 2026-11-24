# Local signing and verification

The optional security extension signs the preserved export, using open-source
PDFBox 3.0.8, dcm4che 5.33.1, Bouncy Castle 1.87, EU DSS 6.5 and Java JSON Canonicalization 1.1.
EU DSS's PDFBox backend handles PAdES B-LTA augmentation and validation.
Export authentication does not establish authenticated acquisition.
No keys, passphrases or trust configuration are attached to the PDF.

## Supported protection

| Capability | Current implementation |
| --- | --- |
| Exact originals, all frames/private metadata/existing signatures | Preserved unchanged, including invalid or unsupported supplied files |
| Input inventory | Every captured source has a distinct path/attachment, length and SHA-256; duplicate UIDs remain separate |
| Deterministic manifest | RFC 8785 JCS serialization; schema 2, profile 0.3.0, optional security schema 1 |
| Manifest signature | Detached CMS with SHA-256, public certificate chain and ESS SigningCertificateV2 binding |
| Completed PDF signature | CAdES detached signature; full coverage, or verified DSS/timestamp extensions for B-LTA |
| Institutional credentials | PKCS12; RSA >=2048 or EC >=256; validity, usage and key/certificate match checked |
| Offline trust | Explicit external trust anchors, local PKIX path validation, fresh signed full CRLs or supported OCSP responses |
| PDF Document Security Store (DSS) | Standard Certs/CRLs/OCSPs streams retained before the completed PDF is signed; bounded DER parsing and separate certificate-retention checks |
| Offline OCSP | Issuer-signed responses and directly delegated OCSP responders with OCSP-signing EKU and nocheck; freshness, certificate identity, authorization, signature and status checked |
| RFC 3161 acquisition and verification | Configured HTTP/HTTPS TSA requests; both manifest and PDF signatures receive verified tokens; offline Java verification checks imprint, TSA signature, trust and revocation evidence |
| Independent verification | Separate Python/pypdf/pydicom/ASN.1 implementation, OpenSSL CMS/PDF/timestamp and external-chain checks, plus veraPDF |
| External evidence renewal | Timestamped, signed sidecar chains bind the unchanged PDF and prior evidence; offline verification supported |
| PAdES B-LTA and incremental PDF archival timestamps | EU DSS augmentation/validation with retained evidence and final RFC 3161 document timestamp; renewal writes a new PDF |
| Existing DICOM PS3.15 signature cryptographic validation | Not implemented; signatures are preserved and detected, validity is UNKNOWN |
| Acquisition identity, clinical completeness, delivery receipt | UNKNOWN unless separately supported evidence is added; none is invented |

`PADES_B_LTA` publication requires EU DSS's default validation policy to pass,
recognize B-LTA, and satisfy the archive's stricter change/coverage checks.
This is tested implementation behavior, not external certification or an eIDAS
qualified-signature claim. Other protection modes retain their existing behavior.
The PDF CMS is DER encoded, has ESS SigningCertificateV2, and omits CMS signingTime
as required by the PAdES baseline format. PDF /M remains a local-clock statement;
the separate manifest CMS retains its existing signingTime behavior. Neither is a trusted
timestamp. Delta/indirect CRLs and unsupported critical CRL extensions do not
establish revocation status. No automatic AIA, OCSP, CRL or TSA network requests
are made by default. Only explicitly configured timestamped creation/renewal contacts
the selected HTTP/HTTPS TSA. A valid timestamp does not
by itself solve long-term trust, certificate expiry or evidence renewal.

## Retained PDF validation evidence

New signed archives include the standard PDF catalog DSS dictionary, containing
deduplicated DER public certificates and configured CRL/OCSP evidence in compressed
streams. Manifest-signature timestamp certificates are included as well. The final
PDF signature covers this store, all original attachments, and package metadata.
For `PADES_B_LTA`, EU DSS adds any required evidence and an incremental archival
document timestamp. Other modes retain the single completed-PDF signature.
Unsigned trailing revisions are rejected. VRI dictionaries are optional in the
standard and are not emitted by this implementation.

The verifier parses retained evidence with bounds of 256 entries per array,
16 MiB per stream and 32 MiB total decoded DSS content. OCSP responses have a
1 MiB individual limit and 16 MiB combined policy limit. It checks that PDF signer
and signature-timestamp certificate chains are retained, then cryptographically
validates used evidence against independently selected external trust anchors.
Presence or successful parsing alone never establishes trust or revocation status.
If the TSA changes certificates between the manifest and PDF signing requests and
the new certificates are not retained, publication fails explicitly.

Optional local configuration `ocsps` lists DER RFC 6960 **OCSPResponse** files,
for example `"ocsps": ["keys/current-response.der"]`. No responder is contacted.
Used responses must match the certificate serial number and issuer hashes, have
a supported strong signature and a current thisUpdate/nextUpdate interval, and
report GOOD. Revoked, forged, ambiguous or malformed matching evidence fails;
stale, future, unknown or unsupported evidence cannot establish GOOD. A delegated
responder must be directly authorized by the issuer and have OCSP-signing EKU,
appropriate key usage, a supported key, and the OCSP nocheck extension. Delegated
responder revocation without nocheck, unsupported critical response extensions,
RSA-PSS response signatures and live OCSP acquisition remain unsupported.

The independent Python/pypdf/OpenSSL validator now parses DSS separately and uses
its retained CRLs for offline validation. Independent OCSP policy evaluation remains
UNKNOWN; Java supports the above OCSP subset. External evidence-renewal sidecars
retain CRLs; OCSP-only sidecar validation still requires separately supplied OCSP
evidence. The Python verifier does not implement B-LTA revision-chain validation;
use the Java/EU DSS validator for that separate check.

Design references: [ETSI EN 319 142-1 V1.2.1](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf),
clauses 5.4.2 and 6.3; [Apache PDFBox signing examples](https://github.com/apache/pdfbox/tree/3.0.8/examples/src/main/java/org/apache/pdfbox/examples/signature).
No example network-fetching code is incorporated.

## Desktop output replacement

An existing output PDF can be replaced only after the user confirms its exact
path in the desktop's Replace/Cancel prompt. The creator and signer still write
only to a new PDF path. The desktop stages the completed replacement on the same
filesystem, checks the existing target's identity, size, timestamp and SHA-256,
and publishes with an atomic rename. A detected target change or unsupported
atomic replacement fails instead of deleting the old file. Cancel and conversion
failures leave the old PDF intact; staged replacements are cleaned up. Source
inputs and symlink targets are excluded. Renaming the completed signed PDF does
not modify its bytes or signature coverage. CLI no-overwrite rules are unchanged.

## Desktop certificate selection

Launch `java -jar dist/dicom-pdf-0.48.0-desktop.jar`. The single **Signing identity
or JSON policy** picker accepts an optional `.p12`, `.pfx` or institutional `.json`.
For a certificate file with the passphrase field blank, click Create. The desktop prompts for its password, following the
EA-PDF certificate/password workflow. It transfers the password only over private
stdin to the isolated worker and clears temporary buffers; no password file,
command-line secret, environment secret or saved password is used. Cancel starts
no operation; an incorrect password fails without creating an unsigned fallback.
The simple picker expects one signing key in the PKCS12 file. Credentials must
remain outside the supplied inputs and are never embedded.
Alternatively choose a passphrase file in the GUI; the worker reads that file
instead of prompting. JSON signing displays and uses its passphrase-file path.

The existing CMS-manifest and PDF-signature implementation is reused with an
explicitly untrusted verification policy. This produces verifiable signatures
without silently treating the selected certificate or its root as trusted.
Certificate trust, revocation and trusted timestamps stay UNKNOWN when evidence
has not been configured. The desktop detects signed archives for cryptographic
checks without needing a password; an explicit verification configuration adds
operator-selected trust and revocation policy. Source diagnostics remain visible
and separate from the desktop's archive/security outcome.

See the [signing configuration guide](SIGNING_CONFIGURATION.md) for a full field
reference, central certificate storage and the DigiCert example.

Selecting JSON uses the existing institutional workflow for aliases, trust, CRLs,
passphrase files and timestamps. Its certificate and protection are displayed
below the same picker. A configured `tsaUrl` automatically turns on
**Add trusted timestamps**, without a separate contact-permission prompt. The desktop upgrades ordinary
signing in its temporary configuration; the supplied JSON is unchanged. Required
timestamped or B-LTA policies cannot be downgraded by unchecking it.
The passphrase file is shown in a separate editable field; browsing overrides
its path for the run without editing the JSON. File dialogs remember directories
in local user preferences, without storing passwords or source contents.
The separate C2PA checkbox controls Content Credentials with either signing method.

## Configure and create

Keep the credential, passphrase, trust certificates and this configuration outside
the archival input directory. Supply real institutional credentials through the
operator's existing secure process. Do not copy the synthetic test identity into
production or commit private keys. Passphrases are read from a separate UTF-8 file;
trailing CR/LF is stripped. Restrict access to both credential and passphrase files.

Example local configuration (paths resolve relative to the configuration file):

```json
{
  "protection": "CMS_AND_PDF",
  "pkcs12": "keys/institution.p12",
  "passphraseFile": "keys/password.txt",
  "alias": "export",
  "trustCertificates": ["keys/root.pem"],
  "crls": ["keys/current.crl"],
  "verapdf": "/absolute/path/to/verapdf"
}
```

```sh
mvn verify
java -jar dist/dicom-pdf-0.48.0.jar create --input in/example --output out/example-signed.pdf --security-config /secure/location/security.json
java -jar dist/dicom-pdf-0.48.0.jar verify-security --input out/example-signed.pdf --sources in/example --security-config /secure/location/verify.json --output target/security-report.json
```

For verification, supply `protection` and omit `pkcs12`, `passphraseFile` and
`alias`. Select trusted certificates independently in `trustCertificates`.
The desktop and CLI use the configuration's `verapdf` executable when supplied,
then the `VERAPDF` environment variable, then `verapdf` on PATH.
Optional verificationTime is an ISO-8601 UTC reference instant. It changes the
verifier's evaluation time and is explicitly reported as a verifier reference,
not independently established historical evidence. Default is the current time.

Secure creation requires a **new** output path outside the source directory and
a working local veraPDF executable. It validates preservation, metadata,
external-input reconciliation and PDF/A-4f before and after signing. Invalid
signatures, failed trust validation, revoked certificates and other checked
security failures prevent publication. Missing trust/revocation evidence remains
UNKNOWN, and cannot produce EXPORT_AUTHENTICATED. Protection must be explicitly
CMS_AND_PDF, CMS_AND_PDF_TIMESTAMPED or PADES_B_LTA; no requested mode can silently fall back. Ordinary create without security
configuration omits institutional CMS/PDF signatures; C2PA uses a local identity
when enabled separately.

No original is removed to make signing succeed. Sources containing the configured
PKCS12 credential cause refusal of the entire conversion. CLI configuration also
refuses credential/passphrase paths and hard links within the inputs. This is a
guard against accidentally archiving configured secrets, not a general secret
scanner for arbitrary files.

## Evidence format and scope

The signed canonical manifest binds every original attachment, its bytes and
length, source identifiers, preview page/frame/display settings, diagnostics and
hashed generated artifacts. security.schemaVersion=1 adds the declared protection,
canonicalization, manifest.p7s, provenance.json and actual issuer certificate hash.
The local [manifest schema](profile/0.3.0/manifest.schema.json) and
[profile](profile/0.3.0/PROFILE.md) define the base mapping. Canonical serialization
does not make two different export events identical: provenance contains actual
local observation times, and signatures/PDF serialization may vary.

provenance.json records ingestion observation start/end, source count and a JCS
SHA-256 of the ordered attachment/path/size/hash input inventory, software identity,
unchanged-original processing, actual local validation results and signing request.
The ingestion observation interval includes the export's initial byte comparison;
it is not a device acquisition event. Delivery and acquisition remain UNKNOWN.
The CMS authenticates these as exporter statements, not independent proof that
each statement is true. Verification recomputes content checks instead of trusting
the recorded validation claims. Optional revocation.json retains base64 DER CRLs;
their signatures, scope and freshness must still be checked.

The CMS cannot hash itself in its own signed manifest. manifest.p7s is the explicit
exception to artifact hashes; the completed PDF signature covers it. Public
certificates in CMS and CRLs in the archive establish no trust by themselves.

## Reading results and recovering files

Each security check is PASS, FAIL, UNKNOWN or NOT_APPLICABLE. The JSON report
separates original bytes, external inventory reconciliation, metadata agreement,
source DICOM subset checks, explicit references, PDF/A, manifest/PDF cryptography,
certificate validity/trust, revocation and timestamps. Full DICOM IOD validation
is not implemented. An invalid original may be faithfully preserved; this is
reported separately and does not justify silently dropping it.

Exit 1 means a check failed; exit 2 means at least one check is UNKNOWN; exit 0
means every applicable check is known and passed. Since clinical completeness and
acquisition are not established, a correctly signed archive can still exit 2.
An intentionally invalid source can produce exit 1 even when its bytes and the
exporter's signatures pass. Read the individual checks, not only the exit code.

EXPORT_AUTHENTICATED requires verified manifest/PDF signatures and coverage,
supported valid signing certificates, explicit trust, applicable revocation,
preserved bytes and the signed captured-inventory receipt. Otherwise assurance
is INTEGRITY_ONLY. No current path claims SOURCE_AUTHENTICATED. Hashes establish
agreement with a baseline, not origin. Inventory completeness is only relative
to the submitted set, never a complete medical study claim.

Use inspect/extract or any ordinary PDF attachment extractor to recover originals.
Compare recovered lengths/hashes with manifest.json; preserve the original PDF,
manifest.p7s and public evidence for signature verification. The optional viewer
is not required. See [independent verification](INDEPENDENT-VALIDATION.md) for a
separate implementation. Reports and recovered files belong under target/;
out/ is reserved for converted PDFs.

External renewal retains the PDF and previous evidence unchanged. It is a separate
chain described below. `renew-pdf` instead uses EU DSS for incremental archival
timestamps. Adding an unsigned trailing revision still fails coverage checks.

## EU DSS PAdES B-LTA

Use the timestamped configuration below with `"protection": "PADES_B_LTA"`.
Select explicit institutional/TSA trust anchors and sufficient local CRL/OCSP
evidence. The desktop accepts the same configuration in its signing picker;
`tsaUrl` enables timestamping automatically without a contact-permission prompt. The simple .p12 picker
does not implicitly select B-LTA or trust its own certificate.

Creation signs the canonical manifest and completed PDF, then calls EU DSS
`PAdESService.extendDocument` with `PAdES_BASELINE_LTA`. EU DSS retains validation
evidence and adds the document timestamp. Publication requires independent
source/metadata checks, veraPDF 4f, EU DSS validation and archive change-policy
checks to pass. A failed or indeterminate required protection check publishes
no PDF; no weaker substitute is produced.

```sh
java -jar dist/dicom-pdf-0.48.0.jar create --input in/example --output out/example-lta.pdf --security-config /secure/lta-signing.json
java -jar dist/dicom-pdf-0.48.0.jar verify-security --input out/example-lta.pdf --security-config /secure/lta-verification.json --output target/lta-report.json
java -jar dist/dicom-pdf-0.48.0.jar renew-pdf --input out/example-lta.pdf --output out/example-renewed.pdf --security-config /secure/lta-renewal.json
```

Renewal needs `PADES_B_LTA`, the TSA URL, trust/evidence and veraPDF. Archives
without C2PA need no institutional private key or password. C2PA-enabled archives
also need `pkcs12` and `passphraseFile` to sign the current revision's fresh claim.
It validates before and after augmentation,
preserves the earlier signed bytes as an unchanged prefix, and leaves the input
PDF, manifest and all DICOM objects unchanged. Keep the newest PDF and an external
record of its hash if detecting rollback to an earlier valid edition matters.

Verification uses EU DSS's default policy, an explicit local trusted-certificate
source, offline CRL/OCSP sources and an AIA loader that cannot fetch data.
It checks signer binding, signatures, timestamps, trust and allowed revisions;
the final document timestamp must cover the complete current PDF. EU DSS's object
comparison also checks trailer /Info because its normal comparison starts at the
catalog. Changes to pages, attachments, metadata, annotations or ordinary form
fields are not allowed archival updates. With a valid whole-file C2PA binding,
only the reserved C2PA stream payload is additionally allowed to change. Its
dictionary and references still undergo normal comparison. Verification normalizes
that payload only in transient comparison readers; the PDF is never modified.
The manifest's B-LTA declaration alone
never satisfies verification.

`pdf.padesValidation`, `pdf.padesLevel`, `pdf.allowedChanges`, `pdf.coverage`,
individual timestamp checks and `padesBLta` are reported separately from hashes,
PDF/A, inventory and source diagnostics. Only fully validated DSS historical
evidence permits evaluating the manifest signer at the established signature time.
Certificate expiry alone does not prove an old signature invalid; insufficient
historical revocation/timestamp evidence remains UNKNOWN. Tests deliberately
exercise this case instead of suppressing DSS validation policy failures.

Checked with synthetic institutional/TSA certificates, local timestamp responses,
CRLs, repeated timestamps, tampering, duplicate IDs and veraPDF. Live institutional
TSA interoperability, OCSP-only B-LTA workflows, long-duration renewal policy,
algorithm migration and external PAdES certification remain unqualified.
There is no automatic renewal scheduler or guarantee of indefinite protection.
See [EU DSS documentation](https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/doc/dss-documentation.html)
for the maintained signature implementation and policy model.

## Tests

```sh
mvn -Ddicompdf.test.verapdf=/absolute/path/to/verapdf verify
```

Focused synthetic tests cover altered content/signatures, duplicate IDs, missing
external files, expired/revoked certificates, stale/forged CRLs, wrong anchors,
valid and invalid timestamp tokens, unsigned PDF revisions, credential inclusion,
existing DICOM signature preservation and actual signed PDF/A-4f compatibility.
The veraPDF integration tests require the property above; without it they are
explicitly skipped. Keys generated by tests are synthetic and never an issuer
trust recommendation. No approved input or archival master is modified.

## Request timestamps during creation

Add `tsaUrl` to the signing configuration. This enables `CMS_AND_PDF_TIMESTAMPED`
when the original protection is `CMS_AND_PDF`; an explicit `PADES_B_LTA` is preserved.
`tsaPolicyOid` is optional; when supplied, the response must use that policy.
The URL must be HTTP or HTTPS, without user information, query or fragment; redirects
are refused. Authenticated TSA services requiring custom headers, mTLS or
query credentials are not supported yet. Include independently selected issuer
and TSA roots in trustCertificates and appropriate fresh full CRLs in crls.
Verification does not need tsaUrl and never contacts the service.

```json
{
  "protection": "CMS_AND_PDF_TIMESTAMPED",
  "pkcs12": "keys/institution.p12",
  "passphraseFile": "keys/password.txt",
  "trustCertificates": ["keys/institution-root.pem", "keys/tsa-root.pem"],
  "crls": ["keys/institution.crl", "keys/tsa.crl"],
  "verapdf": "/absolute/path/to/verapdf",
  "tsaUrl": "https://tsa.example.org/timestamp"
}
```

The request sends a SHA-256 imprint of the CMS signature value, a fresh 160-bit
nonce, certificate request flag and optional policy. No DICOM bytes, metadata,
PDF bytes, filenames or private keys are sent. The server can observe network
connection metadata and the cryptographic imprint. Ordinary timestamped signing
makes two requests, one for each signature. B-LTA adds document timestamp requests;
with C2PA the final request covers the completed claim. Responses are limited to 1 MiB; connect/read
timeouts are 10/30 seconds, and redirects/compressed responses are refused.
The client checks status, nonce, imprint, algorithm, optional policy, issuance
within five minutes before/one minute after its local clock, TSA signature,
certificate trust and revocation. Required evidence must PASS. It does not fall
back to untimestamped protection on failure, including a failed second request.
The local clock window is a client freshness check, not the source of trusted time.

These checks follow [RFC 3161 request/response validation](https://www.rfc-editor.org/rfc/rfc3161.html#section-2.2).
The implementation uses Bouncy Castle rather than custom cryptographic primitives.
Positive transport tests run synthetic local HTTP and HTTPS TSAs, including actual
TLS and certificate validation for HTTPS. No live commercial/institutional TSA
has been qualified. HTTP does not provide transport confidentiality; token
signature and trust checks apply independently of transport.

## External evidence renewal

```sh
java -jar dist/dicom-pdf-0.48.0.jar renew-evidence --input out/example-signed.pdf --security-config /secure/location/timestamped.json --output target/evidence-1.json
java -jar dist/dicom-pdf-0.48.0.jar renew-evidence --input out/example-signed.pdf --previous target/evidence-1.json --security-config /secure/location/timestamped.json --output target/evidence-2.json
java -jar dist/dicom-pdf-0.48.0.jar verify-evidence --input out/example-signed.pdf --evidence target/evidence-2.json --security-config /secure/location/verify.json --output target/evidence-report.json
```

Renewal requires a signing identity, timestamped protection, explicit trust/CRLs
and passing archive byte/metadata/PDF/A checks. New evidence is verified using the completion clock so the check accounts for time spent processing the PDF. Verification needs public trust
only. Its report concerns external evidence; run verify/verify-security separately
for archive structure, metadata, original signatures and PDF/A. Reports can exit
2 because acquisition/completeness remain UNKNOWN even when the chain passes.

The [external-evidence schema](profile/0.3.0/external-evidence.schema.json) defines
version 1. The canonical UTF-8 JSON envelope contains an ordered entries array.
Each entry has binding and a base64 detached CMS. The canonical binding contains
PDF SHA-256/length, issuer certificate SHA-256, observedAt, retained base64 DER
CRLs and previousEntrySha256 (null for the first entry). Each CMS signs the binding
and carries a verified RFC 3161 signature timestamp. Every predecessor hash is
SHA-256 of the complete canonical preceding entry, including its signature.
The next entry therefore protects prior evidence and its retained certificates/CRLs.
Limits are 32 entries, 16 MiB envelope and 1 MiB per CMS.

The PDF, original DICOM bytes and earlier evidence files are not modified. Keep
the newest envelope with the PDF; it contains the previous entries. Keep a trusted
record of the latest envelope hash externally if detecting rollback to an older,
still-valid envelope is required. A valid earlier prefix alone cannot reveal
that a newer envelope exists.

Only after verifying a token's imprint, TSA signature, explicit trust and retained
revocation evidence does verification evaluate that entry's institutional signer
at the trusted token time. This supports checking retained evidence after the
signer's certificate expires; it is not a complete historical revocation policy
or proof against later compromise/retroactive revocation. No network evidence is
fetched. Missing trust/CRLs remain UNKNOWN; altered bytes/bindings/signatures fail.
Timestamp order and all predecessor bindings are checked.

This is a locally documented external evidence format, **not PAdES B-LTA, RFC 4998
ERS or a certified long-term preservation service**. Cryptographic algorithm
migration, full historical revocation policy,
OCSP retention in sidecars and further long-term evidence qualification remain TBD.
PDF archival renewal is separately implemented by the EU DSS path described above.
Do not assume that repeated SHA-256/RSA timestamps provide indefinite protection.

## Viewer integrity checks

### Dependency advisory status

COSE-JAVA's unused `net.i2p.crypto:eddsa` provider is excluded from the runnable
JARs. The supported C2PA algorithms remain RSA-PSS and P-256. The upstream
[EdDSA-Java issue](https://github.com/str4d/ed25519-java/issues/82) describes the
signature-malleability defect tracked as CVE-2020-36843.

The viewer pins fflate 0.8.3, the latest published release as of 2026-11-20.
[CVE-2026-122146](https://www.cve.org/CVERecord?id=CVE-2026-122146) describes
uncontrolled memory allocation in `unzipSync`. The package-level Qodana finding
remains open. Both browser builds omit `unzipSync`. The ZIP ingestion module
checks the central directory, compression ratio and byte limits before
allocating an entry, then uses the streaming `Inflate` API. Its regression
tests verify rejection before a large allocation. The recovery ZIP tests use
fflate's entry filter to enforce stored entries and bound their total size by
the archive length.

### Viewer results

Archive security checks start in the background after the first image opens.
Click the filename to see the report or select **Save report** for the JSON
results. The report has separate sections for archive files, C2PA, PAdES,
combined C2PA and PAdES checks, CMS, certificate trust and archive declarations.
Green marks passed integrity checks, red marks failures, amber marks incomplete
checks, and blue marks work in progress. The report gives an independent verdict
on certificate trust and shows the certificate fingerprints and verification times.
The overview shows integrity and signer trust separately. An archive signed
with a one-time C2PA certificate can pass the integrity checks while the
exporter’s identity stays unverified.

The browser checks original and package file hashes, inventory and exact manifest
bytes. It verifies supported SHA-256 CMS and PAdES signatures and RFC 3161
imprints over their exact covered bytes. For profile 0.4.0 it verifies the
COSE/JUMBF claim, restricted PDF hash exclusions, XMP instance ID and the
`digital.thinkbox.archive` assertion over the embedded `manifest.json`.
For DICOM B-LTA it checks the saved PDF revisions, unchanged protected objects,
signed certificate bindings, retained evidence, archival timestamps and C2PA
renewals where present. Certificate paths and signed CRL or OCSP evidence are
checked offline at the applicable time. Trusted time requires a verified TSA
certificate path, timestamp usage, and revocation evidence.

With **Get timestamp CA certificates online** enabled, the viewer downloads
public timestamp CA certificates from the official DigiCert timestamping
repository and the C2PA timestamp trust list. It checks the DigiCert download
against its approved SHA-256 fingerprint and uses the bundled copy of that
certificate if the online copy is unavailable or fails the fingerprint check.
The report shows a successful fallback as a passed check with the reason it
used the bundled certificate.
These certificates apply to timestamp checks. The viewer validates the signatures and the PDF’s stored revocation
evidence locally. Its certificate requests carry no archive files or data.

The Java desktop viewer automatically loads the bundled DigiCert Trusted Root G4
for the archive’s declared timestamped or B-LTA protection. It verifies the
embedded timestamp evidence offline and uses the CA you supply for signer trust.

Supply the archive signer’s independently trusted CA certificate using
**Add certificates…** or **Signing CA certificate URL**. The URL must be HTTPS
and point to one PEM or DER certificate on an approved site. The signer’s CA
selection stays in the tab and triggers a recheck. The report gives each
selected certificate’s SHA-256 fingerprint and shows the source of any CA used
for timestamp verification. With online checks off, you can also add any
independently trusted timestamp CA certificate from a file.

IT deployments can preconfigure roots and approve their own signing CA
download sites when building the standalone viewer and extension. Each site
must be an exact HTTPS origin. The defaults allow DigiCert certificate sites.

```bash
DICOM_SIGNING_CA_ORIGINS=https://pki.example.org npm --prefix viewer run build
DICOM_VIEWER_TRUST_PEM=/absolute/path/to/viewer-roots.pem npm --prefix viewer run build
```

Standalone browser downloads require the certificate server to allow
cross-origin requests. In Chrome, **Allow certificate site** can grant the
extension temporary access to the approved site when needed. A session
selection takes precedence over build roots, and clearing it restores the
build’s trust policy. Use a viewer distributed by a trusted party for
independent verification.

Unsupported algorithms, missing anchors or revocation evidence, and limits appear
as incomplete checks. The browser supports the DICOM creator’s archival layout
and a bounded subset of X.509, CMS, CRL/OCSP and COSE. Use the desktop validator
or `verify-security` for PDF/A, broader evidence handling and independent policy
options. C2PA public trust-list validation, acquisition authenticity and clinical
completeness are outside the browser report’s scope. Opening another PDF cancels
the previous report. Updating the extension or standalone viewer works with
existing archives, which retain the viewer they originally embedded.

## C2PA Content Credentials

The command-line and desktop creators include C2PA by default. The desktop's
**Include C2PA Content Credentials** checkbox starts checked. The CLI accepts
`--c2pa on` and `--c2pa off`; other values fail. Disabling it creates the existing
profile 0.3.0. Enabled archives use [profile 0.4.0](profile/0.4.0/PROFILE.md).

Without institutional signing configuration, a new P-256 signing identity and
local issuer are generated in memory for each archive. Only their public
certificates are embedded. These credentials provide tamper evidence, with no
verified institution or persistent creator identity. Their private keys are not
written to disk. The local certificate lasts one year; C2PA adds no trusted
signing time, automatic renewal or guarantee of indefinite validity.

With a signing certificate or security configuration, C2PA uses that same
credential. It must be a non-CA certificate permitting digital signatures with
an appropriate document/claim-signing EKU, and a supported P-256 or RSA key.
An incompatible credential fails creation with instructions to configure a
suitable certificate or disable C2PA. Institutional PKCS12 support alone does
not establish C2PA certificate compatibility or public Content Credentials trust.

C2PA manifests contain export actions and a hash of the finalized archive
manifest. They add no patient metadata, source paths or thumbnails. Source
metadata elsewhere in the archive remains unchanged. Cryptographic validity,
signer trust, trusted time and clinical completeness remain distinct results.

Plain creation, `CMS_AND_PDF`, `CMS_AND_PDF_TIMESTAMPED` and `PADES_B_LTA` support
C2PA. Ordinary signing reserves the C2PA stream and PDF signature space, signs
C2PA, then signs the PDF over the completed store.

For B-LTA the order is:

1. Sign the manifest and PDF export, including a fixed-size C2PA reservation.
2. EU DSS adds archival validation evidence and its document timestamp.
3. Append one revision containing a fresh C2PA store and a reserved document timestamp.
4. Sign C2PA over the current PDF, excluding only its own stream and that final
   timestamp's `/Contents`. Earlier signature and timestamp values remain hashed.
5. Obtain and insert the final RFC 3161 timestamp over the completed C2PA claim
   and the rest of the PDF. Publish only after C2PA, B-LTA and PDF/A checks pass.

Renewal follows the same final-revision order and preserves all earlier bytes
as an unchanged prefix. It needs the configured C2PA signing key for a fresh claim;
no timestamp, key or identity fallback is performed. The latest PDF object version
holds the active store; earlier versions remain in the immutable revision history.
The profile currently describes each export, without a C2PA ingredient lineage UI.
PDF timestamps cover the C2PA claim but do not add a C2PA-specific COSE timestamp:
`c2pa.timestamp` remains UNKNOWN, while `trustedTimestamp` reports the independently
validated PDF/manifest timestamps. External evidence renewal leaves the PDF unchanged.

`verify` and `verify-security` report C2PA signature and content binding checks.
The built-in C2PA verifier supports this project's single-manifest profile; it
reports external C2PA trust policy and trusted time as UNKNOWN. It does not
fetch credentials, manifests, revocation data or timestamps. The GUI displays
these checks separately. The viewer and independent Python validator recognize
the inventory but label C2PA attached/unverified.

An independent CAI tool can inspect and validate an archive:

```sh
c2patool out/example.pdf --detailed > target/example-c2pa-report.json
```

Inspect the report's validation results and signer trust; the command's exit
status alone does not establish authentication. A local or privately issued
certificate can have valid signatures and content binding while remaining
untrusted to a public validator. Configure trust independently of the archive.
