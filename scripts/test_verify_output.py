import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verify_output


class VerifyOutputDestinationTest(unittest.TestCase):
    def test_source_files_and_existing_reports_are_never_replaced(self):
        script = Path(__file__).with_name("verify_output.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = root / "originals"
            originals.mkdir()
            pdf = root / "archive.pdf"
            pdf.touch()
            existing = root / "report"
            existing.mkdir()
            for directory in (originals, existing):
                (directory / "page-1.png").write_bytes(b"original pixels")
                (directory / "manifest.json").write_bytes(b"original data")
            for report in (originals, originals / "new", existing):
                with self.subTest(report=report):
                    run = subprocess.run(
                        [sys.executable, script, "--input", originals, "--pdf", pdf, "--report", report],
                        capture_output=True, text=True, timeout=15,
                    )
                    self.assertEqual(2, run.returncode, run.stderr)
                    self.assertIn("Report destination", run.stderr)
                    if report == originals / "new":
                        self.assertFalse(report.exists())
                    else:
                        self.assertEqual(b"original pixels", (report / "page-1.png").read_bytes())
                        self.assertEqual(b"original data", (report / "manifest.json").read_bytes())

    def test_mismatched_original_fails_before_writing_a_success_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = root / "originals"
            originals.mkdir()
            original = b"synthetic original"
            (originals / "image.dcm").write_bytes(original)
            pdf = root / "archive.pdf"
            pdf.touch()
            report = root / "report"

            def extract(command):
                self.assertEqual("pdfdetach", command[0])
                extracted = command[3]
                (extracted / "image.dcm").write_bytes(b"different synthetic bytes")
                (extracted / "manifest.json").write_text(json.dumps({
                    "schemaVersion": 1,
                    "images": [{
                        "sourcePath": "image.dcm",
                        "attachment": "image.dcm",
                        "sha256": hashlib.sha256(original).hexdigest(),
                        "referencePage": 2,
                        "status": "rendered",
                    }],
                }), encoding="utf-8")

            argv = ["verify_output.py", "--input", str(originals), "--pdf", str(pdf), "--report", str(report)]
            with patch.object(sys, "argv", argv), patch.object(verify_output, "run", side_effect=extract):
                with self.assertRaisesRegex(SystemExit, "Extracted bytes differ"):
                    verify_output.main()
            self.assertFalse((report / "verification.json").exists())
