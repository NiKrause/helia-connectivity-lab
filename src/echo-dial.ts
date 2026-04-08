import { createLibp2p } from 'libp2p'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { createClientLibp2pOptions } from './libp2p-client-config.js'
import { CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { readLine, writeLine } from './stream-line.js'

/** Single dial + one-line echo; returns server reply (e.g. `echo:hello`). */
export async function dialEchoOnce(multiaddrStr: string, message: string): Promise<string> {
  const privateKey = await generateKeyPair('Ed25519')
  const libp2p = await createLibp2p(createClientLibp2pOptions(privateKey) as Parameters<typeof createLibp2p>[0])
  await libp2p.start()
  const relayMa = multiaddr(multiaddrStr)
  try {
    await libp2p.dial(relayMa)
    const stream = await libp2p.dialProtocol(relayMa, CONNECTIVITY_ECHO_PROTOCOL)
    try {
      await writeLine(stream, message)
      return await readLine(stream)
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  } finally {
    await libp2p.stop()
  }
}
