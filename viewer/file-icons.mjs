/*
 * View/download/pane-chevron path geometry adapted from EA-PDF browser-viewer/src/viewer-icons.ts.
 * Copyright 2026 ThinkBox Digital.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The EA-PDF application code is Apache-2.0. No branding asset or third-party
 * icon library is copied here. See third_party_licenses/EA-PDF-ICONS-NOTICE.txt.
 */
const FILE_PATHS = Object.freeze({
  view: Object.freeze([
    'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z',
    'M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  ]),
  download: Object.freeze(['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5']),
  left: Object.freeze(['m15 5-7 7 7 7']),
  right: Object.freeze(['m9 5 7 7-7 7']),
});

/** Accessible button labels belong to the button; the matching line icon is decorative. */
export function fileActionIcon(kind) {
  const paths = FILE_PATHS[kind];
  if (!paths) throw new TypeError(`Unknown file action icon: ${kind}`);
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.classList.add('file-action-icon', 'tree-icon');
  for (const geometry of paths) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', geometry);
    icon.append(path);
  }
  return icon;
}

/** EA-PDF matching chevrons for pane headings and their reader-edge reopen controls. */
export function paneToggleIcon(direction) {
  if (direction !== 'left' && direction !== 'right') throw new TypeError(`Unknown pane direction: ${direction}`);
  const icon = fileActionIcon(direction);
  icon.classList.add('pane-icon');
  return icon;
}
