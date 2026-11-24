# DICOM PDF Viewer — Chrome extension 0.88.0

The extension reads converted PDF packages locally and displays their unchanged
2D image frames from CT/MR and other DICOM image-storage classes. It shares the pilot's PDF.js, native decoder,
SHA-256/instance checks and Cornerstone controls. All scripts and the PDF worker
are bundled. The viewer downloads public certificates from approved sources
when online timestamp trust is enabled or you enter a certificate URL.
The running viewer version appears in the lower-right status bar, including
narrow windows, so it can be checked after reloading the extension.
JPEG/PNG and other raster previews retain a permanent image-control row below
the image, including zoom, adjustments, rotation, Fit and fullscreen. The Save
menu combines unchanged original files, originals ZIP export and PNG image copies.
DICOM Surface Segmentation attachments open in the **3D surface** tab with
rotation, pan, zoom and reset.

## Install and open a PDF

1. Build with `npm ci --prefix viewer` and `npm run build --prefix viewer`
   from the repository root. The extension build uses Node.js, npm and Python 3.
2. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
3. Select `target/chrome-extension` (the directory containing `manifest.json`).
4. Click the extension icon to open the viewer, then drop `target/viewer-test-pdfs/sample-images.pdf`
   onto the viewer or choose **Open PDF…**. A Loading… dialog stays visible until
   the PDF and initial image are ready, and closes if opening fails.
5. Switch between **Image** and **PDF reference**, choose a source on the left,
   or use the right pane for inventory, source fields, references and individual
   attachment views/downloads. Both panes use chevrons to close and reopen them.
   Selected file metadata opens a separate dialog from the first action in the
   right pane. Other supplied files, Inventory and References are collapsible;
   generated technical files remain hidden and recoverable as PDF
   attachments or through CLI extraction.
   References are grouped by target at the bottom. PDF reference follows the
   selected DICOM image's mapped page; PDF page navigation selects its original
   when switching back. Use **Export metadata…** at the top right for selected/all
   images and selected/all metadata fields.
   Brightness/contrast, zoom, pan and Reset affect the display only. Scroll to
   step through slices/frames; Ctrl+scroll or +/− zooms, and dragging pans. The
   position slider follows the current physical stack or multiframe original.
   The Window menu offers file-provided alternatives; Info toggles image overlays.
   **Save document XMP** is available inside **Export metadata…**.

`target/dicom-pdf-chrome-0.88.0.zip` contains the same installable unpacked files.
This pilot is not published or signed through the Chrome Web Store. Extract the
ZIP before choosing Load unpacked; Chrome does not install that ZIP directly.

PDF drops are handled inside the viewer page. The extension does not register
as a browser-wide PDF handler or inject drop handlers into other pages. PDFs
opened or dropped elsewhere continue to use normal browser handling. Ordinary
PDFs explicitly opened inside this viewer display in its PDF reference tab.

## Explicit toolbar opening

The toolbar button opens the viewer in a full tab. If the active tab is a local
PDF, a random one-use token transfers its location through an extension message
to that specific viewer tab. The source path and filename are never included in
the viewer URL. The token is removed from the address bar on startup; pending
handoffs expire after 60 seconds and are held only in the background worker's
memory, with at most 32 pending. Closing the viewer clears its pending handoff.
Expired, reused or restarted-worker handoffs show **Open PDF** as the recovery
path. No local paths or tokens are written to extension storage or logs.

Only `activeTab` is required at installation. The local `file:///*` host pattern
is declared under `optional_host_permissions` for this toolbar compatibility
route. **Open PDF…** and PDF drops onto the viewer work
without that optional grant. The build also declares the exact approved signing
CA hosts as optional. A certificate download blocked by the site can request
temporary access to that one host through **Allow certificate site**.

When a toolbar handoff needs access, the viewer offers **Enable local PDF access**:

1. Click that button to request the optional local-file grant. Startup never
   displays a permission prompt automatically. Chrome requires the request to
   originate from an explicit user gesture; see its
   [Permissions API guidance](https://developer.chrome.com/docs/extensions/reference/api/permissions#step_3_request_optional_permissions).
2. Chrome also has a separate per-extension **Allow access to file URLs** setting.
   If the viewer says it is disabled, right-click the extension icon, choose
   **Manage extension**, and enable that setting. Return to the same viewer tab
   and click **Enable local PDF access** again, or use **Open PDF** instead. The
   setting is checked through Chrome's
   [file-scheme access API](https://developer.chrome.com/docs/extensions/reference/api/extension#method-isAllowedFileSchemeAccess).
3. Declining or revoking access leaves the file picker available. Every toolbar
   fetch checks both the optional host grant and the separate setting, including
   another check before loading a completed stream. No grant is silently restored.
4. Opening another input immediately hides and invalidates the pending access
   action. A delayed permission reply or old fetch cannot replace the new input.
   Reloaded or expired handoffs recover through **Open PDF**; no source path is
   retained in extension storage to revive them.

The build changes no browser profile. Tests use isolated temporary profiles.
Remote URLs are never automatically fetched by this fallback.

## Scope and recovery

Supported grayscale/color images and individual frames of multi-frame objects
are displayed. JPEG-LS and JPEG2000 originals can be viewed even when the PDF
contains only a diagnostic page. Unsupported/non-image objects retain their
diagnostics and original attachments. The viewer does not certify de-identification. Keep
archival masters and approved de-identified copies in separate packages.

Click the filename to open the security report for original checksums,
supported PDF signatures and timestamps, C2PA, and DICOM PAdES B-LTA revisions.
The viewer can fetch approved timestamp CA certificates. Add the signer’s CA
from a file or an approved HTTPS URL for this tab.
See [browser security verification](../../docs/SECURITY.md#viewer-results).
Use the package's `RECOVERY.txt`, `manifest.json` and Java `extract` command for
viewer-independent recovery.

EA-PDF's viewer was inspected read-only for the compact toolbar, document title,
left navigation, central reading surface, detail panel and explicit local-file
opening patterns. This extension does not reuse EA-PDF email code, rules or its
patched PDF.js build. Distributed dependency licenses and notices accompany the
extension in `THIRD_PARTY_NOTICES.txt`, `LICENSE` and `NOTICE`.

## Tests and output locations

Run `npm run test:extension --prefix viewer` for URL-boundary, single-use,
expiry, tab/sender binding, startup-race and bounded-memory tests. Its 41 unit
tests include optional-grant absence, synchronous click requests, denial,
revocation, Chrome's separate setting, stale transactions, MIME independence and
immediate action hiding for new input intent.
After building, `python3 viewer/extension/check_handoff.py` checks the real
toolbar handoff, filename-free viewer URL, token reuse refusal, picker recovery
and remote-source refusal offline in a temporary Chromium profile.
Browser integration checks and exact tested Chrome versions are reported in the
root verification documentation. Browser checks confirm viewer-local PDF drops,
normal PDF handling outside the viewer and loading-dialog completion/error cleanup.

Only converted PDFs belong in `out/`. Extension builds, ZIPs, screenshots,
reports and recovered originals belong under `target/`.

Official API references:

- [Permission declarations](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Extension content security policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
