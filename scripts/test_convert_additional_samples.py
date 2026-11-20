"""Byte-preservation and inventory checks using generated, nonclinical files."""
import copy
from pathlib import Path
import tempfile
import unittest

import convert_additional_samples as conversion
import convert_archives as archives


class AdditionalSamplesTest(unittest.TestCase):
    def setUp(self):
        parent = Path("target/additional-samples/tests")
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.work = Path(self.temporary.name).resolve()
        self.stage = self.work / "staged/input-001-synthetic"
        self.stage.mkdir(parents=True)
        (self.stage / "IMAGE001").write_bytes(b"\x00\xffsynthetic original"*100)
        self.expected = [{"path": "IMAGE001", "size": (self.stage / "IMAGE001").stat().st_size,
                          "sha256": archives.fingerprint(self.stage / "IMAGE001")}]

    def tearDown(self):
        self.temporary.cleanup()

    def test_stage_verification_detects_extra_missing_modified_and_symlink_files(self):
        conversion.verify_files(self.stage, self.expected)
        extra = self.stage / "extra"
        extra.write_bytes(b"unlisted")
        with self.assertRaises(ValueError):
            conversion.verify_files(self.stage, self.expected)
        extra.unlink()
        original = self.stage / "IMAGE001"
        data = original.read_bytes()
        original.write_bytes(data[:-1]+b"!")
        with self.assertRaises(ValueError):
            conversion.verify_files(self.stage, self.expected)
        original.unlink()
        with self.assertRaises(ValueError):
            conversion.verify_files(self.stage, self.expected)
        original.symlink_to(self.work / "outside")
        with self.assertRaises(ValueError):
            conversion.verify_files(self.stage, self.expected)

    def test_recovery_is_compared_against_original_bytes_and_preconversion_hash(self):
        recovered = self.work / "recovered"
        recovered.mkdir()
        payload = (self.stage / "IMAGE001").read_bytes()
        (recovered / "IMAGE001").write_bytes(payload)
        self.assertEqual(1, conversion.compare_recovery(self.stage, recovered, self.expected)["count"])
        (recovered / "IMAGE001").write_bytes(payload[:-1]+b"!")
        with self.assertRaises(ValueError):
            conversion.compare_recovery(self.stage, recovered, self.expected)

    def test_poppler_mapping_checks_every_original_and_rejects_unsafe_names(self):
        detached = self.work / "detached"
        detached.mkdir()
        (detached / "original.dcm").write_bytes((self.stage / "IMAGE001").read_bytes())
        image = {"sourcePath": "IMAGE001", "attachment": "original.dcm", **{key: self.expected[0][key] for key in ("size", "sha256")}}
        manifest = {"sourceRole": "archival-master", "images": [image]}
        self.assertEqual("PASS", conversion.compare_poppler(self.stage, detached, manifest, self.expected)["status"])
        for attachment in ("../outside", "/absolute", "nested/original.dcm", "bad\\name"):
            bad = copy.deepcopy(manifest)
            bad["images"][0]["attachment"] = attachment
            with self.assertRaises(ValueError):
                conversion.compare_poppler(self.stage, detached, bad, self.expected)
        manifest["images"].append(image)
        with self.assertRaises(ValueError):
            conversion.compare_poppler(self.stage, detached, manifest, self.expected)

    def test_package_selection_requires_safe_complete_verified_staging(self):
        source = {"sourceID": "input-001", "additionalSample": True, **{key: self.expected[0][key] for key in ("size", "sha256")}}
        inventory = {"inputsUnchanged": True, "sourceFiles": [source], "archives": [],
                     "looseStaging": [{"sourceID": "input-001", "status": "staged", "staging": str(self.stage), "file": str(self.stage / "IMAGE001")}]}
        packages = conversion.load_packages(inventory, self.work)
        self.assertEqual(self.expected, packages[0]["files"])
        inventory["inputsUnchanged"] = False
        with self.assertRaises(ValueError):
            conversion.load_packages(inventory, self.work)


if __name__ == "__main__":
    unittest.main()
