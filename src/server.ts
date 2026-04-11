import './bootstrap-debug.js'
import type { RelayRuntime } from './relay-runtime.js'
import { logRelayBanner, startRelayRuntime } from './relay-runtime.js'
import { loadOrGenerateRelayPrivateKey } from './relay-key.js'
import { startControlHttpServer } from './control-http.js'
import { readIpfsGatewayFeatureConfig, startIpfsHttpGateway } from './ipfs-http-gateway.js'
import { localHttpOrigins } from './http-listen-urls.js'
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

  if (!control.started) {
    const standaloneGatewayOrigin =
      ipfsFeature.enabled && ipfsFeature.standalonePort > 0
        ? localHttpOrigins(ipfsFeature.host, ipfsFeature.standalonePort, ipfsFeature.tls ? 'https' : 'http')[0] ?? null
        : null
    if (standaloneGatewayOrigin) {
      console.log(`[server] control HTTP is disabled; standalone health is at ${standaloneGatewayOrigin}/health`)
    } else {
      console.log(
        '[server] no local /health endpoint is active. Set RELAY_CONTROL_HTTP_PORT + RELAY_CONTROL_TOKEN to enable the control health URL.'
      )
    }
  }

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
