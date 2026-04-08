# helia-connectivity-lab

Phase 1: minimal **libp2p** connectivity check between a **relay + echo server** and a **desktop CLI client**. The server runs **circuit relay v2** (`circuitRelayServer`) and a custom protocol `/connectivity-echo/1.0.0` that echoes a line prefixed with `echo:`.

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
| **QUIC**        | *Not wired in this repo yet* | **QUIC on libp2p 2.x is supported** via **`@chainsafe/libp2p-quic@1.1.x`** (declares `@libp2p/interface` ^2.10 and `multiaddr` ^12, same generation as `libp2p` 2.x). **`@chainsafe/libp2p-quic@2.x`** targets **interface v3** / **multiaddr v13** (libp2p **3.x**); installing 2.x on a libp2p **2.x** app caused duplicate types and a **`stringTuples` / `getMultiaddrs` runtime error** in our earlier attempt. There is no separate **`@libp2p/quic`** package on npm; ChainSafe is the practical JS implementation. **Phase 1b:** pin **`@chainsafe/libp2p-quic@1.1.8`** (or latest **1.1.x**) with **`libp2p` ^2.10**—a full jump to libp2p v3 is optional, not required for QUIC. |

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
- **`POST /run/tcp/<port>`** — stops libp2p and starts it again with TCP bound to `<port>`. **PeerId stays the same** if you use `RELAY_PRIVATE_KEY_HEX` or `RELAY_KEY_FILE` (recommended on a VPS).
- **`POST /run/ws/<port>`** — same for the **WebSocket** listener port.

Each restart recreates the libp2p node; **WebRTC-Direct** listening addresses (including `certhash`) change even when **PeerId** is stable—re-copy those multiaddrs after a restart if you use WebRTC.

Example (control on 8008, then move libp2p TCP to 81 — **run Node as root** for ports &lt; 1024, or use `setcap cap_net_bind_service=+ep $(which node)`):

```bash
curl -sS -X POST "http://YOUR_HOST:8008/run/tcp/81" \
  -H "Authorization: Bearer $RELAY_CONTROL_TOKEN"
```

**Security:** anyone who can reach the control port and guess the token can rebind listeners. Prefer binding control to **localhost** and using SSH port-forwarding, or firewall the control port to your IP only, and use a long random token.

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
RELAY_TCP_PORT=9091 RELAY_WS_PORT=9092 RELAY_WEBRTC_PORT=9093 RELAY_LISTEN_IPV4=0.0.0.0 npm run server
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `RELAY_TCP_PORT` | `9091` | TCP listen port |
| `RELAY_WS_PORT` | `9092` | WebSocket listen port |
| `RELAY_WEBRTC_PORT` | `9093` | UDP port for **WebRTC-Direct** |
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

## Protocol

- **ID:** `/connectivity-echo/1.0.0`
- **Client → server:** one line terminated by `\n`
- **Server → client:** one line `\n`-terminated: `echo:<same line>` (or `echo:(empty)` if the line was blank)

## Roadmap

1. **Phase 1 (this repo):** libp2p dial + stream echo; relay server enabled; TCP, WS, WebRTC-Direct.
2. **Phase 1b:** Add **`@chainsafe/libp2p-quic@1.1.x`** + `/udp/.../quic-v1` listeners (stays on **libp2p 2.x**). Use **`@chainsafe/libp2p-quic@2.x`** only if you migrate the whole stack to **libp2p 3.x**.
3. **Phase 2:** Add `helia` + `@helia/unixfs`; publish a small text blob from the client; fetch on the server via the network (bitswap/DHT), still without HTTP.
4. **Phase 3:** Optional HTTP server on the server: `GET /ipfs/<cid>` backed by Helia `unixfs.cat` over the network.
5. **Phase 4:** Browser bundle (e.g. Vite) with WebSockets/WebRTC; same echo or `/ipfs` flow with CORS on the HTTP API.

## License

MIT
