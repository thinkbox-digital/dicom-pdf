#!/usr/bin/env python3
"""Offline DICOM/PNG drops across viewer surfaces, including child event interception."""
import base64
import json
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report = Path('target/drop-anywhere-checks'); report.mkdir(parents=True, exist_ok=True)
    dicom = Path('fixtures/synthetic/explicit-le-8-unsigned-mono2.dcm').read_bytes()
    results = []
    with sync_playwright() as p:
        mode = 'extension'
        with tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
            context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome', Path('target/chrome-extension').resolve(), profile)
            result = {'mode': mode, 'httpRequests': 0, 'pageErrors': 0, 'cases': []}
            try:
                context.set_offline(True)
                context.on('request', lambda r: result.__setitem__('httpRequests', result['httpRequests'] + 1) if r.url.startswith(('http:', 'https:')) else None)
                page = context.pages[0]
                page.on('pageerror', lambda e: result.__setitem__('pageErrors', result['pageErrors'] + 1))
                page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
                png = page.evaluate('''async()=>{
                  const c=document.createElement('canvas');c.width=8;c.height=6;
                  const x=c.getContext('2d');x.fillStyle='#579abc';x.fillRect(0,0,8,6);
                  const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
                  return Array.from(new Uint8Array(await b.arrayBuffer()));
                }''')

                def drop(selector, name, data, image=False):
                    transfer = page.evaluate_handle('''args=>{
                      const t=new DataTransfer();t.items.add(new File([new Uint8Array(args.bytes)],args.name,{type:args.image?'image/png':'application/dicom'}));return t;
                    }''', {'name': name, 'bytes': list(data), 'image': image})
                    page.dispatch_event(selector, 'dragover', {'dataTransfer': transfer})
                    assert page.locator('body').evaluate("e=>e.classList.contains('file-drop-active')")
                    page.dispatch_event(selector, 'drop', {'dataTransfer': transfer})
                    transfer.dispose()
                    expect(page.locator('#image-list option')).to_have_count(1, timeout=30000)
                    expect(page.locator('#image-list option')).to_contain_text(name)
                    if image:
                        expect(page.locator('#attachment-view')).to_be_visible(timeout=30000)
                        page.wait_for_function("()=>document.querySelector('#attachment-content img')?.naturalWidth===8")
                    else:
                        page.wait_for_function("()=>Boolean(document.getElementById('viewport').dataset.loadedAttachment)")
                        expect(page.locator('#image-view')).to_be_visible()
                    assert not page.locator('body').evaluate("e=>e.classList.contains('file-drop-active')")
                    with page.expect_download() as event:
                        page.locator('#download-original').click()
                    recovered = report / f'{mode}-{name}'
                    event.value.save_as(recovered)
                    assert recovered.read_bytes() == bytes(data)
                    result['cases'].append({'target': selector, 'image': image, 'originalByteExact': True})

                drop('.app-header', 'toolbar.dcm', dicom)
                drop('#image-list', 'list.png', png, True)
                drop('#details-panel', 'metadata.dcm', dicom)
                # A child which stops bubbling must not prevent opening a file.
                page.locator('#viewport').evaluate("e=>{window.childDrop=false;e.addEventListener('drop',v=>{window.childDrop=true;v.stopImmediatePropagation();});}")
                drop('#viewport', 'viewport.png', png, True)
                assert page.evaluate('childDrop') is False
                drop('#attachment-content img', 'attachment.dcm', dicom)
                page.locator('#pdf-file').set_input_files(Path('out/desktop-final-activity.pdf').resolve())
                expect(page.locator('#viewport')).not_to_have_attribute('data-loaded-attachment', '', timeout=30000)
                page.locator('#show-pdf').click()
                expect(page.locator('#pdf-view')).to_be_visible()
                drop('#pdf-canvas', 'pdf-reference.png', png, True)
                result.update({'capturePreventsChildInterception': True, 'browserVersion': context.browser.version, 'passed': True})
                assert result['httpRequests'] == result['pageErrors'] == 0, result
                results.append(result)
            finally:
                context.close()
    (report / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results))


if __name__ == '__main__':
    main()
