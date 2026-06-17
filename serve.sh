#!/usr/bin/env bash
# Build the React UI (Vite) and serve it together with the Blender render backend
# (server.py). The Python server adds:
#   POST /api/save-scad  — writes floorplan.scad into this directory
#   POST /api/render     — renders the client's camera view via Blender → PNG (async job)
# Blender is found via $BLENDER, then PATH, then /Applications/Blender.app.
#
# For live UI development instead, run `npm run dev` (Vite proxies /api here).
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
if [ ! -d node_modules ]; then echo "Installing UI dependencies…"; npm install --no-audit --no-fund; fi
echo "Building UI (vite)…"; npm run build
exec python3 server.py "$PORT"
