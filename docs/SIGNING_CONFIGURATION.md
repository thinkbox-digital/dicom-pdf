# Signing, timestamps and certificate configuration

The desktop has one **Signing identity or JSON policy** picker. Choose a
`.p12`/`.pfx` for a simple export signature, or a JSON file containing the signing
identity, timestamp service and verification policy. Leave **Include C2PA Content
Credentials** checked to include C2PA.

## Checks before creation

When you click Create, the desktop checks the selected identity, password,
supported C2PA certificate profile and archive signer trust before staging inputs
or requesting timestamps. Known local issues are reported together in Activity.
The CLI repeats these checks before conversion and publication. A timestamp
service can still fail later because network availability and fresh TSA responses
are separate from the local setup checks.

The C2PA signing certificate must be an X.509 v3 non-CA leaf with an Authority Key
Identifier, `digitalSignature` Key Usage, and a supported document/claim-signing
Extended Key Usage. Supported keys are RSA of at least 2048 bits or P-256 EC.
The verifier also accepts the supported `emailProtection` EKU; timestamping,
OCSP signing and unrestricted EKUs are not export-signing roles. An ordinary
PDF-signing certificate can lack these C2PA-specific extensions.

Replacing the PKCS12 changes the signing identity, but does not add its issuing
CA to your trust policy. Include the independently selected archive issuer root
and the TSA root in `trustCertificates`. The creator reports chain-trust problems
before conversion; B-LTA also requires fresh revocation evidence for the archive
signer. Selecting a local issuer root establishes your application's trust policy;
it does not establish public C2PA program trust.

## Turn timestamping on

Selecting a JSON with `tsaUrl` turns **Add trusted timestamps** on automatically.
There is no separate contact-permission checkbox or confirmation. The checkbox
shows and controls the timestamp selection.
The desktop prepares `CMS_AND_PDF_TIMESTAMPED` when the JSON originally selects
`CMS_AND_PDF`; an existing `PADES_B_LTA` selection is preserved. Your JSON is
unchanged: only a temporary worker configuration is adjusted.

A checked box requires a TSA URL, signing identity and suitable local trust and
revocation evidence. Missing settings or an invalid, unavailable or untrusted
timestamp stop creation. The app never substitutes an untimestamped archive.
A JSON that already requires timestamping or B-LTA is never silently downgraded.
With `CMS_AND_PDF` and the box
unchecked, the desktop omits TSA settings from its temporary configuration and
makes no timestamp requests.

CLI use has no checkbox. A configured `tsaUrl` also enables timestamped signing
when the JSON originally selects `CMS_AND_PDF`. Explicit
`CMS_AND_PDF_TIMESTAMPED` and `PADES_B_LTA` remain supported; B-LTA is preserved.

## Passphrase field and remembered folders

The GUI has a **Passphrase file** field and Browse button. Selecting JSON fills
the field from `passphraseFile`, resolving relative paths from that JSON. You
can browse to another file for this run; the original JSON remains unchanged.
For a `.p12`/`.pfx` selected directly, choose a passphrase file or leave the field
blank to enter the password on Create. No password is placed in command arguments
or saved in preferences.

File dialogs remember their directories locally between application launches,
separately for each purpose. New fields use the last dialog directory as a
fallback; an existing field path opens its own directory. Save report starts in
`target/` until its own folder has been remembered. Preferences store directory
paths, not passwords, selected filenames or source contents.

## Certificate and password locations

Files may be anywhere readable on your computer, including central directories
outside the project. Absolute paths work. Relative paths resolve from the JSON
file's directory. Use a complete path such as `/home/your-user/keys/signing.p12`;
the JSON reader does not expand `~` or environment variables.

Public CA and supporting certificates may live in `/etc/ssl/certs/`. Point to
individual files or a PEM bundle, not the directory. Private signing keys and
their passphrase files belong in a protected location outside all archival inputs.
The app does not automatically read the operating system certificate store.

These roles are separate:

