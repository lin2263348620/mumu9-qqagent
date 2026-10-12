#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(unset CDPATH; cd -- "$SCRIPT_DIR/.." && pwd)
AIO_ROOT="$PROJECT_ROOT/.aio-root"
NAPCAT_HOME="$PROJECT_ROOT/.napcat"
QQ_BASE="$NAPCAT_HOME/opt/QQ"
QQ_PACKAGE_JSON="$QQ_BASE/resources/app/package.json"
NAPCAT_DIR="$QQ_BASE/resources/app/app_launcher/napcat"

NAPCAT_URL="https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.28/NapCat.Shell.zip"
NAPCAT_SHA256="bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94"
QQ_VERSION="3.2.33-52892"

case "$(uname -m)" in
  x86_64|amd64)
    DEB_ARCH=amd64
    LIB_ARCH=x86_64-linux-gnu
    QQ_URL="https://qqdl.gtimg.cn/qqfile/QQNT/9.9.35/beta/1763096b/linuxqq_3.2.33-52892_amd64.deb"
    ;;
  aarch64|arm64)
    DEB_ARCH=arm64
    LIB_ARCH=aarch64-linux-gnu
    QQ_URL="https://qqdl.gtimg.cn/qqfile/QQNT/9.9.35/beta/1763096b/linuxqq_3.2.33-52892_arm64.deb"
    ;;
  *)
    echo "ERROR: Unsupported CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for command_name in apt-get curl dpkg-deb find node sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p \
  "$AIO_ROOT/var/lib/apt/lists/partial" \
  "$AIO_ROOT/var/cache/apt/archives/partial" \
  "$AIO_ROOT/var/log/apt" \
  "$NAPCAT_HOME"

tmp_dir=$(mktemp -d "$PROJECT_ROOT/.rootless-install.XXXXXX")
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT INT TERM

qq_deb="$tmp_dir/linuxqq.deb"
napcat_zip="$tmp_dir/NapCat.Shell.zip"

echo "Downloading LinuxQQ $QQ_VERSION from Tencent..."
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused --proto '=https' --tlsv1.2 "$QQ_URL" --output "$qq_deb"
qq_package=$(dpkg-deb -f "$qq_deb" Package)
qq_version=$(dpkg-deb -f "$qq_deb" Version)
qq_arch=$(dpkg-deb -f "$qq_deb" Architecture)
if [ "$qq_package" != "linuxqq" ] || [ "$qq_version" != "$QQ_VERSION" ] || [ "$qq_arch" != "$DEB_ARCH" ]; then
  echo "ERROR: LinuxQQ package metadata verification failed: $qq_package $qq_version $qq_arch" >&2
  exit 1
fi

APT_OPTIONS=(
  -o "Dir::State::status=/var/lib/dpkg/status"
  -o "Dir::State::lists=$AIO_ROOT/var/lib/apt/lists"
  -o "Dir::Cache::archives=$AIO_ROOT/var/cache/apt/archives"
  -o "Dir::Log=$AIO_ROOT/var/log/apt"
  -o "Dir::Etc::sourcelist=/etc/apt/sources.list"
  -o "Dir::Etc::sourceparts=/etc/apt/sources.list.d"
  -o "APT::Sandbox::User=$(id -un)"
  -o "APT::Get::List-Cleanup=0"
  -o "Debug::NoLocking=1"
)

echo "Updating a private apt index under $AIO_ROOT ..."
apt-get "${APT_OPTIONS[@]}" update

echo "Downloading Xvfb and LinuxQQ libraries into the writable project directory..."
apt-get "${APT_OPTIONS[@]}" \
  --download-only --no-install-recommends -y \
  install "$qq_deb" xvfb xauth x11-xkb-utils xkb-data unzip fontconfig fonts-dejavu-core

archive_dir="$AIO_ROOT/var/cache/apt/archives"
deb_count=0
while IFS= read -r -d '' package_file; do
  dpkg-deb -x "$package_file" "$AIO_ROOT"
  deb_count=$((deb_count + 1))
done < <(find "$archive_dir" -maxdepth 1 -type f -name '*.deb' -print0)

if [ "$deb_count" -eq 0 ] && ! command -v Xvfb >/dev/null 2>&1; then
  echo "ERROR: apt did not download Xvfb packages." >&2
  exit 1
fi

export PATH="$AIO_ROOT/usr/bin:$AIO_ROOT/usr/sbin:$PATH"
export LD_LIBRARY_PATH="$AIO_ROOT/usr/lib/$LIB_ARCH:$AIO_ROOT/lib/$LIB_ARCH:$AIO_ROOT/usr/lib:$AIO_ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="$AIO_ROOT/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"

if ! command -v Xvfb >/dev/null 2>&1 || ! command -v xvfb-run >/dev/null 2>&1; then
  echo "ERROR: The private Xvfb runtime could not be prepared." >&2
  exit 1
fi

mkdir -p "$NAPCAT_HOME"
dpkg-deb -x "$qq_deb" "$NAPCAT_HOME"

echo "Downloading and verifying NapCat v4.18.28..."
curl --fail --location --retry 5 --retry-delay 3 --retry-connrefused --proto '=https' --tlsv1.2 "$NAPCAT_URL" --output "$napcat_zip"
actual_sha=$(sha256sum "$napcat_zip" | awk '{print $1}')
if [ "$actual_sha" != "$NAPCAT_SHA256" ]; then
  echo "ERROR: NapCat archive checksum mismatch." >&2
  exit 1
fi

napcat_extract="$tmp_dir/napcat"
mkdir -p "$napcat_extract" "$NAPCAT_DIR"
unzip -q -o "$napcat_zip" -d "$napcat_extract"
cp -a "$napcat_extract/." "$NAPCAT_DIR/"
chmod -R u+rwX "$NAPCAT_DIR"

node "$SCRIPT_DIR/patch-linuxqq.mjs" "$QQ_PACKAGE_JSON" "$NAPCAT_DIR"
node "$SCRIPT_DIR/configure.mjs" "$NAPCAT_DIR/config"

xvfb_bin=$(command -v Xvfb)
if ! "$xvfb_bin" -help >/dev/null 2>&1; then
  echo "ERROR: The extracted Xvfb binary cannot run with the available libraries." >&2
  exit 1
fi

echo "Rootless NapCat installation completed: $NAPCAT_HOME"
