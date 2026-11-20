# DICOM image archive profile 0.4.0

This profile extends [0.3.0](../0.3.0/PROFILE.md) with embedded C2PA 2.2 export
credentials. Source preservation, display mappings, metadata and recovery rules
are inherited unchanged. The manifest remains schema 2. Archives without C2PA
continue to use profile 0.3.0; existing archives are never rewritten implicitly.

The [manifest schema](manifest.schema.json) requires a hashed `c2pa-policy.json`
artifact. Its exact UTF-8 bytes, including the final newline, are:

```json
{"attachment":"content-credentials.c2pa","schemaVersion":1,"scope":"ARCHIVE_EXPORT","specification":"2.2"}
```

`content-credentials.c2pa` is a required document-associated embedded file with
`AFRelationship=C2PA_Manifest` and subtype `application/c2pa`, also registered in
the embedded-file name tree. Its uncompressed stream contains a 32 KiB JUMBF
manifest store, padded in the COSE unprotected `pad` header. It is declared by
the hashed policy and deliberately excluded from `artifactSha256`: it binds the
exact finalized manifest bytes, so hashing it back into that manifest would be
circular. Other attachment-inventory rules remain strict.

The store contains one standard manifest, a version-2 CBOR claim, and a detached
COSE Sign1 signature (ES256/P-256 or PS256/RSA). It has three created assertions:

- `c2pa.hash.data`: SHA-256 over the current PDF with only the active manifest
  stream and the predetermined signature or document timestamp `/Contents` in
  that revision excluded. Earlier signature values remain included.
- `c2pa.actions.v2`: creation of the initially empty PDF, with
  `digitalSourceType=http://c2pa.org/digitalsourcetype/empty`.
- `digital.thinkbox.archive`: schema 1, SHA-256 of exact `manifest.json` bytes,
  `scope=ARCHIVE_EXPORT`, `originalsModified=false`, and either
  `identity=LOCAL_EPHEMERAL_UNTRUSTED` or `identity=CONFIGURED_CERTIFICATE`.

The custom assertion identifies the observed packaging operation. It makes no
statement that original images were captured by this software. No patient
identifiers, source paths, thumbnails, or DICOM acquisition claims are copied
into the C2PA assertions. Existing source metadata remains in its normal archive
locations and can contain sensitive information.

The attached `profile.json` and `dicom-xmp.rng` identify version 0.4.0. Other
profile resources remain inherited from 0.3.0. Consumers must recognize the new
inventory exception explicitly; they must not ignore arbitrary extra attachments.

The Java verifier checks this supported single-manifest profile, assertion
hashes, COSE signature, exact manifest binding and PDF byte exclusions. It reports
signer trust and C2PA trusted time separately as UNKNOWN. The Python validator
and browser check the declared inventory and label C2PA as unverified. Use an
independent C2PA validator with independently selected trust for additional checks.

C2PA and CMS/PDF signatures are finalized together before publication. Ordinary
PDF signing covers the complete C2PA store. For PAdES B-LTA, the export signature
covers its reservation; after DSS augmentation, a fresh active C2PA store and
covering document timestamp are finalized together in the last revision. The
active store binds the entire current PDF, including earlier signature values.
Only that reserved stream's payload may change alongside the allowed DSS and
timestamp updates; page, source, metadata and ordinary form changes remain invalid.
Renewal requires a C2PA signing identity and repeats this order while preserving
all previous bytes. External evidence renewal can bind the unchanged completed PDF.

Reference: [C2PA 2.2 specification](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html),
sections 10, 11, 13, 18.5, 18.14 and Appendix A.4.
