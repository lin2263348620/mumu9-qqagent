#!/usr/bin/env bash
set -euo pipefail

# Pinned upstream installer. The installer itself is interactive and may use sudo
# to install LinuxQQ, Xvfb and shared libraries.
INSTALLER_URL="https://raw.githubusercontent.com/NapNeko/NapCat-Installer/6644b95e026ba21098fc36de7563416e45b1e7af/script/install.sh"
INSTALLER_SHA256="945583a7877bf183648c4167134a72f2e55a5a9a622192ef7cdda0199e88becd"

if [ "$(uname -s)" != "Linux" ]; then
  echo "ERROR: NapCat must be installed on the AIO Linux server." >&2
  exit 1
fi

for command_name in curl bash; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: Missing command: $command_name" >&2
    exit 1
  fi
done

tmp_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT INT TERM

if ! command -v sudo >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    printf '#!/bin/sh\nexec "$@"\n' > "$tmp_dir/sudo"
    chmod 700 "$tmp_dir/sudo"
    PATH="$tmp_dir:$PATH"
    export PATH
    echo "Running as root; using a temporary sudo compatibility wrapper."
  else
    echo "ERROR: The official NapCat installer needs root or sudo to install system libraries and Xvfb." >&2
    echo "This AIO instance provides neither. Ask the host to install the dependencies, or use an external OneBot v11 service." >&2
    exit 1
  fi
fi

installer="$tmp_dir/napcat-installer.sh"
echo "Downloading the pinned official NapCat installer..."
curl --fail --location --proto '=https' --tlsv1.2 "$INSTALLER_URL" --output "$installer"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$installer" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$installer" | awk '{print $1}')
else
  echo "ERROR: sha256sum or shasum is required to verify the installer." >&2
  exit 1
fi

if [ "$actual_sha" != "$INSTALLER_SHA256" ]; then
  echo "ERROR: NapCat installer checksum mismatch. Nothing was executed." >&2
  exit 1
fi

echo "Checksum verified. NapCat and LinuxQQ will be installed under: $HOME/Napcat"
echo "The following official installer may ask for the sudo password."
bash "$installer" --docker n --cli n --proxy 0

echo
echo "NapCat installation finished. Return to the AIO panel and restart this project."
