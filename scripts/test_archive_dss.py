"""DSS parsing must reject attacker-controlled containers before using evidence."""
import io
import unittest
from unittest.mock import patch
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, DecodedStreamObject
from archive_dss import read_dss


class DssStructureTests(unittest.TestCase):
    def reader(self, dss=None):
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        if dss is not None:
            writer.root_object[NameObject('/DSS')] = dss
        output = io.BytesIO()
        writer.write(output)
        return PdfReader(io.BytesIO(output.getvalue()))

    def test_missing_dss_is_not_treated_as_authentication(self):
        self.assertIsNone(read_dss(self.reader()))

    def test_unknown_keys_nonstream_and_empty_arrays_fail(self):
        for dss in [DictionaryObject({NameObject('/Unexpected'): NameObject('/Value')}),
                    DictionaryObject({NameObject('/Certs'): ArrayObject()}),
                    DictionaryObject({NameObject('/Certs'): ArrayObject([NameObject('/NotAStream')])})]:
            with self.assertRaises(ValueError):
                read_dss(self.reader(dss))

    def test_invalid_der_and_oversized_expansion_fail(self):
        stream = DecodedStreamObject()
        stream.set_data(b'not a certificate')
        dss = DictionaryObject({NameObject('/Certs'): ArrayObject([stream])})
        with self.assertRaises(ValueError):
            read_dss(self.reader(dss))
        with patch('archive_dss.MAX_ITEM', 4):
            with self.assertRaisesRegex(ValueError, 'expanded evidence limit'):
                read_dss(self.reader(dss))


if __name__ == '__main__':
    unittest.main()