| Setting | What goes here |
| --- | --- |
| `pkcs12` | Your archive exporter's `.p12`/`.pfx`, containing its private key and public certificate chain. A TSA responder certificate is not your signing identity. |
| `passphraseFile` | A separate UTF-8 file containing that PKCS12's existing password. Trailing CR/LF is removed. Do not put the password itself in JSON. |
| `alias` | Optional key alias; useful when the PKCS12 contains multiple signing keys. |
| `trustCertificates` | Independently selected CA/root certificate files, PEM or DER. Certificates in this list are explicit trust anchors. Include roots for both your archive signer and TSA. |
| `supportingCertificates` | Optional intermediate and responder certificate files, PEM or DER. They help construct chains and are retained as public evidence; they do not become trust anchors. |
| `crls` | Local, fresh, issuer-signed full CRL files covering the non-root certificates being validated. |
| `ocsps` | Optional local DER OCSP response files supplying supported, fresh revocation evidence. |
| `tsaUrl` | The RFC 3161 service's HTTP or HTTPS URL. No URL credentials, query, fragment or redirect is supported. |
| `tsaPolicyOid` | Optional TSA policy OID; the response must match it when supplied. |
| `protection` | `CMS_AND_PDF`, `CMS_AND_PDF_TIMESTAMPED`, or `PADES_B_LTA`. |
| `verapdf` | Optional path to the veraPDF executable, relative to this configuration file or absolute. The desktop and CLI otherwise use `VERAPDF`, then `verapdf` on PATH. |
| `verificationTime` | Optional ISO-8601 reference time for explicit verification. Creation checks use the current creation clock, including after long conversions. This setting is not evidence of a trusted timestamp. |

To explicitly use the machine's installed CA bundle, set:

```json
"trustCertificates": ["/etc/ssl/certs/ca-certificates.crt"]
```

That trusts all CAs in the bundle. To restrict trust, list specific CA files.
Add your organization's root separately if the bundle does not contain it.
For HTTPS, Java's TLS trust store authenticates the transport server;
`trustCertificates` authenticates the timestamp and archive signatures. They
serve different purposes.

## DigiCert example, with C2PA and B-LTA

The following shows the five supplied public certificate filenames. Only
`DigiCertTrustedRootG4.cer` is used as the DigiCert trust anchor; the intermediate
and three responder certificates are supporting certificates.

Replace the organization key/root and CRL paths with your actual files. This
is a configuration example, not a complete credential or revocation evidence set.

```json
{
  "protection": "PADES_B_LTA",
  "pkcs12": "/secure/location/organization-signing.p12",
  "passphraseFile": "/secure/location/organization-signing.passphrase",
  "trustCertificates": [
    "/secure/location/organization-root.pem",
    "/etc/ssl/certs/DigiCertTrustedRootG4.cer"
  ],
  "supportingCertificates": [
    "/etc/ssl/certs/DigiCertTrustedG4TimeStampingRSA4096SHA2562025CA1.pem",
    "/etc/ssl/certs/DigiCertSHA256RSA4096TimestampResponder20261.cer",
    "/etc/ssl/certs/DigiCertSHA384RSA4096TimestampResponder20261.cer",
    "/etc/ssl/certs/DigiCertSHA512RSA4096TimestampResponder20261.cer"
  ],
  "crls": [
    "/secure/location/organization-current.crl",
    "/secure/location/DigiCertTrustedRootG4.crl"
  ],
  "ocsps": [
    "/secure/location/DigiCertSHA256RSA4096TimestampResponder20261.ocsp.der",
    "/secure/location/DigiCertSHA384RSA4096TimestampResponder20261.ocsp.der",
    "/secure/location/DigiCertSHA512RSA4096TimestampResponder20261.ocsp.der"
  ],
  "verapdf": "/path/to/verapdf",
  "tsaUrl": "http://timestamp.digicert.com"
}
```

