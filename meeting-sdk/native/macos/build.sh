#!/bin/sh
# Builds the macOS helper with swiftc directly (swift-package is not needed).
set -e
cd "$(dirname "$0")"
OUT=../../packages/sdk/bin
mkdir -p "$OUT"
SDK="${MSDK_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk}"
swiftc -sdk "$SDK" -O -swift-version 5 Sources/meeting-sdk-macos/*.swift -o "$OUT/meeting-sdk-macos"
echo "built $OUT/meeting-sdk-macos"
