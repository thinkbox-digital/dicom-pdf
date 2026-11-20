#!/usr/bin/env python3
"""Local independent profile verifier: pypdf, pydicom, jsonschema, defusedxml.

No creator/Java imports, network, uploads or source writes. This verifies the
declared checks, not clinical completeness, full DICOM IOD validity or authenticity.
"""
import argparse
import base64
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
from select import select
import signal
import subprocess
import sys
import tempfile
import rfc8785
from archive_openssl import verify_cms, verify_pdf
from archive_timestamps import verify_timestamp
from archive_dss import read_dss
from archive_dicom_probe import MAX_RESULT_BYTES

from defusedxml import ElementTree
from jsonschema import Draft202012Validator
from pypdf import PdfReader, overwrite_configuration
from pypdf.filters import decode_stream_data
from pypdf.generic import EncodedStreamObject

# pypdf materializes decoded attachments. Use available runtime memory as its
# allocation budget; source/PDF file length is not an eligibility criterion.
try:
    _available_memory = os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
except (ValueError, OSError, AttributeError):
    _available_memory = 2**31
MAX_FILE = max(1, _available_memory // 4)
MAX_PACKAGE = MAX_FILE
MAX_ENTRIES = 50000
NS = 'https://thinkbox.digital/ns/dicom/2.0/'
PROFILE_SCHEMA = Path(__file__).resolve().parents[1]/'docs/profile/0.3.0/manifest.schema.json'
overwrite_configuration(zlib_maximum_output_length=MAX_FILE,maximum_declared_stream_length=MAX_FILE,stream_decoding_work_maximum_length=MAX_FILE)


class ArchiveError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ArchiveError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def constant(_):
        raise ArchiveError('NONFINITE_JSON_NUMBER')
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def check(status, code, **values):
    status = {'NOT_CHECKED': 'UNKNOWN', 'PARTIAL': 'UNKNOWN', 'UNRESOLVED': 'UNKNOWN'}.get(status, status)
    return {'status': status, 'code': code, **values}


def source_inventory(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ArchiveError('SOURCE_ROOT_NOT_DIRECTORY')
    result = {}
    visited = 1
    for current, directories, files in os.walk(root, followlinks=False):
        for name in [*directories, *files]:
            visited += 1
            path = Path(current)/name
            if visited > MAX_ENTRIES or path.is_symlink():
                raise ArchiveError('UNSAFE_OR_OVERSIZED_SOURCE_TREE')
        for name in files:
            path = Path(current)/name
            if not path.is_file():
                raise ArchiveError('SOURCE_FILE_LIMIT_OR_TYPE')
            result[path.relative_to(root).as_posix()] = path
            if len(result) > 10000:
                raise ArchiveError('SOURCE_COUNT_LIMIT')
    return result


def external_validation(pdf, executable):
    if not executable:
        return check('NOT_CHECKED', 'VERAPDF_NOT_REQUESTED')
    try:
        # Bound validator logging on disk and execution time; never print its
        # file-derived messages to the caller's console/report.
        with tempfile.TemporaryFile() as output:
            process = subprocess.run([str(executable), '--format', 'json', '--flavour', '4f', str(pdf)],
                stdout=output, stderr=subprocess.DEVNULL, timeout=120, check=False)
            if output.tell() > 16*1024**2:
                return check('FAIL', 'VERAPDF_OUTPUT_LIMIT')
            output.seek(0)
            data = json.load(output)
        jobs = data.get('report', data).get('jobs', [])
        results = [v for job in jobs for v in job.get('validationResult', [])]
        valid = bool(results) and process.returncode == 0 and all(v.get('compliant') is True for v in results)
        return check('PASS' if valid else 'FAIL', 'VERAPDF_4F_RESULT', jobs=len(jobs))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return check('FAIL', 'VERAPDF_UNAVAILABLE_OR_FAILED')


PROBE_SCRIPT = Path(__file__).with_name('archive_dicom_probe.py')
PROBE_TIMEOUT = 30


@contextmanager
def probe_session(directory):
    source = directory / 'source.dcm'
    result = directory / 'result.json'
    environment = dict(os.environ, OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1',
                       MKL_NUM_THREADS='1', BLIS_NUM_THREADS='1')
    server = None

    def reply():
        if not select([server.stdout], [], [], PROBE_TIMEOUT)[0]:
            raise TimeoutError('DICOM probe deadline')
        value = server.stdout.read(1)
        if value not in (b'+', b'-'):
            raise OSError('DICOM probe exited early')
        return value == b'+'

    def stop():
        nonlocal server
        if server is None:
            return
        try:
            server.stdin.close()
            try:
                server.wait(timeout=1)
            except subprocess.TimeoutExpired:
                # A probe may still be running in the server's process group.
                try:
                    os.killpg(server.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                server.wait()
        finally:
            server.stdout.close()
            server = None

    def probe(data):
        source.write_bytes(data)
        try:
            if server is not None:
                try:
                    server.stdin.write(b'?')
                    success = reply()
                except OSError:
                    stop()
                    raise
            else:
                with result.open('xb') as output:
                    process = subprocess.run([sys.executable, str(PROBE_SCRIPT), str(source)],
                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                        env=environment, timeout=PROBE_TIMEOUT, check=False)
                    success = process.returncode == 0
            if not success or result.stat().st_size > MAX_RESULT_BYTES:
                raise ArchiveError('DICOM_PROBE_FAILED')
            return strict_json(result.read_bytes())
        except (ValueError, OSError, subprocess.TimeoutExpired, ArchiveError):
            return {'status': 'UNREADABLE', 'fields': {}, 'references': [], 'digitalSignaturesPresent': None}
        finally:
            source.unlink(missing_ok=True)
            result.unlink(missing_ok=True)

    try:
        if sys.platform == 'linux':
            try:
                server = subprocess.Popen([sys.executable, str(PROBE_SCRIPT), '--serve', str(directory)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env=environment, start_new_session=True, bufsize=0)
                if not reply():
                    stop()
            except OSError:
                stop()
        yield probe
    finally:
        stop()


def attachment_bytes(reader, embedded):
    # pypdf 7's EmbeddedFile.content uses get_data(), which permanently caches
    # the decoded data in each encoded stream. Reuse its filter implementation
    # directly and release this one resolved stream when the caller has its bytes.
    stream = embedded._embedded_file
    try:
        return decode_stream_data(stream) if isinstance(stream, EncodedStreamObject) else stream.get_data()
    finally:
        reference = getattr(stream, 'indirect_reference', None)
        if reference is not None:
            key = (reference.generation, reference.idnum)
            if reader.resolved_objects.get(key) is stream:
                del reader.resolved_objects[key]


def digest_file(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):value.update(block)
    return value.hexdigest()


def check_signed_inventory(encoding, images, provenance):
    if encoding != 'RFC8785_JCS':
        raise ArchiveError('SIGNED_MANIFEST_NOT_CANONICAL')
    receipt = strict_json(provenance)
    events = receipt.get('events', []) if isinstance(receipt, dict) else []
    first = events[0] if isinstance(events, list) and events and isinstance(events[0], dict) else {}
    captured = [{key: image[key] for key in ('attachment', 'sourcePath', 'size', 'sha256')} for image in images]
    receipt_matches = (first.get('event') == 'INGESTION'
        and type(first.get('fileCount')) is int and first['fileCount'] == len(images)
        and first.get('inputInventorySha256') == digest(rfc8785.dumps(captured)))
    return check('PASS' if receipt_matches else 'FAIL', 'SIGNED_CAPTURED_INVENTORY_COMPARISON')


def verify(pdf, sources=None, verapdf=None, trust_files=()):
    pdf = Path(pdf)
    report = {'schemaVersion': 1, 'implementation': 'independent-python-1',
        'profile': 'dicom-images', 'profileVersion': '0.3.0', 'checks': {},
        'claims': {'clinicalCompleteness': 'UNKNOWN', 'fullDicomIodConformance': 'UNKNOWN',
                   'issuerIdentity': 'UNKNOWN', 'fullMetadataSemanticAgreement': 'UNKNOWN', 'acquisitionAuthentication': 'UNKNOWN'}}
    checks = report['checks']
    checks['provenance'] = check('NOT_CHECKED', 'NO_AUTHENTICATED_ISSUER_EVIDENCE_IMPLEMENTED')
    reader = None
    try:
        pdf = pdf.resolve(strict=True)
        report['pdfSha256'] = digest_file(pdf)
        reader = PdfReader(pdf, strict=True)
        if reader.is_encrypted:
            raise ArchiveError('ENCRYPTED_PDF_NOT_PROFILE_CONFORMING')
        attachments = {}
        for embedded in reader.attachment_list:
            name = embedded.name
            if name in attachments:
                raise ArchiveError('DUPLICATE_ATTACHMENT_NAME')
            if len(attachments) >= MAX_ENTRIES:
                raise ArchiveError('PACKAGE_LIMIT')
            attachments[name] = embedded

        total = 0
        retained = {}
        def read_attachment(name, *, keep=False):
            nonlocal total
            if name in retained:
                return retained[name]
            data = attachment_bytes(reader, attachments[name])
            if len(data) > MAX_FILE:
                raise ArchiveError('ATTACHMENT_SIZE_LIMIT')
            total += len(data)
            if total > MAX_PACKAGE:
                raise ArchiveError('PACKAGE_LIMIT')
            if keep:
                retained[name] = data
            return data

        if 'manifest.json' not in attachments or 'manifest.sha256' not in attachments:
            raise ArchiveError('MANIFEST_OR_CHECKSUM_MISSING')
        manifest_bytes = read_attachment('manifest.json', keep=True)
        manifest = strict_json(manifest_bytes)
        try:
            report['manifestEncoding'] = 'RFC8785_JCS' if rfc8785.dumps(manifest) == manifest_bytes else 'LEGACY_JSON_BYTES'
        except rfc8785.CanonicalizationError:
            report['manifestEncoding'] = 'LEGACY_JSON_BYTES'
        c2pa = manifest.get('profileVersion') == '0.4.0'
        schema_path = PROFILE_SCHEMA.parent.parent/'0.4.0/manifest.schema.json' if c2pa else PROFILE_SCHEMA
        schema = strict_json(schema_path.read_bytes())
        report['profileVersion'] = manifest.get('profileVersion')
        Draft202012Validator.check_schema(schema)
        errors = list(islice(Draft202012Validator(schema).iter_errors(manifest), 101))
        if errors:
            checks['manifestSchema'] = check('FAIL', 'MANIFEST_SCHEMA_VIOLATION', count=len(errors))
            raise ArchiveError('MANIFEST_SCHEMA_VIOLATION')
        checks['manifestSchema'] = check('PASS', 'LOCAL_PROFILE_SCHEMA')
        expected = (digest(manifest_bytes)+'  manifest.json\n').encode('ascii')
        if read_attachment('manifest.sha256', keep=True) != expected:
            raise ArchiveError('MANIFEST_CHECKSUM_MISMATCH')
        images = manifest['images']
        names = [i['attachment'] for i in images]
        paths = [i['sourcePath'] for i in images]
        pages = [i['referencePage'] for i in images]
        if len(set(names)) != len(names) or len(set(paths)) != len(paths) or len(set(pages)) != len(pages):
            raise ArchiveError('DUPLICATE_SOURCE_MAPPING')
        if any(page > len(reader.pages) for page in pages):
            raise ArchiveError('REFERENCE_PAGE_OUT_OF_RANGE')
        artifacts = manifest['artifactSha256']
        declared = set(names) | set(artifacts) | {'manifest.json', 'manifest.sha256'}
        if c2pa:
            policy = {'attachment': 'content-credentials.c2pa', 'schemaVersion': 1, 'scope': 'ARCHIVE_EXPORT', 'specification': '2.2'}
            if ('c2pa-policy.json' not in attachments or 'content-credentials.c2pa' not in attachments
                    or strict_json(read_attachment('c2pa-policy.json', keep=True)) != policy
                    or str(attachments['content-credentials.c2pa'].associated_file_relationship) != '/C2PA_Manifest'):
                raise ArchiveError('INVALID_C2PA_DECLARATION')
            declared.add('content-credentials.c2pa')
            checks['c2pa'] = check('UNKNOWN', 'C2PA_ATTACHED_USE_C2PATOOL_FOR_CRYPTOGRAPHIC_VALIDATION')
        security = manifest.get('security')
        if security:
            if security.get('schemaVersion') != 1 or security.get('manifestSignature') != 'manifest.p7s' or security.get('canonicalization') != 'RFC8785':
                raise ArchiveError('UNSUPPORTED_SECURITY_DECLARATION')
            declared.add('manifest.p7s')
        if set(names) & set(artifacts) or set(attachments) != declared:
            raise ArchiveError('ATTACHMENT_INVENTORY_MISMATCH')
        consumed = {'manifest.json', 'manifest.sha256'} | set(names)
        required = {'dicom-metadata.json'} if manifest.get('metadataXmpVersion') == 1 else set()
        if security:
            required.update({'manifest.p7s', 'provenance.json', 'revocation.json'})
        for name, expected_hash in artifacts.items():
            if digest(read_attachment(name, keep=name in required)) != expected_hash:
                raise ArchiveError('ARTIFACT_BYTES_MISMATCH')
        consumed.update(artifacts)
        for name in declared - consumed:
            read_attachment(name, keep=name in required)

        parsed, identity_mismatches = {}, 0
        with tempfile.TemporaryDirectory(prefix='dicom-independent-') as directory, probe_session(Path(directory)) as probe:
            for image in images:
                name = image['attachment']
                data = read_attachment(name)
                if len(data) != image['size'] or digest(data) != image['sha256']:
                    raise ArchiveError('ORIGINAL_BYTES_MISMATCH')
                if str(attachments[name].associated_file_relationship) != '/Source':
                    raise ArchiveError('ORIGINAL_ASSOCIATION_MISMATCH')
                parsed[name] = evidence = probe(data)
                del data
                if evidence['status'] == 'PARSED':
                    covered = ['SOPClassUID', 'SOPInstanceUID', 'StudyInstanceUID', 'SeriesInstanceUID',
                               'Rows', 'Columns', 'NumberOfFrames', 'TransferSyntaxUID']
                    for key in covered:
                        if key in image['fields'] and str(image['fields'][key]) != evidence['fields'].get(key):
                            identity_mismatches += 1
                    if image['sopInstanceUID'] != evidence['fields'].get('SOPInstanceUID'):
                        identity_mismatches += 1
        checks['preservationIntegrity'] = check('PASS', 'ALL_DECLARED_ATTACHMENTS_MATCH', originals=len(images), artifacts=len(artifacts))
        if security:
            checks['capturedInventory'] = check_signed_inventory(
                report['manifestEncoding'], images, retained['provenance.json'])
            crls = strict_json(retained['revocation.json']).get('crls', []) if 'revocation.json' in attachments else []
            try:
                dss = read_dss(reader)
            except (ValueError, TypeError, KeyError):
                checks['pdf.validationStore'] = check('FAIL', 'MALFORMED_OR_UNSUPPORTED_PDF_DSS')
                raise ArchiveError('MALFORMED_OR_UNSUPPORTED_PDF_DSS')
            if dss is not None:
                checks['pdf.validationStore'] = check('PASS', 'BOUNDED_DER_DSS_PARSED_NOT_A_TRUST_ANCHOR',
                    certificates=len(dss['/Certs']), crls=len(dss['/CRLs']), ocsps=len(dss['/OCSPs']))
                crls = list(dict.fromkeys([*crls, *(base64.b64encode(item).decode('ascii') for item in dss['/CRLs'])]))
                if dss['/OCSPs']:
                    checks['pdf.ocspPolicy'] = check('UNKNOWN', 'INDEPENDENT_OCSP_POLICY_NOT_IMPLEMENTED')
            else:
                checks['pdf.validationStore'] = check('NOT_APPLICABLE', 'NO_STANDARD_PDF_DSS_PRESENT')
            expected_issuer = security.get('issuerCertificateSha256')
            for name, result in verify_cms(manifest_bytes, retained['manifest.p7s'], trust_files, crls, expected_issuer).items():
                checks['manifest.'+name] = result
            for name, result in verify_pdf(reader, pdf, trust_files, crls, expected_issuer).items():
                checks['pdf.'+name] = result
            checks['manifest.timestamp'] = verify_timestamp(retained['manifest.p7s'], trust_files, crls)
            fields = [field for field in (reader.get_fields() or {}).values() if field.get('/FT') == '/Sig'
                      and field['/V'].get_object().get('/SubFilter') != '/ETSI.RFC3161']
            if len(fields) == 1:
                checks['pdf.timestamp'] = verify_timestamp(fields[0]['/V'].get_object()['/Contents'].original_bytes, trust_files, crls)
            else:
                checks['pdf.timestamp'] = check('FAIL', 'EXPECTED_ONE_PDF_SIGNATURE')
            time_states = [checks[key]['status'] for key in ['manifest.timestamp', 'pdf.timestamp']]
            timestamp_status = 'FAIL' if 'FAIL' in time_states else 'PASS' if all(s == 'PASS' for s in time_states) else 'UNKNOWN'
            checks['trustedTimestamps'] = check(timestamp_status, 'SEPARATE_MANIFEST_AND_PDF_TIMESTAMP_RESULTS')
            if security.get('protection') == 'PADES_B_LTA':
                checks['requestedProtection'] = check('UNKNOWN', 'PADES_REVISION_CHAIN_NOT_IMPLEMENTED_USE_EU_DSS')
            elif security.get('protection') not in ('CMS_AND_PDF', 'CMS_AND_PDF_TIMESTAMPED'):
                checks['requestedProtection'] = check('FAIL', 'PROTECTION_LEVEL_NOT_IMPLEMENTED')
            elif security.get('protection') == 'CMS_AND_PDF_TIMESTAMPED':
                missing_timestamp = any(checks[key]['code'] == 'NO_RFC3161_SIGNATURE_TIMESTAMP' for key in ['manifest.timestamp', 'pdf.timestamp'])
                checks['requestedProtection'] = check('FAIL' if missing_timestamp else timestamp_status, 'BOTH_SIGNATURE_TIMESTAMPS_REQUIRED')
            authenticated = all(checks.get(key, {}).get('status') == 'PASS' for key in
                ['capturedInventory', 'preservationIntegrity', 'manifest.signature', 'manifest.keyPolicy', 'manifest.certificateTrust', 'manifest.revocation',
                 'pdf.signature', 'pdf.keyPolicy', 'pdf.coverage', 'pdf.certificateTrust', 'pdf.revocation'])
            report['assurance'] = 'EXPORT_AUTHENTICATED' if authenticated else 'INTEGRITY_ONLY'
            if authenticated:
                report['claims']['issuerIdentity'] = 'PASS'
                checks['provenance'] = check('PASS', 'SIGNED_EXPORT_WITH_EXPLICIT_TRUST_AND_VALID_REVOCATION_EVIDENCE')
        metadata = reader.trailer['/Root'].get('/Metadata')
        if metadata is None:
            raise ArchiveError('XMP_MISSING')
        packet = metadata.get_object().get_data()
        if len(packet) > MAX_FILE:
            raise ArchiveError('XMP_LIMIT')
        xml = ElementTree.fromstring(packet, forbid_dtd=True)
        def property_text(key):
            nodes = xml.findall('.//{'+NS+'}'+key)
            if len(nodes) != 1:
                raise ArchiveError('XMP_PROPERTY_CARDINALITY')
            return nodes[0].text or ''
        for key in ['schemaVersion', 'profile', 'profileVersion', 'sourceRole']:
            if property_text(key) != str(manifest[key]):
                raise ArchiveError('XMP_PROFILE_MISMATCH')
        if property_text('inventoryJson') != manifest_bytes.decode('utf-8'):
            raise ArchiveError('XMP_MANIFEST_MISMATCH')
        if manifest.get('metadataXmpVersion') == 1:
            metadata_bytes = retained['dicom-metadata.json']
            if property_text('metadataVersion') != '1' or property_text('metadataJson') != metadata_bytes.decode('utf-8') or property_text('metadataSha256') != artifacts['dicom-metadata.json']:
                raise ArchiveError('FULL_XMP_METADATA_MISMATCH')
        checks['xmpConsistency'] = check('PASS', 'EXACT_ATTACHMENT_TEXT_AND_HASHES')
        if sources is None:
            checks['inputReconciliation'] = check('NOT_CHECKED', 'EXTERNAL_INPUTS_NOT_SUPPLIED')
        else:
            inventory = source_inventory(sources)
            matches = set(inventory) == set(paths)
            for image in images:
                path = inventory.get(image['sourcePath'])
                if path is None or path.stat().st_size != image['size'] or digest_file(path) != image['sha256']:
                    matches = False
            checks['inputReconciliation'] = check('PASS' if matches else 'FAIL', 'EXTERNAL_SUPPLIED_SET_COMPARISON', supplied=len(inventory))
        unreadable = sum(p['status'] != 'PARSED' for p in parsed.values())
        report['sourceEvidence'] = [{'attachment': name, 'readability': evidence['status'],
            'digitalSignaturesPresent': evidence['digitalSignaturesPresent'],
            'nativePixelStructure':evidence.get('nativePixelStructure',{'status':'UNKNOWN','code':'SOURCE_UNREADABLE'})} for name, evidence in parsed.items()]
        checks['dicomReadability'] = check('PARTIAL' if unreadable else 'PASS', 'PYDICOM_REPARSE_NOT_IOD_VALIDATION', parsed=len(images)-unreadable, unreadable=unreadable)
        native=[value.get('nativePixelStructure',{'status':'UNKNOWN'}) for value in parsed.values()]
        checks['nativePixelStructure']=check('FAIL' if any(item['status']=='FAIL' for item in native) else 'UNKNOWN' if any(item['status']=='UNKNOWN' for item in native) else 'PASS' if any(item['status']=='PASS' for item in native) else 'NOT_APPLICABLE',
            'PYDICOM_NATIVE_LENGTH_AND_HEADER_SUBSET_NOT_FULL_IOD',assessed=sum(item['status'] in ('PASS','FAIL') for item in native))
        checks['identityMetadata'] = check('FAIL' if identity_mismatches else 'PARTIAL' if unreadable else 'PASS',
            'SUPPLIED_IDENTITY_AND_DIMENSIONS_ONLY', mismatches=identity_mismatches)
        by_uid = defaultdict(list)
        for image in images:
            evidence = parsed[image['attachment']]
            uid = evidence['fields'].get('SOPInstanceUID')
            if uid:
                by_uid[uid].append(image['attachment'])
        duplicates = {uid: names for uid, names in by_uid.items() if len(names) > 1}
        readable = {name for name, evidence in parsed.items() if evidence['status'] == 'PARSED'}
        declared_duplicates = manifest['duplicateInstanceUIDs']
        for uid, known_names in duplicates.items():
            if set(known_names) != (set(declared_duplicates.get(uid, [])) & readable):
                raise ArchiveError('DUPLICATE_UID_INVENTORY_MISMATCH')
        for uid, declared_names in declared_duplicates.items():
            if (not set(declared_names) <= parsed.keys()
                    or set(declared_names) & readable != set(by_uid.get(uid, []))):
                raise ArchiveError('DUPLICATE_UID_INVENTORY_MISMATCH')
        def ref_key(source, ref):
            return (source, ref['sopInstanceUID'], ref.get('sopClassUID'), tuple(ref.get('frames', [])))
        observed = Counter(ref_key(name, ref) for name, evidence in parsed.items() for ref in evidence['references'])
        declared_refs = Counter(ref_key(ref['sourceAttachment'], ref) for ref in manifest['references']
                                if ref['status'] != 'unassessed' and ref['sourceAttachment'] in readable)
        unresolved, reference_errors = 0, 0
        for ref in manifest['references']:
            targets = by_uid.get(ref['sopInstanceUID'], [])
            if ref['status'] == 'unassessed':
                unresolved += 1
                continue
            status = 'missing' if not targets else 'ambiguous' if len(targets) > 1 else 'resolved'
            if status == 'resolved':
                fields = parsed[targets[0]]['fields']
                if ref.get('sopClassUID') and fields.get('SOPClassUID') != ref['sopClassUID']:
                    status = 'class-mismatch'
                elif any(f < 1 or f > int(fields.get('NumberOfFrames', 1)) for f in ref['frames']):
                    status = 'invalid-frame'
            unresolved += status != 'resolved'
            declared_targets = set(ref['resolvedAttachments'])
            if (ref['sourceAttachment'] not in parsed or not declared_targets <= parsed.keys()
                    or declared_targets & readable != set(targets)):
                reference_errors += 1
            # With unreadable candidates we can still prove ambiguity among two known
            # targets. A declaration that lists only readable candidates is fully checkable.
            if (len(targets) > 1 or declared_targets <= readable) and status != ref['status']:
                reference_errors += 1
        if observed != declared_refs:
            reference_errors += 1
        checks['explicitSopReferences'] = check('FAIL' if reference_errors else 'PARTIAL' if unreadable else 'UNRESOLVED' if unresolved else 'PASS',
            'EXPLICIT_UID_CLASS_FRAME_COUNTS_ONLY', unresolved=unresolved, mismatches=reference_errors)
        checks['dicomIodConformance'] = check('NOT_CHECKED', 'READABILITY_IS_NOT_IOD_VALIDATION')
        checks['pdfa4f'] = external_validation(pdf, verapdf)
    except Exception as error:
        code = str(error) if isinstance(error, ArchiveError) else 'UNREADABLE_OR_UNSAFE_PACKAGE'
        checks['packageRead'] = check('FAIL', code)
    finally:
        if reader is not None:
            reader.close()
    statuses = [item['status'] for item in checks.values()]
    report['exitCode'] = 1 if 'FAIL' in statuses else 2 if 'UNKNOWN' in statuses else 0
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--sources', type=Path)
    parser.add_argument('--verapdf', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--trust', type=Path, action='append', default=[], help='Explicit local issuer trust certificate (PEM)')
    args = parser.parse_args()
    # Validate every output path before reading untrusted content. Never replace
    # input files, supplied sources or put a non-PDF report in the out/ directory.
    if args.output:
        output = args.output.resolve()
        if output == args.pdf.resolve() or (args.sources and output.is_relative_to(args.sources.resolve())) or 'out' in output.relative_to(Path.cwd().anchor).parts:
            parser.error('Report destination must be outside inputs and converted-PDF directories.')
        if output.exists():
            parser.error('Report destination already exists; choose a new path.')
    result = verify(args.pdf, args.sources, args.verapdf, args.trust)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x', encoding='utf-8') as destination:
            json.dump(result, destination, indent=2, sort_keys=True)
            destination.write('\n')
    for name, item in result['checks'].items():
        print(f"{name}: {item['status']} ({item['code']})")
    print(f"Clinical completeness: UNKNOWN; acquisition authentication: UNKNOWN; issuer identity: {result['claims']['issuerIdentity']}")
    return result['exitCode']


if __name__ == '__main__':
    raise SystemExit(main())
