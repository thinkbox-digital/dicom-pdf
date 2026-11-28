# Reusing the PDF security library

The Maven build has two modules:

| Module | Responsibility |
| --- | --- |
| [pdf-security](../pdf-security/README.md) | Reusable C2PA/COSE, CMS/PDF signing, certificate policy, timestamps, PAdES B-LTA and revision coordination. |
| [app](../app/pom.xml) | DICOM conversion, archive manifests and preservation checks, desktop/CLI configuration, viewer packaging and archive publication. |

The library uses package `digital.thinkbox.pdfsecurity` and is independently
versioned as `digital.thinkbox:pdf-security:0.1.0`. The application remains
`digital.thinkbox:dicom-pdf:0.67.0` and consumes the library as a normal dependency.
The [reactor parent POM](../pom.xml) is `digital.thinkbox:pdf-tools-parent:1.0.0`.

The example includes two source files.

- [Working Java example with a complete C2paProfile](../pdf-security/examples/pdf-security-consumer/src/main/java/example/ReusableSigningExample.java)
- [Example Maven POM with the library dependency](../pdf-security/examples/pdf-security-consumer/pom.xml)

## Build and consume

Java 21 and Maven are required. From this repository root:

```sh
# Build/test/install only the reusable library and its parent.
mvn -pl pdf-security -am install
```

