#!/usr/bin/env python3
"""Independent offline verification of external evidence; no Java or creator imports."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import rfc8785
from jsonschema import Draft202012Validator
from archive_validator import strict_json
from archive_openssl import verify_cms
from archive_timestamps import verify_timestamp

LIMIT = 16*1024**2
SCHEMA = Path(__file__).resolve().parents[1]/'docs/profile/0.3.0/external-evidence.schema.json'


def verify(pdf, evidence, trust_files=(), at=None):
    checks = {'acquisitionProvenance': {'status': 'UNKNOWN', 'code': 'NO_ACQUISITION_CLAIM'},
              'clinicalCompleteness': {'status': 'UNKNOWN', 'code': 'CLINICAL_COMPLETENESS_NOT_ASSESSED'}}
    report = {'schemaVersion': 1, 'implementation': 'independent-python-evidence-1',
              'assurance': 'INTEGRITY_ONLY', 'checks': checks}
    try:
        pdf, evidence = Path(pdf), Path(evidence)
        if evidence.stat().st_size > LIMIT or pdf.stat().st_size > 384*1024**2:
            raise ValueError('Resource limit')
        with evidence.open('rb') as source:
            raw = source.read(LIMIT+1)
        if len(raw) > LIMIT:
            raise ValueError('Evidence limit')
        envelope = strict_json(raw)
        if rfc8785.dumps(envelope) != raw:
            raise ValueError('Noncanonical evidence')
        Draft202012Validator(strict_json(SCHEMA.read_bytes())).validate(envelope)
        digest, length = hashlib.sha256(), 0
        with pdf.open('rb') as source:
            for block in iter(lambda: source.read(1024**2), b''):
                length += len(block)
                if length > 384*1024**2:
                    raise ValueError('PDF limit')
                digest.update(block)
        pdf_hash, previous, previous_time = digest.hexdigest(), None, None
        for index, entry in enumerate(envelope['entries']):
            prefix = f'entry.{index+1}.'
            binding = entry['binding']
            observation = datetime.fromisoformat(binding['observedAt'].replace('Z', '+00:00'))
            if observation.tzinfo is None:
                raise ValueError('Observation requires a timezone')
            if binding['pdfSha256'] != pdf_hash or binding['pdfSize'] != length or binding['previousEntrySha256'] != previous:
                raise ValueError('PDF or predecessor mismatch')
            checks[prefix+'binding'] = {'status': 'PASS', 'code': 'UNCHANGED_PDF_AND_PREDECESSOR_HASH_MATCH'}
            cms = base64.b64decode(entry['cms'], validate=True)
            if len(cms) > 1024**2:
                raise ValueError('CMS limit')
            timestamp = verify_timestamp(cms, trust_files, binding['crls'], at)
            checks[prefix+'timestamp'] = timestamp
            if timestamp['status'] != 'PASS':
                if timestamp['code'] == 'NO_RFC3161_SIGNATURE_TIMESTAMP':
                    checks[prefix+'timestamp'] = {'status': 'FAIL', 'code': 'REQUIRED_TIMESTAMP_MISSING'}
                break
            issued = datetime.fromisoformat(timestamp['genTime'])
            if previous_time is not None and issued < previous_time:
                raise ValueError('Timestamp order mismatch')
            signed = verify_cms(rfc8785.dumps(binding), cms, trust_files, binding['crls'], binding['issuerCertificateSha256'], issued)
            for name, result in signed.items():
                checks[prefix+name] = result
            if any(signed.get(name, {}).get('status') != 'PASS' for name in ['signature', 'certificateTrust', 'revocation']):
                break
            previous, previous_time = hashlib.sha256(rfc8785.dumps(entry)).hexdigest(), issued
        else:
            report['assurance'] = 'TIMESTAMPED_ARCHIVE_EVIDENCE'
            checks['evidenceChain'] = {'status': 'PASS', 'code': 'INDEPENDENT_OPENSSL_CHAIN_VERIFIED'}
        if 'evidenceChain' not in checks:
            failed = any(value['status'] == 'FAIL' for value in checks.values())
            checks['evidenceChain'] = {'status': 'FAIL' if failed else 'UNKNOWN', 'code': 'EVIDENCE_CHAIN_NOT_ESTABLISHED'}
    except Exception:
        # Never emit file-derived ASN.1/JSON/parser text or patient values.
        checks['evidenceChain'] = {'status': 'FAIL', 'code': 'MISSING_INVALID_OR_UNSUPPORTED_EVIDENCE_CHAIN'}
    statuses = [value['status'] for value in checks.values()]
    report['exitCode'] = 1 if 'FAIL' in statuses else 2 if 'UNKNOWN' in statuses else 0
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--trust', action='append', default=[], type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.output:
        output = args.output.resolve()
        if output in [args.pdf.resolve(), args.evidence.resolve()] or 'out' in output.parts or output.exists():
            parser.error('Choose a new report path outside inputs and converted-PDF directories.')
    report = verify(args.pdf, args.evidence, args.trust)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x', encoding='utf-8') as destination:
            json.dump(report, destination, indent=2, sort_keys=True)
            destination.write('\n')
    for name, value in report['checks'].items():
        print(f"{name}: {value['status']} ({value['code']})")
    return report['exitCode']


if __name__ == '__main__':
    raise SystemExit(main())
