#!/usr/bin/env python3
"""Exercise the unpacked Chrome extension offline in isolated browser profiles.

Chrome 151+ is required for the automatic local-PDF MIME-handler checks. The
optional older Chromium check opens the extension directly and uses its picker.
Reports, screenshots, browser profiles and recovered test downloads stay in target/.
"""
import argparse
import io
import struct
import zlib
import hashlib
import csv
import json
import re
from pathlib import Path
import tempfile
import time
from urllib.parse import urlparse, unquote
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject
from playwright.sync_api import sync_playwright, expect


def manifest_for(pdf):
    reader = PdfReader(pdf)
    return json.loads(reader.attachments["manifest.json"][0]), reader.attachments["manifest.json"][0]


def first_supported(manifest):
    browser_only = {"1.2.840.10008.1.2.4.80", "1.2.840.10008.1.2.4.81", "1.2.840.10008.1.2.4.90", "1.2.840.10008.1.2.4.91"}
    return next((i for i, entry in enumerate(manifest["images"])
                 if entry["status"] == "rendered" and entry.get("displayRejected") is not True
                 or manifest.get("profile") == "dicom-images" and entry.get("fields", {}).get("TransferSyntaxUID") in browser_only), None)


def viewer_frame(page, extension_id, timeout=20000):
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        for frame in page.frames:
            if frame.url.startswith(f"chrome-extension://{extension_id}/viewer.html"):
                return frame
        page.wait_for_timeout(50)
    raise AssertionError("Chrome did not automatically route the PDF to the extension viewer")


def settle(page):
    page.wait_for_timeout(120)


def check_initial(page, frame, manifest):
    expect(frame.locator("#image-list option")).to_have_count(len(manifest["images"]))
    index = first_supported(manifest)
    if index is None:
        expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment", "")
        expect(frame.locator("#status")).to_contain_text("No supported")
        for control in frame.locator("#controls input, #controls button").all():
            assert control.is_disabled(), "No-image package enabled image controls"
        return None
    entry = manifest["images"][index]
    expect(frame.locator("#image-list")).to_have_value(str(index))
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"])
    expect(frame.locator("#viewport canvas").first).to_be_visible()
    expect(frame.locator("#reset")).to_be_enabled()
    assert frame.locator("#pdf-file").evaluate("input => input.files.length") == 0, "MIME route used the file picker"
    return index


def check_extension_shell(frame, attachment_count, extension=None):
    assert frame.evaluate("document.title") == "DICOM PDF Viewer", "Incorrect extension product title"
    assert frame.evaluate("chrome.runtime.getManifest().name") == "DICOM PDF Viewer", "Incorrect installed extension name"
    assert " ".join(frame.locator("h1").inner_text().split()) == "DICOM PDF Viewer", "Incorrect extension brand"
    expect(frame.locator("#details-panel")).to_be_visible()
    banner = frame.locator("#extension-message")
    if banner.count():
        expect(banner).not_to_be_visible()
    expect(frame.locator(".package-file[data-attachment]")).to_have_count(attachment_count)
    expect(frame.locator("button[data-download-attachment]")).to_have_count(attachment_count)
    header_icon=frame.locator(".brand-mark img")
    expect(header_icon).to_be_visible()
    assert header_icon.evaluate("image=>image.complete&&image.naturalWidth>0"),"Header icon failed to decode"
    favicons=frame.locator('link[rel="icon"]')
    assert favicons.count()>=1,"Viewer has no favicon"
    for href in [header_icon.get_attribute("src")]+favicons.evaluate_all("links=>links.map(link=>link.href)"):
        parsed=urlparse(href)
        assert parsed.scheme in {"","chrome-extension"},"Viewer icon points outside the extension"
        if extension is not None:
            relative=unquote(parsed.path).lstrip("/")
            assert (extension/relative).is_file(),"Viewer icon asset is missing"


def check_file_panel_downloads(page, frame, manifest, attachments, report):
    names = [manifest["images"][first_supported(manifest)]["attachment"], "manifest.json", "dicom-xmp.rng"]
    checked = []
    for name in names:
        with page.expect_download() as event:
            frame.locator(f'button[data-download-attachment="{name}"]').click()
        destination = report / "downloads" / "right-pane" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        event.value.save_as(destination)
        assert destination.read_bytes() == attachments[name][0], f"Right-pane download differs: {name}"
        checked.append(name)
    return checked


def check_controls(page, frame):
    viewport = frame.locator("#viewport")

    def digest():
        settle(page)
        return hashlib.sha256(viewport.screenshot()).hexdigest()

    baseline = digest()
    hashes = {"baseline": baseline}
    for name, value in [("brightness", 35), ("contrast", 180)]:
        frame.locator(f"#{name}").evaluate("(input,value) => {input.value=value; input.dispatchEvent(new Event('input',{bubbles:true}));}", value)
        hashes[name] = digest()
        assert hashes[name] != baseline, f"{name} did not change displayed pixels"
        frame.locator("#reset").click()
        assert digest() == baseline, f"Reset did not restore {name}"
    frame.locator("#zoom-in").click()
    hashes["zoom"] = digest()
    assert hashes["zoom"] != baseline, "Zoom did not change displayed pixels"
    box = viewport.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 60, y + 35, steps=5)
    page.mouse.up()
    hashes["pan"] = digest()
    assert hashes["pan"] != hashes["zoom"], "Pan did not change displayed pixels"
    frame.locator("#reset").click()
    assert digest() == baseline, "Reset did not restore zoom/pan"
    return hashes


def check_wheel_navigation(page, frame):
    viewport = frame.locator("#viewport")
    before = viewport.get_attribute("data-loaded-attachment")
    box = viewport.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    settle(page)
    page.mouse.wheel(0,120)
    expect(viewport).not_to_have_attribute("data-loaded-attachment", before)
    expect(viewport).to_have_attribute("data-loaded-attachment", re.compile(".+"))
    next_image = viewport.get_attribute("data-loaded-attachment")
    assert next_image != before, "Wheel did not navigate to another source image"
    settle(page)
    page.mouse.wheel(0,-120)
    expect(viewport).to_have_attribute("data-loaded-attachment", before)
    settle(page); baseline = hashlib.sha256(viewport.screenshot()).hexdigest()
    page.keyboard.down("Control")
    try:
        page.mouse.wheel(0,-120)
    finally:
        page.keyboard.up("Control")
    settle(page)
    assert viewport.get_attribute("data-loaded-attachment") == before, "Ctrl+wheel changed source image"
    assert hashlib.sha256(viewport.screenshot()).hexdigest() != baseline, "Ctrl+wheel did not zoom"
    frame.locator("#reset").click();settle(page)
    assert hashlib.sha256(viewport.screenshot()).hexdigest() == baseline, "Reset did not restore Ctrl+wheel zoom"
    return {"nextImage": next_image, "reversedToInitial": True, "controlWheelZoom": True}


