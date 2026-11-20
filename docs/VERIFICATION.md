# Verification

The repository includes automated tests and [synthetic DICOM fixtures](../fixtures/README.md).
Run the suites from the repository root.

## Java converter and PDF security library

Use Java 21 and Maven.

```sh
mvn test
```

The tests cover DICOM source handling, reference images, archive recovery,
metadata and signing. Maven writes test reports to `target/app/surefire-reports/`
and `target/pdf-security/surefire-reports/`.

## Offline viewer and Chrome extension

Use Node.js 24 and npm.

```sh
npm ci --prefix viewer
npm --prefix viewer test
npm --prefix viewer run test:extension
```

The viewer tests cover image decoding, archive integrity, navigation and
original-file export. The extension tests cover file permissions and handoff
from Chrome's PDF viewer.

With Playwright Chromium installed, run `python3 scripts/check_surface_segmentation.py`
against the built viewer and extension. It checks the 3D preview, the PDF
reference tab, byte-exact recovery and the WebGL-unavailable message. Use
`--help` to see the expected input paths and overrides.

## Python tools

Use Python 3 and OpenSSL.

```sh
python3 -m venv target/script-test-env
target/script-test-env/bin/python -m pip install -r scripts/archive-validator-requirements.txt py7zr==1.1.4
target/script-test-env/bin/python -m unittest discover -s scripts -p 'test_*.py'
```

## Verify an archive

Use the [independent validation guide](INDEPENDENT-VALIDATION.md) for
recovered-byte comparison, PDF/A conformance, and signature and timestamp
checks. See the [format matrix](GUIDE.md#image-support) for display support.
