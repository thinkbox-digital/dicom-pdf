#!/usr/bin/env python3
"""Exercise keyboard guards against a real offline extension viewport."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from check_extension import launch, extension_identity


def main():
    report = Path('target/keyboard-guards-checks')
    report.mkdir(parents=True, exist_ok=True)
    result = {'httpRequests': 0, 'pageErrors': 0}
    with sync_playwright() as p, tempfile.TemporaryDirectory(dir=report, prefix='profile-') as profile:
        context = launch(p, '/snap/chromium/current/usr/lib/chromium-browser/chrome',
                         Path('target/chrome-extension').resolve(), profile)
        try:
            context.set_offline(True)
            context.on('request', lambda r: result.__setitem__('httpRequests', result['httpRequests'] + 1)
                       if r.url.startswith(('http:', 'https:')) else None)
            page = context.pages[0]
            page.on('pageerror', lambda e: result.__setitem__('pageErrors', result['pageErrors'] + 1))
            page.goto(f'chrome-extension://{extension_identity(context)}/viewer.html')
            page.locator('#dicom-files').set_input_files(Path('target/overlay-inputs/01-axial.dcm').resolve())
            expect(page.locator('#save-view')).to_be_enabled(timeout=30000)
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            before = page.locator('#viewport canvas').first.evaluate('c=>c.toDataURL()')
            checks = page.evaluate('''()=>{
              const viewport=document.querySelector('#viewport');
              const dispatch=(target,options={})=>{
                const event=new KeyboardEvent('keydown',{key:'i',bubbles:true,cancelable:true,...options});
                target.dispatchEvent(event);return event.defaultPrevented;
              };
              const results=[];
              for(const kind of ['button','editable','plaintext','slider','link','summary']){
                const host=document.createElement(kind==='button'?'button':kind==='link'?'a':kind==='summary'?'summary':'div');
                if(kind==='editable')host.contentEditable='true';
                if(kind==='plaintext')host.contentEditable='plaintext-only';
                if(kind==='slider')host.setAttribute('role','slider');
                if(kind==='link')host.href='#';
                const child=document.createElement('span');host.append(child);viewport.append(host);
                results.push({kind,handled:dispatch(child)});host.remove();
              }
              results.push({kind:'composition',handled:dispatch(viewport,{isComposing:true})});
              const event=new KeyboardEvent('keydown',{key:'i',bubbles:true,cancelable:true});
              event.preventDefault();viewport.dispatchEvent(event);
              return results;
            }''')
            assert all(not c['handled'] for c in checks), checks
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            assert page.locator('#viewport canvas').first.evaluate('c=>c.toDataURL()') == before
            page.evaluate("window.keyboardGuardPixels=document.querySelector('#viewport canvas').toDataURL()")
            page.locator('#viewport').focus()
            page.keyboard.press('i')
            page.wait_for_function("()=>document.querySelector('#viewport canvas').toDataURL()!==window.keyboardGuardPixels")
            result.update({'browserVersion': context.browser.version, 'guardedCases': checks,
                           'guardedPixelsUnchanged': True, 'normalInvertWorks': True})
            assert result['httpRequests'] == result['pageErrors'] == 0, result
            result['passed'] = True
        finally:
            context.close()
    (report / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
