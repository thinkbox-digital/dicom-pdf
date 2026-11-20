#!/usr/bin/env python3
"""Generate synthetic edge cases and check folder/ZIP stack navigation offline."""
import json
import struct
import tempfile
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity
from check_direct_inputs import PROBE, wait_model

LONG = {'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV'}


def element(tag, vr, value):
    value = value if isinstance(value, bytes) else str(value).encode('ascii')
    if len(value) % 2:
        value += b'\0' if vr in ('UI', 'OB', 'OW') else b' '
    header = struct.pack('<HH', *tag) + vr.encode('ascii')
    header += b'\0\0' + struct.pack('<I', len(value)) if vr in LONG else struct.pack('<H', len(value))
    return header + value


def fixtures(report):
    base = Path('fixtures/expanded/sc-native-gray8.dcm').read_bytes()
    assert base[128:132] == b'DICM'
    attributes = {}
    at = 132
    while at < len(base):
        tag = struct.unpack_from('<HH', base, at)
        vr = base[at+4:at+6].decode('ascii')
        header = 12 if vr in LONG else 8
        size = struct.unpack_from('<I' if vr in LONG else '<H', base, at+8 if vr in LONG else at+6)[0]
        assert size != 0xffffffff and at + header + size <= len(base)
        attributes[tag] = (vr, base[at+header:at+header+size])
        at += header + size
    root = report / 'inputs'
    root.mkdir(exist_ok=True)
    # Each tuple is (supplied positions, supplied instance numbers, expected order).
    groups = [(['30', '10', ''], ['3', '1', '2'], [1, 2, 0]),
              ([None, None, None], ['3', '', '-2'], [0, 1, 2]),
              ([' +2.0E1 ', '0', '-.5'], ['1', '2', '3'], [2, 1, 0])]
    orders = []
    for group, (positions, instances, order) in enumerate(groups):
        names = []
        for index in range(3):
            attrs = dict(attributes)
            uid = f'2.25.8137{group}{index}'
            attrs.update({(2, 3): ('UI', uid), (8, 0x18): ('UI', uid),
                          (0x20, 0x0d): ('UI', '2.25.813799'),
                          (0x20, 0x0e): ('UI', f'2.25.813701{group}'),
                          (8, 0x103e): ('LO', f'Synthetic missing-value stack {group+1}'),
                          (0x20, 0x13): ('IS', instances[index]),
                          (0x20, 0x37): ('DS', '1\\0\\0\\0\\1\\0')})
            if positions[index] is None:
                attrs.pop((0x20, 0x32), None)
            else:
                attrs[(0x20, 0x32)] = ('DS', '0\\0\\' + positions[index])
            meta = b''.join(element(tag, *value) for tag, value in sorted(attrs.items()) if tag[0] == 2 and tag != (2, 0))
            data = b''.join(element(tag, *value) for tag, value in sorted(attrs.items()) if tag[0] != 2)
            name = f'group-{group+1}-{index+1}.dcm'
            (root / name).write_bytes(base[:132] + element((2, 0), 'UL', struct.pack('<I', len(meta))) + meta + data)
            names.append(name)
        orders.append([names[i] for i in order])
    archive = report / 'inputs.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(root.iterdir()):
            z.write(path, path.name)
    return root, archive, orders


def main():
    report = Path('target/stack-missing-values-checks')
    report.mkdir(parents=True, exist_ok=True)
    root, archive, orders = fixtures(report)
    result = {'httpRequests': 0, 'pageErrors': 0, 'cases': []}
    with sync_playwright() as p, tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
        context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome',
                         Path('target/chrome-extension').resolve(), profile)
        try:
            context.set_offline(True)
            context.add_init_script(PROBE)
            context.on('request', lambda r: result.__setitem__('httpRequests', result['httpRequests'] + 1)
                       if r.url.startswith(('http:', 'https:')) else None)
            for kind in ['folder', 'zip']:
                page = context.new_page()
                page.on('pageerror', lambda e: result.__setitem__('pageErrors', result['pageErrors'] + 1))
                try:
                    page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
                    page.locator('#dicom-folder' if kind == 'folder' else '#dicom-files').set_input_files((root if kind == 'folder' else archive).resolve())
                    model = wait_model(page)
                    indices = {Path(e['sourcePath']).name: i for i, e in enumerate(model['entries'])}
                    observed = []
                    for order in orders:
                        # Start on the first source in supplied filename order.
                        first = min(order)
                        page.locator('#image-list').select_option(str(indices[first]))
                        expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
                        expect(page.locator('#stack-position')).to_have_attribute('max', '3')
                        for position, name in enumerate(order, 1):
                            page.locator('#stack-position').evaluate('''(e,p)=>{
                              e.value=String(p);e.dispatchEvent(new Event('input',{bubbles:true}));
                              e.dispatchEvent(new Event('change',{bubbles:true}));
                            }''', position)
                            expect(page.locator('#image-list')).to_have_value(str(indices[name]))
                            expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', model['entries'][indices[name]]['attachment'])
                            expect(page.locator('#viewport')).to_have_attribute('aria-busy', 'false')
                            observed.append(name)
                        with page.expect_download() as event:
                            page.locator('#download-original').click()
                        recovered = report / f'{kind}-{len(observed)}.dcm'
                        event.value.save_as(recovered)
                        assert recovered.read_bytes() == (root / order[-1]).read_bytes()
                    result['cases'].append({'kind': kind, 'order': observed, 'byteExactOriginals': 3})
                finally:
                    page.close()
            assert result['cases'][0]['order'] == result['cases'][1]['order']
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result.update({'browserVersion': context.browser.version, 'passed': True})
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