def assert_pdf_preview(page, frame, manifest):
    entries=manifest["images"]
    initial=int(frame.locator("#image-list").input_value())
    candidates=[i for i,entry in enumerate(entries) if entry["status"]=="rendered" and entry.get("displayRejected") is not True]
    assert len(candidates)>=3,"Synchronization fixture needs three renderable sources"
    first,second,third=candidates[:3]
    viewport=frame.locator("#viewport")

    def selected_image(index):
        expect(frame.locator("#image-list")).to_have_value(str(index))
        expect(viewport).to_be_visible()
        expect(viewport).to_have_attribute("data-loaded-attachment",entries[index]["attachment"])
        expect(frame.locator("#selected-source")).to_have_text(entries[index]["sourcePath"])

    def pdf_page(index):
        expect(frame.locator("#pdf-view")).to_be_visible()
        expect(frame.locator("#pdf-canvas")).to_be_visible()
        expect(frame.locator("#page-number")).to_have_value(str(entries[index]["referencePage"]))

    frame.locator("#image-list").select_option(str(first));selected_image(first)
    frame.locator("#show-pdf").click();pdf_page(first)
    assert entries[second]["referencePage"]==entries[first]["referencePage"]+1,"Fixture needs adjacent reference pages"
    frame.locator("#next-page").click();pdf_page(second)
    frame.locator("#show-image").click();selected_image(second)
    frame.locator("#show-pdf").click();pdf_page(second)
    frame.locator("#previous-page").click();pdf_page(first)
    frame.locator("#show-image").click();selected_image(first)

    # A source chosen while reading the PDF must update that page and remain
    # selected when returning to the original-image viewport.
    frame.locator("#show-pdf").click()
    frame.locator("#image-list").select_option(str(third))
    expect(frame.locator("#selected-source")).to_have_text(entries[third]["sourcePath"])
    pdf_page(third)
    frame.locator("#show-image").click();selected_image(third)

    # Direct page-number navigation is a separate event path from Previous/Next.
    frame.locator("#show-pdf").click()
    frame.locator("#page-number").fill(str(entries[second]["referencePage"]))
    frame.locator("#page-number").dispatch_event("change");pdf_page(second)
    frame.locator("#show-image").click();selected_image(second)
    frame.locator("#show-pdf").click();pdf_page(second)

    # Summary/inventory pages have no original association. They must preserve
    # the last selected source, rather than selecting another image by offset.
    frame.locator("#page-number").fill("1");frame.locator("#page-number").dispatch_event("change")
    expect(frame.locator("#page-number")).to_have_value("1")
    frame.locator("#show-image").click();selected_image(second)
    for _ in range(2):
        frame.locator("#show-pdf").click();pdf_page(second)
        frame.locator("#show-image").click();selected_image(second)
    frame.locator("#image-list").select_option(str(initial));selected_image(initial)
    return {"dicomToPdf":True,"nextPreviousPdfToDicom":True,"pageNumberPdfToDicom":True,
            "sourceSelectionInPdf":True,"summaryPreservesSelection":True,"repeatedRoundtrips":True}



