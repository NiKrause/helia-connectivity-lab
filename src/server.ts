import type { RelayRuntime } from './relay-runtime.js'
import { logRelayBanner, startRelayRuntime } from './relay-runtime.js'
import { loadOrGenerateRelayPrivateKey } from './relay-key.js'
import { startControlHttpServer } from './control-http.js'
import { readIpfsGatewayFeatureConfig, startIpfsHttpGateway } from './ipfs-http-gateway.js'
import type { RelayListenOverrides } from './libp2p-server-config.js'

async function main() {
  const privateKey = await loadOrGenerateRelayPrivateKey()

  let activeOverrides: RelayListenOverrides = {}
  let runtime: RelayRuntime = await startRelayRuntime(privateKey, activeOverrides)

  logRelayBanner(runtime.libp2p)

  const control = startControlHttpServer({
    privateKey,
    getRuntime: () => runtime,
    setRuntime: (r) => {
      runtime = r
    },
    getOverrides: () => activeOverrides,
    setOverrides: (o) => {
      activeOverrides = o
    },
  })

  const ipfsFeature = readIpfsGatewayFeatureConfig()
  const ipfsGateway = startIpfsHttpGateway(() => runtime, {
    mountOnControl: control.started && ipfsFeature.enabled,
  })

  const shutdown = async () => {
    try {
      await control.close()
    } catch {
      // ignore
    }
    try {
      await ipfsGateway.close()
    } catch {
      // ignore
    }
    try {
      await runtime.stop()
    } catch {
      // ignore
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
