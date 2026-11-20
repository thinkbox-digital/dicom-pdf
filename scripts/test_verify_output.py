import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


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
