import type { Libp2p } from 'libp2p'

type ReserveResult = { status: string; expire?: number }
type ReservationStoreLike = {
  reserve: (peer: { toString: () => string }, addr: { toString: () => string }, limit?: unknown) => ReserveResult
}

type RelayServiceLike = {
  reservationStore: ReservationStoreLike & { __relayReservationLogPatched?: boolean }
}

type Libp2pWithRelay = Libp2p & { services: { relay?: RelayServiceLike } }

/**
 * Always-visible stdout lines for circuit relay v2 reservation outcomes (complements DEBUG=libp2p:circuit-relay*).
 * Hooks the relay service reservation store after the node is up.
 */
export function attachRelayReservationConsoleLog(libp2p: Libp2p): void {
  const relay = (libp2p as Libp2pWithRelay).services?.relay
  const store = relay?.reservationStore
  if (store?.reserve == null || store.__relayReservationLogPatched) return
  store.__relayReservationLogPatched = true

  const orig = store.reserve.bind(store) as ReservationStoreLike['reserve']

  store.reserve = (peer, addr, limit) => {
    const result = orig(peer, addr, limit)
    const peerStr = peer.toString()
    const addrStr = addr.toString()
    const st = result.status

    if (st === 'RESERVATION_REFUSED') {
      console.warn(
        `[relay-reservation] REFUSED peer=${peerStr} remoteAddr=${addrStr} (relay slots full or existing policy)`
      )
    } else if (st === 'OK') {
      console.log(
        `[relay-reservation] OK peer=${peerStr} remoteAddr=${addrStr} expireSec=${result.expire ?? '?'}`
      )
    } else {
      console.warn(`[relay-reservation] status=${String(st)} peer=${peerStr} remoteAddr=${addrStr}`)
    }
    return result
  }
}
