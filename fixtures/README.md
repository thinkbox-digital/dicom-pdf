All DICOM files in `synthetic/` are generated from mathematical gradients and ellipses by
`src/test/java/digital/thinkbox/dicompdf/SyntheticFixtures.java`. They contain the explicit
patient identity `Synthetic^DICOM` / `SYNTHETIC-NOT-A-PATIENT`, except the fixture that
intentionally omits optional metadata. No patient images or de-identified clinical data
are used. The shapes are a software test phantom, not an anatomical model.

The 25 baseline fixtures cover each combination of Explicit VR Little Endian,
Implicit VR Little Endian, Explicit VR Big Endian; 8-bit and 16-bit allocation
(8 and 12 stored bits respectively); signed and unsigned values; MONOCHROME1 and
MONOCHROME2, plus an image with missing optional metadata. All use the Digital
Intra-Oral X-Ray Image Storage - For Presentation SOP class and one frame.

The six signed 8-bit baseline fixtures are deliberately outside the supported pilot
and must be reported as unrendered. This leaves 19 renderable baseline images.

`unsupported/` exercises two frames, RGB, deflated transfer syntax, corrupt bytes,
and a zero-byte file. They must be reported as unrendered and preserved byte for byte.

Regenerate after `mvn test-compile dependency:build-classpath -Dmdep.outputFile=target/test-classpath.txt`:

```sh
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" \
  digital.thinkbox.dicompdf.SyntheticFixtures fixtures/synthetic
```


`references/` is a separate all-synthetic graph of five single-frame intraoral
images. `reference-source.dcm` explicitly names one supplied target (frame 1),
two missing instance UIDs (one nested under Referenced Series Sequence), an
ambiguous target UID shared by three files, and an invalid frame 2 on a
single-frame target. Two duplicate files are byte-identical; the third shares the
UID but has different synthetic metadata. Files must remain separate even when
an identifier or payload repeats. No targets are inferred for missing references.

Regenerate this separate graph with the same test classpath:

```sh
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" \
  digital.thinkbox.dicompdf.SyntheticFixtures --references fixtures/references
```

`writeDeidentifiedCopy` is a test-only generator for a distinct synthetic derived
copy with omitted patient fields and a different instance UID. Production code
never anonymizes or modifies master DICOM bytes; declared derived packages use
`--source-role deidentified-copy` and separate input/output locations.

`surface-segmentation/asymmetric-tetrahedron.dcm` is an Explicit VR Little Endian
Surface Segmentation object with four vertices and four triangular faces. The
unequal sides make changes in orientation visible during the browser test.
The fixture uses invented study metadata and the same synthetic patient identity
as the baseline fixtures. Regenerate it with the dcm4che-based fixture writer.

```sh
mvn -B -pl app -am test-compile exec:java -Dexec.classpathScope=test \
  -Dexec.mainClass=digital.thinkbox.dicompdf.SurfaceSegmentationFixtures \
  '-Dexec.args=--write-dicom fixtures/surface-segmentation/asymmetric-tetrahedron.dcm'
```
