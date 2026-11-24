"""Advance the minor version shared by the creator, viewer and command-line JARs."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POM = 'app/pom.xml'
JAVA_VERSION = 'src/main/java/digital/thinkbox/dicompdf/ApplicationVersion.java'
JAR_NAMES = ('dicom-pdf-{version}.jar', 'dicom-pdf-{version}-desktop.jar', 'dicom-pdf-{version}-viewer.jar')
DISTRIBUTION_REFERENCES = {
    'README.md': ('(`{version}`) embeds viewer',),
    'docs/GUIDE.md': ('Desktop version `{version}`',),
    'docs/PDF_SECURITY_LIBRARY.md': ('digital.thinkbox:dicom-pdf:{version}`',),
    'docs/SECURITY.md': (),
    'docs/SIGNING_CONFIGURATION.md': (),
    'fixtures/reports/README.md': (),
    'scripts/check_desktop_distribution.py': ("default='{version}'",),
    'scripts/check_tall_image_layout.py': (),
    'scripts/convert_additional_samples.py': (),
    'scripts/convert_archives.py': (),
    'scripts/dicom_regenerate.py': (),
    'scripts/sample_inventory.py': (),
}
POM_VERSION = r'<artifactId>dicom-pdf</artifactId>\s*<version>(\d+\.\d+\.\d+)</version>'
RUNTIME_VERSION = r'\bVERSION\s*=\s*"(\d+\.\d+\.\d+)"'


def advance_application_version(root: Path) -> str:
    pom = (root / POM).read_text(encoding='utf-8')
    java = (root / JAVA_VERSION).read_text(encoding='utf-8')
    pom_version = re.search(POM_VERSION, pom)
    runtime_version = re.search(RUNTIME_VERSION, java)
    if pom_version is None or runtime_version is None:
        raise ValueError('Expected an application version in the POM and Java source.')

    previous = pom_version[1]
    if runtime_version[1] != previous:
        raise ValueError('The application POM and Java source versions must match.')
    major, minor, _ = previous.split('.')
    version = f'{major}.{int(minor) + 1}.0'

    updates = {
        POM: pom[:pom_version.start(1)] + version + pom[pom_version.end(1):],
        JAVA_VERSION: java[:runtime_version.start(1)] + version + java[runtime_version.end(1):],
    }
    for name, references in DISTRIBUTION_REFERENCES.items():
        content = (root / name).read_text(encoding='utf-8')
        updated = content
        for reference in (*JAR_NAMES, *references):
            updated = updated.replace(reference.format(version=previous), reference.format(version=version))
        if updated != content:
            updates[name] = updated

    for name, content in updates.items():
        (root / name).write_text(content, encoding='utf-8')
    return version


if __name__ == '__main__':
    print(f'Application version {advance_application_version(ROOT)}')
