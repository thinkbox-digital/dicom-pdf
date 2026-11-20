"""Synthetic conformance cases, generated with independent open-source libraries."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import rfc8785
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as XML

from pydicom import Dataset, FileDataset, FileMetaDataset, dcmwrite
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

import archive_validator
from archive_validator import verify, strict_json, check_signed_inventory, ArchiveError, PROFILE_SCHEMA, NS
from jsonschema import Draft202012Validator


def source_bytes(value=1):
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = '2.25.314159.1'
    meta.ImplementationClassUID = '2.25.314159.9'
    ds = FileDataset(None, {}, file_meta=meta, preamble=bytes(128))
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = '2.25.314159.2'
    ds.SeriesInstanceUID = '2.25.314159.3'
    ds.PatientName = 'Synthetic^Private'
    ds.Rows = ds.Columns = 2
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = bytes([value, 2, 3, 4])
    output = io.BytesIO()
    dcmwrite(output, ds, enforce_file_format=True)
    return output.getvalue()


def fixture(path, *, count=1, corrupt=False, wrong_metadata=False, extra=False,
            wrong_role=False, invented_reference=False, unsafe_xml=False, unreadable=False):
    sources = {f'image-{i}.dcm': source_bytes(i+1) for i in range(count)}
    if unreadable:
        sources[f'image-{count-1}.dcm'] = b''
    artifacts = {'inventory.txt': b'Synthetic inventory\n', 'profile.json': b'{}',
                 'field-mapping.json': b'{}', 'dicom-xmp.rng': b'<schema/>',
                 'RECOVERY.txt': b'Extract originals; compare SHA-256.\n'}
    manifest = {'schemaVersion': 2, 'profile': 'dicom-images', 'profileVersion': '0.3.0',
        'creator': 'Independent synthetic fixture', 'sourceRole': 'archival-master',
        'images': [], 'references': [], 'duplicateInstanceUIDs': {},
        'artifactSha256': {name: hashlib.sha256(data).hexdigest() for name, data in artifacts.items()}}
    for index, (name, data) in enumerate(sources.items()):
        manifest['images'].append({'attachment': f'original-{index+1:04}.dcm', 'sourcePath': name,
            'sopInstanceUID': '2.25.314159.1', 'sha256': hashlib.sha256(data).hexdigest(),
            'size': len(data), 'referencePage': index+2, 'status': 'unrendered',
            'reason': 'Synthetic diagnostic page; no preview', 'fields': {
                'SOPClassUID': str(SecondaryCaptureImageStorage), 'SOPInstanceUID': '2.25.314159.1',
                'StudyInstanceUID': '2.25.999' if wrong_metadata else '2.25.314159.2',
                'SeriesInstanceUID': '2.25.314159.3', 'Rows': '2', 'Columns': '2',
                'TransferSyntaxUID': str(ExplicitVRLittleEndian)}, 'supplied': True, 'embedded': True,
            'displayRejected': True, 'sourceFrame': None, 'displayAdjustments': {}, 'previewSha256': None})
    if count > 1:
        manifest['duplicateInstanceUIDs'] = {'2.25.314159.1': [i['attachment'] for i in manifest['images']]}
    if invented_reference:
        manifest['references'] = [{'sourceAttachment': 'original-0001.dcm', 'sequencePath': '/Invented',
            'sopInstanceUID': '2.25.404', 'sopClassUID': None, 'frames': [],
            'status': 'missing', 'resolvedAttachments': []}]
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode('utf-8')
    artifacts['manifest.json'] = manifest_bytes
    artifacts['manifest.sha256'] = (hashlib.sha256(manifest_bytes).hexdigest()+'  manifest.json\n').encode('ascii')
    writer = PdfWriter()
    for _ in range(count+1):
        writer.add_blank_page(width=595, height=842)
    for name, data in artifacts.items():
        file = writer.add_attachment(name, data)
        file.associated_file_relationship = NameObject('/Data')
    for image, data in zip(manifest['images'], sources.values()):
        file = writer.add_attachment(image['attachment'], data[:-1]+b'\xff' if corrupt else data)
        file.associated_file_relationship = NameObject('/Data' if wrong_role else '/Source')
    if extra:
        writer.add_attachment('undeclared.bin', b'not in manifest')
    rdf = XML.Element('{adobe:ns:meta/}xmpmeta')
    for key in ['schemaVersion', 'profile', 'profileVersion', 'sourceRole']:
        XML.SubElement(rdf, '{'+NS+'}'+key).text = str(manifest[key])
    XML.SubElement(rdf, '{'+NS+'}inventoryJson').text = manifest_bytes.decode('utf-8')
    packet = XML.tostring(rdf, encoding='utf-8')
    if unsafe_xml:
        packet = b'<!DOCTYPE unsafe [<!ENTITY x "unsafe">]>'+packet
    stream = DecodedStreamObject()
    stream.set_data(packet)
    stream[NameObject('/Type')] = NameObject('/Metadata')
    stream[NameObject('/Subtype')] = NameObject('/XML')
    writer._root_object[NameObject('/Metadata')] = writer._add_object(stream)
    with path.open('wb') as output:
        writer.write(output)
    return sources


class IndependentArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.pdf = self.root/'archive.pdf'

    def tearDown(self):
        self.directory.cleanup()

    def test_independent_bytes_xmp_identity_and_external_inventory(self):
        originals = fixture(self.pdf)
        inputs = self.root/'sources'
        inputs.mkdir()
        for name, data in originals.items():
            (inputs/name).write_bytes(data)
        report = verify(self.pdf, inputs)
        for key in ['manifestSchema', 'preservationIntegrity', 'xmpConsistency', 'inputReconciliation', 'identityMetadata', 'explicitSopReferences']:
            self.assertEqual('PASS', report['checks'][key]['status'], (key, report))
        self.assertEqual('UNKNOWN', report['checks']['pdfa4f']['status'])
        self.assertEqual('UNKNOWN', report['checks']['provenance']['status'])
        self.assertEqual(2, report['exitCode'], 'No PDF/A check must never be reported fully checked')

    def test_corrupted_source_is_not_hidden_by_a_readable_pdf(self):
        fixture(self.pdf, corrupt=True)
        report = verify(self.pdf)
        self.assertEqual('ORIGINAL_BYTES_MISMATCH', report['checks']['packageRead']['code'])
        self.assertEqual(1, report['exitCode'])

    def test_self_consistent_manifest_xmp_cannot_hide_wrong_dicom_identity(self):
        fixture(self.pdf, wrong_metadata=True)
        report = verify(self.pdf)
        self.assertEqual('PASS', report['checks']['preservationIntegrity']['status'])
        self.assertEqual('PASS', report['checks']['xmpConsistency']['status'])
        self.assertEqual('FAIL', report['checks']['identityMetadata']['status'])

    def test_unsubmitted_and_missing_originals_are_reconciled_separately(self):
        fixture(self.pdf)
        inputs = self.root/'sources'
        inputs.mkdir()
        (inputs/'extra.dcm').write_bytes(source_bytes())
        report = verify(self.pdf, inputs)
        self.assertEqual('FAIL', report['checks']['inputReconciliation']['status'])
        self.assertEqual('PASS', report['checks']['preservationIntegrity']['status'])

    def test_undeclared_attachment_is_rejected(self):
        fixture(self.pdf, extra=True)
        self.assertEqual('ATTACHMENT_INVENTORY_MISMATCH', verify(self.pdf)['checks']['packageRead']['code'])

    def test_duplicate_instances_are_preserved_as_distinct_sources(self):
        fixture(self.pdf, count=2)
        report = verify(self.pdf)
        self.assertEqual('PASS', report['checks']['identityMetadata']['status'])
        self.assertEqual(2, report['checks']['preservationIntegrity']['originals'])
        self.assertNotEqual(1, report['exitCode'])

    def test_reference_inventory_is_reparsed_not_trusted(self):
        fixture(self.pdf, invented_reference=True)
        self.assertEqual('FAIL', verify(self.pdf)['checks']['explicitSopReferences']['status'])

    def test_unreadable_member_does_not_hide_a_known_reference_mismatch(self):
        fixture(self.pdf, count=2, invented_reference=True, unreadable=True)
        report = verify(self.pdf)
        self.assertEqual('UNKNOWN', report['checks']['dicomReadability']['status'])
        self.assertEqual('FAIL', report['checks']['explicitSopReferences']['status'])

    def test_signed_ingestion_receipt_reconciles_ordered_canonical_source_inventory(self):
        images = [dict(attachment='original-0001.dcm', sourcePath='scan.dcm', size=10, sha256='a'*64)]
        receipt = {'event': 'INGESTION', 'fileCount': 1,
                   'inputInventorySha256': hashlib.sha256(rfc8785.dumps(images)).hexdigest()}
        def checked():
            return check_signed_inventory('RFC8785_JCS', images, rfc8785.dumps({'events': [receipt]}))['status']
        self.assertEqual('PASS', checked())
        with self.assertRaises(ArchiveError):
            check_signed_inventory('LEGACY_JSON_BYTES', images, b'{}')
        receipt['fileCount'] = 2
        self.assertEqual('FAIL', checked())
        receipt['fileCount'] = 1
        images[0]['sourcePath'] = 'other.dcm'
        self.assertEqual('FAIL', checked())

    def test_source_relationship_and_unsafe_xml_are_not_accepted(self):
        fixture(self.pdf, wrong_role=True)
        self.assertEqual('ORIGINAL_ASSOCIATION_MISMATCH', verify(self.pdf)['checks']['packageRead']['code'])
        fixture(self.pdf, unsafe_xml=True)
        self.assertEqual(1, verify(self.pdf)['exitCode'])

    def test_flate_attachment_does_not_keep_decoded_or_resolved_payloads(self):
        data = b'original bytes' * 10_000
        writer = PdfWriter()
        embedded = writer.add_attachment('original.dcm', data)
        stream = writer._add_object(embedded._embedded_file.flate_encode())
        embedded.pdf_object['/EF'][NameObject('/F')] = stream
        writer.write(self.pdf)
        with PdfReader(self.pdf, strict=True) as reader:
            attachment = next(reader.attachment_list)
            stream = attachment._embedded_file
            identity = stream.indirect_reference
            self.assertEqual(data, archive_validator.attachment_bytes(reader, attachment))
            self.assertIsNone(stream.decoded_self)
            self.assertNotIn((identity.generation, identity.idnum), reader.resolved_objects)
            self.assertEqual(data, archive_validator.attachment_bytes(reader, attachment))

    @unittest.skipUnless(sys.platform == 'linux', 'preloaded probe server is available on Linux')
    def test_timed_out_probe_is_unreadable_and_next_source_uses_fallback(self):
        script = self.root / 'probe.py'
        script.write_text(
            "import sys, time\n"
            "if sys.argv[1] == '--serve':\n"
            "    sys.stdout.buffer.write(b'+'); sys.stdout.buffer.flush()\n"
            "    if sys.stdin.buffer.read(1) == b'?': time.sleep(10)\n"
            "else:\n"
            "    print('{\"status\":\"PARSED\"}')\n"
        )
        with patch.object(archive_validator, 'PROBE_SCRIPT', script), patch.object(archive_validator, 'PROBE_TIMEOUT', 0.5):
            with archive_validator.probe_session(self.root) as probe:
                self.assertEqual('UNREADABLE', probe(b'first')['status'])
                self.assertEqual('PARSED', probe(b'second')['status'])
        self.assertFalse((self.root/'source.dcm').exists())
        self.assertFalse((self.root/'result.json').exists())

    def test_strict_json_and_machine_readable_path_rules(self):
        for value in [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}']:
            with self.assertRaises(Exception):
                strict_json(value)
        schema = strict_json(PROFILE_SCHEMA.read_bytes())
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema['$defs']['path'])
        for path in ['../a', 'x/../a', '/a', 'a/', 'a//b', 'a\\b', 'a\0b', './a', 'a\n', 'a\t', 'a\x7f']:
            self.assertFalse(validator.is_valid(path), path)
        for path in ['a', 'dir/image.dcm', 'café/ภาพ.dcm', '.hidden']:
            self.assertTrue(validator.is_valid(path), path)


if __name__ == '__main__':
    unittest.main()