Use `CMS_AND_PDF_TIMESTAMPED` for timestamped signatures without B-LTA. For
C2PA, the archive signing identity must also satisfy the
[C2PA certificate requirements](SECURITY.md#c2pa-content-credentials).

DigiCert documents [its RFC 3161 service and current public certificate
chain](https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server).
Use its documented HTTP endpoint. A live synthetic request succeeded on HTTP;
the same host refused HTTPS connections on port 443. Changing `http` to `https`
does not enable TLS on a server. The application never silently changes protocols.
Responder certificates rotate; obtain current files from the provider.
[RFC 3161 section 3.4](https://www.rfc-editor.org/rfc/rfc3161.html#section-3.4)
defines HTTP transport. For both HTTP and HTTPS, the app checks the token's
cryptographic signature, nonce, requested hash, time, certificate path and
revocation evidence. HTTP carries only the imprint/request and signed response;
it does not provide transport confidentiality.

## Revocation evidence is required too

A CA bundle or the five certificate files do not provide CRLs or OCSP responses.
Obtain current evidence from the issuing authorities for the actual chains.
Use the certificates' CRL Distribution Points and Authority Information Access
to identify the issuer's evidence services. Do not guess CRL filenames from the
example above. Files must remain fresh and cover the signer, TSA and relevant
intermediates.

Add the archive issuer's CRL file to the existing top-level `crls` array alongside
the TSA CRLs. For example, a locally managed issuer might supply
`/secure/location/root-ca.crl`. Keep existing `ocsps` entries. They
cover separate certificates. To request archival signing, set the separate
top-level `protection` value to `PADES_B_LTA`.

The application does not automatically download CRLs, OCSP responses or missing
issuer certificates. Verification is offline. Missing, stale or unsupported
required evidence remains UNKNOWN. Timestamped creation requires passing TSA
evidence; B-LTA additionally requires passing archive signer revocation evidence.
Ordinary timestamped signing can retain UNKNOWN archive signer revocation and
report INTEGRITY_ONLY. Putting responder certificates directly in `trustCertificates` to
bypass chain/revocation requirements changes trust policy and is not the example's
configuration.

For the supplied DigiCert chain, a complete root CRL covers the timestamping
intermediate, and signed OCSP responses cover the three responder certificates.
This avoids relying on a scoped responder CRL: the current verifier does not use
CRLs with Issuing Distribution Point extensions as evidence of good status.
The downloaded local setup stores verified evidence under
`target/timestamp-evidence/digicert/` and uses absolute file paths in JSON.
`mvn clean` removes that generated directory; restore or refresh the evidence
before creating another timestamped archive. Keep each file within its signed
`thisUpdate`/`nextUpdate` interval. These TSA files do not replace the archive
signer's own trust and revocation evidence.

## Timestamp connection failures

The creator reports the configured host, protocol and port along with connection,
timeout, TLS, HTTP status, media-type or response-size failures. It does not print
the timestamp response body or URL path. A response received successfully can
still fail certificate trust or revocation checks; those checks are named in
the error. No untimestamped output is substituted.

For `timestamp.digicert.com`, a refused connection to port 443 indicates that
the configured HTTPS endpoint could not be reached. Use the documented HTTP URL
or configure a separately tested HTTPS TSA and its own trust/evidence files.
Testing an ordinary web page is insufficient: test an RFC 3161 POST and verify
the returned timestamp.

## How C2PA and B-LTA are ordered

1. The creator signs the archive manifest and PDF export, which includes a C2PA
   reservation.
2. EU DSS adds validation evidence and an archival document timestamp.
3. A final incremental revision reserves space for C2PA and another document timestamp.
4. C2PA signs the current PDF, excluding its own stream and the final timestamp's
   reserved value. Earlier signature/timestamp values remain included in the hash.
5. The final document timestamp covers the completed C2PA claim and PDF.

Publication requires C2PA binding, B-LTA validation, allowed revision changes and
PDF/A-4f checks to pass. Other content changes remain forbidden. Renewal repeats
the final-revision order and preserves all preceding bytes; a fresh C2PA claim
also requires the configured signing key and password. Without C2PA, B-LTA renewal
does not require the institution's private key.

```sh
java -jar dist/dicom-pdf-0.24.0.jar create --input in/example --output out/example-lta.pdf --security-config /secure/location/signing.json
java -jar dist/dicom-pdf-0.24.0.jar renew-pdf --input out/example-lta.pdf --output out/example-renewed.pdf --security-config /secure/location/signing.json
java -jar dist/dicom-pdf-0.24.0.jar verify-security --input out/example-renewed.pdf --security-config /secure/location/verification.json --output target/lta-report.json
```

For verification, omit `pkcs12` and `passphraseFile`; keep the expected protection,
trust, supporting certificates, revocation evidence and veraPDF setting. No TSA
request is made during verification. Generated reports belong under `target/`.

## What the time results mean

The viewer verifies file checksums. Its timestamp text describes what the archive
requested; it does not validate timestamp signatures or establish TSA trust.
Use the desktop **Validate** tab with a verification JSON, or `verify-security`,
for those checks.

`trustedTimestamp: PASS` refers to verified manifest/PDF timestamp evidence.
`c2pa.timestamp: UNKNOWN` means the C2PA COSE signature has no separate C2PA-specific
timestamp. A B-LTA document timestamp still covers that completed C2PA claim.
These results describe different evidence and do not contradict each other.

## Viewer compatibility

C2PA archives use profile 0.4.0 and require viewer 0.10.0 or later. Open older
signed PDFs with the current standalone viewer or updated extension. The viewer
embedded in an existing archive retains its original version; using a newer
external viewer preserves the archive's signed bytes.