def check_downloads(page, frame, manifest, raw_manifest, sources, report):
    entry = manifest["images"][first_supported(manifest)]
    with page.expect_download() as event:
        frame.locator("#download-original").click()
    download = event.value
    destination = report / "downloads" / entry["attachment"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    download.save_as(destination)
    assert destination.read_bytes() == (sources / entry["sourcePath"]).read_bytes(), "Recovered original differs from input"
    with page.expect_download() as event:
        frame.locator("#download-manifest").click()
    destination = report / "downloads" / "manifest.json"
    event.value.save_as(destination)
    assert destination.read_bytes() == raw_manifest, "Recovered manifest differs from embedded bytes"
    return {"originalSha256": hashlib.sha256((sources / entry["sourcePath"]).read_bytes()).hexdigest(),
            "original": entry["sourcePath"], "manifestByteMatch": True}


def altered_resource_pdf(source, destination, resource="dicom-xmp.rng"):
    writer = PdfWriter(clone_from=source)
    names = writer._root_object["/Names"]["/EmbeddedFiles"]["/Names"]
    changed = False
    for index in range(0, len(names), 2):
        if str(names[index]) != resource:
            continue
        specification = names[index + 1].get_object()
        stream = DecodedStreamObject(); stream.set_data(b"Synthetic altered resource; checksum must fail.\n")
        reference = writer._add_object(stream)
        specification["/EF"][NameObject("/F")] = reference
        specification["/EF"][NameObject("/UF")] = reference
        changed = True
        break
    assert changed, f"Fixture lacks attached resource {resource}"
    with destination.open("wb") as output:
        writer.write(output)


def check_expanded_formats(page, frame, manifest, attachments, report):
    checked = []
    frame_checks = []
    for index, entry in enumerate(manifest["images"]):
        frame.locator("#image-list").select_option(str(index))
        expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment", entry["attachment"])
        expect(frame.locator("#viewport")).to_have_attribute("data-source-frame", "1")
        expect(frame.locator("#viewport canvas").first).to_be_visible()
        checked.append({"sourcePath": entry["sourcePath"], "transferSyntax": entry["fields"]["TransferSyntaxUID"],
                        "pdfPreview": entry["status"] == "rendered"})
        if entry["status"] != "rendered":
            assert "interactive source display" in frame.locator("#status").inner_text(), "Browser-only codec falsely claimed a PDF preview"
        if entry["sourcePath"] in {"sc-multiframe-gray8.dcm", "mr-enhanced-functional-groups.dcm"}:
            viewport = frame.locator("#viewport")
            settle(page); baseline = hashlib.sha256(viewport.screenshot()).hexdigest()
            box=viewport.bounding_box();page.mouse.move(box["x"]+box["width"]/2,box["y"]+box["height"]/2)
            settle(page);page.mouse.wheel(0,120)
            expect(viewport).to_have_attribute("data-source-frame", "2")
            settle(page); second = hashlib.sha256(viewport.screenshot()).hexdigest()
            assert baseline != second, "Frame 2 did not change displayed pixels"
            assert "PDF baseline unchanged" in frame.locator("#status").inner_text()
            if entry["sourcePath"] == "mr-enhanced-functional-groups.dcm":
                expect(viewport).to_have_attribute("data-window-center", "1000")
                expect(viewport).to_have_attribute("data-window-width", "2000")
            # The PDF has an immutable frame-1 baseline. Merely visiting it
            # must not discard the frame currently explored in the original.
            frame.locator("#show-pdf").click()
            expect(frame.locator("#page-number")).to_have_value(str(entry["referencePage"]))
            frame.locator("#show-image").click()
            expect(viewport).to_have_attribute("data-loaded-attachment",entry["attachment"])
            expect(viewport).to_have_attribute("data-source-frame", "2")
            settle(page)
            assert hashlib.sha256(viewport.screenshot()).hexdigest()==second,"View roundtrip discarded or changed interactive frame 2"
            with page.expect_download() as event:
                frame.locator("#download-original").click()
            output = report / "downloads" / ("frame2-" + entry["attachment"])
            output.parent.mkdir(parents=True, exist_ok=True)
            event.value.save_as(output)
            assert output.read_bytes() == attachments[entry["attachment"]][0], "Frame exploration changed recovered original"
            frame_checks.append({"sourcePath": entry["sourcePath"], "frame2ChangedPixels": True, "wheelSelectedFrame2": True, "viewRoundtripPreservesFrame2":True, "originalByteMatch": True})
        page.screenshot(path=str(report / ("expanded-" + entry["sourcePath"] + ".png")))
    return {"images": checked, "frameChecks": frame_checks}


def synthetic_png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    pixels = b"".join(b"\x00" + b"\xe0\x20\x10" * 4 for _ in range(4))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def preview_fixture(source, destination):
    embedded_pdf = io.BytesIO()
    writer = PdfWriter(); writer.add_blank_page(width=210,height=150);writer.write(embedded_pdf)
    attachments = {
        "sample-text.txt": b"Synthetic attachment text, local only.\nSecond line.\n",
        "sample-data.json": b'{"synthetic":true,"count":2}\n',
        "sample-data.xml": b'<sample><value>42</value></sample>\n',
        "sample-table.csv": b'name,value\nsynthetic,42\n',
        "sample-page.html": b'<!doctype html><h1>Preview fixture</h1><script>window.__attachmentScriptRan=true;fetch("https://example.invalid/upload")</script>',
        "sample-pixel.png": synthetic_png(),
        "sample-document.pdf": embedded_pdf.getvalue(),
        "opaque-file.bin": bytes(range(256)),
    }
    package=PdfWriter(clone_from=source)
    for name, data in attachments.items():
        package.add_attachment(name,data)
    with destination.open("wb") as output:
        package.write(output)
    return attachments


def section_open(frame, section):
    details=frame.locator("#"+section)
    if not details.evaluate("element=>element.open"):
        details.locator("summary").first.click()


def check_section_defaults(frame):
    assert frame.locator("#files-section").evaluate("element=>element.open"),"Files should start open"
    for section in ["inventory-section","metadata-section","references-section"]:
        assert not frame.locator("#"+section).evaluate("element=>element.open"),f"{section} should start collapsed"
    expect(frame.locator("#export-csv")).to_be_visible()
    expect(frame.locator("#export-csv")).to_be_enabled()
    return {"files":True,"inventory":False,"metadata":False,"references":False}


def assert_section_collapse(frame):
    selected=frame.locator("#viewport").get_attribute("data-loaded-attachment")
    for section,content in [("files-section","package-files"),("inventory-section","inventory-summary"),("metadata-section","metadata-fields")]:
        details=frame.locator("#"+section)
        original=details.evaluate("element=>element.open")
        section_open(frame,section)
        details.locator("summary").first.click()
        expect(frame.locator("#"+content)).not_to_be_visible()
        assert frame.locator("#viewport").get_attribute("data-loaded-attachment")==selected,"Section collapse changed selected image"
        details.locator("summary").first.click()
        expect(frame.locator("#"+content)).to_be_visible()
        if not original:details.locator("summary").first.click()
    return True



def check_pane_toggles(frame):
    selected=frame.locator("#viewport").get_attribute("data-loaded-attachment")
    for close_id,reopen_id,panel in [("toggle-navigation","show-navigation",".source-panel"),("toggle-details","show-details","#details-panel")]:
        close=frame.locator("#"+close_id)
        assert close.get_attribute("title") and close.get_attribute("aria-label"),"Pane icon lacks accessible labels"
        expect(close.locator("svg")).to_have_count(1)
        close.click();expect(frame.locator(panel)).not_to_be_visible()
        expect(frame.locator("#export-csv")).to_be_visible()
        reopen=frame.locator("#"+reopen_id);expect(reopen).to_be_visible();reopen.click()
        expect(frame.locator(panel)).to_be_visible()
        assert frame.locator("#viewport").get_attribute("data-loaded-attachment")==selected,"Pane toggle changed selected image"
    return {"leftRoundtrip":True,"rightRoundtrip":True,"selectedImagePreserved":True}


def check_layout_widths(page, frame, report):
    checked=[]
    for width,left,right in [(1440,300,360),(1100,264,324)]:
        page.set_viewport_size({"width":width,"height":1000});settle(page)
        sizes=frame.evaluate("({left:document.querySelector('.source-panel').getBoundingClientRect().width,right:document.querySelector('#details-panel').getBoundingClientRect().width,viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})")
        assert abs(sizes["left"]-left)<1 and abs(sizes["right"]-right)<1,f"Unexpected widened panels: {sizes}"
        assert sizes["scroll"]<=sizes["viewport"],"Desktop layout overflows horizontally"
        checked.append({"width":width,"leftPanel":sizes["left"],"rightPanel":sizes["right"]})
        page.screenshot(path=str(report/f"layout-{width}.png"))
    page.set_viewport_size({"width":700,"height":900});settle(page)
    sizes=frame.evaluate("({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})")
    assert sizes["scroll"]<=sizes["width"],"Narrow layout overflows horizontally"
    page.screenshot(path=str(report/"layout-700.png"))
    page.set_viewport_size({"width":1440,"height":1000});settle(page)
    return checked


def check_attachment_previews(page, extension_id, source, report):
    fixture=report/"attachment-previews.pdf"
    expected=preview_fixture(source,fixture)
    page.goto(fixture.as_uri(),wait_until="domcontentloaded")
    frame=viewer_frame(page,extension_id);manifest,_=manifest_for(fixture);check_initial(page,frame,manifest)
    assert_section_collapse(frame)
    attachments=PdfReader(fixture).attachments
    assert frame.locator('.package-file[data-attachment]').count()==len(attachments)
    original=manifest["images"][first_supported(manifest)]["attachment"]
    source_view=frame.locator(f'button[data-view-attachment="{original}"]')
    assert source_view.get_attribute("title") and source_view.get_attribute("aria-label"),"View icon lacks accessible labels"
    expect(source_view.locator("svg")).to_have_count(1)
    source_view.click()
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment",original)
    checked=[]
    for name,data in expected.items():
        view=frame.locator(f'button[data-view-attachment="{name}"]')
        if name.endswith('.bin'):
            assert view.count()==0 or view.is_disabled(),"Opaque binary offered an unsafe preview"
            with page.expect_download() as event:
                frame.locator(f'button[data-download-attachment="{name}"]').click()
            recovered=report/'downloads'/name;event.value.save_as(recovered)
            assert recovered.read_bytes()==data
            checked.append({"name":name,"downloadOnly":True})
            continue
        assert view.get_attribute("title") and view.get_attribute("aria-label"),"View icon lacks accessible labels"
        expect(view.locator("svg")).to_have_count(1)
        view.click()
        expect(frame.locator("#attachment-view")).to_be_visible()
        expect(frame.locator("#attachment-title")).to_contain_text(name)
        content=frame.locator("#attachment-content")
        if name.endswith('.png'):
            expect(content.locator('img')).to_be_visible()
            assert content.locator('img').evaluate('image=>image.complete&&image.naturalWidth>0'),"PNG preview did not decode"
        elif name.endswith('.pdf'):
            expect(content.locator('canvas')).to_be_visible()
        else:
            text=content.inner_text()
            if name.endswith('.html'):
                if content.locator('iframe').count():
                    element=content.locator('iframe').element_handle()
                    sandbox=element.get_attribute('sandbox')
                    assert sandbox is not None and 'allow-scripts' not in sandbox.split(),"HTML iframe permits scripts"
                    child=element.content_frame()
                    assert child is not None and 'Preview fixture' in child.locator('body').inner_text()
                    assert child.evaluate('window.__attachmentScriptRan') is None,"Sandboxed HTML script executed"
                else:
                    assert 'Preview fixture' in text
                    assert not content.locator('script').count(),"HTML was inserted into the live extension DOM"
                assert frame.evaluate('window.__attachmentScriptRan') is None,"HTML attachment script executed"
            else:
                assert text.strip()==data.decode('utf-8').strip(),f"Text preview differs: {name}"
        checked.append({"name":name,"previewed":True})
        page.screenshot(path=str(report/("attachment-"+name+".png")))
        frame.locator("#close-attachment").click()
        expect(frame.locator("#attachment-view")).not_to_be_visible()
        expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment",original)
    return {"files":checked,"collapsibleSections":True,"htmlScriptsExecuted":False}


def check_extension_icons(extension):
    manifest=json.loads((extension/"manifest.json").read_text())
    checked={}
    mappings=[manifest.get("icons",{}),manifest.get("action",{}).get("default_icon",{})]
    assert mappings[0],"Extension has no packaged icons"
    for mapping in mappings:
        if isinstance(mapping,str):mapping={"default":mapping}
        for size,name in mapping.items():
            path=(extension/name).resolve()
            assert path.is_relative_to(extension) and path.is_file(),"Icon is not packaged locally"
            data=path.read_bytes();assert data.startswith(b"\x89PNG\r\n\x1a\n"),"Icon is not a PNG"
            width,height=struct.unpack(">II",data[16:24])
            if size!="default":assert width==height==int(size),f"Icon size mismatch: {name}"
            checked[name]={"width":width,"height":height}
    return checked


def sidecar_absent_fixture(source, destination):
    package=PdfWriter(clone_from=source)
    names=package._root_object["/Names"]["/EmbeddedFiles"]["/Names"]
    manifest=json.loads(PdfReader(source).attachments["manifest.json"][0])
    manifest.get("artifactSha256",{}).pop("dicom-metadata.json",None)
    # A distinct same-length synthetic PatientID proves export reparses this
    # original instead of reusing the previous document's sidecar/cache.
    selected=manifest["images"][first_supported(manifest)]
    old=selected.get("fields",{}).get("PatientID")
    source_change={}
    if old:
        original=PdfReader(source).attachments[selected["attachment"]][0]
        assert original.count(old.encode("ascii"))==1
        marker=("CSV-FALLBACK-"+"X"*len(old))[:len(old)]
        changed_original=original.replace(old.encode("ascii"),marker.encode("ascii"),1)
        selected["fields"]["PatientID"]=marker
        selected["sha256"]=hashlib.sha256(changed_original).hexdigest()
        source_change[selected["attachment"]]=changed_original
    for index in range(len(names)-2,-1,-2):
        if str(names[index])=="dicom-metadata.json":del names[index:index+2]
    raw=json.dumps(manifest,ensure_ascii=False,indent=2).encode("utf-8")
    changed={"manifest.json":raw,"manifest.sha256":(hashlib.sha256(raw).hexdigest()+"  manifest.json\n").encode("ascii"),**source_change}
    for index in range(0,len(names),2):
        name=str(names[index])
        if name in changed:
            stream=DecodedStreamObject();stream.set_data(changed[name]);reference=package._add_object(stream)
            names[index+1].get_object()["/EF"][NameObject("/F")]=reference
            names[index+1].get_object()["/EF"][NameObject("/UF")]=reference
    with destination.open("wb") as output:package.write(output)
    assert "dicom-metadata.json" not in PdfReader(destination).attachments


CSV_IDENTITY_COLUMNS=["Source file","Attachment","SOP Instance UID","SHA-256"]
CSV_SOURCE_COLUMNS=CSV_IDENTITY_COLUMNS+["Metadata status","Metadata diagnostics"]


def csv_source_header(keyword,path):
    return f"{keyword} [{path}]"


def export_csv(page, frame, output, images="selected", paths=None, layout="columns"):
    section_open(frame,"metadata-section")
    frame.locator("#export-csv").click()
    expect(frame.locator("#metadata-export-dialog")).to_be_visible()
    expect(frame.locator("#export-csv-layout")).to_have_value("columns")
    if layout!="columns":frame.locator("#export-csv-layout").select_option(layout)
    if images!="selected":frame.locator("#export-image-scope").select_option(images)
    expect(frame.locator("#export-csv-confirm")).to_be_enabled(timeout=30000)
    if paths is not None:
        frame.locator("#export-field-scope").select_option("selected")
        frame.locator("#export-metadata-fields").select_option(paths)
    with page.expect_download() as event:frame.locator("#export-csv-confirm").click()
    output.parent.mkdir(parents=True,exist_ok=True);event.value.save_as(output)
    with output.open(encoding="utf-8-sig",newline="") as stream:
        reader=csv.DictReader(stream);rows=list(reader)
    if layout=="rows":
        expected=CSV_IDENTITY_COLUMNS+["Path","Tag","Keyword","VR","Value","Encoding"]
        assert reader.fieldnames==expected,"Detailed CSV field mapping/header changed"
    else:
        assert reader.fieldnames[:len(CSV_SOURCE_COLUMNS)]==CSV_SOURCE_COLUMNS,"Metadata-column CSV lacks source identity or diagnostic columns"
        assert len(reader.fieldnames)==len(set(reader.fieldnames)),"Metadata-column CSV has duplicate headers"
        assert len(reader.fieldnames)>len(CSV_SOURCE_COLUMNS),"Export everything contains only identity headers, without metadata columns"
    return rows


def check_metadata_field_buttons(page, frame, report):
    # The export entry point must work while the metadata disclosure is closed.
    section=frame.locator("#metadata-section")
    if section.evaluate("element=>element.open"):
        section.locator("summary").first.click()
    restore=[]
    for close_id,open_id,panel in [("toggle-navigation","show-navigation",".source-panel"),("toggle-details","show-details","#details-panel")]:
        if frame.locator(panel).is_visible():
            frame.locator("#"+close_id).click();restore.append(open_id)
    expect(frame.locator("#export-csv")).to_be_visible()
    frame.locator("#export-csv").click()
    expect(frame.locator("#export-csv-confirm")).to_be_enabled()
    field_list=frame.locator("#export-metadata-fields")
    count=field_list.locator("option").count()
    assert count>0,"Metadata field selector is empty"
    frame.locator("#export-fields-none").click()
    expect(frame.locator("#export-field-scope")).to_have_value("selected")
    assert field_list.evaluate("element=>element.selectedOptions.length")==0
    frame.locator("#export-csv-confirm").click()
    expect(frame.locator("#metadata-export-dialog")).to_be_visible()
    expect(frame.locator("#export-csv-status")).to_contain_text("Select one or more metadata fields")
    frame.locator("#export-fields-all").click()
    expect(field_list).to_be_enabled()
    assert field_list.evaluate("element=>element.selectedOptions.length")==count
    with page.expect_download() as event:
        frame.locator("#export-csv-confirm").click()
    output=report/"downloads"/"metadata-select-all-control.csv"
    output.parent.mkdir(parents=True,exist_ok=True);event.value.save_as(output)
    with output.open(encoding="utf-8-sig",newline="") as stream:
        reader=csv.DictReader(stream);rows=list(reader)
    assert len(rows)==1,"Default CSV must have one row for the selected original"
    assert len(reader.fieldnames)>len(CSV_SOURCE_COLUMNS),"Select all exported no metadata columns"
    check_exported_selected_original(rows,selected_original_values(frame))
    for open_id in restore:
        frame.locator("#"+open_id).click()
    return {"toolbarVisibleWithMetadataCollapsed":True,"clearSelection":True,
            "toolbarVisibleWithBothPanesClosed":True,"emptySelectionRefused":True,
            "selectAllRows":len(rows),"selectAllColumns":len(reader.fieldnames)}


def selected_original_values(frame):
    return frame.locator("#metadata-fields").evaluate("""element => Object.fromEntries(
      [...element.querySelectorAll('dt')].map(term => [term.textContent,term.nextElementSibling.textContent]))""")


def check_exported_selected_original(rows, expected):
    if rows and "Metadata status" in rows[0]:
        assert len(rows)==1,"Selected original must occupy one metadata-column CSV row"
        row=rows[0]
        for label,value in expected.items():
            safe="'"+value if re.match(r"^\s*[=+@-]|^[\t\r\n]",value) else value
            assert label in row,f"Selected-original column omitted: {label}"
            assert row[label]==safe,f"Selected-original column differs: {label}"
        return len(expected)
    context=[row for row in rows if row["Encoding"]=="package-context"]
    by_label={row["Keyword"]:row for row in context}
    assert len(by_label)==len(context),"Selected-original CSV context has duplicate labels"
    assert set(by_label)==set(expected),"CSV does not include every field shown under Selected original"
    for label,value in expected.items():
        row=by_label[label]
        # Spreadsheet-safe CSV prefixes dangerous cell values; the displayed
        # source value and original DICOM remain unchanged.
        safe="'"+value if re.match(r"^\s*[=+@-]|^[\t\r\n]",value) else value
        assert row["Value"]==safe,f"Selected-original value differs in CSV: {label}"
        assert row["Path"]=="package/selected-original/"+label
        assert not row["Tag"] and not row["VR"],"Package context was assigned a fictitious DICOM tag or VR"
    return len(context)


def check_metadata_exports(page, frame, source, manifest, report):
    selected_index=int(frame.locator("#image-list").input_value())
    selected=manifest["images"][selected_index]
    selected_context=selected_original_values(frame)
    rows=export_csv(page,frame,report/"downloads"/"metadata-selected.csv")
    assert len(rows)==1,"Selected-source CSV should contain one image row"
    for row in rows:
        assert row["Source file"]==selected["sourcePath"] and row["Attachment"]==selected["attachment"]
        assert row["SOP Instance UID"]==(selected.get("sopInstanceUID") or "") and row["SHA-256"]==selected["sha256"]
    expected_id=selected["fields"].get("PatientID")
    patient_path="dataset/(0010,0020)"
    patient_column=csv_source_header("PatientID",patient_path)
    if expected_id is not None:
        assert rows[0].get(patient_column)==expected_id,"Known source PatientID differs in metadata-column CSV"
    selected_context_count=check_exported_selected_original(rows,selected_context)
    context_path="package/selected-original/PDF reference page"
    filtered=export_csv(page,frame,report/"downloads"/"metadata-filtered.csv",paths=[patient_path,context_path])
    assert len(filtered)==1 and set(filtered[0])==set(CSV_SOURCE_COLUMNS+[patient_column,"PDF reference page"]),"Selected metadata filter leaked or omitted columns"
    assert filtered[0][patient_column]==expected_id
    assert filtered[0]["PDF reference page"]==str(selected["referencePage"])
    detailed=export_csv(page,frame,report/"downloads"/"metadata-detailed.csv",layout="rows")
    assert any(row["Tag"]=="(0010,0020)" and row["Keyword"]=="PatientID" and row["Value"]==expected_id for row in detailed),"Detailed tag rows omitted actual source metadata"
    check_exported_selected_original(detailed,selected_context)
    # Capture the actual UI values for every original. This independently
    # catches an export accidentally reusing the selected file's context for
    # all sources or substituting display defaults for original metadata.
    expected_context={}
    for index,entry in enumerate(manifest["images"]):
        frame.locator("#image-list").select_option(str(index))
        expect(frame.locator("#selected-source")).to_have_text(entry["sourcePath"])
        # Availability is live state. Capture it after the requested source has
        # been checked, rather than the initial Not checked paint before decode.
        expect(frame.locator("#metadata-fields dt").filter(has_text=re.compile(r"^Interactive display$")).locator("+ dd")).not_to_have_text("Not checked")
        expected_context[entry["sourcePath"]]=selected_original_values(frame)
    frame.locator("#image-list").select_option(str(selected_index))
    expect(frame.locator("#viewport")).to_have_attribute("data-loaded-attachment",selected["attachment"])
    all_rows=export_csv(page,frame,report/"downloads"/"metadata-all.csv",images="all")
    by_source={entry["sourcePath"]:entry for entry in manifest["images"]}
    assert len(all_rows)==len(manifest["images"]),"All-image CSV must contain one row per supplied original"
    assert {row["Source file"] for row in all_rows}==set(by_source),"All-image export omitted supplied sources or unreadable markers"
    for row in all_rows:
        entry=by_source[row["Source file"]]
        assert row["Attachment"]==entry["attachment"] and row["SHA-256"]==entry["sha256"]
    all_context_count=0
    for name,expected in expected_context.items():
        all_context_count+=check_exported_selected_original([row for row in all_rows if row["Source file"]==name],expected)
    unreadable=[row for row in all_rows if row["Metadata status"] in {"partial","unreadable"}]
    expected_unreadable={entry["sourcePath"] for entry in manifest["images"] if not entry.get("fields")}
    assert expected_unreadable<={row["Source file"] for row in unreadable},"Corrupt metadata lacked explicit export status"
    assert all(row["Metadata diagnostics"] for row in unreadable),"Unreadable image row hides its diagnostic"
    all_filtered=export_csv(page,frame,report/"downloads"/"metadata-all-filtered.csv",images="all",paths=[patient_path])
    assert len(all_filtered)==len(all_rows),"Field filtering removed originals with missing metadata"
    for row in all_filtered:
        assert set(row)==set(CSV_SOURCE_COLUMNS+[patient_column]),"All-source field filtering leaked metadata columns"
        if row["Source file"] in expected_unreadable:assert row["Metadata diagnostics"],"Field filtering hid unreadable-source diagnostics"
    sidecar="dicom-metadata.json" in PdfReader(source).attachments
    compatibility=report/"metadata-sidecar-absent.pdf";sidecar_absent_fixture(source,compatibility)
    identity=frame.url.split('/')[2]
    page.goto(compatibility.as_uri(),wait_until="domcontentloaded")
    fallback_manifest=manifest_for(compatibility)[0]
    frame=viewer_frame(page,identity);check_initial(page,frame,fallback_manifest)
    fallback_expected=fallback_manifest["images"][first_supported(fallback_manifest)]["fields"].get("PatientID")
    fallback_rows=export_csv(page,frame,report/"downloads"/"metadata-direct-dicom.csv",paths=[patient_path])
    assert len(fallback_rows)==1 and fallback_rows[0][patient_column]==fallback_expected,"Sidecar-absent original-DICOM export differs"
    return {"selectedSourceRows":len(rows),"allSourceRows":len(all_rows),"sourceCount":len(by_source),
            "defaultLayout":"columns","metadataColumns":len(rows[0]),"allMetadataColumns":len(all_rows[0]),"detailedTagRows":len(detailed),
            "selectedOriginalContextRows":selected_context_count,"allOriginalContextRows":all_context_count,
            "filteredPaths":[patient_path,context_path],"explicitUnreadableSources":len(expected_unreadable),
            "creatorSidecarUsed":sidecar,"directDicomFallback":True,"allSelectedOriginalValuesExported":True}


def check_corrupt_metadata_export(page, extension_id, source, report):
    if "dicom-metadata.json" not in PdfReader(source).attachments:
        return False
    altered = report / "altered-metadata-inventory.pdf"
    altered_resource_pdf(source, altered, "dicom-metadata.json")
    page.goto(altered.as_uri(), wait_until="domcontentloaded")
    frame = viewer_frame(page, extension_id)
    check_initial(page, frame, manifest_for(altered)[0])
    section_open(frame, "metadata-section")
    frame.locator("#export-csv").click()
    expect(frame.locator("#metadata-export-dialog")).to_be_visible()
    expect(frame.locator("#export-csv-status")).to_contain_text("SHA-256 mismatch")
    expect(frame.locator("#export-csv-confirm")).to_be_disabled()
    page.screenshot(path=str(report / "corrupt-metadata-inventory-refused.png"))
    frame.locator("#export-csv-cancel").click()
    return True


def check_duplicate_uid_csv(page,frame,manifest,report):
    rows=export_csv(page,frame,report/"downloads"/"metadata-duplicate-instance-ids.csv",images="all")
    assert len(rows)==len(manifest["images"]),"Duplicate instance IDs merged exported source rows"
    assert {row["Attachment"] for row in rows}=={entry["attachment"] for entry in manifest["images"]}
    checked={}
    for uid,attachments in manifest.get("duplicateInstanceUIDs",{}).items():
        matches=[row for row in rows if row["SOP Instance UID"]==uid]
        assert len(matches)==len(attachments),"Duplicate instance UID lost an original CSV row"
        assert {row["Attachment"] for row in matches}==set(attachments),"Duplicate UID source identities were combined"
        checked[uid]=len(matches)
    return {"sourceRows":len(rows),"duplicateInstanceUIDs":checked,"sourcesRemainDistinct":True}


def check_preview_order(page, frame, source):
    schema = PdfReader(source).attachments["profile.json"][0]
    frame.evaluate("""size => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      window.__restoreDigest = () => { crypto.subtle.digest = original; };
      window.__heldDigest = false;
      crypto.subtle.digest = function(algorithm, bytes) {
        if (!window.__heldDigest && bytes.byteLength === size) {
          window.__heldDigest = true;
          return new Promise((resolve,reject) => {
            window.__releaseDigest = () => original(algorithm,bytes).then(resolve,reject);
          });
        }
        return original(algorithm,bytes);
      };
    }""", len(schema))
    try:
        frame.locator('button[data-view-attachment="profile.json"]').click()
        frame.wait_for_function("() => window.__heldDigest === true")
        frame.locator('button[data-view-attachment="field-mapping.json"]').click()
        expect(frame.locator("#attachment-title")).to_contain_text("field-mapping.json")
        frame.evaluate("window.__releaseDigest()")
        expect(frame.locator('button[data-view-attachment="profile.json"]')).to_be_enabled()
        expect(frame.locator("#attachment-title")).to_contain_text("field-mapping.json")
        assert "field-mapping.json" in frame.locator("#status").inner_text()
        frame.locator("#close-attachment").click()
    finally:
        frame.evaluate("window.__restoreDigest()")
    return {"delayedEarlierShaCannotReplaceLaterView": True}


def check_metadata_scope_race(page, frame, manifest, report):
    selected = manifest["images"][int(frame.locator("#image-list").input_value())]
    # Prewarm the sidecar/cache, then hold an old one-source request exactly at
    # its final event-loop yield while the newer all-source request completes.
    export_csv(page, frame, report / "downloads" / "metadata-race-warmup.csv")
    frame.locator("#export-csv").click()
    expect(frame.locator("#export-csv-confirm")).to_be_enabled()
    frame.evaluate("""() => {
      const original = window.setTimeout.bind(window);
      window.__restoreExportTimeout = () => { window.setTimeout = original; };
      window.__heldExportYield = false;
      window.setTimeout = function(callback, delay, ...args) {
        if (delay === 0 && !window.__heldExportYield) {
          window.__heldExportYield = true;
          window.__releaseExportYield = () => callback(...args);
          return -1;
        }
        return original(callback,delay,...args);
      };
      const scope = document.getElementById('export-image-scope');
      scope.value = 'selected'; scope.dispatchEvent(new Event('change'));
    }""")
    try:
        frame.wait_for_function("() => window.__heldExportYield === true")
        frame.locator("#export-image-scope").select_option("all")
        expect(frame.locator("#export-csv-status")).to_contain_text(f'{len(manifest["images"])} source files')
        expect(frame.locator("#export-csv-confirm")).to_be_enabled()
        frame.evaluate("window.__releaseExportYield()")
        settle(page)
        expect(frame.locator("#export-csv-status")).to_contain_text(f'{len(manifest["images"])} source files')
        with page.expect_download() as event:
            frame.locator("#export-csv-confirm").click()
        output = report / "downloads" / "metadata-race-all.csv"; event.value.save_as(output)
        with output.open(encoding="utf-8-sig", newline="") as stream:
            all_rows = list(csv.DictReader(stream))
        assert {row["Source file"] for row in all_rows} == {entry["sourcePath"] for entry in manifest["images"]}
    finally:
        frame.evaluate("window.__restoreExportTimeout()")
    frame.locator("#export-csv").click()
    expect(frame.locator("#export-csv-confirm")).to_be_enabled()
    frame.evaluate("""() => {
      const scope = document.getElementById('export-image-scope');
      for (const value of ['selected','all','selected']) {
        scope.value=value; scope.dispatchEvent(new Event('change'));
      }
    }""")
    expect(frame.locator("#export-csv-status")).to_contain_text("1 source file")
    expect(frame.locator("#export-csv-confirm")).to_be_enabled()
    with page.expect_download() as event:
        frame.locator("#export-csv-confirm").click()
    output = report / "downloads" / "metadata-race-selected.csv"; event.value.save_as(output)
    with output.open(encoding="utf-8-sig", newline="") as stream:
        selected_rows = list(csv.DictReader(stream))
    assert selected_rows and all(row["Attachment"] == selected["attachment"] for row in selected_rows)
    return {"delayedOldSelectedCannotReplaceAllSources": True,
            "rapidSelectedAllSelectedUsesLastScope": True,
            "allSourceCount": len(manifest["images"]), "selectedSourceRows": len(selected_rows)}


def check_series_grouping(page, extension_id, source, report):
    manifest, _ = manifest_for(source)
    entries, references = manifest["images"], manifest["references"]
    expected_groups = {}
    for reference in references:
        key = (reference["status"], reference.get("sopInstanceUID"), reference.get("sopClassUID"))
        expected_groups.setdefault(key, []).append(reference)
    page.goto(source.resolve().as_uri(), wait_until="domcontentloaded", timeout=120000)
    frame = viewer_frame(page, extension_id, timeout=120000)
    index = check_initial(page, frame, manifest)
    assert index is not None
    # The supplied README may be listed too; every DICOM source must remain in
    # the left inventory independently of grouped, absent reference targets.
    expect(frame.locator("#image-list option")).to_have_count(len(entries))
    assert all(entry["attachment"] in frame.locator("#package-files").inner_text() for entry in entries)
    assert frame.locator("#details-panel .detail-section").last.get_attribute("id") == "references-section"
    section_open(frame, "references-section")
    groups = frame.locator("#references-list > li[data-reference-status]")
    expect(groups).to_have_count(len(expected_groups))
    counts = []
    for (status, uid, _), occurrences in expected_groups.items():
        row = groups.filter(has_text=uid).first
        expect(row).to_have_attribute("data-reference-status", status)
        sources = {reference["sourceAttachment"] for reference in occurrences}
        assert f"{len(sources)} referring files" in row.inner_text()
        assert f"{len(occurrences)} references" in row.inner_text()
        row.locator("details > summary").click()
        expect(row.locator("details > ul > li")).to_have_count(len(sources))
        assert row.inner_text().count("(embedded)") == len(sources)
        for reference in occurrences:
            assert reference["sequencePath"] in row.inner_text()
        row.locator("details > summary").click()
        counts.append({"status": status, "referringFiles": len(sources), "references": len(occurrences)})
    viewport = frame.locator("#viewport")
    initial = viewport.get_attribute("data-loaded-attachment")
    box = viewport.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    settle(page)
    for delta in (120, -120):
        page.mouse.wheel(0, delta)
        page.wait_for_timeout(250)
        if viewport.get_attribute("data-loaded-attachment") != initial:
            break
    selected = entries[int(frame.locator("#image-list").input_value())]
    assert selected["attachment"] != initial, "Wheel did not change the selected CT slice"
    frame.locator("#show-pdf").click()
    expect(frame.locator("#page-number")).to_have_value(str(selected["referencePage"]))
    expect(frame.locator("#pdf-canvas")).to_be_visible()
    frame.locator("#show-image").click()
    expect(viewport).to_have_attribute("data-loaded-attachment", selected["attachment"])
    page.screenshot(path=str(report / ("grouped-references-" + source.stem + ".png")))
    return {"file": source.name, "suppliedFiles": len(entries),
            "dicomSources": sum(entry["sourcePath"].lower().endswith(".dcm") for entry in entries),
            "referenceRecords": len(references), "referenceGroups": counts,
            "allSourcesRetained": True, "referencesLastDisclosure": True,
            "wheelSelectionPdfPageMatches": True}


def check_spec_display(page, extension_id, source, report):
    manifest,_=manifest_for(source)
    page.goto(source.resolve().as_uri(),wait_until="domcontentloaded")
    frame=viewer_frame(page,extension_id);check_initial(page,frame,manifest)
    checked=[]
    for index,entry in enumerate(manifest["images"]):
        frame.locator("#image-list").select_option(str(index))
        item={"sourcePath":entry["sourcePath"],"pdfPreview":entry["status"]=="rendered"}
        if entry["status"]!="rendered":
            expect(frame.locator("#download-original")).to_be_enabled()
            item["reason"]=entry.get("reason")
            checked.append(item);continue
        viewport=frame.locator("#viewport")
        expect(viewport).to_have_attribute("data-loaded-attachment",entry["attachment"])
        recipe=entry["displayAdjustments"]
        for key,dataset in [("windowCenter","data-window-center"),("windowWidth","data-window-width")]:
            actual=float(viewport.get_attribute(dataset));expected=float(recipe[key])
            assert abs(actual-expected)<=1e-6*max(1,abs(expected)),f"Spec display {key} differs: {entry['sourcePath']}"
        item["windowMethod"]=recipe["windowMethod"]
        item["windowCenter"]=float(viewport.get_attribute("data-window-center"))
        item["windowWidth"]=float(viewport.get_attribute("data-window-width"))
        if recipe.get("geometryMethod")=="source-aspect-v1":
            settle(page)
            bounds=viewport.locator("canvas").first.evaluate("""canvas => {
              const {width,height}=canvas, pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
              let left=width,top=height,right=-1,bottom=-1;
              for(let y=0;y<height;y++)for(let x=0;x<width;x++){
                const offset=(y*width+x)*4;
                if(Math.max(pixels[offset],pixels[offset+1],pixels[offset+2])>12){
                  left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
                }
              }
              return {left,top,width:right-left+1,height:bottom-top+1};
            }""")
            assert bounds["width"]>0 and bounds["height"]>0,"Non-square fixture has no visible image pixels"
            row,column=map(float,recipe["pixelAspectRatio"].split(":"))
            expected=float(entry["fields"]["Columns"])*column/(float(entry["fields"]["Rows"])*row)
            actual=bounds["width"]/bounds["height"]
            assert abs(actual-expected)<=0.08*expected,f"Visible image aspect differs: {entry['sourcePath']} {actual} != {expected}"
            item.update({"sourceAspectVerified":True,"geometrySource":recipe["geometrySource"],
                         "expectedImageAspect":expected,"actualImageAspect":actual,"visibleBounds":bounds})
        page.screenshot(path=str(report/("spec-display-"+entry["sourcePath"].replace('/','-')+".png")))
        checked.append(item)
    assert any(item.get("windowMethod")=="auto-min-max-padding-v2" for item in checked),"Spec fixture has no padding-aware automatic window"
    assert any(item.get("sourceAspectVerified") for item in checked),"Spec fixture has no non-square source aspect"
    return {"file":source.name,"images":checked,"paddingAndRelativeAspectChecked":True}


def launch(playwright, executable, extension, profile):
    return playwright.chromium.launch_persistent_context(
        str(profile), executable_path=executable, headless=True, accept_downloads=True,
        ignore_default_args=["--disable-extensions"],
        args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}", "--no-sandbox"],
        viewport={"width": 1440, "height": 1000}, timeout=30000)


