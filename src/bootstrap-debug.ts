/**
 * Import this file first from `server.ts` so the `debug` package sees namespaces
 * before libp2p / AutoTLS load.
 *
 * Use **`RELAY_DEBUG=libp2p:auto-tls`** (systemd `Environment=`) or shell:
 * `DEBUG=libp2p:auto-tls npm run server`
 *
 * The AutoTLS service logs under **`libp2p:auto-tls`** (hyphen). The name
 * `libp2p:autotls` will not match.
 */
const relay = process.env.RELAY_DEBUG?.trim()
if (relay) {
  const existing = process.env.DEBUG?.trim()
  process.env.DEBUG = [existing, relay].filter(Boolean).join(',')
}
