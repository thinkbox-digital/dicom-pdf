#!/usr/bin/env python3
"""Bounded subprocess: independent pydicom evidence, never pixel decoding or logs."""
import json
import logging
import sys
import warnings
from pathlib import Path


def probe(path):
    # A deflated input is decompressed by pydicom. Bound the whole subprocess,
    # not just the file's compressed size. The parent also imposes a timeout.
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (2*1024**3, 2*1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    logging.disable(logging.CRITICAL)
    warnings.simplefilter('ignore')
    import pydicom
    pydicom.config.settings.reading_validation_mode = pydicom.config.RAISE
    dataset = pydicom.dcmread(path, defer_size=1024**2, force=False)
    wanted = ['SOPClassUID', 'SOPInstanceUID', 'StudyInstanceUID', 'SeriesInstanceUID',
              'Rows', 'Columns', 'NumberOfFrames']
    fields = {}
    for keyword in wanted:
        value = dataset.get(keyword)
        if value is not None and str(value).strip():
            text = str(value)
            if len(text) > 4096:
                raise ValueError('Field limit')
            fields[keyword] = text
    syntax = dataset.file_meta.get('TransferSyntaxUID')
    if syntax:
        fields['TransferSyntaxUID'] = str(syntax)
    references = []
    count = 0
    signed = False

    def scan(ds, depth):
        nonlocal count, signed
        if depth > 64:
            raise ValueError('Depth limit')
        for tag in ds.keys():
            count += 1
            if count > 200000:
                raise ValueError('Element limit')
            if int(tag) in (0x7fe00008, 0x7fe00009, 0x7fe00010):
                continue
            if int(tag) == 0xfffafffa:
                signed = True
            if int(tag) == 0x00081155:
                uid = str(ds[tag].value)
                if len(uid) > 128:
                    raise ValueError('UID limit')
                frames = ds.get('ReferencedFrameNumber', [])
                if frames == '':
                    frames = []
                if not isinstance(frames, (list, tuple, pydicom.multival.MultiValue)):
                    frames = [frames]
                references.append({'sopInstanceUID': uid,
                    'sopClassUID': str(ds.ReferencedSOPClassUID) if 'ReferencedSOPClassUID' in ds else None,
                    'frames': [int(frame) for frame in frames]})
            element = ds[tag]
            if element.VR == 'SQ':
                for item in element.value:
                    scan(item, depth+1)
    scan(dataset, 0)
    from archive_native_structure import native_structure
    return {'status': 'PARSED', 'fields': fields, 'references': references,
            'digitalSignaturesPresent': signed,'nativePixelStructure':native_structure(dataset,Path(path).stat().st_size)}


if __name__ == '__main__':
    try:
        result = probe(sys.argv[1])
    except BaseException:
        result = {'status': 'UNREADABLE', 'fields': {}, 'references': [],
                  'digitalSignaturesPresent': None}
    print(json.dumps(result, sort_keys=True))
