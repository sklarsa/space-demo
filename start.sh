#!/usr/bin/env bash
# One-shot launcher (Linux + macOS). Extra args go to feeder.py, e.g. ./start.sh --spacing 20
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d
[ -d node_modules/cesium ] || npm install
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
until curl -sf -o /dev/null "http://localhost:9000/exec?query=SELECT+1"; do sleep 1; done
trap 'kill $(jobs -p) 2>/dev/null' EXIT
.venv/bin/python -u feeder.py "$@" &
.venv/bin/python -u server.py &
sleep 2
url=http://localhost:8080
echo "demo: $url   questdb console: http://localhost:9000"
if [ "$(uname)" = Darwin ]; then open "$url"; else xdg-open "$url" >/dev/null 2>&1 || true; fi
wait
