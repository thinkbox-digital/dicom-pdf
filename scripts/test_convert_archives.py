"""Safe ZIP extraction regressions; no clinical fixture data is used."""
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

import convert_archives as archive_tools


class SafeArchiveExtractionTest(unittest.TestCase):
    def setUp(self):
        root = Path("target/series-tests")
        root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def make_zip(self, entries):
        source = self.root / "source.zip"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as zipped:
                for name, data in entries:
                    zipped.writestr(name, data)
        return source

    def test_preserves_binary_readme_and_empty_file_without_changing_zip(self):
        expected = {"folder/image.dcm": b"\x00\xffsynthetic\n", "README.txt": b"Complete source package\n", "empty.dcm": b""}
        archive = self.make_zip(expected.items())
        before = archive_tools.fingerprint(archive)
        destination = self.root / "staged"
        result = archive_tools.safe_extract(archive, destination)
        self.assertEqual(3, result["fileCount"])
        self.assertEqual(before, archive_tools.fingerprint(archive))
        for name, data in expected.items():
            self.assertEqual(data, (destination / name).read_bytes())
        archive_tools.verify_stage(result, archive, destination)
        (destination / "README.txt").write_text("tampered")
        with self.assertRaises(ValueError):
            archive_tools.verify_stage(result, archive, destination)

    def test_rejects_traversal_absolute_and_windows_paths(self):
        for name in ["../escape.dcm", "/absolute.dcm", "folder/../escape.dcm", "folder\\escape.dcm", "C:/escape.dcm", "folder//alias.dcm"]:
            with self.subTest(name=name):
                archive = self.make_zip([(name, b"payload")])
                destination = self.root / "rejected"
                with self.assertRaises(ValueError):
                    archive_tools.safe_extract(archive, destination)
                self.assertFalse(destination.exists())
                self.assertFalse((self.root / "escape.dcm").exists())

    def test_rejects_duplicate_portable_paths_and_file_directory_collision(self):
        for entries in [[("a.dcm", b"one"), ("a.dcm", b"two")], [("A.dcm", b"one"), ("a.dcm", b"two")], [("folder", b"file"), ("folder/a.dcm", b"bytes")]]:
            archive = self.make_zip(entries)
            with self.assertRaises(ValueError):
                archive_tools.safe_extract(archive, self.root / "rejected")

    def test_rejects_symlinks_and_payload_disguised_as_directory(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        directory = zipfile.ZipInfo("folder/")
        directory.external_attr = (stat.S_IFDIR | 0o755) << 16
        for entry in [link, directory]:
            archive = self.make_zip([(entry, b"payload")])
            with self.assertRaises(ValueError):
                archive_tools.safe_extract(archive, self.root / "rejected")

    def test_rejects_file_count_file_size_and_total_size_limits(self):
        archive = self.make_zip([("a.dcm", b"123"), ("b.dcm", b"456")])
        for limit, value in [("MAX_FILES", 1), ("MAX_FILE_BYTES", 2), ("MAX_TOTAL_BYTES", 5)]:
            with self.subTest(limit=limit), patch.object(archive_tools, limit, value):
                with self.assertRaises(ValueError):
                    archive_tools.safe_extract(archive, self.root / "rejected")

    def test_never_overwrites_existing_staging(self):
        archive = self.make_zip([("a.dcm", b"bytes")])
        destination = self.root / "existing"
        destination.mkdir()
        marker = destination / "master.dcm"
        marker.write_bytes(b"existing original")
        with self.assertRaises(FileExistsError):
            archive_tools.safe_extract(archive, destination)
        self.assertEqual(b"existing original", marker.read_bytes())


if __name__ == "__main__":
    unittest.main()
