# DICOM implementation review

The source and fixture review used edition 2026d of the
[DICOM Standard](https://dicom.nema.org/medical/dicom/current/output/chtml/).
The converter reads DICOM and embeds each supplied original in the PDF/A-4f
archive. The [source validation documentation](DICOM-STRUCTURE.md) lists
the structural checks and the classes they cover.

- **PS3.3 and PS3.5** cover information object definitions, functional groups,
  display parameters, data encoding and transfer syntaxes. The
  [format matrix](GUIDE.md#image-support) describes the supported rendering subset.
- **PS3.6** defines the tag dictionary used for the archive's selected field
  mapping. See the [archival profile](profile/0.3.0/PROFILE.md).
- **PS3.10** covers file-meta information, DICOMDIR and File-sets. The archive
  records unresolved references and retains the supplied directory records.
- **PS3.14 and PS3.15** describe display calibration and confidentiality
  profiles. The [user guide](GUIDE.md) describes viewing and handling limits.

A source can pass preservation checks while its DICOM structural result is
invalid or unknown. See the [independent validation guide](INDEPENDENT-VALIDATION.md)
for how these results are evaluated.
