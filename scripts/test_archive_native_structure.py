"""Independent native-length checks using synthetic pydicom data, never pixel_array."""
import io
import unittest
from pydicom import Dataset, FileDataset, FileMetaDataset, dcmread
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian
from archive_native_structure import native_structure


def image():
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    data = FileDataset(None, {}, file_meta=meta, preamble=b'\0'*128)
    data.Rows, data.Columns, data.SamplesPerPixel = 2, 4, 1
    data.BitsAllocated = data.BitsStored = 8
    data.HighBit, data.PixelRepresentation = 7, 0
    data.PhotometricInterpretation = 'MONOCHROME2'
    data.PixelData = b'\0'*8
    data['PixelData'].VR = 'OB'
    return data


class IndependentNativeStructureTests(unittest.TestCase):
    def test_actual_native_length_and_bad_lengths_are_distinct(self):
        data = image()
        result = native_structure(data)
        self.assertEqual('PASS', result['status'])
        self.assertEqual(8, result['expectedPixelBytes'])
        data.PixelData = b'\0'*2
        self.assertEqual('FAIL', native_structure(data)['status'])

    def test_bitpacked_frames_and_subsampled_color_follow_storage_rules(self):
        data = image()
        data.Rows, data.Columns, data.BitsAllocated, data.NumberOfFrames = 1, 3, 1, '3'
        data.PixelData = b'\0'*2
        self.assertEqual(2, native_structure(data)['expectedPixelBytes'])
        self.assertEqual('PASS', native_structure(data)['status'])
        data.PixelData = b'\0'*6
        self.assertEqual('FAIL', native_structure(data)['status'])
        data = image()
        data.SamplesPerPixel, data.PhotometricInterpretation, data.PlanarConfiguration = 3, 'YBR_FULL_422', 0
        data.PixelData = b'\0'*16
        self.assertEqual('PASS', native_structure(data)['status'])
        data.PixelData = b'\0'*24
        self.assertEqual('FAIL', native_structure(data)['status'])

    def test_float_headers_remote_provider_and_unknown_syntax_are_not_guessed(self):
        data = image()
        del data.PixelData
        data.FloatPixelData = b'\0'*32
        data.BitsAllocated = 32
        self.assertEqual('PASS', native_structure(data)['status'])
        data.BitsAllocated = 64
        self.assertEqual('FAIL', native_structure(data)['status'])
        del data.FloatPixelData
        data.PixelDataProviderURL = 'https://invalid.example/never-fetch'
        self.assertEqual('UNKNOWN', native_structure(data)['status'])
        data = image()
        data.file_meta.TransferSyntaxUID = '2.25.987654321'
        self.assertEqual('UNKNOWN', native_structure(data)['status'])

    def test_deferred_value_bounds_and_truncation_use_raw_pydicom_headers(self):
        data = image()
        data.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.7'
        data.file_meta.MediaStorageSOPInstanceUID = '2.25.123'
        data.file_meta.ImplementationClassUID = '2.25.456'
        stream = io.BytesIO()
        data.save_as(stream, enforce_file_format=True)
        raw = stream.getvalue()
        deferred = dcmread(io.BytesIO(raw), defer_size=1)
        self.assertEqual('PASS', native_structure(deferred, len(raw))['status'])
        truncated = dcmread(io.BytesIO(raw[:-2]), defer_size=1)
        self.assertEqual('FAIL', native_structure(truncated, len(raw)-2)['status'])
        data.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
        stream = io.BytesIO()
        data.save_as(stream, enforce_file_format=True)
        self.assertEqual('PASS', native_structure(dcmread(io.BytesIO(stream.getvalue())), len(stream.getvalue()))['status'])


if __name__ == '__main__':
    unittest.main()
