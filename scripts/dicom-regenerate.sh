#!/usr/bin/env bash
# Regenerate PDFs with the existing command-line JAR; no build is performed.
set -euo pipefail
umask 077
script_file=$(readlink -f -- "${BASH_SOURCE[0]}")
script_dir=$(cd -- "$(dirname -- "$script_file")" && pwd -P)
exec "${PYTHON:-python3}" -B "$script_dir/dicom_regenerate.py" "$@"
