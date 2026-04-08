# helia-connectivity-lab

Phase 1: minimal **libp2p** connectivity check between a **relay + echo server** and a **desktop CLI client**. The server runs **circuit relay v2** (`circuitRelayServer`) and two custom protocols: **`/connectivity-echo/1.0.0`** (one-line echo) and **`/connectivity-bulk/1.0.0`** (length-prefixed random payloads echoed back for sustained load tests).

Later phases (not implemented here yet): Helia + UnixFS CID fetch, HTTP `GET /ipfs/<cid>`, browser client.

## TLS / AutoTLS vs what this lab uses

- **This project does not use AutoTLS or WSS.** The WebSocket transport listens on **`ws://` (cleartext)**. The libp2p stack still negotiates **Noise** on top of the socket, so the libp2p session is encrypted and authenticated—this is **not** the same as browser-grade `wss://` + public PKI.
- **AutoTLS** (as in [orbitdb-relay-pinner](https://github.com/NiKrause/orbitdb-relay-pinner) with `@ipshipyard/libp2p-auto-tls`) provisions TLS certs so **`wss://`** and HTTPS endpoints can use normal TLS hostnames. That is **not** wired here; add it only if you need WSS/HTTPS interop.

## Transports you can test (no WebTransport)

| Transport        | Multiaddr shape (after `/p2p/<peerId>`) | Notes |
|-----------------|----------------------------------------|--------|
| **TCP**         | `/ip4/<host>/tcp/<port>/p2p/<peerId>` | Simplest for VPS + firewall. |
| **WebSocket**   | `/ip4/<host>/tcp/<port>/ws/p2p/<peerId>` | Cleartext **WS** + Noise (see above). |
| **WebRTC-Direct** | `/ip4/<host>/udp/<port>/webrtc-direct/certhash/.../p2p/<peerId>` | Copy **full** addr from server output (includes `certhash`). UDP port must be open. |
| **QUIC**        | `/ip4/<host>/udp/<port>/quic-v1/p2p/<peerId>` | **`@chainsafe/libp2p-quic@1.1.8`** with **libp2p 2.x**. Default **`RELAY_QUIC_PORT=5000`** matches Nym **`ExitPolicy accept *:5000-5005`**. Nym’s published policy is **TCP-oriented**; **UDP** to your server may still depend on the VPN path—test from your client. |

**WebTransport** is intentionally out of scope for now.

Disable WebRTC-Direct on the server if you only want TCP/WS: `RELAY_DISABLE_WEBRTC=true`.

## Nym VPN and the control HTTP API

[Nym exit policy](https://nymtech.net/.wellknown/network-requester/exit-policy.txt) only allows outbound TCP to certain **destination ports**. Your libp2p **TCP relay** must therefore listen on a port the mixnet can reach (e.g. **81**). The **control REST API** should listen on a port **you** can call through the mixnet (often **8008** or another allowed port—check the current policy).

Enable a small **Node HTTP** control server (plain HTTP, separate from libp2p):

| Variable | Meaning |
|----------|---------|
| `RELAY_CONTROL_HTTP_PORT` | If set (e.g. `8008`), the control API listens on this port. **Unset = disabled.** Alias: `CONTROL_HTTP_PORT`. |
| `RELAY_CONTROL_HTTP_HOST` | Bind address (default `0.0.0.0`). Alias: `CONTROL_HTTP_HOST`. |
| `RELAY_CONTROL_TOKEN` | **Required** when the control port is set. Use `Authorization: Bearer <token>` or header `X-Control-Token: <token>`. Alias: `CONTROL_TOKEN`. |
| `RELAY_CONTROL_CORS_ORIGIN` | Optional CORS allowlist for browser tools (default `*`). |

Endpoints:

- **`GET /health`** — no auth; `{"status":"ok","control":true}`.
- **`GET /status`** — requires auth; returns `peerId`, active `listenOverrides`, and `multiaddrs`.
- **`POST /run/tcp/<port>`** — schedules a libp2p stop/start with TCP bound to `<port>`. Responds **`202 Accepted`** with JSON **before** the restart finishes (so slow or crashy restarts do not produce an empty HTTP reply). **Poll `GET /status`** for the new `multiaddrs`. **PeerId stays the same** if you use `RELAY_PRIVATE_KEY_HEX` or `RELAY_KEY_FILE` (recommended on a VPS).
- **`POST /run/ws/<port>`** — same for the **WebSocket** listener port.
- **`POST /run/quic/<udp-port>`** — same for the **QUIC** (UDP) listener port.
- **`POST /run/webrtc/<udp-port>`** — same for **WebRTC-Direct** (UDP). **`POST /run/webrtc-direct/<udp-port>`** is an alias (same handler).

Each restart recreates the libp2p node; **WebRTC-Direct** listening addresses (including `certhash`) change even when **PeerId** is stable—re-copy those multiaddrs after a restart if you use WebRTC.

**`curl: (52) Empty reply from server` on `POST /run/...`:** often means the TCP connection closed with **no** HTTP body—e.g. **HTTPS on that port** while you use `http://` (try `openssl s_client -connect host:88` to see TLS), a **reverse proxy** resetting idle connections, or the **Node process exiting** during restart (check `journalctl -u helia-connectivity-lab -e`). After deploying the current code, you should at least get a **`202` JSON** before any in-process restart runs.

**`202` but `/status` never changes:** older builds waited for a response `finish` event before scheduling the restart; with some clients that event never fired, so nothing ran. Current code schedules restart on **`setImmediate`** and sends **`Connection: close`**. Wait a second, then **`GET /status`** again.

**TCP ports &lt; 1024** (e.g. **81**, **82**): binding requires **root** or **`CAP_NET_BIND_SERVICE`** on the Node binary (systemd `AmbientCapabilities=`). If restart fails after that, check **`journalctl -u helia-connectivity-lab -e`** for `EACCES` / `permission denied`.

Example (control on 8008, then move libp2p TCP to 81 — **run Node as root** for ports &lt; 1024, or use `setcap cap_net_bind_service=+ep $(which node)`):

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://YOUR_HOST:8008/run/tcp/81" \
  -H "Authorization: Bearer $RELAY_CONTROL_TOKEN"
# Expect HTTP 202, then:
curl -sS -H "Authorization: Bearer $RELAY_CONTROL_TOKEN" "http://YOUR_HOST:8008/status"
```

**Security:** anyone who can reach the control port and guess the token can rebind listeners. Prefer binding control to **localhost** and using SSH port-forwarding, or firewall the control port to your IP only, and use a long random token.

**401 Unauthorized with a “correct” token:** systemd applies **`EnvironmentFile=` after `Environment=`** and **overrides the same variable name**. If both the unit file and **`/etc/default/helia-connectivity-lab`** set `RELAY_CONTROL_TOKEN`, the **file wins**—the process will not use the token in the unit. Put the token in **one place only** (recommended: `/etc/default/helia-connectivity-lab`). Also use **`GET /status`** (not `POST`); `POST` is only for `/run/...`.

## Stable PeerId (recommended with control API)

| Variable | Meaning |
|----------|---------|
| `RELAY_PRIVATE_KEY_HEX` | Hex-encoded libp2p **private key protobuf** (persistent identity). |
| `RELAY_KEY_FILE` | Path to a hex key file; created on first start if missing (mode `0600`). |

Without these, each process start generates a new key; **TCP port changes via REST keep the same key** only within one process lifetime.

## Requirements

- Node.js **22+**

## Install & build

```bash
npm install
npm run build
```

## Run the server

Default listen: TCP **9091**, WebSocket **9092**, WebRTC-Direct UDP **9093** on `0.0.0.0`.

```bash
npm run server
# or
RELAY_TCP_PORT=9091 RELAY_WS_PORT=9092 RELAY_QUIC_PORT=5000 RELAY_WEBRTC_PORT=9093 RELAY_LISTEN_IPV4=0.0.0.0 npm run server
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `RELAY_TCP_PORT` | `9091` | TCP listen port (Nym: **81** is in `*:80-81`) |
| `RELAY_WS_PORT` | `9092` | WebSocket listen port (Nym: **8080** is allowed) |
| `RELAY_QUIC_PORT` | `5000` | UDP port for **QUIC** `/quic-v1` (Nym: **5000–5005** allowed) |
| `RELAY_WEBRTC_PORT` | `9093` | UDP for **WebRTC-Direct** (Nym: **3478–3484** allowed) |
| `RELAY_DISABLE_QUIC` | unset | Set to `true` to disable QUIC |
| `RELAY_LISTEN_IPV4` | `0.0.0.0` | IPv4 bind address |
| `RELAY_DISABLE_IPV6` | unset | Set to `true` or `1` to skip IPv6 listeners |
| `RELAY_DISABLE_WEBRTC` | unset | Set to `true` or `1` to disable WebRTC-Direct |

On start, the server prints **PeerId** and **dialable multiaddrs**. Pick the line that matches the transport you want to test (TCP, `/ws`, or `/webrtc-direct/.../certhash/...`).

## Run the client

Use the **exact** multiaddr from the server (including `/p2p/<peerId>` and, for WebRTC-Direct, the full `certhash` segment).

```bash
# TCP
npm run client -- '/ip4/<host>/tcp/9091/p2p/<serverPeerId>' 'home-vpn'

# WebSocket
npm run client -- '/ip4/<host>/tcp/9092/ws/p2p/<serverPeerId>' 'beeline-vpn'

# WebRTC-Direct (paste full line from server)
npm run client -- '/ip4/<host>/udp/9093/webrtc-direct/certhash/<...>/p2p/<serverPeerId>' 'simple-coffee-vpn'
```

Or:

```bash
RELAY_MULTIADDR='/ip4/203.0.113.10/tcp/9092/ws/p2p/12D3KooW...' npm run client -- 'beeline-vpn'
```

If the client should not load WebRTC (e.g. TCP/WS-only test): `CLIENT_DISABLE_WEBRTC=true`.

## Bulk transfer client (`/connectivity-bulk/1.0.0`)

Framing: **4-byte big-endian length** + **payload** (max **256 KiB** per frame). The server echoes each frame. The client verifies every round-trip.

```bash
# Default: escalation ladder 30s → 60s → 120s → 180s → 300s → 600s (stop on first failure)
npm run client:transfer -- '/ip4/<host>/tcp/<port>/p2p/<serverPeerId>'

# Fixed duration (seconds)
npm run client:transfer -- '/ip4/<host>/tcp/<port>/p2p/<serverPeerId>' --duration 120

# Optional payload size bounds (bytes)
npm run client:transfer -- '/ip4/.../p2p/...' --duration 60 --min-chunk 1024 --max-chunk 65536
```

## Repeatable transport matrix (VPN vs non-VPN)

Script: **`npm run test:transports`** — calls control **`GET /status`**, picks one multiaddr per transport (**TCP**, **WebSocket**, **QUIC**, **WebRTC-Direct**) for your **dial host**, runs **echo** (default) or **bulk** transfer, and **appends** a block to a text file (default **`transport-test-results.txt`** in the current directory; listed in `.gitignore`).

| Env / flag | Meaning |
|------------|---------|
| `RELAY_CONTROL_BASE` or `--base` | e.g. `http://95.217.163.72:8008` |
| `RELAY_CONTROL_TOKEN` or `--token` | Bearer token for `/status` |
| `RELAY_DIAL_HOST` or `--dial` | **Relay’s** public **IP or DNS** embedded in multiaddrs (e.g. `95.217.163.72`). This is where libp2p connects **to** — the VPS, **not** your laptop’s IP. If `--base` uses a numeric IP, this defaults to that host. |
| `--show-egress-ip` or `TRANSPORT_TEST_SHOW_EGRESS_IP=1` | Calls **api.ipify.org** and records **this machine’s** public IP in the report (handy to confirm Nym on vs off). |
| First positional | **Label** for the run (logged in the file; also the default **echo** payload when `--mode echo`). |
| `--mode echo` or `bulk` | **echo** = one-line test per transport (default). **bulk** = random framed payloads for a duration per transport. |
| `--duration SEC` | With **`--mode bulk`**: run exactly **SEC** seconds per transport (overrides default **30s**). |
| `--escalate` | With **`--mode bulk`**: run **30, 60, 120, 180, 300, 600** seconds per transport, stop at first failure. Ignored if **`--duration`** is set. |
| `--out FILE` | Append to this file instead (e.g. `--out ~/vpn-comparison.txt`). |
| `--message TEXT` | Override the echo string (default: same as the label; **echo** mode only). |
| `TRANSPORT_TEST_MODE` | Optional env alias for **`--mode`**. |

**Examples** (run twice: once with Nym off, once with Nym on, same `--out` to accumulate):

```bash
export RELAY_CONTROL_BASE=http://95.217.163.72:8008
export RELAY_CONTROL_TOKEN='your-token'
export RELAY_DIAL_HOST=95.217.163.72

npm run test:transports -- "run-without-vpn" --out ./transport-runs.txt
npm run test:transports -- "run-with-nym-vpn" --out ./transport-runs.txt
```

Requires server ports matching your deployment (e.g. Nym-friendly **81 / 8080 / 5000 / 3478** from [deploy/helia-connectivity-lab.service](deploy/helia-connectivity-lab.service)).

### VPN on vs off (run on your laptop)

Public **:8008** may be blocked by your cloud firewall; the matrix can still load **`GET /status`** via **SSH** and dial the public IP. Use:

```bash
chmod +x scripts/run-vpn-compare-matrix.sh
./scripts/run-vpn-compare-matrix.sh
```

The script prints when to turn **Nym ON** (wait 50s, then first run **`with-nym-vpn`**) and when to turn it **OFF** (wait 35s, then **`without-vpn`**). It fetches **`GET /status` over SSH** on **`RELAY_CTRL_PORT`** (default **88**). Override **`RELAY_SSH`**, **`RELAY_DIAL_HOST`**, **`TRANSPORT_RUNS`**, **`RELAY_CTRL_PORT`** if needed.

**`--dial`** is always the **relay server** address (same idea as **`RELAY_DIAL_HOST`** in the shell script). To see **your** public IP manually: `curl -sS https://api.ipify.org` (or add **`--show-egress-ip`** to the matrix so it’s written into the report).

Optional extra phases (same status JSON, same prompts pattern):

- **`RUN_BULK_MATRIX=1`** — after the two echo runs, runs **`--mode bulk`** (default **30s** per transport) with VPN on, then off.
- **`RUN_BULK_MATRIX_ESCALATE=1`** — runs bulk **escalation** (30s→10m per transport) with VPN on, then off (can take a long time).

## Deploying to a VPS (e.g. `libp2p.le-space.de`)

From your laptop (with SSH access), sync sources and install on the server:

```bash
rsync -avz --delete \
  --exclude node_modules --exclude dist --exclude .git \
  ./ root@libp2p.le-space.de:/opt/helia-connectivity-lab/

ssh root@libp2p.le-space.de 'cd /opt/helia-connectivity-lab && npm install && npm run build'
```

Run under `systemd`, `tmux`, or `screen`. Open ports **in your cloud provider’s firewall / security group** as well as on the VM (UFW etc.): **TCP 9091**, **TCP 9092**, **UDP 9093** (WebRTC-Direct). If inbound connections get `ECONNREFUSED` while `ss` shows `0.0.0.0:9091` listening, the block is almost always **upstream of the host**.

A reference unit file lives at [deploy/helia-connectivity-lab.service](deploy/helia-connectivity-lab.service). Adjust `ExecStart` to your Node path (`which node` on the server).

## Protocols

### `/connectivity-echo/1.0.0`

- **Client → server:** one line terminated by `\n`
- **Server → client:** one line `\n`-terminated: `echo:<same line>` (or `echo:(empty)` if the line was blank)

### `/connectivity-bulk/1.0.0`

- **Client → server:** repeated frames: **4-byte big-endian uint32** length **N**, then **N** bytes ( **N** ≤ 256 KiB; client uses random payloads).
- **Server → client:** same frame echoed back after each read.
- One libp2p stream uses a **single** `sink()` async generator (yield frame, await echo) so the writable half is only consumed once.

## Roadmap

1. **Phase 1 (this repo):** libp2p dial + stream echo + **bulk** sustained transfer; relay server enabled; TCP, WS, QUIC, WebRTC-Direct.
2. **Phase 1b:** **Done in repo** — **`@chainsafe/libp2p-quic@1.1.8`** + `/udp/.../quic-v1`. Optional future: **`@chainsafe/libp2p-quic@2.x`** if you migrate to **libp2p 3.x**.
3. **Phase 2:** Add `helia` + `@helia/unixfs`; publish a small text blob from the client; fetch on the server via the network (bitswap/DHT), still without HTTP.
4. **Phase 3:** Optional HTTP server on the server: `GET /ipfs/<cid>` backed by Helia `unixfs.cat` over the network.
5. **Phase 4:** Browser bundle (e.g. Vite) with WebSockets/WebRTC; same echo or `/ipfs` flow with CORS on the HTTP API.

## License

MIT
