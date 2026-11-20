#!/usr/bin/env python3
"""Check independently runnable desktop/CLI distributions; no GUI display required."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZipFile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='0.19.0')
    args = parser.parse_args()
    java = shutil.which('java')
    assert java, 'Java 21 must be on PATH'
    report = Path('target/desktop-distribution-checks')
    report.mkdir(parents=True, exist_ok=True)
    result = {}
    gui = 'digital/thinkbox/dicompdf/ArchiveDesktop'
    with tempfile.TemporaryDirectory(dir=report, prefix='isolated-') as temporary:
        for kind in ['desktop', 'cli']:
            source = Path('dist') / f'dicom-pdf-{args.version}{"-desktop" if kind == "desktop" else ""}.jar'
            with ZipFile(source) as jar:
                names = set(jar.namelist())
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
                            'noticesPresent': True, 'passed': True}
            if kind == 'desktop':
                result[kind]['advancedSigningPreparation'] = True
    result['passed'] = True
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
