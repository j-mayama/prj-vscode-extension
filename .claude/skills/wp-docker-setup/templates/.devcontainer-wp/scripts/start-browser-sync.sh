#!/usr/bin/env bash
set -euo pipefail

if ! command -v browser-sync >/dev/null 2>&1; then
  echo "browser-sync is missing. Installing to ~/.npm-global..."
  mkdir -p "${HOME}/.npm-global"
  npm config set prefix "${HOME}/.npm-global"
  export PATH="${HOME}/.npm-global/bin:${PATH}"
  npm install -g browser-sync
fi

if pgrep -f "browser-sync.*browser-sync.config.cjs" >/dev/null 2>&1; then
  echo "browser-sync already running"
  exit 0
fi

nohup browser-sync start --config /workspace/.devcontainer/scripts/browser-sync.config.cjs \
  >/tmp/browser-sync.log 2>&1 &

echo "browser-sync started on http://localhost:3000 (UI: http://localhost:3001)"
