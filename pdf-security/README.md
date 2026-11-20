# Thinkbox PDF security

Java 21 library for profile-driven C2PA credentials, CMS/PDF signing, offline
certificate policy, RFC 3161 timestamps and PAdES B-LTA creation and renewal.

Maven coordinates: **`digital.thinkbox:pdf-security:0.1.0`**.

The library has no dependency on the DICOM application, its GUI, its viewer,
dcm4che, a fixed JSON configuration or a local veraPDF installation. The host
application supplies its C2PA profile, signing identity, explicit trust and
revocation evidence, clock and timestamp client. `PdfSecurity` coordinates the
combined signing order and refuses an omitted profile for C2PA-bearing PDFs.

From the repository root, run `mvn -pl pdf-security -am install` to build, test
and install the library and its parent POM. Library artifacts and test reports
are under `target/pdf-security/`. See the [application release build instructions](../docs/GUIDE.md#building-from-source)
to produce the runnable JARs.

See the [API and reuse guide](../docs/PDF_SECURITY_LIBRARY.md) and the
[independent consumer example](examples/pdf-security-consumer).
