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

# SDK native dependencies must be built on the target OS and architecture.
host_platform_arch="$(node -p "process.platform + ':' + process.arch")"
if [[ "$host_platform_arch" != "win32:x64" ]]; then
  echo "Windows SDK packaging requires target-native dependencies. Build on Windows x64 with npm run build:package -- windows; macOS cross-builds cannot stage a Windows SDK." >&2
  exit 1
fi
# Stage the target keyring immediately before electron-builder.
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
keyring_staging="$tmp_dir/keyring-packages"
mkdir -p "$keyring_staging"
export OMP_DESKTOP_WINDOWS_KEYRING_STAGING="$keyring_staging"

keyring_version="$(node -p "require('./node_modules/@napi-rs/keyring/package.json').version")"

for arch in "${arches[@]}"; do
  package_name="keyring-win32-${arch}-msvc"
  package="@napi-rs/$package_name"
  archive="$(npm pack --silent --pack-destination "$tmp_dir" "$package@$keyring_version")"
  package_dir="$keyring_staging/$package_name"
  mkdir -p "$package_dir"
  tar -xzf "$tmp_dir/$archive" -C "$package_dir" --strip-components=1
  test -f "$package_dir/keyring.win32-${arch}-msvc.node"
done

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
