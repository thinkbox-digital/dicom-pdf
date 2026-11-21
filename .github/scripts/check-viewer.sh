#!/usr/bin/env bash
set -euo pipefail

npm ci --prefix viewer
# The build advances the viewer versions and produces the artifacts for these checks.
npm --prefix viewer run build
npm --prefix viewer test
npm --prefix viewer run test:extension
python -m pip install -r scripts/requirements.txt
python -m playwright install --with-deps chromium
python scripts/check_surface_segmentation.py
