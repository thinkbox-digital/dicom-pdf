"""Independent native pixel-header/length evidence using pydicom; no pixel decoding."""
from pydicom.uid import UID
from pydicom.datadict import dictionary_VR


def native_structure(dataset, source_size=None):
    result = {'status': 'UNKNOWN', 'code': 'PIXEL_STRUCTURE_NOT_ASSESSED',
              'expectedPixelBytes': None, 'suppliedPixelBytes': None}
    pixels = [tag for tag in (0x7fe00008, 0x7fe00009, 0x7fe00010) if tag in dataset]
    if not pixels:
        if dataset.get('PixelDataProviderURL'):
            result['code'] = 'PIXEL_PROVIDER_NOT_RETRIEVED'
        elif 'Rows' in dataset or 'Columns' in dataset:
            result.update(status='FAIL', code='MISSING_PIXEL_ELEMENT')
        else:
            result.update(status='NOT_APPLICABLE', code='NO_TOP_LEVEL_PIXEL_PAYLOAD')
        return result
    if len(pixels) != 1:
        result.update(status='FAIL', code='MULTIPLE_PIXEL_ELEMENTS')
        return result
    try:
        tag = pixels[0]
        raw = dataset.get_item(tag, keep_deferred=True)
        undefined = getattr(raw, 'length', None) == 0xffffffff or getattr(raw, 'is_undefined_length', False)
        length = None if undefined else raw.length if hasattr(raw, 'length') else len(raw.value)
        result['suppliedPixelBytes'] = length
        syntax = UID(str(dataset.file_meta.TransferSyntaxUID))
        if not syntax.is_transfer_syntax:
            result['code'] = 'UNSUPPORTED_TRANSFER_SYNTAX'
            return result
        vr=raw.VR if raw.VR is not None else dictionary_VR(tag) if syntax.is_implicit_VR else None
        if syntax.is_compressed:
            valid = tag == 0x7fe00010 and vr == 'OB' and undefined
            result.update(status='PASS' if valid else 'FAIL', code='ENCAPSULATED_HEADER_ONLY_NOT_CODESTREAM_VALIDITY')
            return result
        value = getattr(raw, 'value', None)
        if length is not None and isinstance(value, bytes) and len(value) != length:
            result.update(status='FAIL', code='TRUNCATED_NATIVE_PIXEL_VALUE')
            return result
        if value is None and length is not None:
            if syntax.is_deflated or source_size is None or not hasattr(raw, 'value_tell'):
                result['code'] = 'DEFERRED_NATIVE_VALUE_NOT_BOUNDED'
                return result
            if raw.value_tell+length > source_size:
                result.update(status='FAIL', code='TRUNCATED_NATIVE_PIXEL_VALUE')
                return result
        rows, columns, samples, bits = (int(dataset.get(name, -1)) for name in ['Rows', 'Columns', 'SamplesPerPixel', 'BitsAllocated'])
        frames = int(dataset.get('NumberOfFrames', 1))
        if min(rows, columns, samples, frames) < 1 or not (bits == 1 or bits >= 8 and bits % 8 == 0):
            raise ValueError('Invalid dimensions')
        photo = str(dataset.get('PhotometricInterpretation', ''))
        if photo == 'YBR_FULL_422':
            if samples != 3 or int(dataset.get('PlanarConfiguration', -1)) != 0 or bits == 1:
                raise ValueError('Invalid subsampling structure')
            samples = 2
        elif photo in ('YBR_PARTIAL_420', 'YBR_PARTIAL_422'):
            return result
        total = rows*columns*samples*bits*frames
        if total > 2**63-8:
            raise ValueError('Dimension overflow')
        expected = (total+7)//8
        expected += expected % 2
        result['expectedPixelBytes'] = expected
        valid_vr = (tag == 0x7fe00008 and vr == 'OF' and bits == 32 or
                    tag == 0x7fe00009 and vr == 'OD' and bits == 64 or
                    tag == 0x7fe00010 and (vr in ('OB', 'OW') and bits <= 8 or vr == 'OW' and bits > 8 or vr == 'OB or OW' and syntax.is_implicit_VR))
        valid = not undefined and length == expected and valid_vr
        result.update(status='PASS' if valid else 'FAIL', code='NATIVE_HEADER_AND_ENCODED_LENGTH_ONLY')
    except (ValueError, TypeError, AttributeError, OverflowError):
        result.update(status='UNKNOWN' if not getattr(dataset.file_meta, 'TransferSyntaxUID', None) else 'FAIL', code='UNSUPPORTED_SYNTAX_OR_INVALID_PIXEL_STRUCTURE')
    return result
