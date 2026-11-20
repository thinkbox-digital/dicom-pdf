"""Independent, offline OpenSSL CMS verification; never consumes private keys."""
import base64
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def outcome(status, code):
    return {'status': status, 'code': code}


def verify_cms(content, signature, trust_files=(), crls=(), expected_certificate=None, at=None):
    executable = shutil.which('openssl')
    if not executable:
        return {'signature': outcome('UNKNOWN', 'OPENSSL_UNAVAILABLE')}
    with tempfile.TemporaryDirectory(prefix='dicom-openssl-') as temporary:
        root = Path(temporary)
        data, cms, authorities = root/'content.bin', root/'signature.der', root/'trust.pem'
        if len(signature) > 1024**2:
            return {'signature': outcome('FAIL', 'CMS_SIZE_LIMIT')}
        with data.open('wb') as output:
            if isinstance(content, bytes):
                output.write(content)
            else:
                for chunk in content:
                    output.write(chunk)
        cms.write_bytes(signature)
        signer_certificate = root/'signer.pem'
        command = [executable, 'cms', '-verify', '-binary', '-inform', 'DER', '-in', str(cms),
                   '-content', str(data), '-out', os.devnull, '-signer', str(signer_certificate)]
        def run(arguments):
            return subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=30, check=False)
        try:
            valid = run([*command, '-noverify'])
            if valid.returncode:
                return {'signature': outcome('FAIL', 'OPENSSL_CMS_SIGNATURE_INVALID')}
            if expected_certificate:
                actual = run([executable, 'x509', '-in', str(signer_certificate), '-outform', 'DER'])
                if actual.returncode or hashlib.sha256(actual.stdout).hexdigest() != expected_certificate:
                    return {'signature': outcome('FAIL', 'OPENSSL_SIGNER_CERTIFICATE_BINDING_MISMATCH')}
            result = {'signature': outcome('PASS', 'OPENSSL_VERIFIED_EXTRACTED_CONTENT'),
                      'certificateTrust': outcome('UNKNOWN', 'NO_EXPLICIT_TRUST_ANCHORS'),
                      'revocation': outcome('UNKNOWN', 'NO_VERIFIED_REVOCATION_EVIDENCE')}
            if not trust_files:
                return result
            public_certificates = []
            for path in trust_files:
                if Path(path).stat().st_size > 1024**2:
                    raise ValueError('Trust material size limit')
                cert = run([executable, 'x509', '-in', str(path), '-outform', 'PEM'])
                if cert.returncode:
                    raise ValueError('Trust certificate parse failure')
                public_certificates.append(cert.stdout)
            authorities.write_bytes(b'\n'.join(public_certificates))
            trust = ['-CAfile', str(authorities), '-no-CApath', '-no-CAstore', '-purpose', 'any']
            if at is not None:
                trust += ['-attime', str(int(at.timestamp()))]
            chain = run([*command, *trust])
            result['certificateTrust'] = outcome('PASS' if not chain.returncode else 'FAIL', 'OPENSSL_EXPLICIT_TRUST_PATH')
            if chain.returncode or not crls:
                return result
            evidence = []
            for index, encoded in enumerate(crls):
                raw = base64.b64decode(encoded, validate=True)
                if len(raw) > 16*1024**2:
                    raise ValueError('CRL size limit')
                source = root/f'crl-{index}.der'
                source.write_bytes(raw)
                crl = run([executable, 'crl', '-inform', 'DER', '-in', str(source), '-outform', 'PEM'])
                if crl.returncode:
                    raise ValueError('CRL parse failure')
                evidence.append(crl.stdout)
            authorities.write_bytes(b'\n'.join([*public_certificates, *evidence]))
            revoked = run([*command, *trust, '-crl_check_all'])
            unknown = any(code in revoked.stderr for code in [b'unable to get certificate CRL', b'CRL has expired', b'CRL is not yet valid'])
            result['revocation'] = outcome('PASS' if not revoked.returncode else 'UNKNOWN' if unknown else 'FAIL', 'OPENSSL_OFFLINE_CRL_POLICY')
            return result
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return {'signature': outcome('FAIL', 'OPENSSL_VERIFICATION_FAILED')}


def verify_pdf(reader, pdf, trust_files=(), crls=(), expected_certificate=None):
    try:
        signatures = [field for field in (reader.get_fields() or {}).values() if field.get('/FT') == '/Sig']
        timestamps = [field for field in signatures if field['/V'].get_object().get('/SubFilter') == '/ETSI.RFC3161']
        signatures = [field for field in signatures if field not in timestamps]
        if len(signatures) != 1:
            return {'coverage': outcome('FAIL', 'EXPECTED_ONE_PDF_SIGNATURE')}
        signature = signatures[0]['/V'].get_object()
        ranges = signature['/ByteRange']
        size = Path(pdf).stat().st_size
        if len(ranges) != 4 or any(type(n).__name__ != 'NumberObject' for n in ranges):
            raise ValueError('Integer byte ranges required')
        a, b, c, d = map(int, ranges)
        if a != 0 or b <= 0 or c <= b or d < 0 or c+d > size or not timestamps and c+d != size or c-b > 2*1024**2+2:
            raise ValueError('Incomplete PDF coverage')
        with Path(pdf).open('rb') as source:
            source.seek(b)
            gap = source.read(c-b)
        contents = signature['/Contents'].original_bytes
        if gap[:1] != b'<' or gap[-1:] != b'>' or bytes.fromhex(gap[1:-1].decode('ascii')) != contents:
            raise ValueError('Contents binding mismatch')
        def chunks():
            with Path(pdf).open('rb') as source:
                for offset, length in [(a, b), (c, d)]:
                    source.seek(offset)
                    while length:
                        chunk = source.read(min(length, 1024**2))
                        if not chunk:
                            raise ValueError('Truncated PDF')
                        length -= len(chunk)
                        yield chunk
        result = verify_cms(chunks(), contents, trust_files, crls, expected_certificate)
        result['coverage'] = outcome('UNKNOWN', 'PADES_REVISION_CHAIN_NOT_IMPLEMENTED_USE_EU_DSS') if timestamps else outcome('PASS', 'COMPLETE_PDF_EXCEPT_SIGNATURE_VALUE')
        return result
    except (KeyError, TypeError, ValueError, OSError):
        return {'coverage': outcome('FAIL', 'INVALID_OR_UNSUPPORTED_PDF_SIGNATURE')}
