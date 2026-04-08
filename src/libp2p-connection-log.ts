import type { Connection, PeerId } from '@libp2p/interface'
import type { Libp2p } from 'libp2p'

/** Server / generic: `LIBP2P_CONN_LOG=1` or `RELAY_LIBP2P_CONN_LOG=1` */
export function libp2pConnLogEnabledForRelay(): boolean {
  const v = (process.env.LIBP2P_CONN_LOG || process.env.RELAY_LIBP2P_CONN_LOG || '').toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * Laptop `helia-laptop-provide`: on by default; set `HELIA_LAPTOP_CONN_LOG=0` to silence.
 * You can also force `LIBP2P_CONN_LOG=1` (redundant if default on).
 */
export function libp2pConnLogEnabledForLaptopProvide(): boolean {
  const off = (process.env.HELIA_LAPTOP_CONN_LOG || '').toLowerCase()
  if (off === '0' || off === 'false') {
    return false
  }
  return true
}

/**
 * Logs `connection:open` / `connection:close` with peer id, direction, remote addr, mux + encryption.
 */
export function attachLibp2pConnectionLogging(libp2p: Libp2p, tag: string): void {
  const line = (msg: string) => console.log(`${tag} ${msg}`)

  const onConnOpen = (evt: Event) => {
    const c = (evt as CustomEvent<Connection>).detail
    line(
      `connection:open  id=${c.id}  dir=${c.direction}  remotePeer=${c.remotePeer.toString()}  remoteAddr=${c.remoteAddr.toString()}  mux=${c.multiplexer ?? '-'}  enc=${c.encryption ?? '-'}`
    )
  }

  const onConnClose = (evt: Event) => {
    const c = (evt as CustomEvent<Connection>).detail
    line(`connection:close  id=${c.id}  remotePeer=${c.remotePeer.toString()}`)
  }

  const onPeerConnect = (evt: Event) => {
    const id = (evt as CustomEvent<PeerId>).detail
    line(`peer:connect  ${id.toString()}  (libp2p peers: ${libp2p.getPeers().length})`)
  }

  const onPeerDisconnect = (evt: Event) => {
    const id = (evt as CustomEvent<PeerId>).detail
    line(`peer:disconnect  ${id.toString()}`)
  }

  libp2p.addEventListener('connection:open', onConnOpen)
  libp2p.addEventListener('connection:close', onConnClose)
  libp2p.addEventListener('peer:connect', onPeerConnect)
  libp2p.addEventListener('peer:disconnect', onPeerDisconnect)
}
