#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export CODEX_PROVIDER_HUB_DATA_DIR="$(cd "$DIR/.." && pwd)/data"

if [ ! -d node_modules ]; then
  npm install
fi

/usr/bin/env node "$DIR/install-autostart.js" start
sleep 1

/usr/bin/open "http://127.0.0.1:8790"
