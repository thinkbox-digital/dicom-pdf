These fixtures are generated entirely from code. They contain a mathematical
grayscale image, a one-page PDF saying “Synthetic report”, and an SR content tree
with Unicode text, inert HTML, an unsupported spatial item, and an image
reference. They contain no patient images or genuine clinical findings.

Generate inputs and independent expected payloads:

```sh
node fixtures/reports/generate.mjs
java -jar dist/dicom-pdf-0.53.0.jar create --input target/report-inputs --output target/viewer-test-pdfs/synthetic-reports.pdf
java -jar dist/dicom-pdf-0.53.0.jar create --input target/report-only-inputs --output target/viewer-test-pdfs/synthetic-reports-only.pdf
python3 scripts/check_dicom_reports.py
```

Generated DICOM files stay under `target/report-inputs` and `target/report-only-inputs`, and expected payloads
under `target/report-fixtures`. The converted viewer test PDFs go in
`target/viewer-test-pdfs`.
