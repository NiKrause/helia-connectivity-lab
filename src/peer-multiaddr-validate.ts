import type { Multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'

/**
 * Fail fast with a clear message when `/p2p/<id>` cannot be parsed (e.g. truncated copy/paste).
 * libp2p surfaces multiformats `Incorrect length`, which is easy to misread as a dependency bug.
 */
export function assertDialablePeerMultiaddr(ma: Multiaddr): void {
  const pidStr = ma.getPeerId()
  if (pidStr == null) {
    return
  }
  try {
    peerIdFromString(pidStr)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    let extra = ''
    if (pidStr.startsWith('12D3KooW') && pidStr.length < 52) {
      extra = ` The inline peer id looks truncated (${pidStr.length} characters; Ed25519 ids in this form are usually 52). Copy the full line from the relay "Listen addresses" or GET /status — do not shorten the /p2p/… segment.`
    } else if (msg.includes('Incorrect length')) {
      extra =
        ' The /p2p/ value is not a valid base58-encoded multihash (often a truncated or corrupted peer id when copying).'
    }
    const err = new Error(`Cannot parse peer id from multiaddr: ${msg}.${extra}`)
    ;(err as Error & { cause?: unknown }).cause = e
    throw err
  }
}
