---
title: Archival DICOM in PDF/A
---

# Archival DICOM in PDF/A

DICOM PDF packages original DICOM files and metadata in a self-contained PDF/A-4f archive. The archive includes reference images you can read in a regular PDF reader and preserves the original files for recovery. The standalone viewer and Chrome extension open the embedded DICOM images for interactive viewing.

{% assign release_page = 'https://github.com/thinkbox-digital/dicom-pdf/releases/latest' %}
{% assign release = site.github.latest_release %}
{% assign version = release.tag_name | remove_first: 'v' %}
{% assign jar_prefix = 'dicom-pdf-' | append: version %}
{% assign creator_name = jar_prefix | append: '-desktop.jar' %}
{% assign viewer_name = jar_prefix | append: '-viewer.jar' %}
{% assign creator = release.assets | where: 'name', creator_name | first %}
{% assign viewer = release.assets | where: 'name', viewer_name | first %}

[Download the creator]({{ creator.browser_download_url | default: release_page }}) · [Download the desktop viewer]({{ viewer.browser_download_url | default: release_page }}) · [Download example archives (ZIP)]({{ release_page }}/download/dicom-pdf-examples.zip) · [Browse example archives](https://github.com/thinkbox-digital/dicom-pdf/tree/main/examples)

![DICOM PDF Viewer showing an axial chest CT image from greg.pdf with the left series pane open](desktop-viewer.png?v=0.56.0&rev=a8690b83)

[View the full-size screenshot with overlays](desktop-viewer.png?v=0.56.0&rev=a8690b83).

## Open, create, or recover an archive

| If you want to | Start here |
| --- | --- |
| Open an existing archive | [Standalone Java viewer](GUIDE.md#desktop-dicom-viewer) or [Chrome extension](GUIDE.md#install-the-chrome-extension) |
| Convert loose DICOM files, folders, or ZIP archives | [Desktop creator and validator](GUIDE.md#desktop-creator-and-validator) |
| Extract the original files | [Save original files](GUIDE.md#save-original-files) |
| Inspect or export metadata | [Check files and export metadata](GUIDE.md#check-files-and-export-metadata) |
| Verify an archive | [Read the viewer's security report](SECURITY.md#viewer-results) or [run independent verification](INDEPENDENT-VALIDATION.md) |

## Security and preservation

- [Supported signatures, timestamps, and trust checks](SECURITY.md)
- [Signing configuration and certificate setup](SIGNING_CONFIGURATION.md)
- [PDF/A-4f archival profile](profile/0.3.0/PROFILE.md) and [C2PA Content Credentials profile](profile/0.4.0/PROFILE.md)
- [Supported image formats](GUIDE.md#image-support) and [DICOM source validation scope](DICOM-STRUCTURE.md)
- [Personal data and sharing](GUIDE.md#protect-personal-data)

## Build and integrate

- [Build from source](GUIDE.md#building-from-source)
- [Run the tests](VERIFICATION.md)
- [Use the Java PDF security library](PDF_SECURITY_LIBRARY.md)
