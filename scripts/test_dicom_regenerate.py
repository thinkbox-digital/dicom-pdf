"""Regeneration selection, archive staging and atomic publication regressions.

Run: python3 -B -m unittest discover -s scripts -p test_dicom_regenerate.py -v
"""
import gzip
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from unittest.mock import patch
import zipfile

import dicom_regenerate as regenerate


class DicomRegenerateTest(unittest.TestCase):
    def setUp(self):
        parent = regenerate.PROJECT / "target/dicom-regenerate-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temporary.name)
        self.source = self.root / "in"
        self.source.mkdir()
        self.jar = self.root / "fake.jar"
        self.jar.touch()
        self.policy = self.root / "signing.json"
        (self.root / "credential.p12").write_bytes(b"synthetic signing identity")
        (self.root / "passphrase.txt").write_bytes(b"synthetic passphrase")
        self.policy.write_text(json.dumps({"protection": "PADES_B_LTA", "pkcs12": "credential.p12",
                                           "passphraseFile": "passphrase.txt"}), encoding="utf-8")
        self.output = regenerate.PROJECT / "out" / ("regenerate-test-" + self.root.name)
        self.addCleanup(shutil.rmtree, self.output, True)

    def tearDown(self):
        self.temporary.cleanup()

    def fake_java(self):
        path = self.root / "fake-java"
        path.write_text("""#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import sys
import time
args = sys.argv
if retiring_jar := os.environ.get('REGENERATE_TEST_RETIRE_JAR'):
    Path(retiring_jar).unlink(missing_ok=True)
    jar = Path(args[args.index('-jar')+1])
    assert jar.read_bytes() == b'original CLI JAR'
stage = Path(args[args.index('--input')+1])
output = Path(args[args.index('--output')+1])
if 'extract' in args:
    if stage.read_bytes() == b'%PDF-fail extraction':
        sys.exit(7)
    (output.parent.parent / 'extract-args.json').write_text(json.dumps(args))
    (output / 'originals/series').mkdir(parents=True)
    (output / 'originals/series/image.dcm').write_bytes(b'recovered DICOM')
    (output / 'package').mkdir()
    manifest = {'sourceRole': 'deidentified-copy'}
    if stage.read_bytes() == b'%PDF-example with receipt':
        receipt = b'{"schemaVersion":1}'
        (output / 'package/import-source.json').write_bytes(receipt)
        manifest['artifactSha256'] = {'import-source.json': hashlib.sha256(receipt).hexdigest()}
    (output / 'package/manifest.json').write_text(json.dumps(manifest))
    sys.exit(0)
entries = {p.relative_to(stage).as_posix(): p.read_bytes().hex() for p in stage.rglob('*') if p.is_file()}
barrier = Path(__file__).with_name('barrier')
if barrier.is_dir():
    (barrier / next(iter(entries))).touch()
    deadline = time.monotonic() + 10
    while len(list(barrier.iterdir())) < 2:
        if time.monotonic() >= deadline:
            sys.exit('Conversions did not overlap')
        time.sleep(0.02)
(output.parent.parent / 'staged-files.json').write_text(json.dumps(entries))
(output.parent.parent / 'create-args.json').write_text(json.dumps(args))
if '--import-provenance' in args:
    receipt = Path(args[args.index('--import-provenance')+1])
    (output.parent.parent / 'import-receipt.json').write_bytes(receipt.read_bytes())
output.write_bytes(b'%PDF-1.7\\nsynthetic test output')
if 'fail.dcm' in entries:
    sys.exit(7)
""")
        path.chmod(0o700)
        return path

    def run_cli(self, *arguments, success=True):
        result = subprocess.run(["bash", str(regenerate.PROJECT / "scripts/dicom-regenerate.sh"),
                                 "--input", str(self.source), "--output", str(self.output),
                                 "--jar", str(self.jar), "--java", str(self.fake_java()), *arguments],
                                cwd=self.root, capture_output=True, text=True, timeout=60,
                                env={**os.environ, "DICOM_REGENERATE_SECURITY_CONFIG": str(self.policy)})
        self.assertEqual(0 if success else 1, result.returncode, result.stdout + result.stderr)
        return result

    def reports(self, stdout):
        path = next(line.removeprefix("Reports: ") for line in stdout.splitlines() if line.startswith("Reports: "))
        return regenerate.PROJECT / path

    def test_help_prints_how_to(self):
        result = subprocess.run(["bash", str(regenerate.PROJECT / "scripts/dicom-regenerate.sh"), "--help"],
                                cwd=self.root, capture_output=True, text=True, check=True, timeout=30)
        self.assertIn("How to regenerate PDFs", result.stdout)
        self.assertIn("dicom-regenerate --dry-run", result.stdout)
        self.assertIn("dicom-regenerate --example", result.stdout)
        self.assertIn("dicom-regenerate --everything", result.stdout)
        self.assertNotIn("Reports:", result.stdout)

    def test_no_arguments_returns_success_when_all_inputs_have_pdfs(self):
        (self.source / "image.dcm").write_bytes(b"image")
        output = self.root / "out"
        output.mkdir()
        (output / "image.dcm.pdf").write_bytes(b"%PDF-existing")
        stdout = StringIO()
        with patch.object(regenerate, "PROJECT", self.root), redirect_stdout(stdout):
            self.assertEqual(0, regenerate.main([]))
        self.assertIn("No new inputs to convert", stdout.getvalue())
        self.assertFalse((self.root / regenerate.REPORTS).exists())

    def test_default_converts_only_entries_without_matching_pdfs(self):
        (self.source / "image.dcm").write_bytes(b"image")
        series = self.source / "series"
        series.mkdir()
        (series / "first.dcm").write_bytes(b"first image")
        self.run_cli()
        existing = {path: path.stat().st_ino for path in self.output.iterdir()}
        (self.source / "image.dcm").write_bytes(b"updated image")
        (series / "second.dcm").write_bytes(b"second image")
        (self.source / "new.dcm").write_bytes(b"new image")

        preview = self.run_cli("--new", "--dry-run")
        self.assertIn("new.dcm.pdf", preview.stdout)
        self.assertIn("Dry run: 1 PDFs", preview.stdout)
        self.assertFalse((self.output / "new.dcm.pdf").exists())
        result = self.run_cli()
        self.assertIn("Created 1 PDFs; 0 failed", result.stdout)
        self.assertTrue((self.output / "new.dcm.pdf").is_file())
        for path, inode in existing.items():
            self.assertEqual(inode, path.stat().st_ino)
        self.assertIn("No new inputs to convert", self.run_cli().stdout)

    def test_concurrent_publication_keeps_existing_pdf(self):
        self.output.mkdir(parents=True)
        output = self.output / "image.dcm.pdf"
        pending = self.root / "converted.pdf"
        pending.write_bytes(b"%PDF-new conversion")
        output.write_bytes(b"%PDF-concurrently published")
        self.assertEqual("skipped", regenerate.publish_pdf(pending, output, new_only=True))
        self.assertEqual(b"%PDF-concurrently published", output.read_bytes())

    def test_all_preserves_full_basenames_and_publishes_only_pdfs(self):
        (self.source / "same.dcm").write_bytes(b"unchanged loose DICOM")
        with zipfile.ZipFile(self.source / "same.zip", "w") as archive:
            archive.writestr("series/IMAGE001", b"unchanged archived DICOM")
        before = regenerate.source_inventory(self.source)
        result = self.run_cli("--all")
        self.assertIn("Created 2 PDFs; 0 failed", result.stdout)
        self.assertEqual({"same.dcm.pdf", "same.zip.pdf"}, {p.name for p in self.output.iterdir()})
        self.assertEqual(before, regenerate.source_inventory(self.source))
        command_logs = sorted(self.reports(result.stdout).glob("input-*/create-args.json"))
        self.assertEqual(2, len(command_logs))
        for path in command_logs:
            args = json.loads(path.read_text())
            self.assertEqual("on", args[args.index("--c2pa") + 1])
            self.assertEqual(str(self.policy), args[args.index("--security-config") + 1])
        receipt, = self.reports(result.stdout).glob("input-*/import-receipt.json")
        self.assertEqual({"schemaVersion": 1, "kind": "ZIP_IMPORT", "basis": "LOCAL_CONTAINER_EXTRACTION",
                          "sourceName": "same.zip", "sourceBytes": before[1]["size"],
                          "sourceSha256": before[1]["sha256"], "containerEmbedded": False,
                          "memberRoot": "contents/", "memberCount": 1}, json.loads(receipt.read_text()))
        self.assertEqual({"contents/series/IMAGE001": b"unchanged archived DICOM".hex()},
                         json.loads((receipt.parent / "staged-files.json").read_text()))

    def test_batch_conversions_share_cpu_with_a_fixed_heap_per_job(self):
        (self.root / "barrier").mkdir()
        for name in ("first.dcm", "second.dcm"):
            (self.source / name).write_bytes(b"synthetic DICOM")
        output = StringIO()
        arguments = ["--all", "--pades", "off", "--jar", str(self.jar), "--java", str(self.fake_java())]
        with (patch.object(regenerate, "PROJECT", self.root),
              patch.object(regenerate, "available_resources", return_value=(7, [], 9217)),
              redirect_stdout(output)):
            self.assertEqual(0, regenerate.main(arguments), output.getvalue())
            run = self.reports(output.getvalue())
        summary = json.loads((run / "summary.json").read_text())
        self.assertEqual(2, summary["resources"]["parallelJobs"])
        for number, (result, processors) in enumerate(zip(summary["results"], (3, 4), strict=True), 1):
            self.assertEqual(processors, result["processors"])
            self.assertEqual(4096, result["javaHeapMiB"])
            flags = json.loads((run / f"input-{number:04}/create-args.json").read_text())
            self.assertIn(f"-XX:ActiveProcessorCount={processors}", flags)
            self.assertIn(f"-Ddicompdf.workers={processors}", flags)
            self.assertEqual(["-Xmx4096m"], [flag for flag in flags if flag.startswith("-Xmx")])

    def test_batch_keeps_using_selected_jar_after_distribution_removes_it(self):
        self.jar.write_bytes(b"original CLI JAR")
        for name in ("first.dcm", "second.dcm"):
            (self.source / name).write_bytes(b"synthetic DICOM")
        stdout = StringIO()
        arguments = ["--all", "--pades", "off", "--jar", str(self.jar), "--java", str(self.fake_java())]
        with (patch.object(regenerate, "PROJECT", self.root),
              patch.object(regenerate, "available_resources", return_value=(1, [], 4608)),
              patch.dict(os.environ, REGENERATE_TEST_RETIRE_JAR=str(self.jar)),
              redirect_stdout(stdout)):
            self.assertEqual(0, regenerate.main(arguments), stdout.getvalue())
            run = self.reports(stdout.getvalue())
        self.assertFalse(self.jar.exists())
        self.assertIn("Created 2 PDFs; 0 failed", stdout.getvalue())
        self.assertEqual(str(self.jar), json.loads((run / "summary.json").read_text())["jar"])
        self.assertEqual([], list(run.glob("cli-*")))

    def test_memory_budget_limits_concurrency_and_requires_one_full_heap(self):
        for name in ("first.dcm", "second.dcm"):
            (self.source / name).write_bytes(b"synthetic DICOM")
        arguments = ["--all", "--pades", "off", "--jar", str(self.jar), "--java", str(self.fake_java())]
        stdout = StringIO()
        with (patch.object(regenerate, "PROJECT", self.root),
              patch.object(regenerate, "available_resources", return_value=(7, [], 9215)) as resources,
              redirect_stdout(stdout)):
            self.assertEqual(0, regenerate.main(arguments))
            run = self.reports(stdout.getvalue())
            summary = json.loads((run / "summary.json").read_text())
            self.assertEqual(1, summary["resources"]["parallelJobs"])
            self.assertEqual([4096, 4096], [result["javaHeapMiB"] for result in summary["results"]])
            resources.return_value = (7, [], 4607)
            with self.assertRaises(SystemExit) as failed, patch("sys.stderr", new_callable=StringIO) as stderr:
                regenerate.main(arguments)
            self.assertEqual(2, failed.exception.code)
            self.assertIn("4608 MiB of available RAM after the OS reserve", stderr.getvalue())

    def test_everything_rebuilds_examples_from_originals_and_inputs(self):
        (self.source / "image.dcm").write_bytes(b"input image")
        example = self.root / "examples/CT/nested/series.pdf"
        example.parent.mkdir(parents=True)
        example.write_bytes(b"%PDF-existing example")
        (example.parent / "README.md").write_text("Reference material")
        jar, java = self.jar, self.fake_java()
        output = StringIO()
        default_policy = self.root / regenerate.REPORTS / "signing.json"
        default_policy.parent.mkdir(parents=True)
        for name in ("credential.p12", "passphrase.txt", self.policy.name):
            shutil.copyfile(self.root / name, default_policy.parent / name)
        with patch.object(regenerate, "PROJECT", self.root), patch.dict(os.environ, DICOM_REGENERATE_SECURITY_CONFIG=""), redirect_stdout(output):
            self.assertEqual(0, regenerate.main(["--everything", "--jar", str(jar), "--java", str(java)]))
            report = self.reports(output.getvalue()) / "input-0002"
        self.assertTrue((self.root / "out/image.dcm.pdf").is_file())
        self.assertFalse((self.root / "out/examples").exists())
        self.assertIn("examples/CT/nested/series.pdf -> examples/CT/nested/series.pdf", output.getvalue())
        self.assertEqual(b"%PDF-1.7\nsynthetic test output", example.read_bytes())
        self.assertEqual({"series/image.dcm": b"recovered DICOM".hex()},
                         json.loads((report / "staged-files.json").read_text()))
        args = json.loads((report / "create-args.json").read_text())
        self.assertIn("-Xmx4096m", args)
        self.assertIn("-Xmx4096m", json.loads((report / "extract-args.json").read_text()))
        self.assertEqual("deidentified-copy", args[args.index("--source-role") + 1])
        self.assertEqual("on", args[args.index("--c2pa") + 1])
        self.assertEqual(str(default_policy), args[args.index("--security-config") + 1])

    def test_example_only_replaces_successful_examples_in_place(self):
        examples = self.root / "examples/CT"
        examples.mkdir(parents=True)
        failed = examples / "failed.pdf"
        failed.write_bytes(b"%PDF-fail extraction")
        rebuilt = examples / "series.pdf"
        rebuilt.write_bytes(b"%PDF-existing example")
        output = StringIO()
        arguments = ["--example", "--pades", "off", "--jar", str(self.jar), "--java", str(self.fake_java())]
        with (patch.object(regenerate, "PROJECT", self.root),
              patch.object(regenerate, "available_resources", return_value=(1, [], 4608)),
              redirect_stdout(output)):
            self.assertEqual(1, regenerate.main(arguments), output.getvalue())
        self.assertIn("Created 1 PDFs; 1 failed", output.getvalue())
        self.assertEqual(b"%PDF-fail extraction", failed.read_bytes())
        self.assertEqual(b"%PDF-1.7\nsynthetic test output", rebuilt.read_bytes())
        self.assertFalse((self.root / "out").exists())

    def test_example_selection_and_independent_signing_switches(self):
        for modality in ("CT", "MR"):
            source = self.source / modality / "series.pdf"
            source.parent.mkdir()
            source.write_bytes(b"%PDF-existing example")
        result = self.run_cli("--example", "CT", "--c2pa", "off", "--pades", "off")
        self.assertTrue((self.output / "examples/CT/series.pdf").is_file())
        self.assertFalse((self.output / "examples/MR").exists())
        report = self.reports(result.stdout) / "input-0001"
        args = json.loads((report / "create-args.json").read_text())
        self.assertEqual("off", args[args.index("--c2pa") + 1])
        self.assertNotIn("--security-config", args)

    def test_example_preserves_the_receipt_bound_to_its_manifest(self):
        source = self.source / "series.pdf"
        source.write_bytes(b"%PDF-example with receipt")
        result = self.run_cli("--example", "series.pdf", "--pades", "off")
        receipt = self.reports(result.stdout) / "input-0001/import-receipt.json"
        self.assertEqual(b'{"schemaVersion":1}', receipt.read_bytes())

    def test_weak_policy_and_staged_passphrase_are_rejected(self):
        with zipfile.ZipFile(self.source / "source.zip", "w") as archive:
            archive.writestr("image.dcm", (self.root / "passphrase.txt").read_bytes())
        result = self.run_cli("--all", success=False)
        report = json.loads((self.reports(result.stdout) / "input-0001/result.json").read_text())
        self.assertIn("Signing credentials and passphrases must be outside archival inputs", report["error"])
        self.assertFalse(self.output.exists())
        alternative = self.root / "weaker-policy.json"
        alternative.write_text(json.dumps({"protection": "CMS_AND_PDF"}))
        result = self.run_cli("--all", "--security-config", str(alternative), success=False)
        self.assertIn("must set protection to PADES_B_LTA", result.stderr)

    def test_sample_and_dry_run_are_independent_of_working_directory(self):
        (self.source / "first.dcm").write_bytes(b"one")
        (self.source / "second.dcm").write_bytes(b"two")
        result = self.run_cli("--sample", "second.dcm", "--dry-run")
        self.assertIn("second.dcm.pdf", result.stdout)
        self.assertNotIn("first.dcm.pdf", result.stdout)
        self.assertFalse(self.output.exists())
        self.run_cli("--sample")
        self.assertEqual(["first.dcm.pdf"], [p.name for p in self.output.iterdir()])

    def test_failure_keeps_old_pdf_and_continues_other_inputs(self):
        (self.source / "fail.dcm").write_bytes(b"failure marker")
        (self.source / "good.dcm").write_bytes(b"good")
        self.output.mkdir(parents=True)
        (self.output / "fail.dcm.pdf").write_bytes(b"%PDF-old")
        result = self.run_cli("--all", success=False)
        self.assertIn("Created 1 PDFs; 1 failed", result.stdout)
        report = self.reports(result.stdout).relative_to(regenerate.PROJECT)
        self.assertIn(f"failed: fail.dcm.pdf (see {report}/input-0001/result.json)", result.stdout)
        self.assertEqual(b"%PDF-old", (self.output / "fail.dcm.pdf").read_bytes())
        self.assertTrue((self.output / "good.dcm.pdf").read_bytes().startswith(b"%PDF-"))

    def test_all_replaces_old_pdf(self):
        (self.source / "image.dcm").write_bytes(b"image")
        self.output.mkdir(parents=True)
        target = self.output / "image.dcm.pdf"
        target.write_bytes(b"%PDF-old")
        self.run_cli("--all")
        self.assertNotEqual(b"%PDF-old", target.read_bytes())

    def test_nested_zip_and_gzip_expand_without_dropping_archive_bytes(self):
        folder = self.source / "series"
        folder.mkdir()
        nested = folder / "nested.zip"
        compressed = gzip.compress(b"DICOM pixel bytes")
        with zipfile.ZipFile(nested, "w") as archive:
            archive.writestr("IMAGE001.gz", compressed)
        stage = self.root / "stage"
        expected = regenerate.source_inventory(folder)
        _, captured = regenerate.stage_input(folder, stage)
        self.assertEqual(expected, captured)
        self.assertEqual(nested.read_bytes(), (stage / "nested.zip").read_bytes())
        self.assertEqual(compressed, (stage / "nested.zip.contents/IMAGE001.gz").read_bytes())
        self.assertEqual(b"DICOM pixel bytes", (stage / "nested.zip.contents/IMAGE001.gz.contents/IMAGE001").read_bytes())
        outer_stage = self.root / "outer-stage"
        self.assertIsNone(regenerate.stage_input(nested, outer_stage)[0])
        self.assertEqual(nested.read_bytes(), (outer_stage / "containers/nested.zip").read_bytes())
        self.assertEqual(b"DICOM pixel bytes", (outer_stage / "contents/IMAGE001.gz.contents/IMAGE001").read_bytes())

    def test_copy_and_inventory_reject_changes_after_a_loose_file_is_captured(self):
        path = self.source / "image.dcm"
        path.write_bytes(b"original bytes")
        original_copy = regenerate.copy_input

        def mutate_after_copy(source, destination, size):
            digest = original_copy(source, destination, size)
            source.write_bytes(b"changed! bytes")
            return digest

        with mock.patch.object(regenerate, "copy_input", side_effect=mutate_after_copy):
            with self.assertRaisesRegex(ValueError, "Original input changed during staging"):
                regenerate.stage_input(path, self.root / "stage")

    def test_unsafe_zip_or_expansion_collision_is_rejected(self):
        path = self.source / "bad.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("../escape", b"bad")
        with self.assertRaises(ValueError):
            regenerate.stage_input(path, self.root / "stage")
        self.assertFalse((self.root / "escape").exists())
        path.unlink()
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("data", b"bytes")
        (self.source / "bad.zip.contents").mkdir()
        with self.assertRaises(ValueError):
            regenerate.stage_input(self.source, self.root / "collision")

    def test_dicom_header_takes_priority_over_embedded_zip(self):
        path = self.source / "image.dcm"
        path.write_bytes(b"\0" * 128 + b"DICM")
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("payload", b"opaque pixel bytes")
        self.assertTrue(zipfile.is_zipfile(path))
        self.assertEqual("dicom", regenerate.file_kind(path))
        stage = self.root / "stage"
        regenerate.stage_input(path, stage)
        self.assertEqual(path.read_bytes(), (stage / path.name).read_bytes())
        self.assertEqual([path.name], [p.name for p in stage.iterdir()])

    def test_symlinks_and_samples_outside_input_are_rejected(self):
        (self.source / "link.dcm").symlink_to(self.root / "elsewhere")
        with self.assertRaises(ValueError):
            regenerate.select_inputs(self.source, None)
        with self.assertRaises(ValueError):
            regenerate.select_inputs(self.source, "../outside")

    def test_output_cannot_write_non_pdf_artifacts_outside_out(self):
        (self.source / "image.dcm").write_bytes(b"image")
        result = subprocess.run(["bash", str(regenerate.PROJECT / "scripts/dicom-regenerate.sh"),
                                 "--input", str(self.source), "--output", str(self.root / "bad-output")],
                                capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertFalse((self.root / "bad-output").exists())

    def test_symlink_launcher_resolves_repository(self):
        (self.source / "image.dcm").write_bytes(b"synthetic input")
        link = self.root / "dicom-regenerate"
        link.symlink_to(regenerate.PROJECT / "scripts/dicom-regenerate.sh")
        result = subprocess.run(["bash", str(link), "--input", str(self.source), "--sample", "--dry-run"],
                                cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("image.dcm -> out/image.dcm.pdf", result.stdout)
        self.assertIn("Dry run: 1 PDFs", result.stdout)

    @unittest.skipUnless(shutil.which("7z") or shutil.which("7zz"), "7z reader not installed")
    def test_seven_zip_members_preserve_paths_and_bytes(self):
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "IMAGE001").write_bytes(b"seven zip image")
        source = self.source / "series.7z"
        subprocess.run([shutil.which("7z") or shutil.which("7zz"), "a", str(source), "."], cwd=seed,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        stage = self.root / "stage"
        regenerate.stage_input(source, stage)
        self.assertEqual(b"seven zip image", (stage / "IMAGE001").read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
