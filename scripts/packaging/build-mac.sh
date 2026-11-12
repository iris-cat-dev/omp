#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo "macOS packages must be built on macOS." >&2
  exit 1
fi

has_notarization_credentials=false
if [[ -n "${APPLE_ID:-}" &&
      -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" &&
      -n "${APPLE_TEAM_ID:-}" ]]; then
  has_notarization_credentials=true
elif [[ -n "${APPLE_API_KEY:-}" &&
        -n "${APPLE_API_KEY_ID:-}" &&
        -n "${APPLE_API_ISSUER:-}" ]]; then
  has_notarization_credentials=true
elif [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  has_notarization_credentials=true
fi

if [[ "$has_notarization_credentials" != true ]]; then
  cat >&2 <<'EOF'
No macOS notarization credentials found; signing the local test package with OMP Desktop Local.
This signature is not notarized; Gatekeeper may reject the package on other Macs.
EOF
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- --mac --arm64 --publish never \
    --config.mac.identity="OMP Desktop Local" \
    --config.mac.notarize=false \
    --config.forceCodeSigning=true "$@"
else
  if [[ -z "${CSC_LINK:-}" ]] &&
    ! security find-identity -v -p codesigning |
      grep -q '"Developer ID Application:'; then
    echo "No Developer ID Application identity found; install one or set CSC_LINK." >&2
    exit 1
  fi

  npm run build:desktop -- --mac --arm64 --publish never "$@"
fi

shopt -s nullglob
apps=(packages/desktop/release/unbundled/mac-*/*.app)
if (( ${#apps[@]} == 0 )); then
  echo "No packaged macOS application was produced." >&2
  exit 1
fi

for app in "${apps[@]}"; do
  codesign --verify --deep --strict --verbose=2 "$app"
  if [[ "$has_notarization_credentials" == true ]]; then
    xcrun stapler validate "$app"
    spctl --assess --type execute --verbose=2 "$app"
  fi
done