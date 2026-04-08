import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import type { PrivateKey } from '@libp2p/interface'
import { readFile, writeFile } from 'node:fs/promises'
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays'

/**
 * Stable relay identity across process restarts and libp2p TCP port changes.
 * Priority: RELAY_PRIVATE_KEY_HEX → RELAY_KEY_FILE (create if missing) → ephemeral generate.
 */
export async function loadOrGenerateRelayPrivateKey(): Promise<PrivateKey> {
  const hexEnv = process.env.RELAY_PRIVATE_KEY_HEX?.trim()
  if (hexEnv) {
    return privateKeyFromProtobuf(uint8ArrayFromString(hexEnv, 'hex'))
  }

  const keyFile = process.env.RELAY_KEY_FILE?.trim()
  if (keyFile) {
    try {
      const hex = (await readFile(keyFile, 'utf8')).trim()
      if (hex) {
        return privateKeyFromProtobuf(uint8ArrayFromString(hex, 'hex'))
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        throw e
      }
    }
    const key = await generateKeyPair('Ed25519')
    await writeFile(keyFile, uint8ArrayToString(privateKeyToProtobuf(key), 'hex'), { mode: 0o600 })
    return key
  }

  return generateKeyPair('Ed25519')
}
