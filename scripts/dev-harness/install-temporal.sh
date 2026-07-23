#!/usr/bin/env bash
# Install the Temporal CLI binary into ~/.local/bin if it isn't on PATH yet.
# Linux only (the dev container). Honours TEMPORAL_VERSION (default: latest).

set -euo pipefail

if command -v temporal >/dev/null 2>&1; then
  echo "temporal CLI already on PATH: $(command -v temporal) ($(temporal --version 2>&1 | head -1))"
  exit 0
fi

VERSION="${TEMPORAL_VERSION:-latest}"
DEST="${HOME}/.local/bin"
mkdir -p "$DEST"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
if [[ "$OS" != "linux" ]]; then
  echo "This installer targets Linux only (the dev container). Detected: $OS" >&2
  exit 1
fi

if [[ "$VERSION" == "latest" ]]; then
  URL="https://temporal.download/cli/archive/latest?platform=${OS}&arch=${ARCH}"
else
  URL="https://temporal.download/cli/archive/v${VERSION}?platform=${OS}&arch=${ARCH}"
fi

echo "Downloading temporal CLI (${OS}/${ARCH}, ${VERSION}) → ${DEST}/temporal"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "${TMP}/temporal.tgz" "$URL"
tar -xzf "${TMP}/temporal.tgz" -C "$TMP"
install -m 0755 "${TMP}/temporal" "${DEST}/temporal"

case ":${PATH}:" in
  *":${DEST}:"*) ;;
  *) echo "NOTE: add ${DEST} to your PATH, e.g.: export PATH=\"${DEST}:\$PATH\"" ;;
esac

echo "Installed: $("${DEST}/temporal" --version 2>&1 | head -1)"
