#!/bin/bash
# Génère assets/icon.icns (et icon.png) à partir du rendu CoreGraphics.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p assets
swift scripts/make-icon.swift assets/icon-1024.png

ICONSET="assets/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" \
            "512 icon_512x512" "1024 icon_512x512@2x"; do
  set -- $spec
  sips -z "$1" "$1" assets/icon-1024.png --out "$ICONSET/$2.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o assets/icon.icns
cp assets/icon-1024.png assets/icon.png
rm -rf "$ICONSET"
echo "assets/icon.icns prêt"
