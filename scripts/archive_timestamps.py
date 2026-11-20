"""Independent ASN.1 extraction and offline OpenSSL RFC 3161 verification."""
import base64
from datetime import datetime, timezone, timedelta
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
from asn1crypto import cms, parser, tsp  # tsp registers the TSTInfo content type

OID = '1.2.840.113549.1.9.16.2.14'
MAX_CMS = 1024**2


def timestamp_parts(signature):
    if len(signature) > MAX_CMS:
        raise ValueError('CMS limit')
    framed = parser.parse(signature)
    consumed = sum(len(value) for value in framed[3:])
    if any(signature[consumed:]):
        raise ValueError('Nonzero trailing CMS data')
    value = cms.ContentInfo.load(signature[:consumed], strict=True)
    if value['content_type'].native != 'signed_data':
        raise ValueError('Expected CMS SignedData')
    signed = value['content']
    if len(signed['signer_infos']) != 1:
        raise ValueError('Expected one CMS signer')
    signer = signed['signer_infos'][0]
    attributes = [a for a in signer['unsigned_attrs'] if a['type'].dotted == OID]
    if not attributes:
        return None
    if len(attributes) != 1 or len(attributes[0]['values']) != 1:
        raise ValueError('Ambiguous timestamp')
    token = attributes[0]['values'][0]
    if token['content_type'].native != 'signed_data':
        raise ValueError('Expected timestamp SignedData')
    content = token['content']['encap_content_info']
    if content['content_type'].native != 'tst_info':
        raise ValueError('Expected TSTInfo')
    info = content['content'].parsed
    imprint = info['message_imprint']
    source = signer['signature'].native
    if imprint['hash_algorithm']['algorithm'].native != 'sha256' or imprint['hashed_message'].native != hashlib.sha256(source).digest():
        raise ValueError('Timestamp imprint mismatch')
    return token.dump(), source, info['gen_time'].native


def verify_timestamp(signature, trust_files=(), crls=(), at=None):
    def result(status, code, issued=None):
        value = {'status': status, 'code': code}
        if issued is not None:
            value['genTime'] = issued.isoformat()
        return value
    try:
        parts = timestamp_parts(signature)
        if parts is None:
            return result('UNKNOWN', 'NO_RFC3161_SIGNATURE_TIMESTAMP')
        token, source, issued = parts
        reference = at or datetime.now(timezone.utc)
        if issued > reference + timedelta(seconds=60):
            return result('FAIL', 'TIMESTAMP_IN_FUTURE')
        executable = shutil.which('openssl')
        if not executable or not trust_files:
            return result('UNKNOWN', 'NO_OPENSSL_OR_EXPLICIT_TSA_TRUST')
        with tempfile.TemporaryDirectory(prefix='dicom-timestamp-') as directory:
            root = Path(directory)
            def run(arguments):
                return subprocess.run([executable, *arguments], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=30, check=False)
            (root/'token.der').write_bytes(token)
            (root/'signature.bin').write_bytes(source)
            authorities = []
            for path in trust_files:
                if Path(path).stat().st_size > 1024**2:
                    raise ValueError('Trust limit')
                converted = run(['x509', '-in', str(path), '-outform', 'PEM'])
                if converted.returncode:
                    raise ValueError('Trust parse error')
                authorities.append(converted.stdout)
            if sum(map(len, authorities)) > 16*1024**2:
                raise ValueError('Trust total limit')
            trust = root/'trust.pem'
            trust.write_bytes(b'\n'.join(authorities))
            empty = root/'empty-ca'
            empty.mkdir()
            # ts lacks cms's -no-CAstore flag in OpenSSL 3.0. Explicitly bind
            # CAfile and CAstore to our public bundle and CApath to an empty dir.
            command = ['ts', '-verify', '-token_in', '-in', str(root/'token.der'),
                '-data', str(root/'signature.bin'), '-CAfile', str(trust),
                '-CAstore', str(trust), '-CApath', str(empty), '-auth_level', '2',
                '-attime', str(int(issued.timestamp()))]
            verified = run(command)
            if verified.returncode:
                return result('FAIL', 'OPENSSL_TIMESTAMP_SIGNATURE_OR_TRUST_INVALID')
            if not crls:
                return result('UNKNOWN', 'TSA_REVOCATION_EVIDENCE_MISSING')
            retained, total = [], 0
            for index, encoded in enumerate(crls):
                raw = base64.b64decode(encoded, validate=True)
                total += len(raw)
                if total > 16*1024**2:
                    raise ValueError('CRL total limit')
                path = root/f'crl-{index}.der'
                path.write_bytes(raw)
                converted = run(['crl', '-inform', 'DER', '-in', str(path), '-outform', 'PEM'])
                if converted.returncode:
                    raise ValueError('CRL parse error')
                retained.append(converted.stdout)
            trust.write_bytes(b'\n'.join([*authorities, *retained]))
            revoked = run([*command, '-crl_check_all'])
            if revoked.returncode:
                missing = any(code in revoked.stderr for code in
                    [b'unable to get certificate CRL', b'CRL has expired', b'CRL is not yet valid'])
                return result('UNKNOWN' if missing else 'FAIL', 'OPENSSL_TSA_REVOCATION_POLICY')
            return result('PASS', 'OPENSSL_TIMESTAMP_IMPRINT_SIGNATURE_TRUST_AND_CRLS', issued)
    except (OSError, ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError, subprocess.TimeoutExpired):
        return result('FAIL', 'INVALID_OR_UNSUPPORTED_RFC3161_EVIDENCE')
