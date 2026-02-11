#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(sed -nE 's/.*"version":[[:space:]]*"([^"]+)".*/\1/p' manifest.json | head -n 1)"
if [[ -z "${VERSION}" ]]; then
  echo "Could not read version from manifest.json"
  exit 1
fi

OUT_DIR="$ROOT_DIR/dist"
OUT_FILE="$OUT_DIR/tv-time-quick-tracker-v${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

# Package only runtime files referenced by manifest.
zip -r "$OUT_FILE" manifest.json src icons -x "*.DS_Store" > /dev/null

echo "Package created:"
echo "  $OUT_FILE"
echo ""
echo "Contents:"
unzip -l "$OUT_FILE"