def extension_identity(context):
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
    return worker.url.split("/")[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, default=Path("target/chrome-extension"))
    parser.add_argument("--pdf", type=Path, default=Path("target/viewer-test-pdfs/sample-images.pdf"))
    parser.add_argument("--sources", type=Path, default=Path("fixtures/synthetic"))
    parser.add_argument("--mixed", type=Path, default=Path("target/viewer-test-pdfs/startup-mixed.pdf"))
    parser.add_argument("--all-rejected", type=Path, default=Path("target/viewer-test-pdfs/startup-all-rejected.pdf"))
    parser.add_argument("--all-rejected-sources", type=Path, default=Path("target/startup-all-rejected-input"))
    parser.add_argument("--references", type=Path, default=Path("target/viewer-test-pdfs/reference-cases.pdf"))
    parser.add_argument("--expanded", type=Path, default=Path("target/viewer-test-pdfs/expanded-formats.pdf"))
    parser.add_argument("--supplied-pdf", type=Path, nargs="*", default=[])
    parser.add_argument("--supplied-sources", type=Path, default=Path("in"))
    parser.add_argument("--series-pdf", type=Path, nargs="*", default=[], help="Optional whole-series reference grouping and PDF-page sync checks")
    parser.add_argument("--spec-pdf", type=Path, help="Optional synthetic padding and non-square image-aspect PDF")
    parser.add_argument("--chromium", default="/snap/chromium/current/usr/lib/chromium-browser/chrome")
    parser.add_argument("--legacy-chromium", help="Optional older Chromium executable for file-picker fallback")
    parser.add_argument("--report", type=Path, default=Path("target/extension-verification"))
    args = parser.parse_args()
    extension = args.extension.resolve(strict=True)
    args.report.mkdir(parents=True, exist_ok=True)
    report = args.report.resolve()
    icon_assets=check_extension_icons(extension)
    result = {"iconAssets":icon_assets,"offline": True, "browserErrors": [], "httpRequests": [], "cases": [],
              "extensionAssets": {name: hashlib.sha256((extension / name).read_bytes()).hexdigest() for name in ["manifest.json", "viewer.js", "viewer.css", "pdf.worker.mjs"]}}
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix="profile-", dir=report) as profile:
        context = launch(p, args.chromium, extension, profile)
        try:
            result["browserVersion"] = context.browser.version
            assert int(context.browser.version.split(".")[0]) >= 151, "Chrome 151+ required for actual MIME-handler tests"
            extension_id = extension_identity(context)
            result["extensionId"] = extension_id
            context.set_offline(True)
            page = context.pages[0]
            page.on("pageerror", lambda error: result["browserErrors"].append(str(error)))
            page.on("request", lambda request: result["httpRequests"].append(request.url) if request.url.startswith(("https:", "http:")) else None)
            for label, pdf in [("baseline", args.pdf), ("mixed", args.mixed), ("all-rejected", args.all_rejected), ("references", args.references), ("expanded", args.expanded)]:
                if not pdf.exists():
                    continue
                manifest, raw_manifest = manifest_for(pdf)
                attachment_bytes = PdfReader(pdf).attachments
                page.goto(pdf.resolve().as_uri(), wait_until="domcontentloaded")
                frame = viewer_frame(page, extension_id)
                index = check_initial(page, frame, manifest)
                check_extension_shell(frame, len(attachment_bytes), extension)
                case = {"case": label, "automaticMimeHandler": True,
                        "initialAttachment": manifest["images"][index]["attachment"] if index is not None else None,
                        "pickerUsed": False}
                if index is not None:
                    if label == "baseline":
                        case["sectionDefaults"] = check_section_defaults(frame)
                        case["controls"] = check_controls(page, frame)
                        case["wheelNavigation"] = check_wheel_navigation(page, frame)
                        if not frame.locator("#details-panel").is_visible():
                            frame.locator("#show-details").click()
                        expect(frame.locator("#details-panel")).to_be_visible()
                        section_open(frame,"inventory-section");section_open(frame,"metadata-section")
                        assert str(len(manifest["images"])) in frame.locator("#inventory-summary").inner_text()
                        assert "PDF/A validation" not in frame.locator("body").inner_text(),"Implementation validation wording leaked into the GUI"
                        assert manifest["images"][index]["sopInstanceUID"] in frame.locator("#metadata-fields").inner_text()
                        case["downloads"] = check_downloads(page, frame, manifest, raw_manifest, args.sources.resolve(), report)
                        case["rightPaneDownloads"] = check_file_panel_downloads(page, frame, manifest, attachment_bytes, report)
                        case["packageFileCount"] = len(attachment_bytes)
                        case["detailsVisibleByDefault"] = True
                        case["productName"] = "DICOM PDF Viewer"
                        case["yellowBanner"] = False
                        case["bidirectionalViewSync"] = assert_pdf_preview(page, frame, manifest)
                        case["pdfPreviewNavigation"] = True
                        case["collapsibleSections"] = assert_section_collapse(frame)
                        case["paneToggles"] = check_pane_toggles(frame)
                        case["panelWidths"] = check_layout_widths(page,frame,report)
                        if frame.locator("#export-csv").count():
                            section_open(frame,"files-section");section_open(frame,"metadata-section")
                            case["metadataFieldButtons"] = check_metadata_field_buttons(page,frame,report)
                            case["rapidViewOrder"] = check_preview_order(page,frame,pdf)
                            case["rapidExportScopes"] = check_metadata_scope_race(page,frame,manifest,report)
                            case["metadataCsv"] = check_metadata_exports(page,frame,pdf,manifest,report)
                            page.goto(pdf.resolve().as_uri(),wait_until="domcontentloaded");frame=viewer_frame(page,extension_id);check_initial(page,frame,manifest)
                    if label == "expanded":
                        case["expandedFormats"] = check_expanded_formats(page, frame, manifest, attachment_bytes, report)
                    if label == "references":
                        if not frame.locator("#details-panel").is_visible():
                            frame.locator("#show-details").click()
                        if not frame.locator("#references-section").evaluate("element=>element.open"):
                            frame.locator("#references-section summary").first.click()
                        references=manifest.get("references",[])
                        groups={(r["status"],r.get("sopInstanceUID"),r.get("sopClassUID")) for r in references}
                        expect(frame.locator("#references-list > li[data-reference-status]")).to_have_count(len(groups))
                        for reference in references:
                            rows=frame.locator(f'#references-list > li[data-reference-status="{reference["status"]}"]')
                            row=rows.filter(has_text=reference.get("sopInstanceUID") or "No target instance ID").first
                            expect(row).to_be_visible()
                            if not row.locator("details").evaluate("element=>element.open"):
                                row.locator("details > summary").first.click()
                            assert "(embedded)" in row.inner_text(),"Referring source was not distinguished from missing target"
                            assert reference["sequencePath"] in row.inner_text(),"Actual source metadata path omitted"
                        case["referenceInventory"] = True
                        case["referenceGroups"] = len(groups)
                        frame.locator("#references-section summary").first.click()
                        if manifest.get("duplicateInstanceUIDs"):
                            case["duplicateUidCsv"]=check_duplicate_uid_csv(page,frame,manifest,report)
                else:
                    case["noSupportedImages"] = True
                    if args.all_rejected_sources.is_dir():
                        entry = manifest["images"][0]
                        frame.locator("#image-list").select_option("0")
                        expect(frame.locator("#download-original")).to_be_enabled()
                        with page.expect_download() as event:
                            frame.locator("#download-original").click()
                        recovered = report / "downloads" / ("rejected-" + entry["attachment"])
                        recovered.parent.mkdir(parents=True, exist_ok=True)
                        event.value.save_as(recovered)
                        assert recovered.read_bytes() == (args.all_rejected_sources / entry["sourcePath"]).read_bytes(), "Rejected original download differs"
                        case["rejectedOriginalByteMatch"] = True
                page.screenshot(path=str(report / f"{label}.png"))
                result["cases"].append(case)
            supplied = []
            for pdf in args.supplied_pdf:
                manifest, _ = manifest_for(pdf)
                page.goto(pdf.resolve().as_uri(),wait_until="domcontentloaded")
                frame=viewer_frame(page,extension_id)
                index=check_initial(page,frame,manifest)
                assert index is not None, "Supplied image did not display"
                entry=manifest["images"][index]
                with page.expect_download() as event:
                    frame.locator("#download-original").click()
                output=report/"downloads"/"supplied"/entry["sourcePath"]
                output.parent.mkdir(parents=True,exist_ok=True);event.value.save_as(output)
                master=args.supplied_sources/entry["sourcePath"]
                assert output.read_bytes()==master.read_bytes(), "Supplied original changed during conversion or recovery"
                supplied.append({"file":pdf.name,"sourcePath":entry["sourcePath"],"modality":entry["fields"].get("Modality"),"automaticDisplay":True,"originalByteMatch":True})
                page.screenshot(path=str(report/("supplied-"+pdf.stem+".png")))
            if supplied:result["suppliedImages"]=supplied
            if args.series_pdf:
                result["seriesReferenceGrouping"] = [check_series_grouping(page, extension_id, path, report) for path in args.series_pdf]
            if args.spec_pdf:
                result["specificationDisplay"] = check_spec_display(page,extension_id,args.spec_pdf,report)
            result["attachmentPreviews"]=check_attachment_previews(page,extension_id,args.pdf,report)
            if check_corrupt_metadata_export(page, extension_id, args.pdf, report):
                result["corruptMetadataInventoryExportRefused"] = True
            altered = report / "altered-resource.pdf"
            altered_resource_pdf(args.pdf, altered)
            page.goto(altered.as_uri(), wait_until="domcontentloaded")
            frame = viewer_frame(page, extension_id)
            check_initial(page, frame, manifest_for(altered)[0])
            refused_downloads = []
            page.on("download", lambda download: refused_downloads.append(download.suggested_filename))
            frame.locator('button[data-download-attachment="dicom-xmp.rng"]').click()
            expect(frame.locator("#status")).to_contain_text("SHA-256 mismatch")
            page.wait_for_timeout(250)
            assert not refused_downloads, "Corrupt resource was downloaded despite checksum mismatch"
            result["corruptResourceDownloadRefused"] = True
            frame.locator('button[data-view-attachment="dicom-xmp.rng"]').click()
            expect(frame.locator("#status")).to_contain_text("SHA-256 mismatch")
            expect(frame.locator("#attachment-view")).not_to_be_visible()
            result["corruptResourceViewRefused"] = True
            page.screenshot(path=str(report / "corrupt-resource-refused.png"))
            native_cases = []
            for name in ["ordinary", "ordinary-encrypted", "ordinary-unrelated-manifest"]:
                ordinary = report / f"{name}.pdf"
                writer = PdfWriter(); writer.add_blank_page(width=300, height=300)
                if name == "ordinary-encrypted":
                    writer.encrypt("synthetic-password")
                elif name == "ordinary-unrelated-manifest":
                    writer.add_attachment("manifest.json", b'{"project":"ordinary PDF appendix"}')
                with ordinary.open("wb") as stream:
                    writer.write(stream)
                page.goto(ordinary.as_uri(), wait_until="domcontentloaded")
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    own = [f for f in page.frames if f.url.startswith(f"chrome-extension://{extension_id}/viewer.html")]
                    native = [f for f in page.frames if f.url.startswith("chrome-extension://") and not f.url.startswith(f"chrome-extension://{extension_id}/")]
                    if native and not own:
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError(f"{name} PDF did not fall back to Chrome's native PDF viewer")
                native_cases.append(name)
                page.screenshot(path=str(report / f"{name}-native.png"))
            result["ordinaryPdfNativeFallback"] = True
            result["nativeFallbackCases"] = native_cases
            assert not result["browserErrors"], result["browserErrors"]
            assert not result["httpRequests"], result["httpRequests"]
        finally:
            context.close()
    if args.legacy_chromium:
        with sync_playwright() as p, tempfile.TemporaryDirectory(prefix="legacy-profile-", dir=report) as profile:
            context = launch(p, args.legacy_chromium, extension, profile)
            try:
                extension_id = extension_identity(context)
                context.set_offline(True)
                page = context.pages[0]
                page.goto(f"chrome-extension://{extension_id}/viewer.html")
                page.locator("#pdf-file").set_input_files(args.pdf.resolve())
                manifest, _ = manifest_for(args.pdf)
                index = first_supported(manifest)
                expect(page.locator("#viewport")).to_have_attribute("data-loaded-attachment", manifest["images"][index]["attachment"])
                result["legacyPickerFallback"] = {"version": context.browser.version, "attachment": manifest["images"][index]["attachment"]}
                page.screenshot(path=str(report / "legacy-picker.png"))
            finally:
                context.close()
    assert all(hashlib.sha256((extension / name).read_bytes()).hexdigest() == digest for name, digest in result["extensionAssets"].items()), "Extension assets changed during integration test"
    (report / "extension-checks.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Chrome {result['browserVersion']}: automatic offline MIME viewing, controls, recovery, PDF preview and native fallback passed")


if __name__ == "__main__":
    main()
