#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export OMP_DESKTOP_BUNDLE_OMP=0
exec ./build-windows.sh --config electron-builder-no-omp.cjs "$@"
