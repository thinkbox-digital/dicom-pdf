#!/usr/bin/env python3
"""Check independently runnable desktop/CLI distributions; no GUI display required."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZipFile


def check_painted_reference(java, jar, work):
    """Measure the painted top-left quadrant of the checked-in 2x2 spacing phantom."""
    sources = work / 'aspect-sources'
    sources.mkdir()
    fixture = Path('fixtures/spec-display/non-square-pixel-spacing.dcm')
    shutil.copyfile(fixture, sources / fixture.name)
    pdf = work / 'aspect.pdf'
    subprocess.run([java, '-cp', str(jar.resolve()), 'digital.thinkbox.dicompdf.Main',
                    'create', '--input', str(sources.resolve()), '--output', str(pdf.resolve()),
                    '--c2pa', 'off'], cwd=work, check=True, capture_output=True, timeout=60)

    # One summary, one inventory, then the only reference. The visible reference
    # paints one black top-left source pixel and three white ones on a white page.
    prefix = work / 'aspect-page'
    subprocess.run(['pdftoppm', '-f', '3', '-l', '3', '-singlefile', '-r', '72', '-gray',
                    str(pdf), str(prefix)], check=True, capture_output=True, timeout=30)
    with prefix.with_suffix('.pgm').open('rb') as image:
        assert image.readline().strip() == b'P5', 'Expected a Poppler grayscale raster'
        width, height = map(int, image.readline().split())
        assert image.readline().strip() == b'255'
        raster = image.read()
    assert len(raster) == width * height
    # Text has short runs at 72 dpi. Only the large solid quadrant should produce
    # a continuous black run of this size. Measure the marks on paper independently
    # of the PDF content matrix, embedded XObject and manifest display recipe.
    dark_runs = re.compile(rb'[\x00-\x20]{60,}')
    bands = [(y, m.start(), m.end()) for y in range(height)
             for m in dark_runs.finditer(raster[y * width:(y + 1) * width])]
    assert bands, 'The expected image quadrant was not painted'
    top, bottom = bands[0][0], bands[-1][0] + 1
    left = min(start for _, start, _ in bands)
    right = max(end for _, _, end in bands)
    assert len(bands) == bottom - top, 'The visible image quadrant is interrupted'
    assert all(abs(x - left) <= 2 and abs(end - right) <= 2 for _, x, end in bands), 'Unexpected image shape'
    # Row:column spacing is 2:1. The image is horizontally centered, with a
    # 75-point bottom margin. Its black quadrant ends halfway down and across.
    assert abs((bottom - top) - 2 * (right - left)) <= 3, 'Reference pixel aspect changed'
    assert abs(right - width / 2) <= 2, 'Reference is not centered or its orientation changed'
    assert abs(top + 2 * (bottom - top) - (height - 75)) <= 3, 'Unexpected vertical placement'
    return {'renderer': 'Poppler pdftoppm', 'page': 3, 'dpi': 72, 'size': [width, height],
            'blackQuadrantBounds': [left, top, right, bottom], 'spacingRatio': 2}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='0.24.0')
    parser.add_argument('--verapdf', default=os.environ.get('VERAPDF'),
                        help='validate PDF/A-4f and verify byte-exact round trip using this executable')
    args = parser.parse_args()
    java = shutil.which('java')
    assert java, 'Java 21 must be on PATH'
    report = Path('target/desktop-distribution-checks')
    report.mkdir(parents=True, exist_ok=True)
    standalone_viewer = Path('src/main/resources/viewer.html').read_bytes()
    result = {}
    gui = 'digital/thinkbox/dicompdf/ArchiveDesktop'
    with tempfile.TemporaryDirectory(dir=report, prefix='isolated-') as temporary:
        for kind in ['desktop', 'cli']:
            source = Path('dist') / f'dicom-pdf-{args.version}{"-desktop" if kind == "desktop" else ""}.jar'
            with ZipFile(source) as jar:
                names = set(jar.namelist())
                assert jar.read('viewer.html') == standalone_viewer, f'{source} embeds a different viewer than src/main/resources/viewer.html'
                assert not any(name.startswith('net/i2p/crypto/eddsa/') for name in names), 'Excluded vulnerable EdDSA provider was repackaged'
                assert not any(name.startswith('digital/thinkbox/pdfsecurity/testing/') for name in names), 'Synthetic signing fixtures must not be shipped'
                assert not any(name.startswith('digital/thinkbox/dicompdf/security/') for name in names), 'Legacy security classes must not be repackaged'
                manifest = jar.read('META-INF/MANIFEST.MF').decode('utf-8').replace('\r\n ', '')
                expected = 'digital.thinkbox.dicompdf.' + ('ArchiveDesktop' if kind == 'desktop' else 'Main')
                assert f'Main-Class: {expected}' in manifest
                assert (gui + '.class' in names) == (kind == 'desktop')
                if kind == 'cli':
                    assert not any(n.startswith(gui) or n.startswith('digital/thinkbox/dicompdf/DesktopProcess') or n.startswith('digital/thinkbox/dicompdf/DesktopRequest') or n.startswith('digital/thinkbox/dicompdf/DesktopInputs') or n.startswith('digital/thinkbox/dicompdf/DesktopReplacement') or n.startswith('digital/thinkbox/dicompdf/DesktopPassword') or n.startswith('digital/thinkbox/dicompdf/DesktopSigningMain') or n.startswith('digital/thinkbox/dicompdf/DesktopSigningSelection') or n.startswith('digital/thinkbox/dicompdf/DesktopFileDialogs') for n in names)
                for required in ['digital/thinkbox/dicompdf/Main.class',
                                 'digital/thinkbox/pdfsecurity/PdfSecurity.class',
                                 'digital/thinkbox/pdfsecurity/C2paProfile.class',
                                 'digital/thinkbox/dicompdf/ArchiveC2pa.class',
                                 'org/apache/pdfbox/pdmodel/PDDocument.class',
                                 'org/bouncycastle/cms/CMSSignedData.class',
                                 'com/google/gson/JsonParser.class',
                                 'dicom-codecs/linux-x86-64.so',
                                 'dicom-codecs/linux-aarch64.so',
                                 'dicom-codecs/macosx-x86-64.dylib',
                                 'dicom-codecs/macosx-aarch64.dylib',
                                 'dicom-codecs/windows-x86-64.dll',
                                 'META-INF/dicom-pdf/THIRD_PARTY_NOTICES.md',
                                 'META-INF/dicom-pdf/LICENSE']:
                    assert required in names, (kind, required)
            isolated = Path(temporary) / kind
            isolated.mkdir()
            destination = isolated / 'application.jar'
            shutil.copyfile(source, destination)
            completed = subprocess.run([java, '-jar', str(destination.resolve()), '--help'],
                                       cwd=isolated, capture_output=True, text=True, timeout=30)
            assert completed.returncode == 0, completed.stderr
            assert source.name in completed.stdout, completed.stdout
            assert ('desktop.jar [create|verify]' if kind == 'desktop' else 'verify-security') in completed.stdout
            codec_sources = isolated / 'codec-sources'
            codec_sources.mkdir()
            codec_fixtures = sorted(p for p in Path('fixtures/expanded').glob('*.dcm')
                                    if 'jpegls' in p.name or 'jpeg2000' in p.name)
            assert len(codec_fixtures) == 4
            for fixture in codec_fixtures:
                shutil.copyfile(fixture, codec_sources / fixture.name)
            codec_check = subprocess.run([java, '-cp', str(destination.resolve()),
                'digital.thinkbox.dicompdf.Main', 'create', '--input', 'codec-sources',
                '--output', 'codec-check.pdf', '--c2pa', 'off'],
                cwd=isolated, capture_output=True, text=True, timeout=60)
            assert codec_check.returncode == 0 and '4 displayed; 0 rejected' in codec_check.stdout, codec_check.stderr
            if args.verapdf:
                cli = [java, '-cp', str(destination.resolve()), 'digital.thinkbox.dicompdf.Main']
                verification = subprocess.run([*cli, 'verify', '--input', 'codec-check.pdf',
                    '--sources', 'codec-sources', '--verapdf', args.verapdf],
                    cwd=isolated, capture_output=True, text=True, timeout=120)
                assert verification.returncode == 0, verification.stdout + verification.stderr
                extraction = subprocess.run([*cli, 'extract', '--input', 'codec-check.pdf', '--output', 'recovered'],
                                            cwd=isolated, capture_output=True, text=True, timeout=60)
                assert extraction.returncode == 0, extraction.stdout + extraction.stderr
                for fixture in codec_fixtures:
                    assert (isolated / 'recovered/originals' / fixture.name).read_bytes() == fixture.read_bytes()
            if kind == 'desktop':
                headless = subprocess.run([java, '-Djava.awt.headless=true', '-jar', str(destination.resolve())],
                                          cwd=isolated, capture_output=True, text=True, timeout=30)
                assert headless.returncode == 1 and 'needs a graphical desktop' in headless.stderr
                fixtures = Path('target/app/test-classes').resolve()
                assert (fixtures/'digital/thinkbox/dicompdf/DesktopPreparationMain.class').is_file(), 'Build test fixtures with mvn test-compile first'
                preparation = subprocess.run([java, '-Djava.awt.headless=true', '-cp',
                    str(fixtures)+os.pathsep+str(destination.resolve()),
                    'digital.thinkbox.dicompdf.DesktopPreparationMain', str((isolated/'preparation').resolve())],
                    cwd=isolated, capture_output=True, text=True, timeout=30)
                assert preparation.returncode == 0, preparation.stderr
                assert 'Advanced signing JSON prepared' in preparation.stdout
            result[kind] = {'jar': str(source), 'bytes': source.stat().st_size,
                            'standaloneLaunch': True, 'compressedReferences': len(codec_fixtures),
                            'noticesPresent': True, 'embeddedViewerMatchesStandalone': True, 'passed': True}
            if args.verapdf:
                result[kind].update(pdfa4f=True, recoveredBytesMatch=True)
            result[kind]['paintedReference'] = check_painted_reference(java, destination, isolated)
            if kind == 'desktop':
                result[kind]['advancedSigningPreparation'] = True
    result['passed'] = True
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
