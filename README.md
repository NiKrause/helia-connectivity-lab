# helia-connectivity-lab

[![CI](https://github.com/NiKrause/helia-connectivity-lab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NiKrause/helia-connectivity-lab/actions/workflows/ci.yml?query=branch%3Amain)

Phase 1: minimal **libp2p** connectivity check between a **relay + echo server** and a **desktop CLI client**. The server runs **circuit relay v2** (`circuitRelayServer`) and two custom protocols: **`/connectivity-echo/1.0.0`** (one-line echo) and **`/connectivity-bulk/1.0.0`** (length-prefixed random payloads echoed back for sustained load tests).

The same process also runs **Helia 5** on that **one** libp2p node (bitswap + in-memory blockstore). Optionally expose **`GET /ipfs/<cid>`** over HTTP(S) so the VPS can **`unixfs.cat`** a CID from the network (e.g. a laptop that dialed in on TCP / WS / QUIC / WebRTC like the rest of the lab).

**Browser PWA:** `apps/pwa` — Svelte + Vite + **`vite-plugin-pwa`**. Run **`npm run pwa:dev`** (after **`cd apps/pwa && npm install`**). Set **`VITE_RELAY_HTTP_BASE`** (see [apps/pwa/.env.example](apps/pwa/.env.example)). The app is already implemented; see [Browser PWA](#browser-pwa) for the verified feature set.

## TLS / AutoTLS vs cleartext WebSocket

- **Default:** the WebSocket transport listens on **`ws://` (cleartext TCP)**. **Noise** still encrypts the libp2p session on top—this is **not** browser-style **`wss://`** with public PKI.
- **Optional AutoTLS:** set **`RELAY_AUTO_TLS=1`** and a writable **`RELAY_AUTO_TLS_DATASTORE_PATH`** (LevelDB dir for certs/keys, e.g. under `/var/lib/...`). The relay loads [**`@ipshipyard/libp2p-auto-tls`**](https://www.npmjs.com/package/@ipshipyard/libp2p-auto-tls) plus **`@libp2p/keychain`**, same idea as [orbitdb-relay-pinner](https://github.com/NiKrause/orbitdb-relay-pinner). After the node is **publicly reachable** on the WS port, announced multiaddrs can include **`/tls/ws`** (Let’s Encrypt via **libp2p.direct**). **`autoConfirmAddress: true`** is set so a VPS with a stable public IP does not wait indefinitely for peer confirmation.
- **`RELAY_AUTO_TLS_STAGING=1`** uses Let’s Encrypt **staging** (avoid rate limits while testing).
- If **`Listen addresses`** only show **`127.0.0.1`** (relay behind port forwarding), set **`RELAY_APPEND_ANNOUNCE`** to your **public** TCP and cleartext WS multiaddrs (comma-separated, no spaces) so AutoTLS and **`GET /status`** expose routable addresses.
- **Clients** that want TLS must dial the **`/tls/ws`** multiaddr from **`GET /status`**, not only the cleartext `/ws` line. Rebuild this repo after **`npm install`** so the client uses **`@multiformats/multiaddr@12.5.1`** (see version table); otherwise long **`/tls/sni/...`** addresses can fail at dial with **`Incorrect length`**.
- **Debug AutoTLS:** the service uses the logger component **`libp2p:auto-tls`** (hyphen). Enable with either:
  - **`DEBUG=libp2p:auto-tls npm run server`** (or **`npm run server:debug-autotls`** after `npm run build`), or
  - **`RELAY_DEBUG=libp2p:auto-tls`** in the environment (merged into **`DEBUG`** on startup; handy in systemd).  
  **`DEBUG=libp2p:autotls`** (no hyphen) does **not** match and will stay silent.

## Transports you can test (no WebTransport)

| Transport        | Multiaddr shape (after `/p2p/<peerId>`) | Notes |
|-----------------|----------------------------------------|--------|
| **TCP**         | `/ip4/<host>/tcp/<port>/p2p/<peerId>` | Simplest for VPS + firewall. |
| **WebSocket**   | `/ip4/<host>/tcp/<port>/ws/p2p/<peerId>` | Cleartext **WS** + Noise (see above). With **AutoTLS**, also **`/tcp/.../tls/ws/p2p/...`** (TLS WebSocket). |
| **WebRTC-Direct** | `/ip4/<host>/udp/<port>/webrtc-direct/certhash/.../p2p/<peerId>` | Copy **full** addr from server output (includes `certhash`). UDP port must be open. |
| **QUIC**        | `/ip4/<host>/udp/<port>/quic-v1/p2p/<peerId>` | **`@chainsafe/libp2p-quic@1.1.8`** with **libp2p 2.x**. Default **`RELAY_QUIC_PORT=5000`** matches Nym **`ExitPolicy accept *:5000-5005`**. Nym’s published policy is **TCP-oriented**; **UDP** to your server may still depend on the VPN path—test from your client. |

**WebTransport** is intentionally out of scope for now.

Disable WebRTC-Direct on the server if you only want TCP/WS: `RELAY_DISABLE_WEBRTC=true`.

## Nym VPN and the control HTTP API

[Nym exit policy](https://nymtech.net/.wellknown/network-requester/exit-policy.txt) only allows outbound TCP to certain **destination ports**. Your libp2p **TCP relay** must therefore listen on a port the mixnet can reach (e.g. **8443** with the current published policy). The **control REST API** should listen on a port **you** can call through the mixnet (often **8008** or another allowed port—check the current policy).

Enable a small **Node HTTP** control server (plain HTTP, separate from libp2p):

| Variable | Meaning |
|----------|---------|
| `RELAY_CONTROL_HTTP_PORT` | If set (e.g. `8008`), the control API listens on this port. **Unset = disabled.** Alias: `CONTROL_HTTP_PORT`. |
| `RELAY_CONTROL_HTTP_HOST` | Bind address (default `0.0.0.0`). Alias: `CONTROL_HTTP_HOST`. |
| `RELAY_CONTROL_TOKEN` | **Required** when the control port is set. Use `Authorization: Bearer <token>` or header `X-Control-Token: <token>`. Alias: `CONTROL_TOKEN`. |
| `RELAY_CONTROL_CORS_ORIGIN` | Optional CORS allowlist for browser tools (default `*`). |

Endpoints:

- **`GET /health`** — no auth; `{"status":"ok","control":true}` (and **`"ipfsGateway":true`** when **`RELAY_IPFS_GATEWAY=1`** — see [IPFS gateway](#optional-ipfs-http-gateway-same-libp2p-as-the-relay)).
- **`GET /status`** — **no auth**; returns `peerId`, `listenOverrides`, **`multiaddrs` filtered to public addresses** (no RFC1918 / loopback / typical ULA), and **`pubsubDiscoveryTopic`** (active `@libp2p/pubsub-peer-discovery` topic).
- **`POST /run/tcp/<port>`** — **requires auth**; schedules a libp2p stop/start with TCP bound to `<port>`. Responds **`202 Accepted`** with JSON **before** the restart finishes (so slow or crashy restarts do not produce an empty HTTP reply). **Poll `GET /status`** for the new `multiaddrs`. **PeerId stays the same** if you use `RELAY_PRIVATE_KEY_HEX` or `RELAY_KEY_FILE` (recommended on a VPS).
- **`POST /run/ws/<port>`** — same for the **WebSocket** listener port.
- **`POST /run/quic/<udp-port>`** — same for the **QUIC** (UDP) listener port.
- **`POST /run/webrtc/<udp-port>`** — same for **WebRTC-Direct** (UDP). **`POST /run/webrtc-direct/<udp-port>`** is an alias (same handler).
- **`POST /run/pubsub-discovery`** — **requires auth**; JSON body **`{"topic":"<string>"}`** sets the **pubsub peer discovery** topic and restarts libp2p (same **`202`** + poll **`/status`** pattern).

| Variable | Meaning |
|----------|---------|
| **`RELAY_PUBSUB_DISCOVERY_TOPIC`** | Initial pubsub peer-discovery topic (default **`_peer-discovery._p2p._pubsub`**). Overridden by **`POST /run/pubsub-discovery`** while the process runs. |
| **`RELAY_MAX_RESERVATIONS`** | Max simultaneous **circuit relay v2** reservations the server accepts (default **1500**, ~100× the old **15**). When full, new reserves return **`RESERVATION_REFUSED`**. Capped at **100000** if you set this env. |

The relay also runs **gossipsub**, **`@libp2p/pubsub-peer-discovery`**, and **`@libp2p/dcutr`** alongside **circuit relay v2**.

Each restart recreates the libp2p node; **WebRTC-Direct** listening addresses (including `certhash`) change even when **PeerId** is stable—re-copy those multiaddrs after a restart if you use WebRTC.

**`curl: (52) Empty reply from server` on `POST /run/...`:** often means the TCP connection closed with **no** HTTP body—e.g. **HTTPS on that port** while you use `http://` (try `openssl s_client -connect host:8008` to see TLS), a **reverse proxy** resetting idle connections, or the **Node process exiting** during restart (check `journalctl -u helia-connectivity-lab -e`). After deploying the current code, you should at least get a **`202` JSON** before any in-process restart runs.

**`202` but `/status` never changes:** older builds waited for a response `finish` event before scheduling the restart; with some clients that event never fired, so nothing ran. Current code schedules restart on **`setImmediate`** and sends **`Connection: close`**. Wait a second, then **`GET /status`** again.

**TCP ports &lt; 1024** still require **root** or **`CAP_NET_BIND_SERVICE`** on the Node binary (systemd `AmbientCapabilities=`). If restart fails after that, check **`journalctl -u helia-connectivity-lab -e`** for `EACCES` / `permission denied`. For current Nym-friendly deployments, prefer **8443** instead of older examples such as **81**.

Example (control on 8008, then move libp2p TCP to 8443):

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://YOUR_HOST:8008/run/tcp/8443" \
  -H "Authorization: Bearer $RELAY_CONTROL_TOKEN"
# Expect HTTP 202, then:
curl -sS "http://YOUR_HOST:8008/status"
```

**Security:** anyone who can reach the control port and guess the token can rebind listeners. Prefer binding control to **localhost** and using SSH port-forwarding, or firewall the control port to your IP only, and use a long random token.

## Optional IPFS HTTP gateway (same libp2p as the relay)

When the **control HTTP API** is enabled (**`RELAY_CONTROL_HTTP_PORT`** + **`RELAY_CONTROL_TOKEN`**), **`GET /ipfs/<cid>`** is served on the **same TCP port** as **`GET /health`** and **`GET /status`** — no second HTTP listener. **`GET /ipfs/...`** and **`GET /status`** do not require auth (public read). **`POST /run/...`** still needs the Bearer token.

- **`GET /ipfs/<cid>`** — streams **`unixfs.cat`** via **Helia** (bitswap) on the relay’s libp2p node.
- **`GET /health`** — if the IPFS gateway is enabled, body includes both flags, e.g. `{"status":"ok","control":true,"ipfsGateway":true}`; otherwise `{"status":"ok","control":true}`.

| Variable | Meaning |
|----------|---------|
| `RELAY_IPFS_GATEWAY` | Set to **`1`** or **`true`** to enable **`/ipfs/<cid>`** on the **control HTTP** port (recommended). |
| `RELAY_IPFS_HTTP_PORT` | **Legacy / fallback:** if the control API is **disabled**, a **standalone** gateway can listen on this port (must differ from **`RELAY_WS_PORT`** TCP port). If control HTTP is **enabled**, this value is **not** used for binding (routes are on the control port). Alias: `IPFS_HTTP_PORT`. |
| `RELAY_IPFS_HTTP_HOST` | Bind host for **standalone** mode only (default `0.0.0.0`). Alias: `IPFS_HTTP_HOST`. |
| `RELAY_IPFS_TLS_CERT` / `RELAY_IPFS_TLS_KEY` | PEM paths for **standalone** HTTPS only (control plane stays plain HTTP unless you terminate TLS elsewhere). |
| `RELAY_IPFS_CAT_TIMEOUT_MS` | Max time for a single `cat` stream (default **120000**). |
| `RELAY_IPFS_GATEWAY_LOG` | Set to **`1`** or **`true`** to log each **`/ipfs/<cid>`** to stderr / journal: `cat start`, **`cat progress`**, **`cat done`** / **`cat error`**. Also logs **`GET /health`** when the gateway is enabled. |
| `RELAY_IPFS_GATEWAY_LOG_PROGRESS_BYTES` | Bytes between **`cat progress`** lines (default **262144**). **`0`** = only start/done/error. |

**libp2p connection visibility (optional):**

| Variable | Where | Meaning |
|----------|-------|---------|
| `LIBP2P_CONN_LOG=1` | **VPS** | `connection:open` / `close`, `peer:connect` / `disconnect` (peer id, direction, remote multiaddr, mux, encryption). Alias: `RELAY_LIBP2P_CONN_LOG=1`. |
| _(default on)_ | **`helia-laptop-provide`** | Same on stderr (`[laptop-provide]`). Disable with **`HELIA_LAPTOP_CONN_LOG=0`**. |

Open your **control HTTP** port in the **firewall** if you need **`/ipfs`** from the internet (same port as **`/status`**). **Control-plane restarts** replace the in-process Helia instance; the HTTP server keeps running and uses the current runtime per request.

### Laptop to VPS: Helia file over HTTP and bitswap

**Idea:** the **laptop** runs Helia, **dials the relay** on libp2p (e.g. TCP **8443**), **adds** a file, and stays running. The **VPS relay** serves **`GET /ipfs/<cid>`** on the **control HTTP port**; Helia on the VPS **bitswaps** blocks from the laptop over that libp2p connection. The machine that runs **`curl`** only needs HTTP access to the VPS; it does **not** need to be the laptop—but the **laptop provider must stay up** until the download finishes.

**VPS prerequisites (environment, e.g. `/etc/default/helia-connectivity-lab`):**

- **`RELAY_CONTROL_HTTP_PORT`** and **`RELAY_CONTROL_TOKEN`** (control API on).
- **`RELAY_IPFS_GATEWAY=1`** so **`/ipfs/<cid>`** is mounted on that same HTTP port.
- Optional: **`RELAY_IPFS_GATEWAY_LOG=1`**, **`LIBP2P_CONN_LOG=1`** (see [Viewing logs on the VPS](#viewing-logs-on-the-vps)).
- Firewall: **libp2p TCP** (e.g. **8443**) from the internet so the laptop can dial; **control HTTP port** (e.g. **8008**) if you **`curl`** from outside.

**Steps (order matters):**

1. **VPS — follow logs** (SSH session; see section below):  
   `journalctl -u helia-connectivity-lab -f`  
   Leave this running so you see **`[relay libp2p]`** connection lines and **`[ipfs-gateway]`** `cat start` / `cat done` or errors.

2. **Laptop — provider** (second terminal; repo root, after `npm run build`):

```bash
npm run helia:laptop-provide -- \
  '/ip4/<VPS_PUBLIC_IP>/tcp/<LIBP2P_TCP_PORT>/p2p/<RELAY_PEER_ID>' \
  /path/to/file.jpg
```

Use the **relay’s public IPv4** and the **TCP port** the relay listens on (often **8443** for Nym-friendly setups). **`PeerId`** must match the relay (from **`GET /status`** or server boot log). Wait for **`Dial OK`** and copy the printed **UnixFS CID**. **Do not press Ctrl+C** until the download is done.

3. **Fetch over HTTP** (third terminal or any host that reaches the VPS control port). Prefer **no HTTP proxy** so debugging matches the server logs:

```bash
curl --noproxy '*' -v --progress-bar -o /tmp/out.jpg \
  "http://<VPS_HOST_OR_IP>:<CONTROL_HTTP_PORT>/ipfs/<CID_FROM_STEP_2>"
curl -sS "http://<VPS_HOST_OR_IP>:<CONTROL_HTTP_PORT>/health"
```

Example host **`relay.seidenwege.com`**, control port **443** via reverse proxy or **8008** locally:  
`https://relay.seidenwege.com/ipfs/bafy...`

4. **Success:** laptop stderr shows **`[laptop-provide]`** `connection:open` **outbound**; VPS journal shows **inbound** `connection:open` and **`[ipfs-gateway] cat done`** with **`bytes=`** matching the file size. **`curl`** exits 0 and the output file grows.

**If `cat` times out (`bytesSent=0`, errors like “All promises were rejected”):** bitswap got no blocks—usually the **provider exited**, the **libp2p connection dropped**, or **`curl` used an HTTP proxy** (server log may show `client=…:3128`; that is unrelated to libp2p). Confirm with **`LIBP2P_CONN_LOG`** on both sides that the peer is still connected when **`curl`** runs.

**Standalone gateway (no control API):** set **`RELAY_IPFS_HTTP_PORT`** to a free TCP port (not the WebSocket listener port). With TLS PEM paths, use **`https://`** for that standalone port.

```bash
curl -sS -o downloaded.txt "https://relay.example.com:<STANDALONE_PORT>/ipfs/bafy..."
```

### Viewing logs on the VPS

These commands use **systemd**’s **`journalctl`**. They run **on the VPS** (Linux), not on macOS.

**SSH into the VPS, then:**

```bash
# Live follow (Ctrl+C to stop)
journalctl -u helia-connectivity-lab -f

# Last 80 lines
journalctl -u helia-connectivity-lab -n 80 --no-pager

# Since the last 15 minutes
journalctl -u helia-connectivity-lab --since "15 min ago" --no-pager
```

**From your laptop without an interactive shell:**

```bash
ssh root@YOUR_VPS 'journalctl -u helia-connectivity-lab -f'
```

**Filter to IPFS gateway lines only (on the VPS):**

```bash
journalctl -u helia-connectivity-lab -f | grep ipfs-gateway
```

**What to look for**

- **`[relay libp2p]`** — libp2p **`connection:open`** / **`peer:connect`** when the laptop dials.
- **`[ipfs-gateway]`** — **`cat start`**, **`cat progress`**, **`cat done`** or **`cat error`** for each **`GET /ipfs/<cid>`** (when **`RELAY_IPFS_GATEWAY_LOG=1`**).
- Boot lines: **Control HTTP listening**, **GET /ipfs/<cid>**, relay **PeerId** and **multiaddrs**.

**401 Unauthorized with a “correct” token:** systemd applies **`EnvironmentFile=` after `Environment=`** and **overrides the same variable name**. If both the unit file and **`/etc/default/helia-connectivity-lab`** set `RELAY_CONTROL_TOKEN`, the **file wins**—the process will not use the token in the unit. Put the token in **one place only** (recommended: `/etc/default/helia-connectivity-lab`). **`GET /status`** is public; **`401`** on **`POST /run/...`** means the token header is missing or wrong.

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
| `RELAY_TCP_PORT` | `9091` | TCP listen port (for current Nym-friendly deployments, use **8443**) |
| `RELAY_WS_PORT` | `9092` | WebSocket listen port (Nym: **8080** is allowed) |
| `RELAY_QUIC_PORT` | `5000` | UDP port for **QUIC** `/quic-v1` (Nym: **5000–5005** allowed) |
| `RELAY_WEBRTC_PORT` | `9093` | UDP for **WebRTC-Direct** (Nym: **3478–3484** allowed) |
| `RELAY_DISABLE_QUIC` | unset | Set to `true` to disable QUIC |
| `RELAY_LISTEN_IPV4` | `0.0.0.0` | IPv4 bind address |
| `RELAY_DISABLE_IPV6` | unset | Set to `true` or `1` to skip IPv6 listeners |
| `RELAY_DISABLE_WEBRTC` | unset | Set to `true` or `1` to disable WebRTC-Direct |
| `RELAY_AUTO_TLS` | unset | Set to **`1`** to enable **`@ipshipyard/libp2p-auto-tls`** (needs **`RELAY_AUTO_TLS_DATASTORE_PATH`**). |
| `RELAY_AUTO_TLS_DATASTORE_PATH` | `./libp2p-autotls-data` | Writable directory for LevelDB (certs). Use e.g. **`/var/lib/helia-connectivity-lab/libp2p-datastore`** on a VPS. |
| `RELAY_AUTO_TLS_STAGING` | unset | Set to **`1`** for Let’s Encrypt **staging** ACME. |
| `RELAY_APPEND_ANNOUNCE` | unset | Comma-separated multiaddrs **without spaces** to **append** as announced addresses (e.g. public **`/ip4/x/tcp/8443`** and **`/ip4/x/tcp/8080/ws`** when the process listens on loopback behind port forwarding). Helps **`GET /status`** and **AutoTLS** see a publicly dialable WS address. **WebRTC-Direct:** the relay often lists WebRTC only on **`/ip4/127.0.0.1/udp/…/webrtc-direct/certhash/…`**; browsers cannot dial that. Copy that line, replace **`127.0.0.1`** with your VPS public IPv4 (keep **`certhash`** and **`/p2p/…`** unchanged), and add it here so **gossipsub peer discovery** and **`GET /status`** expose a public WebRTC multiaddr. |
| `RELAY_DEBUG` | unset | Appended to **`DEBUG`** before startup. Examples: **`libp2p:circuit-relay*`**, **`libp2p:gossipsub*`** (logs as `libp2p:gossipsub`), **`libp2p:auto-tls`**. Combine with commas (sample unit includes circuit-relay + gossipsub + `gossipsub:*`). Reservation **`[relay-reservation]`** lines are independent of **`DEBUG`**. |

On start, the server prints **PeerId** and **dialable multiaddrs**. Pick the line that matches the transport you want to test (TCP, `/ws`, **`/tls/ws`** if AutoTLS has run, or `/webrtc-direct/.../certhash/...`).

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

Requires server ports matching your deployment (e.g. Nym-friendly **8443 / 8080 / 5000 / 3478** from [deploy/helia-connectivity-lab.service](deploy/helia-connectivity-lab.service)).

### VPN on vs off (run on your laptop)

Public **:8008** may be blocked by your cloud firewall; the matrix can still load **`GET /status`** via **SSH** and dial the public IP. Use:

```bash
chmod +x scripts/run-vpn-compare-matrix.sh
./scripts/run-vpn-compare-matrix.sh
```

The script prints when to turn **Nym ON** (wait 50s, then first run **`with-nym-vpn`**) and when to turn it **OFF** (wait 35s, then **`without-vpn`**). It fetches **`GET /status` over SSH** on **`RELAY_CTRL_PORT`** (default **8008**). Override **`RELAY_SSH`**, **`RELAY_DIAL_HOST`**, **`TRANSPORT_RUNS`**, **`RELAY_CTRL_PORT`** if needed.

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

## Helia / IPFS (libp2p 2.x only)

**Do not use current `helia@6`** on npm: it pulls **`libp2p@^3`**. This repo stays on **`libp2p@^2.10`** like the rest of the lab.

**Pinned stack (same band as [`orbitdb-relay-pinner`](https://github.com/NiKrause/orbitdb-relay-pinner)):**

| Package | Version | Notes |
|---------|---------|--------|
| `helia` | **5.3.0** | Works with libp2p 2.x |
| `@helia/unixfs` | **5.1.0** | UnixFS add / cat |
| `blockstore-core` / `datastore-core` | **5.x / 10.x** | In-memory stores in tests |
| `multiformats` | **13.4.x** | CID parsing |
| `@multiformats/multiaddr` | **12.5.1** (via **`overrides`**) | **Required** for AutoTLS dial strings with **`/tls/sni/.../libp2p.direct/ws/p2p/...`**. Older **12.4.x** can mis-parse **`/p2p/`** and throw **`Incorrect length`** in **`peerIdFromString`**. Same pin as **pnpm `overrides`** in **bolt-orbitdb-blog** / **`@multiformats/multiaddr@12.5.1`**. |
| `libp2p` | **^2.10.0** | Unchanged |

**`overrides`:** **`it-length-prefixed`** (relay-pinner alignment) and **`@multiformats/multiaddr@12.5.1`** so every dependency resolves one multiaddr implementation.

### Phase 2A — local two-node round-trip

Two default Helia nodes on loopback; peer 2 dials peer 1; add bytes on 1; `cat` the same CID on 2 (bitswap).

```bash
npm run test:helia:local
```

### Phase 2B — remote fetch (your laptop → VPS peer)

After a **remote** Helia/libp2p peer holds the data, fetch by **full multiaddr** + **CID**:

```bash
npm run test:helia:remote -- '/ip4/95.217.163.72/tcp/8443/p2p/12D3KooW...' bafkrei...
```

The **relay process** embeds **Helia** on the **same** libp2p stack as echo/bulk. Step-by-step **laptop to VPS** test (**`helia:laptop-provide`**, **`curl /ipfs/<cid>`**, **journalctl**) is in [Laptop to VPS: Helia file over HTTP and bitswap](#laptop-to-vps-helia-file-over-http-and-bitswap) and [Viewing logs on the VPS](#viewing-logs-on-the-vps). For a full pinning product, **`orbitdb-relay-pinner`** remains the richer reference.

## Browser PWA

The browser app in **`apps/pwa`** is already beyond “roadmap” status.

- **Stack:** **Svelte 5** + **Vite 8** + **`vite-plugin-pwa`** with a generated manifest / service worker for production builds.
- **Commands:** **`npm run pwa:dev`**, **`npm run pwa:check`**, **`npm run pwa:build`**.
- **Env:** set **`VITE_RELAY_HTTP_BASE`** (see [apps/pwa/.env.example](apps/pwa/.env.example)).
- **Verified UI capabilities:** relay **`GET /health`** / **`GET /status`** with optional token, relay multiaddr table with public-address filtering plus custom rows, manual **echo** + **bulk** tests, browser libp2p node + own multiaddrs, **gossipsub / pubsub peer discovery** with topic sync + drift warning, **WebRTC-filtered auto-dial**, relay reservation error banner, **Helia add**, and relay **`GET /ipfs/<cid>`** fetch.
- **Browser transport scope:** the PWA can dial **WebSocket / WSS** and **WebRTC** multiaddrs. Raw **TCP** and **QUIC** remain Node-only in this app.
- **PWA wiring:** the app registers the service worker on startup and the production build emits **`sw.js`** / **`manifest.webmanifest`**.

## Cleanup Candidates

- Replace or remove the stock template doc in **`apps/pwa/README.md`**; it still describes the default Vite/Svelte starter instead of this lab app.
- Remove unused starter assets if you do not plan to use them: **`apps/pwa/src/assets/svelte.svg`**, **`apps/pwa/src/assets/vite.svg`**, **`apps/pwa/src/assets/hero.png`**, **`apps/pwa/public/icons.svg`**.
- The current **`npm run pwa:build`** succeeds, but Vite warns that the main JS chunk is large (~**1.4 MiB** minified). If startup size matters, split the heavy libp2p / Helia paths.

## Roadmap

### Completed in Repo

1. **Phase 1:** libp2p dial + stream echo + **bulk** sustained transfer; relay server enabled; TCP, WS, QUIC, WebRTC-Direct.
2. **Phase 1b:** **Done in repo** — **`@chainsafe/libp2p-quic@1.1.8`** + `/udp/.../quic-v1`. Optional future: **`@chainsafe/libp2p-quic@2.x`** if you migrate to **libp2p 3.x**.
3. **Phase 2:** **Done in repo** — Helia **5.3** + `@helia/unixfs` **5.1**: **2A** local round-trip; **2B** remote `cat` CLI; **relay + Helia** in one process; optional **`GET /ipfs/<cid>`** HTTP(S) gateway.
4. **Phase 4:** **Done in repo** — browser PWA in **`apps/pwa`** with **WebSocket/WebRTC** dialing, echo + bulk, relay status / health integration, pubsub peer discovery, Helia add, and relay **`GET /ipfs/<cid>`** fetch.

### Next

1. **Phase 3:** Hardening / ops (rate limits, auth on **`/ipfs`**, metrics, persistent blockstore if needed).
2. **Polish / cleanup:** replace the PWA starter docs, prune unused starter assets, and reduce the browser bundle size if cold-start performance becomes important.

## License

MIT
