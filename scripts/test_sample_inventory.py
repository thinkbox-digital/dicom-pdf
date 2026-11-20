"""Synthetic archive inventory/staging regressions; never reads supplied samples."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import sample_inventory as inventory
import convert_archives as archive_tools


class SampleInventoryTest(unittest.TestCase):
    def setUp(self):
        parent = Path("target/additional-samples/tests")
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temporary.name)
        self.work = self.root / "work"
        self.work.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def zip_bytes(entries):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, value in entries:
                archive.writestr(name, value)
        return stream.getvalue()

    def make_zip(self, entries):
        path = self.root / "renamed.payload"
        path.write_bytes(self.zip_bytes(entries))
        return path

    def test_signature_detection_and_nested_binary_recovery_preserve_inputs(self):
        nested = self.zip_bytes([("IMAGES/IMAGE001", b"\x00\xffnested bytes"), ("empty", b"")])
        archive = self.make_zip([("nested.payload", nested), ("README.txt", b"Synthetic only")])
        before = archive_tools.fingerprint(archive)
        self.assertEqual("zip", inventory.file_kind(archive))
        probes = []
        rows = inventory.stage_zip(archive, self.work, "source", inventory.SessionBudget(), probe_files=probes)
        self.assertEqual(["staged", "staged"], [row["status"] for row in rows])
        self.assertEqual(before, archive_tools.fingerprint(archive))
        self.assertEqual(b"\x00\xffnested bytes", (Path(rows[1]["staging"]) / "IMAGES/IMAGE001").read_bytes())
        self.assertEqual(nested, (Path(rows[0]["staging"]) / "nested.payload").read_bytes())
        for row in rows:
            archive_tools.verify_stage(row, Path(row["archive"]), Path(row["staging"]))
        reused = inventory.stage_zip(archive, self.work, "source", inventory.SessionBudget())
        self.assertTrue(all(row["status"] == "staged" for row in reused))

    def test_nested_cumulative_file_budget_reports_rejection_without_discarding_outer(self):
        nested = self.zip_bytes([("image", b"bytes")])
        archive = self.make_zip([("inner.zip", nested)])
        rows = inventory.stage_zip(archive, self.work, "source", inventory.SessionBudget(files=1))
        self.assertEqual("staged", rows[0]["status"])
        self.assertEqual("rejected", rows[1]["status"])
        self.assertIn("budget", rows[1]["reason"])
        self.assertEqual(nested, (Path(rows[0]["staging"]) / "inner.zip").read_bytes())

    def test_depth_and_member_path_limits_never_publish_bad_archive(self):
        source = self.make_zip([("../escape", b"payload")])
        rows = inventory.stage_zip(source, self.work, "source", inventory.SessionBudget())
        self.assertEqual("rejected", rows[0]["status"])
        self.assertFalse((self.root / "escape").exists())
        source = self.make_zip([("image", b"bytes")])
        rows = inventory.stage_zip(source, self.work, "deep", inventory.SessionBudget(), depth=inventory.MAX_ARCHIVE_DEPTH+1)
        self.assertEqual("rejected", rows[0]["status"])
        self.assertFalse(any((self.work / "staged").glob("deep-*")))

    def test_staging_symlinks_are_rejected_and_not_followed(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.work / "staged").symlink_to(outside, target_is_directory=True)
        source = self.make_zip([("image", b"bytes")])
        rows = inventory.stage_zip(source, self.work, "source", inventory.SessionBudget())
        self.assertEqual("rejected", rows[0]["status"])
        self.assertFalse(list(outside.iterdir()))

    def test_input_symlinks_are_inventoried_without_reading_target(self):
        source = self.root / "sources"
        source.mkdir()
        outside = self.root / "outside.bin"
        outside.write_bytes(b"Never read through supplied symlink")
        (source / "link").symlink_to(outside)
        rows = inventory.input_inventory(source)
        self.assertEqual("not-read", rows[0]["status"])
        self.assertIsNone(rows[0]["sha256"])

    def test_loose_staging_is_exact_and_existing_mismatches_are_never_overwritten(self):
        source = self.root / "image.dcm"
        source.write_bytes(b"\x00\xffsynthetic")
        row = {"sourceID": "source", "size": source.stat().st_size, "sha256": archive_tools.fingerprint(source)}
        result = inventory.stage_loose(source, self.work, row)
        staged = Path(result["file"])
        self.assertEqual(source.read_bytes(), staged.read_bytes())
        self.assertEqual(result, inventory.stage_loose(source, self.work, row))
        staged.write_bytes(b"existing altered file")
        with self.assertRaises(ValueError):
            inventory.stage_loose(source, self.work, row)
        self.assertEqual(b"existing altered file", staged.read_bytes())

    def test_prior_report_marks_paths_and_hash_evidence_separately(self):
        root = self.root / "inputs"
        root.mkdir()
        (root / "already.zip").write_bytes(b"unchanged")
        report = self.root / "prior.json"
        fingerprint = archive_tools.fingerprint(root / "already.zip")
        report.write_text(json.dumps([{"archive": "already.zip", "archiveSha256": fingerprint}]))
        hashes, paths = inventory.prior_inputs(root, [report])
        self.assertEqual({fingerprint}, hashes)
        self.assertEqual({"already.zip"}, paths)

    def test_seven_listing_preflight_rejects_unsafe_links_encryption_collisions_and_limits(self):
        source = self.root / "source.7z"
        source.write_bytes(b"7z\xbc\xaf\x27\x1c")
        normal = "Path = image\nSize = 3\nAttributes = A_ -rw-------\nEncrypted = -\n\n"
        cases = [normal.replace("image", "../escape"), normal.replace("Encrypted = -", "Encrypted = +"),
                 normal+normal, normal.replace("A_ -rw-------", "A_ lrwxrwxrwx"), normal+"Path = image/child\nSize = 1\nAttributes = A_ -rw-------\n\n",
                 normal.replace("Size = 3", "Size = -1"), normal+"Symbolic Link = outside\n"]
        for listing in cases:
            with self.subTest(listing=listing), patch.object(inventory, "run_7z", return_value=listing.encode()):
                with self.assertRaises(ValueError):
                    inventory.seven_members(source)
        with patch.object(inventory, "run_7z", return_value=normal.encode()), patch.object(archive_tools, "MAX_FILE_BYTES", 2):
            with self.assertRaises(ValueError):
                inventory.seven_members(source)

    @unittest.skipUnless(shutil.which("7z") or shutil.which("7zz"), "Existing local 7z is optional")
    def test_existing_seven_reader_streams_exact_members_without_wildcard_expansion(self):
        sources = self.root / "seven-source"
        sources.mkdir()
        expected = {"literal?.dcm": b"question bytes", "literalA.dcm": b"different bytes", "empty": b""}
        for name, data in expected.items():
            (sources / name).write_bytes(data)
        archive = (self.root / "source.7z").resolve()
        command = [shutil.which("7z") or shutil.which("7zz"), "a", "-t7z", "-spd", str(archive), "."]
        subprocess.run(command, cwd=sources, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30)
        before = archive_tools.fingerprint(archive)
        with patch.object(inventory, "seven_output", wraps=inventory.seven_output) as reader:
            rows = inventory.stage_7z(archive, self.work, "source", inventory.SessionBudget())
        self.assertEqual(["l", "x"], [call.args[0][0] for call in reader.call_args_list])
        self.assertEqual("staged", rows[0]["status"], rows[0].get("reason"))
        staged = Path(rows[0]["staging"])
        for name, data in expected.items():
            self.assertEqual(data, (staged / name).read_bytes())
        self.assertEqual(before, archive_tools.fingerprint(archive))


if __name__ == "__main__":
    unittest.main()
