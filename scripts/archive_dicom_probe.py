#!/usr/bin/env python3
"""Bounded subprocess: independent pydicom evidence, never pixel decoding or logs."""
import json
import logging
import os
import sys
import warnings
from pathlib import Path


MAX_RESULT_BYTES = 16 * 1024**2


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


def write_probe(path, output):
    import resource

    # Bound the output on disk even if the JSON cannot be returned to the caller.
    _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
    ceiling = MAX_RESULT_BYTES if hard == resource.RLIM_INFINITY else min(hard, MAX_RESULT_BYTES)
    resource.setrlimit(resource.RLIMIT_FSIZE, (ceiling, hard))
    try:
        result = probe(path)
    except Exception:
        result = {'status': 'UNREADABLE', 'fields': {}, 'references': [],
                  'digitalSignaturesPresent': None}
    json.dump(result, output, sort_keys=True)
    output.write('\n')
    output.flush()


def serve(directory):
    # This dedicated Linux interpreter never parses an input file itself. A
    # fresh child inherits the imports and receives its own CPU/memory limits.
    import pydicom
    import archive_native_structure

    if len(list(Path('/proc/self/task').iterdir())) != 1:
        return 1
    source = directory / 'source.dcm'
    result = directory / 'result.json'
    os.write(sys.stdout.fileno(), b'+')
    while os.read(sys.stdin.fileno(), 1) == b'?':
        pid = os.fork()
        if pid == 0:
            try:
                os.close(sys.stdin.fileno())
                os.close(sys.stdout.fileno())
                with result.open('x', encoding='utf-8') as output:
                    write_probe(source, output)
                os._exit(0)
            except BaseException:
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        os.write(sys.stdout.fileno(), b'+' if status == 0 else b'-')
    return 0


if __name__ == '__main__':
    if sys.argv[1] == '--serve':
        sys.exit(serve(Path(sys.argv[2])))
    write_probe(Path(sys.argv[1]), sys.stdout)
