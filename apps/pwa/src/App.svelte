<script lang="ts">
  import { onMount } from 'svelte'
  import {
    relayBase as defaultRelayBase,
    relayAuthHeaders,
    fetchHealth,
    fetchStatus,
    isLocalRelayHttpBase,
    pickBrowserDialMultiaddr,
    transportLabel,
    canBrowserDialMultiaddr,
    type RelayStatus,
  } from './lib/relayApi'
  import { DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC } from './lib/protocol'
  import {
    ConnectivityBrowserNode,
    PEER_DISCOVERY_FLASH_MS,
    type DiscoveryRow,
    type RelayReservationUiEvent,
  } from './lib/browserNode'
  import { filterPublicDialMultiaddrs, isPublicDialMultiaddr } from './lib/publicMultiaddrFilter'

  let httpBase = $state('')
  /** Same value as server RELAY_CONTROL_TOKEN when /status is behind auth (legacy relay or reverse proxy). */
  let controlToken = $state('')
  let topic = $state(DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC)
  let healthOk = $state(false)
  let healthMsg = $state('')
  let status = $state<RelayStatus | null>(null)
  let statusErr = $state('')
  let customRows = $state<{ id: string; label: string; ma: string }[]>([])
  let newLabel = $state('')
  let newMa = $state('')
  let discoveryRows = $state<DiscoveryRow[]>([])
  /** Drives flash expiry so the LED hides without mutating discovery rows. */
  let discoveryNowMs = $state(Date.now())
  /** Orange LED: we successfully gossipsub-published our pubsub-peer-discovery payload. */
  let pubsubSelfPublishFlashUntilMs = $state(0)
  /** Cyan LED: inbound discovery advert signed by the relay (`GET /status` peer id). */
  let pubsubRelayRecvFlashUntilMs = $state(0)
  /** Violet LED: inbound discovery advert from some other libp2p peer (e.g. another browser). */
  let pubsubRemoteRecvFlashUntilMs = $state(0)
  /** Synced from `status.peerId` so pubsub hooks classify relay vs peer without stale closures. */
  let relayPeerIdForPubsubLeds = $state('')
  /** Last gossipsub message `from` (signer) on the discovery topic — verifies who you actually hear. */
  let lastInboundPubsubDiscoveryFrom = $state('')
  let peersCount = $state(0)
  let autoEchoResult = $state('')
  let node = $state<ConnectivityBrowserNode | null>(null)
  let busy = $state(false)
  let rowEcho = $state<Record<string, string>>({})
  let bulkDuration = $state(30)
  let bulkMin = $state(512)
  let bulkMax = $state(8192)
  /** When true, Multiaddrs table lists all relay /status addresses, including loopback / RFC1918. */
  let showHiddenRelayAddrs = $state(false)
  /** When true, show this browser libp2p node’s own multiaddrs (circuit, WebRTC, …). */
  let showOwnMultiaddrs = $state(false)
  let ownMultiaddrs = $state<string[]>([])
  /** Last circuit-relay reservation failure (e.g. RESERVATION_REFUSED from relay). */
  let relayReservationBanner = $state<{ relayPeerId: string; message: string; at: number } | null>(null)
  let bulkAbort: AbortController | null = null
  let bulkResult = $state('')
  let heliaCid = $state('')
  let gatewayCid = $state('')
  let gatewayResult = $state('')

  function loadStorage(): void {
    const b = localStorage.getItem('relayHttpBase')
    if (b) httpBase = b
    const tok = localStorage.getItem('relayControlToken')
    if (tok) controlToken = tok
    const t = localStorage.getItem('pubsubTopic')
    if (t) topic = t
    const c = localStorage.getItem('customMultiaddrs')
    if (c) {
      try {
        const parsed = JSON.parse(c) as { id: string; label: string; ma: string }[]
        if (Array.isArray(parsed)) customRows = parsed
      } catch {
        // ignore
      }
    }
  }

  function persistBase(): void {
    localStorage.setItem('relayHttpBase', httpBase.trim())
  }

  function persistControlToken(): void {
    const t = controlToken.trim()
    if (t) {
      localStorage.setItem('relayControlToken', t)
    } else {
      localStorage.removeItem('relayControlToken')
    }
  }

  function normalizedTopic(): string {
    const t = (topic ?? '').trim()
    return t || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
  }

  function effectiveRelayBase(): string {
    return httpBase.trim() || defaultRelayBase()
  }

  function persistTopic(): void {
    localStorage.setItem('pubsubTopic', normalizedTopic())
  }

  function persistCustom(): void {
    localStorage.setItem('customMultiaddrs', JSON.stringify(customRows))
  }

  /** Tooltip for the peer cell: last `peer:discovery` payload. */
  function peerDiscoveryLedTooltip(addrs: string[]): string {
    if (addrs.length === 0) return 'peer:discovery — no multiaddrs in payload'
    return `peer:discovery (${addrs.length} multiaddr${addrs.length === 1 ? '' : 's'}):\n${addrs.join('\n')}`
  }

  function isRelayDiscoveryPeer(peerId: string): boolean {
    const relayId = (status?.peerId ?? '').trim()
    return relayId !== '' && peerId === relayId
  }

  function handleRelayReservationUi(ev: RelayReservationUiEvent): void {
    if (ev.type === 'error') {
      relayReservationBanner = { relayPeerId: ev.relayPeerId, message: ev.message, at: ev.at }
    } else if (ev.type === 'reserved' && relayReservationBanner?.relayPeerId === ev.relayPeerId) {
      relayReservationBanner = null
    }
  }

  function createBrowserNode(): ConnectivityBrowserNode {
    return new ConnectivityBrowserNode(
      normalizedTopic(),
      relayBootstrapAddrs(),
      (rows) => {
        discoveryRows = rows
      },
      handleRelayReservationUi,
      {
        onDiscoveryAdvertPublished: () => {
          pubsubSelfPublishFlashUntilMs = Date.now() + PEER_DISCOVERY_FLASH_MS
        },
        onRemoteDiscoveryAdvertReceived: (info) => {
          lastInboundPubsubDiscoveryFrom = info.fromPeerId
          const t = Date.now() + PEER_DISCOVERY_FLASH_MS
          const relayId = relayPeerIdForPubsubLeds
          if (relayId !== '' && info.fromPeerId === relayId) {
            pubsubRelayRecvFlashUntilMs = t
          } else {
            pubsubRemoteRecvFlashUntilMs = t
          }
        },
      }
    )
  }

  $effect(() => {
    relayPeerIdForPubsubLeds = (status?.peerId ?? '').trim()
  })

  /** Only changes when the latest row flash deadline changes — avoids resetting the LED ticker on every discovery table refresh. */
  const discoveryRowFlashMax = $derived.by(() =>
    discoveryRows.reduce((m, r) => Math.max(m, r.discoveryFlashUntilMs ?? 0), 0)
  )

  $effect(() => {
    /** Single expression so every flash input is a real reactive read (bare statements can be dropped / not tracked). */
    const untilMax = Math.max(
      discoveryRowFlashMax,
      pubsubSelfPublishFlashUntilMs,
      pubsubRelayRecvFlashUntilMs,
      pubsubRemoteRecvFlashUntilMs
    )
    const t0 = Date.now()
    if (untilMax <= t0) {
      discoveryNowMs = t0
      return
    }
    discoveryNowMs = t0
    const id = setInterval(() => {
      const n = Date.now()
      discoveryNowMs = n
      if (n >= untilMax) clearInterval(id)
    }, 48)
    return () => clearInterval(id)
  })

  async function refreshHttp(): Promise<void> {
    statusErr = ''
    const base = effectiveRelayBase()
    const tok = controlToken.trim() || null
    const h = await fetchHealth(base, tok)
    healthOk = h.ok
    healthMsg = h.error ?? (h.raw ? JSON.stringify(h.raw) : '')
    const st = await fetchStatus(base, tok)
    if (st.ok) {
      status = st.data
    } else {
      status = null
      statusErr = st.error
    }
  }

  async function ensureNode(): Promise<ConnectivityBrowserNode> {
    if (node == null) {
      const n = createBrowserNode()
      await n.start()
      node = n
    }
    return node
  }

  function relayPublicMultiaddrs(): string[] {
    return filterPublicDialMultiaddrs(status?.multiaddrs ?? [])
  }

  function relayDialMultiaddrs(): string[] {
    const addrs = status?.multiaddrs ?? []
    return isLocalRelayHttpBase(effectiveRelayBase()) ? addrs : filterPublicDialMultiaddrs(addrs)
  }

  function relayBootstrapAddrs(): string[] {
    const pick = status ? pickBrowserDialMultiaddr(relayDialMultiaddrs()) : null
    return pick == null ? [] : [pick]
  }

  /** Multiaddr used by "Dial relay" / auto-dial: TLS+WS preferred, else first public `/ws`. */
  const pickedRelayDialMa = $derived.by((): string | null => {
    if (!status) return null
    return pickBrowserDialMultiaddr(relayDialMultiaddrs())
  })

  async function applyTopicAndReconnect(): Promise<void> {
    busy = true
    try {
      persistTopic()
      const pick = status ? pickBrowserDialMultiaddr(relayDialMultiaddrs()) : null
      if (node) {
        await node.stop()
        node = null
        relayReservationBanner = null
        lastInboundPubsubDiscoveryFrom = ''
      }
      const n = createBrowserNode()
      await n.start()
      node = n
      if (pick) {
        await n.dialRelay(pick)
      }
    } finally {
      busy = false
    }
  }

  async function dialRelayOnly(): Promise<void> {
    const pick = status ? pickBrowserDialMultiaddr(relayDialMultiaddrs()) : null
    if (!pick) {
      autoEchoResult = 'no browser-dialable /ws multiaddr in relay status'
      return
    }
    busy = true
    try {
      const n = await ensureNode()
      await n.dialRelay(pick)
      autoEchoResult = 'connected to relay'
    } catch (e) {
      autoEchoResult = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  async function runEchoOn(ma: string): Promise<void> {
    busy = true
    rowEcho = { ...rowEcho, [ma]: '…' }
    try {
      const n = await ensureNode()
      const { reply, ms } = await n.runEcho(ma, 'pwa-manual')
      rowEcho = { ...rowEcho, [ma]: `${reply} (${ms}ms)` }
    } catch (e) {
      rowEcho = { ...rowEcho, [ma]: `err: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      busy = false
    }
  }

  async function runBulkOn(ma: string): Promise<void> {
    bulkAbort?.abort()
    bulkAbort = new AbortController()
    bulkResult = 'running…'
    busy = true
    try {
      const n = await ensureNode()
      const r = await n.runBulk(ma, bulkDuration * 1000, {
        minChunk: bulkMin,
        maxChunk: bulkMax,
        signal: bulkAbort.signal,
      })
      if (r.error) {
        bulkResult = `error: ${r.error} rounds=${r.rounds}`
      } else {
        const secs = bulkDuration
        const mb = (r.bytesSent + r.bytesRecv) / (1024 * 1024)
        bulkResult = `rounds=${r.rounds} ~${mb.toFixed(2)} MB bidirectional in ~${secs}s`
      }
    } catch (e) {
      bulkResult = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function stopBulk(): void {
    bulkAbort?.abort()
  }

  function addCustomRow(): void {
    const ma = newMa.trim()
    if (!ma) return
    customRows = [
      ...customRows,
      { id: crypto.randomUUID(), label: newLabel.trim() || 'custom', ma },
    ]
    newMa = ''
    newLabel = ''
    persistCustom()
  }

  function removeCustomRow(id: string): void {
    customRows = customRows.filter((r) => r.id !== id)
    persistCustom()
  }

  async function onHeliaFile(f: File): Promise<void> {
    busy = true
    heliaCid = ''
    try {
      const n = await ensureNode()
      const { cid } = await n.addFileToHelia(f)
      heliaCid = cid
    } catch (e) {
      heliaCid = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function currentAuthToken(): string | null {
    const t = controlToken.trim()
    return t ? t : null
  }

  async function fetchGateway(): Promise<void> {
    const base = (httpBase.trim() || defaultRelayBase()).replace(/\/$/, '')
    const c = gatewayCid.trim()
    if (!c) {
      gatewayResult = 'enter CID'
      return
    }
    gatewayResult = 'fetching…'
    try {
      const r = await fetch(`${base}/ipfs/${encodeURIComponent(c)}`, {
        headers: relayAuthHeaders(currentAuthToken()),
      })
      const buf = await r.arrayBuffer()
      gatewayResult = `HTTP ${r.status} ${r.ok ? 'ok' : ''} ${buf.byteLength} bytes (gateway may 404 if relay does not have block)`
    } catch (e) {
      gatewayResult = e instanceof Error ? e.message : String(e)
    }
  }

  const relayHiddenLocalCount = $derived(
    (status?.multiaddrs?.length ?? 0) - filterPublicDialMultiaddrs(status?.multiaddrs ?? []).length
  )

  const allRows = $derived.by(() => {
    const addrs = status?.multiaddrs ?? []
    const relayAddrs = showHiddenRelayAddrs ? addrs : filterPublicDialMultiaddrs(addrs)
    const fromStatus = relayAddrs.map((ma) => ({
      id: `s-${ma}`,
      label: showHiddenRelayAddrs && !isPublicDialMultiaddr(ma) ? 'relay (local)' : 'relay',
      ma,
      source: 'relay' as const,
    }))
    const fromCustom = customRows.map((r) => ({ ...r, source: 'custom' as const }))
    return [...fromStatus, ...fromCustom]
  })

  const topicDrift = $derived.by(() => {
    if (status == null) return false
    const local = normalizedTopic()
    const relay = (status.pubsubDiscoveryTopic ?? '').trim()
    if (!relay) return false
    return local !== relay
  })

  onMount(() => {
    loadStorage()
    if (!httpBase.trim()) httpBase = defaultRelayBase()

    void (async () => {
      await refreshHttp()
      if (status && !localStorage.getItem('pubsubTopic')) {
        topic =
          status.pubsubDiscoveryTopic?.trim() || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
      }
      try {
        const n = await ensureNode()
        const pick = status ? pickBrowserDialMultiaddr(relayDialMultiaddrs()) : null
        if (pick) {
          await n.dialRelay(pick)
          const { reply, ms } = await n.runEcho(pick, 'pwa-auto')
          autoEchoResult = `${reply} (${ms}ms)`
        } else {
          autoEchoResult = 'no browser-dialable /ws multiaddr in relay status'
        }
      } catch (e) {
        autoEchoResult = `auto-echo: ${e instanceof Error ? e.message : String(e)}`
      }
    })()

    const iv = setInterval(() => {
      if (node) {
        peersCount = node.peerCount()
        ownMultiaddrs = node.getOwnMultiaddrs()
      }
    }, 800)
    return () => clearInterval(iv)
  })
</script>

<h1>Connectivity Lab</h1>
<p class="sub">libp2p relay checks · pubsub discovery · Helia · PWA</p>

<section class="panel">
  <h2>Relay HTTP</h2>
  <div class="row">
    <label for="base">Base URL</label>
    <input id="base" type="text" bind:value={httpBase} placeholder={defaultRelayBase()} />
    <button
      type="button"
      onclick={() => {
        persistBase()
        persistControlToken()
        void refreshHttp()
      }}>Save &amp; refresh</button>
  </div>
  <div class="row">
    <label for="token">Control token</label>
    <input
      id="token"
      type="password"
      bind:value={controlToken}
      placeholder="RELAY_CONTROL_TOKEN (optional)"
      autocomplete="off"
    />
    <button type="button" onclick={() => { controlToken = ''; persistControlToken(); void refreshHttp() }}>Clear token</button>
  </div>
  <p class="sub" style="margin:0 0 0.75rem">
    Latest relay: <code>GET /status</code> is public. If you see <strong>401</strong>, paste the same secret as
    <code>RELAY_CONTROL_TOKEN</code> (sent as <code>Authorization: Bearer …</code> and <code>X-Control-Token</code>).
  </p>
  <div class="row">
    <span class="pill">health: {#if healthOk}<span class="badge ok">ok</span>{:else}<span class="badge bad">down</span>{/if}</span>
    {#if healthMsg}<span class="muted">{healthMsg}</span>{/if}
    {#if statusErr}<span class="badge bad">{statusErr}</span>{/if}
  </div>
  {#if status}
    <div class="row">
      <span>relay peer</span>
      <code class="ma">{status.peerId}</code>
    </div>
    <div class="row">
      <span>pubsub on relay</span>
      <code class="ma">{status.pubsubDiscoveryTopic}</code>
    </div>
  {/if}
</section>

<section class="panel">
  <h2>Relay's Multiaddrs</h2>
  {#if relayHiddenLocalCount > 0}
    <div class="row" style="align-items:flex-start;flex-wrap:wrap;gap:0.5rem;margin:0 0 0.75rem">
      <p class="sub" style="margin:0;flex:1;min-width:12rem">
        {#if showHiddenRelayAddrs}
          Showing <strong>all</strong> relay addresses from <code>/status</code> (including
          <strong>{relayHiddenLocalCount}</strong> not publicly dialable). Custom rows unchanged.
        {:else}
          Hiding <strong>{relayHiddenLocalCount}</strong> relay address(es) that are not publicly dialable (e.g.
          <code>127.0.0.1</code>, RFC1918, link-local IPv6). Custom rows are unchanged.
        {/if}
      </p>
      <button
        type="button"
        aria-pressed={showHiddenRelayAddrs}
        onclick={() => {
          showHiddenRelayAddrs = !showHiddenRelayAddrs
        }}
      >
        {showHiddenRelayAddrs ? 'Hide' : 'Show'} local / non-public ({relayHiddenLocalCount})
      </button>
    </div>
  {/if}
  <div class="row">
    <input type="text" bind:value={newLabel} placeholder="label" />
    <input type="text" bind:value={newMa} placeholder="/ip4/.../ws/p2p/..." />
    <button type="button" onclick={addCustomRow}>Add row</button>
  </div>
  <div class="row">
    <span class="lbl">bulk duration (s)</span>
    <input type="number" bind:value={bulkDuration} min="1" max="600" aria-label="bulk duration seconds" />
    <span class="lbl">chunk min</span>
    <input type="number" bind:value={bulkMin} min="1" aria-label="bulk min chunk" />
    <span class="lbl">chunk max</span>
    <input type="number" bind:value={bulkMax} min="1" aria-label="bulk max chunk" />
    <button type="button" disabled={busy} onclick={stopBulk}>Abort bulk</button>
  </div>
  {#if bulkResult}
    <p class="ma">{bulkResult}</p>
  {/if}
  <table>
    <thead>
      <tr>
        <th>Source</th>
        <th>Transport</th>
        <th>Multiaddr</th>
        <th>Echo</th>
      </tr>
    </thead>
    <tbody>
      {#each allRows as r (r.id)}
        <tr>
          <td>{r.label}</td>
          <td><span class="badge">{transportLabel(r.ma)}</span></td>
          <td class="ma">{r.ma}</td>
          <td>
            <button type="button" disabled={busy || !canBrowserDialMultiaddr(r.ma)} onclick={() => void runEchoOn(r.ma)}>Echo</button>
            <button type="button" disabled={busy || !canBrowserDialMultiaddr(r.ma)} onclick={() => void runBulkOn(r.ma)}>Bulk</button>
            {#if r.source === 'custom'}
              <button type="button" onclick={() => removeCustomRow(r.id)}>Remove</button>
            {/if}
            {#if rowEcho[r.ma]}
              <div class="ma">{rowEcho[r.ma]}</div>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<section class="panel">
  <h2>Browser libp2p node</h2>
  <div class="row">
    <span class="pill">connected peers: <strong data-testid="peer-count">{peersCount}</strong></span>
    <button
      type="button"
      disabled={busy}
      title={pickedRelayDialMa
        ? `Dials this multiaddr via the browser WebSocket API (${pickedRelayDialMa.includes('/tls/') ? 'wss://' : 'ws://'} after multiaddr→URI).`
        : 'Fetch /status first — needs a /ws multiaddr in relay addresses.'}
      onclick={() => void dialRelayOnly()}
    >
      {#if pickedRelayDialMa}
        Dial relay — {transportLabel(pickedRelayDialMa)}
      {:else}
        Dial relay (no WS in /status)
      {/if}
    </button>
  </div>
  {#if relayReservationBanner}
    <div
      class="row"
      style="align-items:flex-start;flex-wrap:wrap;margin-top:0.65rem;gap:0.5rem"
    >
      <p class="badge warn" style="margin:0;flex:1;min-width:14rem;text-align:left">
        <strong>Circuit relay reservation failed</strong> on relay{' '}
        <code class="ma">{relayReservationBanner.relayPeerId}</code>
        <span class="sub" style="display:block;margin-top:0.35rem;font-size:0.82rem;white-space:pre-wrap"
          >{relayReservationBanner.message}</span
        >
      </p>
      <button type="button" onclick={() => { relayReservationBanner = null }}>Dismiss</button>
    </div>
  {/if}
  <p class="sub" style="margin:0.5rem 0 0">Auto echo on load: {autoEchoResult}</p>
  <div class="row" style="margin-top:0.65rem">
    <button
      type="button"
      aria-pressed={showOwnMultiaddrs}
      onclick={() => {
        showOwnMultiaddrs = !showOwnMultiaddrs
        if (node) ownMultiaddrs = node.getOwnMultiaddrs()
      }}
    >
      {showOwnMultiaddrs ? 'Hide' : 'Show'} my multiaddrs
    </button>
    {#if node?.getLocalPeerId()}
      <span class="sub" style="margin:0;font-size:0.82rem"
        >This peer: <code class="ma">{node.getLocalPeerId()}</code></span
      >
    {/if}
  </div>
  {#if showOwnMultiaddrs}
    {#if ownMultiaddrs.length === 0}
      <p class="sub" style="margin:0.4rem 0 0">No addresses yet (node starting or stopped).</p>
    {:else}
      <table class="table-compact" style="margin-top:0.45rem">
        <thead>
          <tr>
            <th>Transport</th>
            <th>Multiaddr</th>
          </tr>
        </thead>
        <tbody>
          {#each ownMultiaddrs as ma (ma)}
            <tr>
              <td><span class="badge">{transportLabel(ma)}</span></td>
              <td class="ma">{ma}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</section>

<section class="panel">
  <div class="panel-title-row">
    <h2>PubSub peer discovery</h2>
    <div
      class="pubsub-discovery-leds"
      aria-label="Pubsub peer discovery activity"
      title="tx (orange): we published our discovery record. relay (cyan): inbound advert signed by this relay’s peer id from GET /status. peer (violet): inbound advert from any other libp2p peer (e.g. another tab). Save &amp; refresh status first so relay id is known."
    >
      <div
        class="pubsub-led-slot"
        title="We gossipsub-published our pubsub-peer-discovery payload on this topic."
      >
        <span
          class="pubsub-led pubsub-led--orange"
          class:pubsub-led--active={pubsubSelfPublishFlashUntilMs > discoveryNowMs}
          aria-hidden="true"
        ></span>
        <span class="pubsub-led-label">tx</span>
      </div>
      <div
        class="pubsub-led-slot"
        title="Inbound discovery message signed by the relay (matches peer id from GET /status)."
      >
        <span
          class="pubsub-led pubsub-led--cyan"
          class:pubsub-led--active={pubsubRelayRecvFlashUntilMs > discoveryNowMs}
          aria-hidden="true"
        ></span>
        <span class="pubsub-led-label">relay</span>
      </div>
      <div
        class="pubsub-led-slot"
        title="Inbound discovery message from another libp2p peer (not the relay id from /status)."
      >
        <span
          class="pubsub-led pubsub-led--violet"
          class:pubsub-led--active={pubsubRemoteRecvFlashUntilMs > discoveryNowMs}
          aria-hidden="true"
        ></span>
        <span class="pubsub-led-label">peer</span>
      </div>
    </div>
  </div>
  <p class="sub" style="margin:0 0 0.65rem;font-size:0.76rem">
    Last inbound discovery signer:
    {#if lastInboundPubsubDiscoveryFrom}
      <code class="ma">{lastInboundPubsubDiscoveryFrom}</code>
      {#if relayPeerIdForPubsubLeds !== '' && lastInboundPubsubDiscoveryFrom === relayPeerIdForPubsubLeds}
        <span class="muted">= relay</span>
      {:else if relayPeerIdForPubsubLeds !== ''}
        <span class="muted">= peer</span>
      {/if}
    {:else}
      <span class="muted">none yet</span>
    {/if}
  </p>
  <div class="row">
    <label for="pubsubTopic">Discovery topic</label>
    <input
      id="pubsubTopic"
      type="text"
      bind:value={topic}
      placeholder={DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC}
    />
    <button type="button" onclick={() => { topic = DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC }}>Reset default</button>
    <button
      type="button"
      title="Copies pubsubDiscoveryTopic from the relay’s last GET /status (use Save &amp; refresh first). Does not restart the browser node — use Apply &amp; recreate node for that."
      onclick={() => {
        if (status) {
          topic =
            status.pubsubDiscoveryTopic?.trim() || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
        }
      }}>Sync from relay</button>
    <button type="button" disabled={busy} onclick={() => void applyTopicAndReconnect()}>Apply &amp; recreate node</button>
  </div>
  {#if topicDrift}
    <p class="badge warn">Local topic differs from relay — discovery may not match.</p>
  {/if}
  <table>
    <thead>
      <tr>
        <th>Peer</th>
        <th>Dial path OK?</th>
        <th>Auto-dial</th>
        <th>Detail</th>
      </tr>
    </thead>
    <tbody>
      {#each discoveryRows as d (d.peerId)}
        <tr data-testid="peer-card" data-peer-id={d.peerId}>
          <td class="ma">
            <span class="peer-discovery-led-wrap" title={peerDiscoveryLedTooltip(d.discoveryAddrs)}>
              {#if d.discoveryFlashUntilMs > discoveryNowMs}
                <span class="peer-discovery-led-flash" aria-hidden="true"></span>
              {/if}
              <span>
                {#if isRelayDiscoveryPeer(d.peerId)}
                  <span class="badge">relay</span>{' '}
                {/if}
                {d.peerId}
              </span>
            </span>
          </td>
          <td>{d.autoDialEligible ? 'yes' : 'no'}</td>
          <td><span data-testid="peer-card-status" class="badge" class:ok={d.autoDial === 'ok'} class:bad={d.autoDial === 'error'}>{d.autoDial}</span></td>
          <td class="ma">{d.detail ?? ''}</td>
        </tr>
      {:else}
        <tr><td colspan="4">No discoveries yet — dial relay and wait for gossipsub mesh.</td></tr>
      {/each}
    </tbody>
  </table>
</section>

<section class="panel">
  <h2>Helia / IPFS</h2>
  <p class="sub">Add stores blocks in this browser only. Gateway fetch hits the relay HTTP <code>/ipfs/&lt;cid&gt;</code> (relay must have the data).</p>
  <div
    class="drop"
    role="button"
    tabindex="0"
    ondragover={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag') }}
    ondragleave={(e) => e.currentTarget.classList.remove('drag')}
    ondrop={(e) => {
      e.preventDefault()
      e.currentTarget.classList.remove('drag')
      const f = e.dataTransfer?.files?.[0]
      if (f) void onHeliaFile(f)
    }}
    onclick={() => document.getElementById('file')?.click()}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file')?.click() } }}
  >
    Drag &amp; drop a file or click to upload
  </div>
  <input id="file" type="file" hidden onchange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void onHeliaFile(f) }} />
  {#if heliaCid}
    <p class="ma">CID: {heliaCid}</p>
  {/if}
  <div class="row">
    <input type="text" bind:value={gatewayCid} placeholder="bafy… or Qm…" />
    <button type="button" onclick={() => void fetchGateway()}>GET /ipfs on relay</button>
  </div>
  {#if gatewayResult}
    <p class="ma">{gatewayResult}</p>
  {/if}
</section>
