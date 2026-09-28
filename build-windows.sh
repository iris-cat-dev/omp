#!/usr/bin/env bash
set -euo pipefail

# Windows installers must be built one architecture per electron-builder
# invocation. Passing both architectures in one invocation emits an additional
# universal NSIS installer containing both payloads.
read -r -a arches <<<"${WINDOWS_ARCHES:-x64 arm64}"

for arch in "${arches[@]}"; do
  case "$arch" in
    x64 | arm64) ;;
    *)
      echo "Unsupported Windows architecture: $arch" >&2
      exit 2
      ;;
  esac
done

# electron-builder's supported Windows toolchain uses Intel Wine and NSIS on
# macOS. Apple silicon hosts therefore need Rosetta; do not substitute a native
# makensis because mixing it with electron-builder's pinned NSIS resources can
# produce installers that Windows refuses to launch.
host_platform_arch="$(node -p "process.platform + ':' + process.arch")"
if [[ "$host_platform_arch" == "darwin:arm64" ]] &&
  ! /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Rosetta 2 is required to build Windows installers on macOS arm64." >&2
  echo "Install it with: softwareupdate --install-rosetta --agree-to-license" >&2
  exit 1
fi

# npm installs only the host platform's optional dependencies. Cross-building on
# macOS therefore omits the Windows keyring bindings that the packaged daemon
# loads at runtime. Fetch the requested Windows architectures directly without
# reifying the workspace (which would remove the other architecture).
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

keyring_version="$(node -p "require('./node_modules/@napi-rs/keyring/package.json').version")"

for arch in "${arches[@]}"; do
  package="@napi-rs/keyring-win32-${arch}-msvc"
  archive="$(npm pack --silent --pack-destination "$tmp_dir" "$package@$keyring_version")"
  package_dir="node_modules/$package"
  rm -rf "$package_dir"
  mkdir -p "$package_dir"
  tar -xzf "$tmp_dir/$archive" -C "$package_dir" --strip-components=1
  binding_name="${package#@napi-rs/keyring-}"
  test -f "$package_dir/keyring.$binding_name.node"
done

# Do not leave a stale universal installer in release/ after splitting builds.
version="$(node -p "require('./packages/desktop/package.json').version")"
channel="latest"
if [[ "$version" == *-* ]]; then
  channel="${version#*-}"
  channel="${channel%%.*}"
fi
metadata_filename="$channel.yml"
rm -f \
  "packages/desktop/release/OMP-Desktop-Setup-$version.exe" \
  "packages/desktop/release/OMP-Desktop-Setup-$version.exe.blockmap"

metadata_dir="$tmp_dir/update-metadata"
mkdir -p "$metadata_dir"
metadata_files=()

for arch in "${arches[@]}"; do
  npm run build:desktop -- --win "--$arch" "$@"
  cp \
    "packages/desktop/release/$metadata_filename" \
    "$metadata_dir/$channel-$arch.yml"
  metadata_files+=("$metadata_dir/$channel-$arch.yml")
done

node scripts/merge-windows-update-metadata.mjs \
  "packages/desktop/release/$metadata_filename" \
  "${metadata_files[@]}"
