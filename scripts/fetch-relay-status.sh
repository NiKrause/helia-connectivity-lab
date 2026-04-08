#!/usr/bin/env bash
# Fetch GET /status from the relay over SSH (when port 8008 is not open on the public IP).
# Usage: ./scripts/fetch-relay-status.sh root@libp2p.le-space.de > .relay-status.json
set -euo pipefail
HOST="${1:?usage: $0 user@ssh-host}"
ssh -o BatchMode=yes "$HOST" 'set -a; [ -f /etc/default/helia-connectivity-lab ] && . /etc/default/helia-connectivity-lab; set +a; curl -sS -H "Authorization: Bearer ${RELAY_CONTROL_TOKEN}" http://127.0.0.1:8008/status'
