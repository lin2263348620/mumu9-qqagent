#!/bin/sh
set -eu

ROOT_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

if [ "${BOT_NODE_READY:-0}" != 1 ] && command -v mise >/dev/null 2>&1; then
  mise use -g node@22.14.0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not available. Use the AIO image with Node.js 22.14.0." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/data" "$ROOT_DIR/logs"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)){console.error("Node.js >=22.13 required");process.exit(1)}'

export AIO_ROOT_PREFIX="$ROOT_DIR/.aio-root"
export NAPCAT_HOME="$ROOT_DIR/.napcat"
napcat_qq=${NAPCAT_QQ_BIN:-"$NAPCAT_HOME/opt/QQ/qq"}
napcat_attempt="$ROOT_DIR/data/napcat-rootless-install-v3-attempted.txt"
if [ "${SKIP_NAPCAT:-0}" != "1" ] && [ ! -x "$napcat_qq" ]; then
  if [ ! -f "$napcat_attempt" ]; then
    echo "NapCat is not installed. Starting the rootless AIO installation..."
    printf 'Rootless NapCat installation started. Delete this file to retry after a failed attempt.\n' > "$napcat_attempt"
    if bash "$ROOT_DIR/onebot/install-napcat-rootless.sh" && [ -x "$napcat_qq" ]; then
      rm -f "$napcat_attempt"
      echo "Rootless NapCat installation completed. Continuing normal startup..."
    else
      printf 'Rootless NapCat installation failed. Delete this file to retry after fixing the reported error.\n' > "$napcat_attempt"
      echo "Rootless NapCat installation failed; the website will continue to start without QQ." >&2
      echo "See the error above. To retry, delete data/napcat-rootless-install-v3-attempted.txt and restart." >&2
    fi
  else
    echo "NapCat is not installed and a previous rootless installation attempt failed; skipping installation."
    echo "Delete data/napcat-rootless-install-v3-attempted.txt to retry."
  fi
fi

init_json_file() {
  destination=$1
  source_file=$2
  fallback=$3

  [ -f "$destination" ] && return 0
  if [ -f "$source_file" ]; then
    cp "$source_file" "$destination"
  else
    echo "WARNING: Missing template $source_file; creating a safe default." >&2
    printf '%s\n' "$fallback" > "$destination"
  fi
}

init_json_file "$ROOT_DIR/data/config.json" "$ROOT_DIR/qq-agent/config.example.json" '{}'
init_json_file "$ROOT_DIR/data/scheduled-tasks.json" "$ROOT_DIR/qq-agent/scheduled-tasks.example.json" '{"tasks":[],"updatedAt":null}'
init_json_file "$ROOT_DIR/data/stickers.json" "$ROOT_DIR/qq-agent/stickers.example.json" '[]'

agent_enabled=1
if [ ! -f "$ROOT_DIR/qq-agent/src/server.js" ]; then
  echo "WARNING: QQ Agent program files are missing: qq-agent/src/server.js" >&2
  echo "The website will continue without the QQ management service." >&2
  agent_enabled=0
fi

if [ "$agent_enabled" -eq 1 ] && [ ! -d "$ROOT_DIR/qq-agent/node_modules/ws" ]; then
  echo "Installing QQ Agent production dependencies..."
  if [ -f "$ROOT_DIR/qq-agent/package-lock.json" ]; then
    if ! npm --prefix "$ROOT_DIR/qq-agent" ci --omit=dev --ignore-scripts --no-audit --no-fund; then
      echo "WARNING: QQ Agent dependency installation failed; the website will continue without the QQ management service." >&2
      agent_enabled=0
    fi
  elif ! npm --prefix "$ROOT_DIR/qq-agent" install --omit=dev --ignore-scripts --no-audit --no-fund; then
    echo "WARNING: QQ Agent dependency installation failed; the website will continue without the QQ management service." >&2
    agent_enabled=0
  fi
fi

export TZ=${TZ:-Asia/Shanghai}
export QQ_AGENT_DATA_DIR="$ROOT_DIR/data"
export QQ_AGENT_HOST=127.0.0.1
export QQ_AGENT_PORT=${QQ_AGENT_PORT:-3210}
export NAPCAT_DIR=${NAPCAT_DIR:-"$NAPCAT_HOME/opt/QQ/resources/app/app_launcher/napcat"}

protocol_pid=""
agent_pid=""
gateway_pid=""
log_pid=""
browser_pid=""

cleanup() {
  trap - EXIT INT TERM
  [ -z "$gateway_pid" ] || kill "$gateway_pid" 2>/dev/null || true
  [ -z "$agent_pid" ] || kill "$agent_pid" 2>/dev/null || true
  [ -z "$protocol_pid" ] || kill "$protocol_pid" 2>/dev/null || true
  [ -z "$gateway_pid" ] || wait "$gateway_pid" 2>/dev/null || true
  [ -z "$agent_pid" ] || wait "$agent_pid" 2>/dev/null || true
  [ -z "$protocol_pid" ] || wait "$protocol_pid" 2>/dev/null || true
  [ -z "$log_pid" ] || kill "$log_pid" 2>/dev/null || true
  [ -z "$log_pid" ] || wait "$log_pid" 2>/dev/null || true
  [ -z "$browser_pid" ] || kill "$browser_pid" 2>/dev/null || true
  [ -z "$browser_pid" ] || wait "$browser_pid" 2>/dev/null || true
}

trap 'exit 0' INT TERM
trap cleanup EXIT

# Mirror new service output without changing service PIDs or replaying old logs.
touch "$ROOT_DIR/logs/onebot.log" "$ROOT_DIR/logs/qq-agent.log"
if command -v tail >/dev/null 2>&1; then
  tail -n 0 -F "$ROOT_DIR/logs/onebot.log" "$ROOT_DIR/logs/qq-agent.log" &
  log_pid=$!
  # Let tail open both files before the services write their startup output.
  sleep 1
  echo "Live service logs are mirrored below and retained in logs/."
else
  echo "WARNING: tail is unavailable; service logs remain in logs/." >&2
fi

if [ "${SKIP_NAPCAT:-0}" != "1" ] && [ -f "$ROOT_DIR/onebot/start.sh" ]; then
  echo "Starting the optional OneBot protocol service..."
  sh "$ROOT_DIR/onebot/start.sh" >> "$ROOT_DIR/logs/onebot.log" 2>&1 &
  protocol_pid=$!
fi

if [ "$agent_enabled" -eq 1 ]; then
  node --env-file-if-exists="$ROOT_DIR/.env" "$ROOT_DIR/qq-agent/src/server.js" >> "$ROOT_DIR/logs/qq-agent.log" 2>&1 &
  agent_pid=$!
else
  echo "QQ Agent was skipped because its dependencies are unavailable." >&2
fi

node --env-file-if-exists="$ROOT_DIR/.env" "$ROOT_DIR/gateway.js" &
gateway_pid=$!
if [ "${BOT_OPEN_BROWSER:-0}" = 1 ]; then
  node --env-file-if-exists="$ROOT_DIR/.env" "$ROOT_DIR/scripts/open-browser.mjs" &
  browser_pid=$!
fi
wait "$gateway_pid"
