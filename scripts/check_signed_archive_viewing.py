#!/usr/bin/env python3
"""Check signed PDF image viewing and exact recovery offline; reports stay in target/."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from pypdf import PdfReader, PdfWriter, overwrite_configuration
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity, first_supported, check_controls


def main():
    headroom=max(1,os.sysconf("SC_AVPHYS_PAGES")*os.sysconf("SC_PAGE_SIZE")//4)
    overwrite_configuration(maximum_declared_stream_length=headroom,zlib_maximum_output_length=headroom,stream_decoding_work_maximum_length=headroom)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--report', type=Path, default=Path('target/signed-viewing-checks'))
    parser.add_argument('--viewer', type=Path, help='Use an updated standalone viewer with an existing signed PDF without modifying the archive')
    parser.add_argument('--chromium', default='/snap/chromium/current/usr/lib/chromium-browser/chrome')
    parser.add_argument('--integrity', action='store_true', help='Check the current integrity GUI and a corrupted synthetic package')
    parser.add_argument('--structure', action='store_true', help='Check stored source structure diagnostics in the metadata pane')
    args = parser.parse_args()
    report = args.report.resolve()
    if not report.is_relative_to(Path('target').resolve()):
        raise ValueError('Reports must stay under target')
    report.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(args.pdf)
    manifest = json.loads(reader.attachments['manifest.json'][0])
    initial = first_supported(manifest)
    assert initial is not None, 'Fixture requires a supported reference image'
    protection = manifest.get('security', {}).get('protection')
    expected_report_status = 'UNKNOWN' if protection == 'PADES_B_LTA' else 'PASS'
    viewer = report/'viewer.html'
    viewer.write_bytes(args.viewer.read_bytes() if args.viewer else reader.attachments['viewer.html'][0])
    corrupt = None
    corrupt_signature = None
    unsupported_profile = None
    if args.integrity:
        assert args.pdf.name.startswith('synthetic-'), 'Corruption checks require an explicitly synthetic fixture'
        writer = PdfWriter(clone_from=args.pdf)
        original = manifest['images'][-1]['attachment']
        for file in writer.attachment_list:
            if file.name == original:
                content = bytearray(file.content)
                assert content, 'Corruption fixture must not be empty'
                content[-1] ^= 1
                file.content = bytes(content)
        corrupt = report/'corrupted-synthetic.pdf'
        writer.write(corrupt)
        if manifest.get('security', {}).get('manifestSignature') == 'manifest.p7s':
            from asn1crypto.cms import ContentInfo
            altered = PdfWriter(clone_from=args.pdf)
            for file in altered.attachment_list:
                if file.name == 'manifest.p7s':
                    cms = ContentInfo.load(file.content)
                    signer = cms['content']['signer_infos'][0]
                    signature = bytearray(signer['signature'].native)
                    signature[-1] ^= 1
                    signer['signature'] = bytes(signature)
                    file.content = cms.dump()
            corrupt_signature = report/'corrupted-synthetic-manifest-signature.pdf'
            altered.write(corrupt_signature)
        if manifest.get('profileVersion') == '0.4.0':
            future = PdfWriter(clone_from=args.pdf)
            for file in future.attachment_list:
                if file.name == 'manifest.json':
                    file.content = json.dumps({**manifest, 'profileVersion': '99.0.0'}).encode('utf-8')
            unsupported_profile = report/'unsupported-synthetic-profile.pdf'
            future.write(unsupported_profile)
    results = []
    with sync_playwright() as p:
        for mode in ['extension', 'standalone']:
            with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
                if mode == 'extension':
                    context = launch(p, args.chromium, Path('target/chrome-extension').resolve(), profile)
                    address = f'chrome-extension://{extension_identity(context)}/viewer.html'
                else:
                    context = p.chromium.launch_persistent_context(profile, executable_path=args.chromium,
                        headless=True, accept_downloads=True, args=['--no-sandbox'],
                        viewport={'width': 1440, 'height': 1000})
                    address = viewer.as_uri()
                requests, errors = [], []
                try:
                    context.set_offline(True)
                    context.on('request', lambda request: requests.append(request.resource_type)
                               if request.url.startswith(('http:', 'https:')) else None)
                    page = context.pages[0]
                    page.on('pageerror', lambda error: errors.append(type(error).__name__))
                    page.goto(address)
                    page.locator('#pdf-file').set_input_files(args.pdf.resolve())
                    selected = manifest['images'][initial]
                    expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', selected['attachment'], timeout=30000)
                    expect(page.locator('#viewport canvas').first).to_be_visible()
                    if manifest.get('profileVersion') == '0.4.0':
                        expect(page.locator('#package-role')).to_contain_text('profile 0.4.0')
                    page.screenshot(path=str(report/f'{mode}-opened.png'))
                    if args.integrity:
                        expect(page.locator('#document-name')).to_have_attribute('data-integrity',expected_report_status,timeout=120000)
                    for entry in manifest['images']:
                        if (entry.get('reason') or '').strip().rstrip('.').casefold() == 'not a dicom stream':
                            row=page.locator('#other-supplied-files').locator(f'[data-attachment="{entry["attachment"]}"]')
                            expect(row).to_have_count(1)
                            assert 'not a dicom stream' not in row.inner_text().casefold()
                    controls = check_controls(page, page)
                    if args.structure:
                        structural=json.loads(reader.attachments['dicom-structure.json'][0])
                        for index, entry in enumerate(manifest['images']):
                            if not page.locator(f'#image-list option[value="{index}"]').count():
                                continue
                            page.locator('#image-list').select_option(str(index))
                            page.locator('#show-metadata').click()
                            expected_record=next(record for record in structural['images'] if record['attachment']==entry['attachment'])
                            expect(page.locator('#metadata-fields')).to_contain_text(entry['sourcePath'], timeout=30000)
                            expect(page.locator('#metadata-fields')).to_contain_text('Stored structural checks', timeout=30000)
                            expect(page.locator('#metadata-fields').get_by_text('Stored structural checks', exact=True).locator('xpath=following-sibling::dd[1]')).to_have_text(expected_record['status'])
                            expect(page.locator('#metadata-fields')).to_contain_text('full IOD validity not established')
                            if expected_record['expectedPixelBytes'] is not None:
                                expect(page.locator('#metadata-fields')).to_contain_text(str(expected_record['expectedPixelBytes']))
                            for issue in expected_record['issues']:
                                expect(page.locator('#metadata-fields')).to_contain_text(issue['code'])
                            page.keyboard.press('Escape')
                        page.locator('#image-list').select_option(str(initial))
                        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', selected['attachment'])
                    if args.integrity:
                        page.locator('#document-name').click()
                        expect(page.locator('#archive-check-status')).to_contain_text('Recorded file checksums match.', timeout=30000)
                        with page.expect_download() as event:
                            page.locator('#save-archive-check').click()
                        saved_report = report/f'{mode}-file-checks.json'
                        event.value.save_as(saved_report)
                        checked = json.loads(saved_report.read_text())
                        assert checked['integrity'] == 'PASS'
                        assert checked['reportStatus'] == expected_report_status
                        security = {check['name']:check['status'] for check in checked['pdfSecurity']['checks']}
                        if protection:
                            assert security['PDF signature 1'] == 'PASS'
                            assert checked['pdfSecurity']['trustStatus'] == 'UNKNOWN'
                        assert checked['matchedOriginals'] == len(manifest['images'])
                        assert checked['checks']['exporterIdentity']['status'] == 'UNKNOWN'
                        assert checked['checks']['trustedTime']['status'] == 'UNKNOWN'
                        assert checked['signingEvidence']['trustedTimeVerification'] == 'UNKNOWN'
                        if manifest.get('security', {}).get('manifestSignature') == 'manifest.p7s':
                            assert checked['checks']['manifestSignature']['status'] == 'PASS'
                            assert checked['checks']['signerCertificateBinding']['status'] == 'PASS'
                            assert checked['checks']['certificateTrust']['status'] == 'UNKNOWN'
                            assert checked['checks']['revocation']['status'] == 'UNKNOWN'
                            assert checked['assurance'] == 'MANIFEST_SIGNATURE_VALID_IDENTITY_UNVERIFIED'
                            expect(page.locator('#archive-check-fields')).to_contain_text('Verified against the included certificate')
                        if protection in ['CMS_AND_PDF_TIMESTAMPED', 'PADES_B_LTA']:
                            assert 'Timestamp requested by export policy' in checked['signingEvidence']['trustedTime']
                            assert security['PDF signature 1 timestamp imprint'] == 'PASS'
                        if protection == 'PADES_B_LTA':
                            assert security['Document timestamp 2'] == 'PASS'
                            assert security['DICOM archival revision history'] == 'PASS'
                            assert security['PAdES B-LTA and permitted revisions'] == 'UNKNOWN'
                            expect(page.locator('#archive-security-groups').get_by_role('heading', name='PAdES', exact=True)).to_be_visible()
                        if manifest.get('artifactSha256', {}).get('c2pa-policy.json'):
                            assert checked['checks']['c2paCredentials']['status'] == 'PASS'
                            assert security['C2PA claim signature'] == 'PASS'
                            expect(page.locator('#archive-security-groups').get_by_role('heading', name='C2PA', exact=True)).to_be_visible()
                        page.locator('#close-archive-check').click()
                        expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', selected['attachment'])
                    recovered = 0
                    for index, entry in enumerate(manifest['images']):
                        if entry['status'] != 'rendered' and not args.structure:
                            continue
                        if page.locator(f'#image-list option[value="{index}"]').count():
                            page.locator('#image-list').select_option(str(index))
                            if entry['status']=='rendered':
                                expect(page.locator('#viewport')).to_have_attribute('data-loaded-attachment', entry['attachment'])
                            else:
                                expect(page.locator('#metadata-fields')).to_contain_text(entry['sourcePath'])
                            download_button=page.locator('#download-original')
                            if not page.locator('#save-menu').evaluate('menu=>menu.open'):
                                page.locator('#save-menu > summary').click()
                        else:
                            page.locator('#other-files-section').evaluate('element=>element.open=true')
                            download_button=page.locator('#other-supplied-files').locator(f'[data-download-attachment="{entry["attachment"]}"]')
                        # Avoid firing a machine-speed burst of automatic downloads;
                        # browser download throttling is separate from file recovery.
                        page.wait_for_timeout(250)
                        with page.expect_download() as event:
                            download_button.click()
                        saved = report/f'{mode}-original-{index}.dcm'
                        event.value.save_as(saved)
                        assert saved.read_bytes() == reader.attachments[entry['attachment']][0]
                        assert hashlib.sha256(saved.read_bytes()).hexdigest() == entry['sha256']
                        recovered += 1
                    if args.integrity:
                        page.locator('#pdf-file').set_input_files(corrupt)
                        expect(page.locator('#document-name')).to_have_attribute('data-integrity','FAIL',timeout=90000)
                        page.locator('#document-name').click()
                        expect(page.locator('#archive-check-status')).to_contain_text('File integrity check failed.', timeout=30000)
                        with page.expect_download() as event:
                            page.locator('#save-archive-check').click()
                        failed_report = report/f'{mode}-failed-file-checks.json'
                        event.value.save_as(failed_report)
                        failed = json.loads(failed_report.read_text())
                        assert failed['integrity'] == 'FAIL'
                        assert failed['pdfSecurity']['status'] == 'FAIL'
                        assert any(file['code'] == 'SHA256_MISMATCH' for file in failed['files'])
                        if corrupt_signature:
                            page.locator('#pdf-file').set_input_files(corrupt_signature)
                            expect(page.locator('#document-name')).to_have_attribute('data-integrity','FAIL',timeout=90000)
                            page.locator('#document-name').click()
                            expect(page.locator('#archive-check-fields')).to_contain_text('FAILED: manifest signature is invalid')
                            with page.expect_download() as event:
                                page.locator('#save-archive-check').click()
                            bad_signature_report = report/f'{mode}-failed-manifest-signature.json'
                            event.value.save_as(bad_signature_report)
                            rejected = json.loads(bad_signature_report.read_text())
                            assert rejected['checks']['originalBytes']['status'] == 'PASS'
                            assert rejected['checks']['manifestChecksum']['status'] == 'PASS'
                            assert rejected['checks']['manifestSignature']['status'] == 'FAIL'
                            page.locator('#close-archive-check').click()
                        if unsupported_profile:
                            page.locator('#pdf-file').set_input_files(unsupported_profile)
                            expect(page.locator('#status')).to_contain_text('Unsupported DICOM profile version.', timeout=30000)
                    assert not requests and not errors, 'Offline viewing requested network or raised a runtime error'
                    results.append({'mode': mode, 'browserVersion': context.browser.version,
                        'profileVersion': manifest.get('profileVersion'),
                        'automaticLoad': True, 'controls': all(value != controls['baseline'] for key, value in controls.items() if key != 'baseline'),
                        'originalsRecoveredByteExact': recovered, 'httpRequests': len(requests), 'pageErrors': len(errors), 'passed': True})
                    if args.integrity:
                        results[-1].update({'allOriginalChecksums': True, 'corruptOriginalRejected': True,
                            'reportResetOnDocumentChange': True, 'offlineTrustRemainsUnknownWithNoAnchors': True})
                        if corrupt_signature:
                            results[-1].update({'manifestSignatureVerified': True,
                                'signerCertificateBindingVerified': True, 'corruptManifestSignatureRejected': True})
                        if unsupported_profile:
                            results[-1]['unsupportedProfileRejected'] = True
                    if args.structure:
                        results[-1]['sourceStructureDiagnostics']=True
                finally:
                    context.close()
    (report/'summary.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
