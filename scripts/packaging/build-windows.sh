#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# mini-electron currently publishes a Windows x64 runtime only.
read -r -a arches <<<"${WINDOWS_ARCHES:-x64}"

for arch in "${arches[@]}"; do
  case "$arch" in
    x64) ;;
    *)
      echo "Unsupported Windows architecture: $arch" >&2
      exit 2
      ;;
  esac
done

# Windows native SDK compilation stays on Windows; Mac builds import its artifact.
host_platform_arch="$(node -p "process.platform + ':' + process.arch")"
case "$host_platform_arch" in
  win32:x64) ;;
  darwin:*)
    if [[ -z "${OMP_DESKTOP_SDK_ARTIFACT:-}" ]]; then
      echo "macOS Windows cross-builds require an extracted native Windows x64 SDK artifact at absolute OMP_DESKTOP_SDK_ARTIFACT." >&2
      exit 1
    fi
    ;;
  *)
    echo "Windows packaging requires native Windows x64 or macOS with a Windows x64 SDK artifact." >&2
    exit 1
    ;;
esac
if [[ -n "${OMP_DESKTOP_SDK_ARTIFACT:-}" ]]; then
  node -e 'const fs = require("node:fs"); const path = require("node:path"); const artifact = process.env.OMP_DESKTOP_SDK_ARTIFACT; if (!path.isAbsolute(artifact) || !fs.statSync(artifact).isDirectory()) throw new Error("OMP_DESKTOP_SDK_ARTIFACT must be an absolute extracted artifact directory");'
fi
export OMP_DESKTOP_PACKAGE_TARGET=win32-x64

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
# Keep the installed Mac mini-electron distribution untouched. The target
# installer downloads and validates the genuine Windows runtime in isolation.
if [[ "$host_platform_arch" == darwin:* && -z "${MINI_ELECTRON_DIST_PATH:-}" ]]; then
  export MINI_ELECTRON_DIST_PATH
  MINI_ELECTRON_DIST_PATH="$(node scripts/packaging/prepare-windows-runtime.mjs "$tmp_dir/runtime")"
fi

# Desktop stages all target-native optional modules after prerequisite builds.

# Merge release update metadata only after all requested architectures finish.
version="$(node -p "require('./packages/desktop/package.json').version")"
build_output="$(node packages/desktop/scripts/windows-build-output.mjs "$version" "$@")"
IFS=$'\t' read -r release_dir metadata_filename legacy_installer <<<"$build_output"
rm -f "$release_dir/$legacy_installer" "$release_dir/$legacy_installer.blockmap"

metadata_dir="$tmp_dir/update-metadata"
mkdir -p "$metadata_dir"
metadata_files=()

for arch in "${arches[@]}"; do
  npm run build:desktop -- --win "--$arch" --publish never "$@"
  cp \
    "$release_dir/$metadata_filename" \
    "$metadata_dir/$arch-$metadata_filename"
  metadata_files+=("$metadata_dir/$arch-$metadata_filename")
done

node scripts/packaging/merge-windows-update-metadata.mjs \
  "$release_dir/$metadata_filename" \
  "${metadata_files[@]}"