See the [application release build instructions](GUIDE.md#building-from-source)
for the desktop and command-line distributions.

Add this dependency to another project's POM:

```xml
<dependency>
  <groupId>digital.thinkbox</groupId>
  <artifactId>pdf-security</artifactId>
  <version>0.1.0</version>
</dependency>
```

Local installation supplies both the library and its parent POM to your Maven
repository (`~/.m2/repository` by default). In the other project, use Java 21 or
newer and reload Maven in the IDE after adding the dependency above. No extra
`<repository>` entry, copied JAR or dependency on the DICOM application is needed
on the same computer, provided both builds use the same local Maven repository.
Import classes from `digital.thinkbox.pdfsecurity`.
The library JAR is a normal dependency JAR with transitive dependencies, not a
standalone application. Sources are generated alongside it. No DICOM libraries,
application classes, GUI or viewer are part of the library.

Maven writes library artifacts to `target/pdf-security/` and application build
intermediates to `target/app/`. Release builds write the runnable JARs to
`dist/`. The root Maven build selects the application for `exec:java`.

## GitHub and use on other machines

Source hosting and Maven artifact distribution are separate steps. The library
can remain a versioned module in this GitHub repository; a separate repository is
optional. Pushing the source or attaching a JAR to a GitHub Release alone does
not make the dependency resolve automatically in another project's Maven build.

For a second computer, either clone this source and run
`mvn -pl pdf-security -am install` there, or publish the library to a Maven
registry. Publish `pdf-tools-parent:1.0.0` as well as `pdf-security:0.1.0`, its POM
and sources: the library POM inherits dependency versions from that parent. The
test-fixtures classifier is needed for building the DICOM application's tests,
but not by ordinary library consumers.

[GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-apache-maven-registry)
supports Maven artifacts associated with the existing repository. Consumers
configure its Maven repository URL and authentication; GitHub currently requires
authentication even to install public Maven packages. Tokens belong in Maven
settings or CI secrets, never in a checked-in POM.

For public reuse, Maven Central is a convenient distribution target. A release
needs a verified namespace and the required POM metadata, sources, Javadocs and
artifact signatures; see the [namespace registration](https://central.sonatype.org/register/namespace/)
and [publishing requirements](https://central.sonatype.org/publish/requirements/).
This extraction supplies a local Maven artifact and sources, but does not claim
a published Central release or configure a remote deployment destination.

## Supply your archive profile

Implement [C2paProfile](../pdf-security/src/main/java/digital/thinkbox/pdfsecurity/C2paProfile.java) to supply:

- Credential and policy attachment names, plus the exact expected policy bytes.
- A private assertion label and claim-generator name/version.
- Creation and verification of the assertion that binds your own manifest or
  other application data to the PDF.
- An instance identifier. The default reads the PDF's standard XMP
  `xmpMM:InstanceID`; an application can provide its own identifier lookup.

Profiles must be immutable and deterministic. Verification receives a profile
selected by the caller; a PDF cannot select arbitrary verification code or trust
anchors. `C2pa.prepare(document, profile)` adds/checks the policy and creates the
fixed-size, unfinalized credentials reservation. Add your original attachments,
manifest and XMP before saving the prepared PDF.

[ArchiveC2pa](../src/main/java/digital/thinkbox/dicompdf/ArchiveC2pa.java) in the DICOM application is its adapter. It preserves the existing
profile 0.4.0 policy, attachment names, generator identity and
`digital.thinkbox.archive` assertion over `manifest.json`. The library does not
know those names or the DICOM manifest schema.

## Sign, verify and renew

The entry point is [PdfSecurity](../pdf-security/src/main/java/digital/thinkbox/pdfsecurity/PdfSecurity.java).
For institutional signing, load a [SigningIdentity](../pdf-security/src/main/java/digital/thinkbox/pdfsecurity/SigningIdentity.java) in the caller's try-with-resources
block, construct a [CertificatePolicy](../pdf-security/src/main/java/digital/thinkbox/pdfsecurity/CertificatePolicy.java) from independently trusted roots and
current local CRL/OCSP evidence, then create a timestamp client where required.
The host constructs typed settings; no user key paths or TSA address are built
into the library.

```java
try (var identity = SigningIdentity.loadWithPassphraseFile(
        credential, passphraseFile, alias, clock.instant())) {
    var options = new PdfSecurity.Options(identity, policy, tsa, clock, profile);
    var result = PdfSecurity.sign(preparedPdf, newOutputPdf,
        PdfSecurity.Protection.PADES_B_LTA, options);
}
```

`PdfSecurity.Options` borrows the identity; signing never closes a caller's
credential. The identity may be reused until its owner closes it. Use a null
profile for a PDF without C2PA. A C2PA-bearing PDF requires an explicit matching
profile; it is never silently signed or renewed with its credentials ignored.

Protection levels are `CMS_AND_PDF`, `CMS_AND_PDF_TIMESTAMPED` and `PADES_B_LTA`.
These retain the existing naming for compatibility; the library signs the PDF's
CMS signature. Signing a separate application manifest with `CmsSigning` and
retaining that result in the PDF remain application work.

For verification:

```java
var result = PdfSecurity.verify(pdf, requiredProtection, policy, profile,
    expectedSignerCertificateSha256); // null if no fingerprint is pinned
```

Read individual checks. `Result.valid()` checks the requested PDF protection and
configured C2PA binding; it does not establish acquisition authenticity or public
C2PA trust. Ordinary signing may have UNKNOWN signer trust/revocation, which
remains explicit. B-LTA requires passing DSS validation, level, trust, evidence
and coverage checks. A browser checksum report is a separate facility.

For archival renewal, call `PdfSecurity.renew(existingPdf, newPdf, options)`.
C2PA requires an identity to sign its fresh claim. Renewal without C2PA may use
a null identity and still requires the TSA and trust/evidence policy.
Signing and renewal require a new output path. Temporary files are created beside
the output and removed; the public destination is linked only after verification.
The original PDF is never rewritten, and failed operations publish no downgrade.

## Keep the combined revision sequence intact

The library's coordinator retains this order:

1. Sign the prepared PDF export, reserving C2PA space where requested.
2. Add DSS validation evidence and archival timestamps for B-LTA.
3. Append one revision containing the fresh C2PA store and a reserved final
   document timestamp.
4. Sign C2PA first, excluding only its current store and final timestamp contents.
5. Obtain the final timestamp over the completed claim, then independently verify
   C2PA binding, PDF signatures, revision coverage and the requested PAdES level.

Renewal follows the same final ordering and preserves the previous PDF bytes as
an unchanged prefix. The profile controls application assertions, not arbitrary
hash exclusions or permission to change signed content. The conservative PDF
policy still permits one export signature followed by archival document
timestamps. Arbitrary multiple-signature/form-edit workflows are not implemented.

The host remains responsible for original-byte comparison, metadata agreement,
archive completeness policy, PDF/A validation, clinical scope and its own final
publication rules. The DICOM application runs those checks before and after the
library's operation. The library supports this project's bounded single-manifest
C2PA 2.2 PDF workflow, not all possible third-party C2PA formats.

## Independent consumer and tests

The [consumer example](../pdf-security/examples/pdf-security-consumer/) is a standalone Maven
project that depends on the library. After installing the library, run the example from the
repository root with a new output path.

```sh
mvn -f pdf-security/examples/pdf-security-consumer/pom.xml compile exec:java \
  -Dexec.args=target/example-reusable-security.pdf
```

It creates a synthetic plain PDF with its own attachment names and receipt
assertion, then signs and verifies local C2PA. Its local ephemeral identity is
explicitly untrusted; it supplies neither institutional authority nor trusted
time. No signing service or production private key is used.

Generic tests live in [pdf-security/src/test/java](../pdf-security/src/test/java/): certificate profile and OCSP
policy, RFC 3161 exchange verification, custom-profile signing/renewal, tampering,
profile mismatch, refusal to downgrade and preservation of existing destinations.
Synthetic keys and TSA/OCSP helpers are in a test-only classifier JAR, excluded
from the production library and the runnable distributions. DICOM/archive,
PDF/A and GUI integration tests remain in the application.

Existing third-party notices, source retention and the EdDSA exclusion remain
in force. See [security limits and dependency advisories](SECURITY.md).
