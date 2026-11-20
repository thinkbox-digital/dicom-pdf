# Cornerstone integration

Core and Tools remain pinned to **2.19.16**, with MIT notices retained in both
offline builds. Further DICOM validation expansion is deferred. The viewer
supports archival access through standard Cornerstone rendering/manipulation APIs.

| Capability | Current implementation |
| --- | --- |
| Main stack and multiframe navigation | Complete source/frame stacks registered once, lazy verified-original loader, native StackViewport scrolling/index handling |
| Mouse wheel | Standard StackScrollTool with Wheel binding; native target/clamping and request pool |
| Mouse/touch pan and zoom | Standard PanTool/ZoomTool in main and comparison viewports |
| Rotate, invert, fit, zoom buttons and keyboard actions | Thin wrappers around Core viewport/camera methods |
| Window/level and file presets | Stock CPU rendering for ordinary LINEAR windows. The compatibility hook uses Cornerstone lookup for Modality LUTs and sampled VOI tables with equivalent precision. |
| Grayscale presentation states | Cornerstone renders compatible saved LINEAR windows. The viewer applies the saved crop, rotation, reflection and annotations. |
| RT Dose | Cornerstone renders the grid-wide palette from one shade per voxel. The viewer keeps the original dose samples and scaling for numeric readouts. |
| Cine | Existing source-timing/backpressure scheduler drives the real native stack; source/frame and capture semantics retained |
| Pinned comparison | Core StackViewport plus native Pan/Zoom; existing single-frame replacement path retained |
| PDF/XMP, hashes, source/page mapping, metadata export, recovery | Archive application responsibilities; not replaced by imaging tools |

## Complete lazy stacks

Previously each selection called setStack([imageId]); Cornerstone had no series to
scroll. The main viewport now receives the physically sorted series with each
original's frames. IDs include document generation, original array index and
one-based frame; duplicate SOP Instance UIDs remain distinct. Cached stack plans
are reused as frames change. Ordinary navigation uses public scroll/target APIs
rather than resetting the full stack. The native wheel tool is enabled only
for the visible DICOM viewport; Ctrl+wheel retains zoom.

A registered asynchronous loader obtains original bytes through the existing
checksum/worker pipeline, supplies metadata and returns IImage objects. Core owns
its request pool and image cache. Queued or completed requests for obsolete
targets/documents are refused. Decoded data/metadata remain byte bounded, with
currently displayed metadata retained while visible even if its LRU entry leaves
the decoded cache. A separate pinned comparison keeps its own verified source.

The adapter observes the public index promise because the standard wheel path
starts that promise without awaiting it. Application callers still receive
failures; obsolete render waits abort promptly. STACK_NEW_IMAGE precedes CPU
viewport updates in this pinned version, so the application commits its matching
source labels/window settings after those updates in the same microtask turn.
No private Cornerstone viewport fields or patched library files are used.

Catalogs are limited to 20,000 image IDs. Larger groups use the selected original's
stack, or individual frame selection for an original exceeding that limit; other
originals remain accessible in the data list. No original is removed from the
archive. Decoding stays lazy and does not allocate a volume or preload all slices.

## Keyboard ownership

The pinned Tools keyboard listener prevents default behavior for every key.
Application shortcuts run in capture phase; an earlier bubble guard protects
child controls, editable content, composing keys and already-handled actions
without blocking those controls' own target handlers. Native mouse/touch tool
bindings keep their modifier handling. Repeated Space toggles cine only once
per press; leaving/hiding never resumes playback automatically.

## Official documentation and issue review

Reviewed the official [FAQ](https://www.cornerstonejs.org/docs/faq/),
[stack tutorial](https://www.cornerstonejs.org/docs/tutorials/basic-stack/),
[image-loader contract](https://www.cornerstonejs.org/docs/concepts/cornerstone-core/imageloader/),
[custom-loader guide](https://github.com/cornerstonejs/cornerstone3D/blob/main/packages/docs/docs/how-to-guides/custom-imageLoader.md),
and [project scope](https://www.cornerstonejs.org/docs/getting-started/scope/).
These support using full stacks and registered loaders/providers, while keeping
archive ingestion and metadata ownership outside Core. The FAQ discusses the
GPU/offscreen architecture; it is not a requirement to switch this tested 2D CPU
viewer to GPU or add diagnostic/volume tools. Current docs can describe a different
release; decisions were checked against the installed 2.19.16 source/API.

Relevant issue reports reviewed:

- [#2343: CPU setDisplayArea failure](https://github.com/cornerstonejs/cornerstone3D/issues/2343):
  motivates keeping tested Core camera/fit operations; it is not proof that every
  CPU API fails in this pinned version.
- [#2844: truncated VOI LUT function](https://github.com/cornerstonejs/cornerstone3D/issues/2844):
  reports a newer DICOM loader's windowing bug. We do not use that loader/version;
  retain scalar pixel oracles before replacing the nonlinear adapter.
- [#1175: increasing memory while scrolling](https://github.com/cornerstonejs/cornerstone3D/issues/1175):
  an older, closed report; retain explicit cache budgets and measure our own case.
- [#1253: missing image metadata](https://github.com/cornerstonejs/cornerstone3D/issues/1253):
  reinforces keeping decoded metadata available when images enter the viewport;
  its report does not establish the root cause of our application.
- [#1532](https://github.com/cornerstonejs/cornerstone3D/issues/1532) /
  [#1538](https://github.com/cornerstonejs/cornerstone3D/issues/1538):
  worker URL/bundling reports inform explicit local worker packaging and offline tests.

No issue is treated as evidence of a reproduced local bug without tests. No
network loader, CDN code or automatic browser persistence is introduced.

## Evidence and remaining work

- target/cornerstone-scale-checks/summary.json: a synthetic 1,000-frame original,
  one Core stack, lazy decoding, independent source-pixel oracle and exact recovery.
  Opens in 2.013 seconds here; this is not a 1,000-file CT or total-memory qualification.
- target/cornerstone-stack-checks/summary.json: a real 101-image Core stack, one
  stack installation, native scroll events, PDF/source tracking and exact recovery.
- target/cornerstone-stack-scroll.log and target/scroll-performance/final/: real CT
  wheel/reversal tests, retained adjustments, no stale commits or blank frames.
- target/window-navigation-checks/summary.json: source windows, physical navigation,
  nonlinear pixel oracles and PDF/frame associations.
- target/cine-interaction-checks/summary.json and target/keyboard-guards-checks/summary.json:
  Space lifecycle, editable/control/composition guards and normal shortcuts.
- target/viewing-copy-checks/summary.json: exact PNG pixels and cine capture pause.
- target/cornerstone-gesture-checks/summary.json: native pan/right zoom, touch,
  rotated pan, comparison isolation and unchanged original download.

The comparison viewport has not yet migrated to a complete native multiframe
stack. Standard WindowLevelTool/cine replacement and GPU rendering still require
matching the tested source presets, nonlinear curves, backpressure and capture
semantics. Those adapters remain deliberate compatibility code, not claims that
every feature has been replaced. Native Tools use Float32 world vectors; camera
checks allow 0.0001 world units while returned pixels remain exact.
