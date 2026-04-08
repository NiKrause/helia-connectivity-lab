#!/usr/bin/env bash
# Run on YOUR machine (where Nym runs). Fetches /status over SSH (avoids public :88).
set -euo pipefail

RELAY_SSH="${RELAY_SSH:-root@libp2p.le-space.de}"
RELAY_DIAL_HOST="${RELAY_DIAL_HOST:-95.217.163.72}"
OUT="${TRANSPORT_RUNS:-$(dirname "$0")/../transport-runs.txt}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON="$(mktemp)"
trap 'rm -f "$JSON"' EXIT

echo "Fetching GET /status from relay over SSH → $JSON"
ssh -o BatchMode=yes "$RELAY_SSH" \
  'set -a; [ -f /etc/default/helia-connectivity-lab ] && . /etc/default/helia-connectivity-lab; set +a; curl -fsS -H "Authorization: Bearer ${RELAY_CONTROL_TOKEN}" http://127.0.0.1:88/status' \
  >"$JSON"

cd "$REPO_ROOT"
npm run build >/dev/null

echo ""
echo "========================================================================"
echo " 1) Turn NYM VPN **ON** and wait until connected."
echo "    First transport matrix runs after 50 seconds."
echo "========================================================================"
sleep 50

node dist/transport-matrix.js "with-nym-vpn" --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"

echo ""
echo "========================================================================"
echo " 2) Turn NYM VPN **OFF** (disconnect)."
echo "    Second transport matrix runs after 35 seconds."
echo "========================================================================"
sleep 35

node dist/transport-matrix.js "without-vpn" --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"

echo ""
echo "===== Done. Appended results to: $OUT ====="
tail -n 80 "$OUT"
