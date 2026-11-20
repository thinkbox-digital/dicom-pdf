"""Synthetic OpenSSL-issued timestamps and external evidence, independent of Java."""
import base64
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import rfc8785
from asn1crypto import cms
from archive_timestamps import OID, verify_timestamp
from archive_evidence_validator import verify as verify_evidence


@unittest.skipUnless(shutil.which('openssl'), 'Local OpenSSL required')
class IndependentTimestampTests(unittest.TestCase):
    @classmethod
    def command(cls, *arguments):
        return subprocess.run(['openssl', *map(str, arguments)], cwd=cls.root,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30).stdout

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='dicom-independent-ts-')
        cls.root = Path(cls.temporary.name)
        (cls.root/'newcerts').mkdir()
        (cls.root/'index').write_text('')
        (cls.root/'serial').write_text('1000\n')
        (cls.root/'crlnumber').write_text('1000\n')
        (cls.root/'tsa.serial').write_text('1000\n')
        (cls.root/'ca.cnf').write_text('''[ca]
default_ca=main
[main]
database=index
new_certs_dir=newcerts
certificate=root.pem
private_key=root.key
serial=serial
crlnumber=crlnumber
default_md=sha256
default_days=1
default_crl_days=1
policy=names
[names]
commonName=supplied
[tsa_ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
[export_ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,nonRepudiation
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
''')
        (cls.root/'tsa.cnf').write_text('''[tsa]
default_tsa=service
[service]
serial=tsa.serial
signer_cert=tsa.pem
certs=root.pem
signer_key=tsa.key
signer_digest=sha256
default_policy=1.2.3.4.5
digests=sha256
accuracy=secs:1
ordering=yes
tsa_name=yes
ess_cert_id_chain=yes
ess_cert_id_alg=sha256
''')
        cls.command('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
            '-subj', '/CN=Synthetic Timestamp Root', '-addext', 'basicConstraints=critical,CA:true',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'root.key', '-out', 'root.pem')
        for name, extension in [('tsa', 'tsa_ext'), ('export', 'export_ext')]:
            cls.command('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Synthetic '+name,
                        '-keyout', name+'.key', '-out', name+'.csr')
            cls.command('ca', '-batch', '-config', 'ca.cnf', '-extensions', extension,
                        '-in', name+'.csr', '-out', name+'.pem', '-notext')
        cls.command('ca', '-config', 'ca.cnf', '-gencrl', '-out', 'current.crl.pem')
        cls.crl = cls.command('crl', '-in', 'current.crl.pem', '-outform', 'DER')
        cls.trust = [cls.root/'root.pem']
        cls.crls = [base64.b64encode(cls.crl).decode('ascii')]
        cls.fingerprint = hashlib.sha256(cls.command('x509', '-in', 'export.pem', '-outform', 'DER')).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def signed(cls, content, defect=None):
        (cls.root/'content.bin').write_bytes(content)
        cls.command('cms', '-sign', '-binary', '-cades', '-in', 'content.bin', '-signer', 'export.pem',
                    '-inkey', 'export.key', '-certfile', 'root.pem', '-outform', 'DER', '-out', 'cms.der')
        value = cms.ContentInfo.load((cls.root/'cms.der').read_bytes())
        signer = value['content']['signer_infos'][0]
        imprint = hashlib.sha256(signer['signature'].native).hexdigest() if defect != 'imprint' else '00'*32
        cls.command('ts', '-query', '-digest', imprint, '-sha256', '-cert', '-out', 'request.tsq')
        cls.command('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'request.tsq', '-token_out', '-out', 'token.der')
        token = cms.ContentInfo.load((cls.root/'token.der').read_bytes())
        if defect == 'signature':
            token_signer = token['content']['signer_infos'][0]
            signature = bytearray(token_signer['signature'].native)
            signature[0] ^= 1
            token_signer['signature'] = bytes(signature)
        attribute = cms.CMSAttribute({'type': OID, 'values': [token]})
        signer['unsigned_attrs'] = cms.CMSAttributes([attribute, attribute] if defect == 'duplicate' else [attribute])
        return value.dump()

    def test_valid_timestamp_is_independent_and_trust_is_explicit(self):
        signed = self.signed(b'Synthetic detached content')
        self.assertEqual('PASS', verify_timestamp(signed, self.trust, self.crls)['status'])
        self.assertEqual('UNKNOWN', verify_timestamp(signed)['status'])
        self.assertEqual('UNKNOWN', verify_timestamp(signed, self.trust)['status'])

    def test_invalid_imprint_signature_duplicate_and_future_reference_fail(self):
        for defect in ['imprint', 'signature', 'duplicate']:
            with self.subTest(defect=defect):
                self.assertEqual('FAIL', verify_timestamp(self.signed(b'Synthetic content', defect), self.trust, self.crls)['status'])
        signed = self.signed(b'Synthetic content')
        self.assertEqual('FAIL', verify_timestamp(signed, self.trust, self.crls, datetime(2000, 1, 1, tzinfo=timezone.utc))['status'])

    def test_external_chain_detects_changed_pdf_binding_and_removed_predecessor(self):
        pdf = self.root/'synthetic-binding.pdf'
        pdf.write_bytes(b'Synthetic binding fixture; no PDF/A validity claim')
        entries, previous = [], None
        for _ in range(2):
            binding = {'schemaVersion': 1, 'purpose': 'DICOM_PDF_EXTERNAL_EVIDENCE',
                'pdfSha256': hashlib.sha256(pdf.read_bytes()).hexdigest(), 'pdfSize': pdf.stat().st_size,
                'previousEntrySha256': previous, 'issuerCertificateSha256': self.fingerprint,
                'observedAt': datetime.now(timezone.utc).isoformat(), 'crls': self.crls}
            entry = {'binding': binding, 'cms': base64.b64encode(self.signed(rfc8785.dumps(binding))).decode('ascii')}
            entries.append(entry)
            previous = hashlib.sha256(rfc8785.dumps(entry)).hexdigest()
        envelope = {'schemaVersion': 1, 'purpose': 'DICOM_PDF_EXTERNAL_EVIDENCE', 'entries': entries}
        evidence = self.root/'evidence.json'
        evidence.write_bytes(rfc8785.dumps(envelope))
        report = verify_evidence(pdf, evidence, self.trust)
        self.assertEqual('TIMESTAMPED_ARCHIVE_EVIDENCE', report['assurance'], report)
        future = datetime.now(timezone.utc)+timedelta(days=90)
        self.assertEqual('TIMESTAMPED_ARCHIVE_EVIDENCE', verify_evidence(pdf, evidence, self.trust, future)['assurance'])
        self.assertEqual('UNKNOWN', verify_evidence(pdf, evidence)['checks']['evidenceChain']['status'])
        original = pdf.read_bytes()
        pdf.write_bytes(b'Changed bytes')
        self.assertEqual('FAIL', verify_evidence(pdf, evidence, self.trust)['checks']['evidenceChain']['status'])
        pdf.write_bytes(original)
        envelope['entries'] = entries[1:]
        evidence.write_bytes(rfc8785.dumps(envelope))
        self.assertEqual('FAIL', verify_evidence(pdf, evidence, self.trust)['checks']['evidenceChain']['status'])
        envelope['entries'] = entries
        entries[0]['binding']['observedAt'] = '2000-01-01T00:00:00Z'
        evidence.write_bytes(rfc8785.dumps(envelope))
        self.assertEqual('FAIL', verify_evidence(pdf, evidence, self.trust)['checks']['evidenceChain']['status'])

    def test_revoked_tsa_cannot_be_hidden_by_valid_token_signature(self):
        index = (self.root/'index').read_bytes()
        try:
            self.command('ca', '-config', 'ca.cnf', '-revoke', 'tsa.pem', '-crl_reason', 'keyCompromise')
            self.command('ca', '-config', 'ca.cnf', '-gencrl', '-out', 'revoked.crl.pem')
            revoked = base64.b64encode(self.command('crl', '-in', 'revoked.crl.pem', '-outform', 'DER')).decode('ascii')
            signed = self.signed(b'Synthetic revoked timestamp')
            self.assertEqual('FAIL', verify_timestamp(signed, self.trust, [revoked])['status'])
        finally:
            (self.root/'index').write_bytes(index)


if __name__ == '__main__':
    unittest.main()
