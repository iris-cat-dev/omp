#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6768}"
configure_dev_paseo_home


echo "══════════════════════════════════════════════════════"
echo "  OMP Desktop Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PASEO_HOME}"
echo "  Listen:  ${PASEO_LISTEN}"
echo "══════════════════════════════════════════════════════"

export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"

if [ "${PASEO_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
