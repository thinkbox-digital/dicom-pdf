"""Cross-implementation signature tests; generated identities are synthetic only."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from archive_openssl import verify_cms


@unittest.skipUnless(shutil.which('openssl'), 'Local OpenSSL executable required')
class IndependentSignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='dicom-cms-test-')
        cls.root = Path(cls.temporary.name)
        cls.key, cls.cert = cls.root/'key.pem', cls.root/'cert.pem'
        def command(*arguments):
            return subprocess.run(['openssl', *arguments], check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=30).stdout
        command('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-subj', '/CN=Synthetic Independent Test',
                '-keyout', str(cls.key), '-out', str(cls.cert))
        cls.content = b'{"schemaVersion":1,"synthetic":true}'
        source = cls.root/'manifest.json'
        source.write_bytes(cls.content)
        signature = cls.root/'manifest.p7s'
        command('cms', '-sign', '-binary', '-cades', '-in', str(source),
                '-signer', str(cls.cert), '-inkey', str(cls.key),
                '-outform', 'DER', '-out', str(signature))
        cls.signature = signature.read_bytes()
        cls.fingerprint = hashlib.sha256(command('x509', '-in', str(cls.cert),
                                                '-outform', 'DER')).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_actual_content_and_explicit_signer_are_verified(self):
        checked = verify_cms(self.content, self.signature, [self.cert],
                             expected_certificate=self.fingerprint)
        self.assertEqual('PASS', checked['signature']['status'])
        self.assertEqual('PASS', checked['certificateTrust']['status'])
        self.assertEqual('UNKNOWN', checked['revocation']['status'])

    def test_modified_content_and_signature_fail(self):
        checked = verify_cms(self.content+b' ', self.signature)
        self.assertEqual('FAIL', checked['signature']['status'])
        changed = bytearray(self.signature)
        changed[-1] ^= 1
        checked = verify_cms(self.content, bytes(changed))
        self.assertEqual('FAIL', checked['signature']['status'])

    def test_missing_trust_and_wrong_certificate_cannot_authenticate(self):
        checked = verify_cms(self.content, self.signature)
        self.assertEqual('PASS', checked['signature']['status'])
        self.assertEqual('UNKNOWN', checked['certificateTrust']['status'])
        checked = verify_cms(self.content, self.signature, [self.cert],
                             expected_certificate='0'*64)
        self.assertEqual('FAIL', checked['signature']['status'])


if __name__ == '__main__':
    unittest.main()
