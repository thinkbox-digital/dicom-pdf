# Verification

The repository includes automated tests and [synthetic DICOM fixtures](../fixtures/README.md).
Run the suites from the repository root.
GitHub Actions runs the suites, veraPDF conformance tests, and the Chromium
surface check on pull requests and pushes to `main`. The version workflow
also checks the packaged JARs and round-trips synthetic originals before
publishing the workflow artifact. [CI workflow](../.github/workflows/ci.yml) ·
[Version workflow](../.github/workflows/version.yml)

## Java converter and PDF security library

Use Java 21 and Maven.

```sh
mvn test
```

The tests cover DICOM source handling, reference images, archive recovery,
metadata and signing. Maven writes test reports to `target/app/surefire-reports/`
and `target/pdf-security/surefire-reports/`.
The PDF/A conformance tests require a veraPDF CLI. Enable them with
`mvn test -Ddicompdf.test.verapdf=/path/to/verapdf`.

## Chrome extension

Use Node.js 24 and npm.

```sh
npm ci --prefix viewer
npm --prefix viewer test
npm --prefix viewer run test:extension
```

The viewer tests cover image decoding, archive integrity, navigation and
original-file export. The extension tests cover file permissions and handoff
from Chrome's PDF viewer.

The Chromium check uses the same Java 21 and Maven setup to convert checked-in
synthetic DICOM fixtures to PDFs under `target/`. It checks rotation, pan, zoom
and reset in the unpacked extension, along with the PDF
reference tab, byte-exact recovery and the WebGL-unavailable message.

Run the viewer build in a disposable checkout if you want to keep your working
copy's extension version. The build advances the extension's minor version.
After `npm ci --prefix viewer`, run:

```sh
npm --prefix viewer run build
python3 -m venv target/browser-test-env
target/browser-test-env/bin/python -m pip install -r scripts/requirements.txt
target/browser-test-env/bin/python -m playwright install chromium
target/browser-test-env/bin/python scripts/check_surface_segmentation.py
```

Use `--help` for custom input paths. Results are written to
`target/surface-segmentation-checks/summary.json`.

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
