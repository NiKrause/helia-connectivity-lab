import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eHome = path.join(os.tmpdir(), `helia-connectivity-lab-e2e-${process.pid}`)
const relayData = path.join(e2eHome, 'relay-data')

await mkdir(relayData, { recursive: true })
process.chdir(e2eHome)

process.env.RELAY_CONTROL_HTTP_PORT = process.env.RELAY_CONTROL_HTTP_PORT || '38008'
process.env.RELAY_CONTROL_HTTP_HOST = process.env.RELAY_CONTROL_HTTP_HOST || '127.0.0.1'
process.env.RELAY_CONTROL_TOKEN = process.env.RELAY_CONTROL_TOKEN || 'e2e-dev-token'
process.env.RELAY_IPFS_GATEWAY = process.env.RELAY_IPFS_GATEWAY || '1'
process.env.RELAY_LISTEN_IPV4 = process.env.RELAY_LISTEN_IPV4 || '127.0.0.1'
process.env.RELAY_DISABLE_IPV6 = process.env.RELAY_DISABLE_IPV6 || '1'
process.env.RELAY_DISABLE_QUIC = process.env.RELAY_DISABLE_QUIC || '1'
process.env.RELAY_DISABLE_WEBRTC = process.env.RELAY_DISABLE_WEBRTC || '1'
process.env.RELAY_TCP_PORT = process.env.RELAY_TCP_PORT || '39091'
process.env.RELAY_WS_PORT = process.env.RELAY_WS_PORT || '39092'
process.env.RELAY_DATASTORE_PATH = process.env.RELAY_DATASTORE_PATH || relayData
process.env.ENABLE_SYNC_LOGS = process.env.ENABLE_SYNC_LOGS || '1'

await import(pathToFileURL(path.join(repoRoot, 'dist/server.js')).href)
