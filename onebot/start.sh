#!/bin/sh
set -eu

ROOT_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(unset CDPATH; cd -- "$ROOT_DIR/.." && pwd)
AIO_ROOT="$PROJECT_ROOT/.aio-root"
NAPCAT_HOME="$PROJECT_ROOT/.napcat"
QQ_BIN=${NAPCAT_QQ_BIN:-"$NAPCAT_HOME/opt/QQ/qq"}
NAPCAT_DIR=${NAPCAT_DIR:-"$NAPCAT_HOME/opt/QQ/resources/app/app_launcher/napcat"}

case "$(uname -m)" in
  x86_64|amd64) LIB_ARCH=x86_64-linux-gnu ;;
  aarch64|arm64) LIB_ARCH=aarch64-linux-gnu ;;
  *) LIB_ARCH="" ;;
esac

if [ -n "$LIB_ARCH" ] && [ -d "$AIO_ROOT" ]; then
  PATH="$AIO_ROOT/usr/bin:$AIO_ROOT/usr/sbin:$PATH"
  LD_LIBRARY_PATH="$AIO_ROOT/usr/lib/$LIB_ARCH:$AIO_ROOT/lib/$LIB_ARCH:$AIO_ROOT/usr/lib:$AIO_ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  XDG_DATA_DIRS="$AIO_ROOT/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
  XKB_CONFIG_ROOT="$AIO_ROOT/usr/share/X11/xkb"
  export PATH LD_LIBRARY_PATH XDG_DATA_DIRS XKB_CONFIG_ROOT
fi

if [ ! -x "$QQ_BIN" ]; then
  echo "NapCat is not installed; QQ protocol service was skipped."
  echo "The website and QQ management page will still start."
  echo "The rootless NapCat installation has not completed. Check the startup log."
  exit 0
fi

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "NapCat was found, but xvfb-run is missing; QQ protocol service was skipped." >&2
  echo "Install Xvfb and the LinuxQQ shared libraries, then restart this project." >&2
  exit 0
fi

mkdir -p "$NAPCAT_DIR/config" "$HOME/.cache"
node "$ROOT_DIR/configure.mjs" "$NAPCAT_DIR/config"

export NAPCAT_WORKDIR="$NAPCAT_DIR"
XVFB_ARGS="-screen 0 1280x1024x24 -nolisten tcp"
if [ -d "$AIO_ROOT/usr/share/X11/xkb" ]; then
  XVFB_ARGS="$XVFB_ARGS -xkbdir $AIO_ROOT/usr/share/X11/xkb"
fi

supervisor_pid_file="$PROJECT_ROOT/data/napcat-supervisor.pid"
child_pid_file="$PROJECT_ROOT/data/napcat-child.pid"
mkdir -p "$PROJECT_ROOT/data"
printf '%s\n' "$$" > "$supervisor_pid_file"

child_pid=""
stopping=0
restart_requested=0

stop_supervisor() {
  stopping=1
  [ -z "$child_pid" ] || kill -TERM -- "-$child_pid" 2>/dev/null || true
}

restart_child() {
  restart_requested=1
  [ -z "$child_pid" ] || kill -TERM -- "-$child_pid" 2>/dev/null || true
}

cleanup_supervisor() {
  rm -f "$supervisor_pid_file" "$child_pid_file"
}

trap stop_supervisor INT TERM HUP
trap restart_child USR1
trap cleanup_supervisor EXIT

if ! command -v setsid >/dev/null 2>&1; then
  echo "ERROR: setsid is required to manage the complete QQ/Xvfb process group." >&2
  exit 1
fi

while [ "$stopping" -eq 0 ]; do
  echo "Starting NapCat from $QQ_BIN"
  if [ -n "${QQ_UIN:-}" ] && [ ! -f "$PROJECT_ROOT/data/manual-login-required" ]; then
    setsid xvfb-run -a -s "$XVFB_ARGS" "$QQ_BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage -q "$QQ_UIN" &
  else
    setsid xvfb-run -a -s "$XVFB_ARGS" "$QQ_BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage &
  fi
  child_pid=$!
  printf '%s\n' "$child_pid" > "$child_pid_file"

  set +e
  wait "$child_pid"
  exit_code=$?
  # A trapped signal interrupts wait before the process tree has necessarily exited.
  kill -TERM -- "-$child_pid" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$child_pid" 2>/dev/null || true
  wait "$child_pid" 2>/dev/null || true
  set -e
  child_pid=""
  rm -f "$child_pid_file"

  [ "$stopping" -eq 0 ] || break
  if [ "$restart_requested" -eq 1 ]; then
    echo "NapCat controlled restart requested; relaunching in 3 seconds..."
    restart_requested=0
    restart_delay=3
  else
    echo "NapCat exited with code $exit_code; relaunching in 5 seconds..." >&2
    restart_delay=5
  fi
  sleep "$restart_delay"
done

exit 0
