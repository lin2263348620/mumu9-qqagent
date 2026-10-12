#!/bin/sh
set -eu
PROJECT_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"
node_ok() {
  command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1
}
if [ "${BOT_USE_LOCAL_NODE:-0}" = 1 ] || ! node_ok; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x64; expected=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37 ;;
    aarch64|arm64) arch=arm64; expected=1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f ;;
    *) echo 'ERROR: Only Linux x64 and ARM64 are supported.' >&2; exit 1 ;;
  esac
  runtime="$PROJECT_DIR/.runtime"
  target="$runtime/node-v22.22.0-linux-$arch"
  if [ ! -x "$target/bin/node" ]; then
    for tool in tar xz sha256sum mktemp; do
      command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: Install required system tool: $tool" >&2; exit 1; }
    done
    mkdir -p "$runtime"
    download=$(mktemp "$runtime/node-download.XXXXXX")
    staging=$(mktemp -d "$runtime/node-extract.XXXXXX")
    url="https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-$arch.tar.xz"
    echo 'Downloading official portable Node.js 22.22.0...'
    if command -v curl >/dev/null 2>&1; then
      curl --fail --location --retry 2 --connect-timeout 20 --max-time 1200 "$url" -o "$download"
    elif command -v wget >/dev/null 2>&1; then
      wget --timeout=30 --tries=3 "$url" -O "$download"
    else
      echo 'ERROR: Install curl or wget first.' >&2; exit 1
    fi
    actual=$(sha256sum "$download"); actual=${actual%% *}
    [ "$actual" = "$expected" ] || { echo 'ERROR: Node.js checksum mismatch. Download will not be executed.' >&2; exit 1; }
    tar -xJf "$download" -C "$staging"
    [ ! -e "$target" ] || { echo 'ERROR: Incomplete runtime exists; rename .runtime and retry.' >&2; exit 1; }
    mv "$staging/node-v22.22.0-linux-$arch" "$target"
    rm -f "$download"
    rmdir "$staging"
  fi
  PATH="$target/bin:$PATH"; export PATH
  node_ok || { echo 'ERROR: Node.js requires a compatible glibc Linux system (Debian/Ubuntu). Alpine/musl is not supported.' >&2; exit 1; }
fi
export BOT_NODE_READY=1
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  export BOT_OPEN_BROWSER=${BOT_OPEN_BROWSER:-1}
fi
exec sh "$PROJECT_DIR/start.sh"
