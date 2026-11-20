# Synthetic image-format fixtures

`expanded/` contains 25 DICOM files made solely from deterministic mathematical
pixels. Every patient field explicitly identifies a synthetic fixture. No clinical
image corpus or user-supplied sample is redistributed here.

The Java generator is `ExpandedSyntheticFixtures.java`. Its grayscale samples are
`(3*x + 5*y) & 255` for 8-bit and `32*x + 16*y` for 12 stored bits in 16-bit words.
Color fixtures contain red, green and blue bars. The one-bit fixture has a dark
left half and a light right half. Two-frame fixtures use reversed pixels or explicit
per-frame/shared functional-group VOI and rescale values.

| Cases | Actually tested behavior |
| --- | --- |
| CT/MR native Implicit LE, Explicit LE/BE; deflated | Exact source samples and equivalent PDF rasters |
| Signed 8-bit and signed/unsigned 16-bit | Correct signed stored values |
| RGB interleaved/planar, YBR_FULL/4:2:2, palette color | Correct channel dominance and equivalent RGB layouts |
| Packed one-bit | Correct least-significant-bit unpacking |
| Multiframe SC and enhanced MR | Frame 2, unavailable-frame refusal, per-frame/shared rescale and VOI precedence |
| JPEG Baseline gray/color | Actual Java and browser decoding; lossy presentation raster |
| JPEG Lossless process 14 / SV1, 8-bit and 12-bit | Handwritten constant-pixel SOF3 streams decode to the exact expected samples |
| RLE Lossless gray8 | Exact native-pixel equality |
| JPEG2000 Lossless gray12 in 16-bit words | Browser OpenJPEG preserves every stored bit; original retained without a Java PDF preview |
| JPEG-LS Lossless gray8/gray12 and Near-Lossless gray8 | Browser CharLS exact samples or encoded error bound 2; originals retained without Java PDF previews |

The 25-file package currently has 21 Java-generated PDF previews and four
browser-only compressed images. The original DICOM files remain unchanged in
both cases. The extension labels interactive source display separately from a
PDF preview and supports saving the complete original from either frame.

JPEG Lossless SOF3 streams are generated directly by this repository's code.
JPEG2000 and JPEG-LS codestreams are generated from the same mathematical pixels
by the pinned OpenJPEG and CharLS packages through
`viewer/test/generate-codec-fixtures.mjs`. Their MIT wrapper and BSD upstream
licenses are retained in the viewer notices. No separate Java JPEG2000 codec is
required or redistributed.

To regenerate from the repository root:

```sh
npm ci --prefix viewer
node viewer/test/generate-codec-fixtures.mjs
mvn test-compile dependency:build-classpath -Dmdep.outputFile=target/test-classpath.txt
java -cp "target/test-classes:target/classes:$(cat target/test-classpath.txt)" \
  digital.thinkbox.dicompdf.ExpandedSyntheticFixtures fixtures/expanded target/codec-fixtures
```

`ExpandedFormatsTest` independently checks actual raster colors, exact lossless
samples/raster hashes, source recovery, frame transforms and diagnostic status.
`viewer/test/expanded-dicom.test.mjs` checks native and bundled-codec sample values.
`scripts/check_extension.py` checks the real installed Chrome extension offline,
including all 25 images, per-file downloads, and frame changes.
