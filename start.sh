#!/usr/bin/env bash
# One-shot launcher (Linux + macOS, Docker or Podman). Extra args go to feeder.py, e.g. ./start.sh --spacing 20
# CTR=podman ./start.sh forces Podman when both are installed; NO_OPEN=1 skips opening the browser.
set -euo pipefail
cd "$(dirname "$0")"

# QuestDB: one container. Localhost-only ports: the public surface is server.py, never QuestDB.
# HTTP is read-only (the page's SQL can't modify data; the feeder's DDL goes over PG wire).
CTR=${CTR:-$(command -v docker || command -v podman || true)}
[ -n "$CTR" ] || { echo "Install Docker or Podman first." >&2; exit 1; }
if [ "$(basename "$CTR")" = podman ] && ! podman info >/dev/null 2>&1; then
  # macOS: Podman runs containers in a VM. Start it, creating it the first time.
  podman machine start 2>/dev/null || podman machine init --cpus 4 --memory 4096 --now
fi
if ! "$CTR" container inspect space-demo-questdb >/dev/null 2>&1; then
  "$CTR" run -d --name space-demo-questdb \
    -p 127.0.0.1:9000:9000 -p 127.0.0.1:9009:9009 -p 127.0.0.1:8812:8812 \
    -e QDB_HTTP_SECURITY_READONLY=true -e QDB_QUERY_TIMEOUT=5s \
    -v space-demo-qdb:/var/lib/questdb \
    docker.io/questdb/questdb:latest >/dev/null
fi
"$CTR" start space-demo-questdb >/dev/null

[ -d node_modules/cesium ] || npm install
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
until curl -sf -o /dev/null "http://localhost:9000/exec?query=SELECT+1"; do sleep 1; done
trap 'kill $(jobs -p) 2>/dev/null' EXIT
.venv/bin/python -u feeder.py "$@" &
.venv/bin/python -u server.py &
sleep 2
url=http://localhost:8080
echo "demo: $url   questdb console: http://localhost:9000   (stop: Ctrl+C, then '$(basename "$CTR") stop space-demo-questdb')"
if [ "$(uname)" = Darwin ]; then
  caffeinate -dis -w $$ & # booth Mac: no display sleep / idle sleep while the demo runs
  [ -n "${NO_OPEN:-}" ] || open "$url"
else
  [ -n "${NO_OPEN:-}" ] || xdg-open "$url" >/dev/null 2>&1 || true
fi
wait
