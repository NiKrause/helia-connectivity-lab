#!/usr/bin/env bash
# Run on YOUR machine (where Nym runs). Fetches /status over SSH (avoids public :8008).
set -euo pipefail

RELAY_SSH="${RELAY_SSH:-root@libp2p.le-space.de}"
RELAY_DIAL_HOST="${RELAY_DIAL_HOST:-95.217.163.72}"
RELAY_CTRL_PORT="${RELAY_CTRL_PORT:-88}"
OUT="${TRANSPORT_RUNS:-$(dirname "$0")/../transport-runs.txt}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON="$(mktemp)"
trap 'rm -f "$JSON"' EXIT

echo "Fetching GET /status from relay over SSH → $JSON (port ${RELAY_CTRL_PORT})"
ssh -o BatchMode=yes "$RELAY_SSH" \
  "curl -fsS http://127.0.0.1:${RELAY_CTRL_PORT}/status" \
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

if [[ "${RUN_BULK_MATRIX:-0}" == "1" ]]; then
  echo ""
  echo "========================================================================"
  echo " 3) BULK transfer matrix (30s per transport). NYM **ON** — wait 50s."
  echo "========================================================================"
  sleep 50
  node dist/transport-matrix.js "with-nym-vpn-bulk" --mode bulk --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"

  echo ""
  echo "========================================================================"
  echo " 4) BULK transfer matrix. NYM **OFF** — wait 35s."
  echo "========================================================================"
  sleep 35
  node dist/transport-matrix.js "without-vpn-bulk" --mode bulk --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"
fi

if [[ "${RUN_BULK_MATRIX_ESCALATE:-0}" == "1" ]]; then
  echo ""
  echo "========================================================================"
  echo " 5) BULK **escalation** (30s→10m per transport). NYM **ON** — wait 50s."
  echo "========================================================================"
  sleep 50
  node dist/transport-matrix.js "with-nym-vpn-bulk-escalate" --mode bulk --escalate --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"

  echo ""
  echo "========================================================================"
  echo " 6) BULK **escalation**. NYM **OFF** — wait 35s."
  echo "========================================================================"
  sleep 35
  node dist/transport-matrix.js "without-vpn-bulk-escalate" --mode bulk --escalate --out "$OUT" --status-file "$JSON" --dial "$RELAY_DIAL_HOST"
fi

echo ""
echo "===== Done. Appended results to: $OUT ====="
tail -n 80 "$OUT"
