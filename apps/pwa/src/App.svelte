<script lang="ts">
  import { onMount } from 'svelte'
  import {
    relayBase as defaultRelayBase,
    fetchHealth,
    fetchStatus,
    pickBrowserDialMultiaddr,
    transportLabel,
    canBrowserDialMultiaddr,
    type RelayStatus,
  } from './lib/relayApi'
  import { DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC } from './lib/protocol'
  import { ConnectivityBrowserNode, type DiscoveryRow } from './lib/browserNode'

  let httpBase = $state('')
  let topic = $state(DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC)
  let healthOk = $state(false)
  let healthMsg = $state('')
  let status = $state<RelayStatus | null>(null)
  let statusErr = $state('')
  let customRows = $state<{ id: string; label: string; ma: string }[]>([])
  let newLabel = $state('')
  let newMa = $state('')
  let discoveryRows = $state<DiscoveryRow[]>([])
  let peersCount = $state(0)
  let autoEchoResult = $state('')
  let node = $state<ConnectivityBrowserNode | null>(null)
  let busy = $state(false)
  let rowEcho = $state<Record<string, string>>({})
  let bulkDuration = $state(30)
  let bulkMin = $state(512)
  let bulkMax = $state(8192)
  let bulkAbort: AbortController | null = null
  let bulkResult = $state('')
  let heliaCid = $state('')
  let gatewayCid = $state('')
  let gatewayResult = $state('')
  let pairRoom = $state('')
  let pairJson = $state('{"peerId":"","multiaddrs":[]}')
  let pairOut = $state('')

  function loadStorage(): void {
    const b = localStorage.getItem('relayHttpBase')
    if (b) httpBase = b
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

  function persistTopic(): void {
    localStorage.setItem('pubsubTopic', topic.trim())
  }

  function persistCustom(): void {
    localStorage.setItem('customMultiaddrs', JSON.stringify(customRows))
  }

  async function refreshHttp(): Promise<void> {
    statusErr = ''
    const base = httpBase.trim() || defaultRelayBase()
    const h = await fetchHealth(base)
    healthOk = h.ok
    healthMsg = h.error ?? (h.raw ? JSON.stringify(h.raw) : '')
    const st = await fetchStatus(base)
    if (st.ok) {
      status = st.data
    } else {
      status = null
      statusErr = st.error
    }
  }

  async function ensureNode(): Promise<ConnectivityBrowserNode> {
    if (node == null) {
      const n = new ConnectivityBrowserNode(topic, (rows) => {
        discoveryRows = rows
      })
      await n.start()
      node = n
    }
    return node
  }

  async function applyTopicAndReconnect(): Promise<void> {
    busy = true
    try {
      persistTopic()
      const pick = status ? pickBrowserDialMultiaddr(status.multiaddrs) : null
      if (node) {
        await node.stop()
        node = null
      }
      const n = new ConnectivityBrowserNode(topic, (rows) => {
        discoveryRows = rows
      })
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
    const pick = status ? pickBrowserDialMultiaddr(status.multiaddrs) : null
    if (!pick) {
      autoEchoResult = 'no /ws multiaddr'
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

  async function fetchGateway(): Promise<void> {
    const base = (httpBase.trim() || defaultRelayBase()).replace(/\/$/, '')
    const c = gatewayCid.trim()
    if (!c) {
      gatewayResult = 'enter CID'
      return
    }
    gatewayResult = 'fetching…'
    try {
      const r = await fetch(`${base}/ipfs/${encodeURIComponent(c)}`)
      const buf = await r.arrayBuffer()
      gatewayResult = `HTTP ${r.status} ${r.ok ? 'ok' : ''} ${buf.byteLength} bytes (gateway may 404 if relay does not have block)`
    } catch (e) {
      gatewayResult = e instanceof Error ? e.message : String(e)
    }
  }

  async function pairPost(): Promise<void> {
    const base = (httpBase.trim() || defaultRelayBase()).replace(/\/$/, '')
    const room = pairRoom.trim()
    if (!room) {
      pairOut = 'set room id'
      return
    }
    let body: unknown
    try {
      body = JSON.parse(pairJson)
    } catch {
      pairOut = 'invalid JSON'
      return
    }
    try {
      const r = await fetch(`${base}/pair/${encodeURIComponent(room)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      pairOut = await r.text()
    } catch (e) {
      pairOut = e instanceof Error ? e.message : String(e)
    }
  }

  async function pairGet(): Promise<void> {
    const base = (httpBase.trim() || defaultRelayBase()).replace(/\/$/, '')
    const room = pairRoom.trim()
    if (!room) {
      pairOut = 'set room id'
      return
    }
    try {
      const r = await fetch(`${base}/pair/${encodeURIComponent(room)}`)
      pairOut = await r.text()
    } catch (e) {
      pairOut = e instanceof Error ? e.message : String(e)
    }
  }

  const allRows = $derived.by(() => {
    const fromStatus = (status?.multiaddrs ?? []).map((ma) => ({
      id: `s-${ma}`,
      label: 'relay',
      ma,
      source: 'relay' as const,
    }))
    const fromCustom = customRows.map((r) => ({ ...r, source: 'custom' as const }))
    return [...fromStatus, ...fromCustom]
  })

  const topicDrift = $derived(
    status != null && topic.trim() !== status.pubsubDiscoveryTopic ? true : false
  )

  onMount(() => {
    loadStorage()
    if (!httpBase.trim()) httpBase = defaultRelayBase()

    void (async () => {
      await refreshHttp()
      if (status && !localStorage.getItem('pubsubTopic')) {
        topic = status.pubsubDiscoveryTopic
      }
      try {
        const n = await ensureNode()
        const pick = status ? pickBrowserDialMultiaddr(status.multiaddrs) : null
        if (pick) {
          await n.dialRelay(pick)
          const { reply, ms } = await n.runEcho(pick, 'pwa-auto')
          autoEchoResult = `${reply} (${ms}ms)`
        } else {
          autoEchoResult = 'no browser-dialable /ws in public /status'
        }
      } catch (e) {
        autoEchoResult = `auto-echo: ${e instanceof Error ? e.message : String(e)}`
      }
    })()

    const iv = setInterval(() => {
      if (node) peersCount = node.peerCount()
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
    <button type="button" onclick={() => { persistBase(); void refreshHttp() }}>Save &amp; refresh</button>
  </div>
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
  <h2>Pubsub discovery topic</h2>
  <div class="row">
    <input type="text" bind:value={topic} placeholder={DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC} />
    <button type="button" onclick={() => { topic = DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC }}>Reset default</button>
    <button type="button" onclick={() => { if (status) topic = status.pubsubDiscoveryTopic }}>Sync from relay</button>
    <button type="button" disabled={busy} onclick={() => void applyTopicAndReconnect()}>Apply &amp; recreate node</button>
  </div>
  {#if topicDrift}
    <p class="badge warn">Local topic differs from relay — discovery may not match.</p>
  {/if}
</section>

<section class="panel">
  <h2>libp2p node</h2>
  <div class="row">
    <span class="pill">connected peers: <strong>{peersCount}</strong></span>
    <button type="button" disabled={busy} onclick={() => void dialRelayOnly()}>Dial relay (/ws)</button>
  </div>
  <p class="sub" style="margin:0.5rem 0 0">Auto echo on load: {autoEchoResult}</p>
</section>

<section class="panel">
  <h2>Multiaddrs</h2>
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
  <h2>Pubsub discovery (WebRTC auto-dial)</h2>
  <table>
    <thead>
      <tr>
        <th>Peer</th>
        <th>WebRTC addrs?</th>
        <th>Auto-dial</th>
        <th>Detail</th>
      </tr>
    </thead>
    <tbody>
      {#each discoveryRows as d (d.peerId)}
        <tr>
          <td class="ma">{d.peerId}</td>
          <td>{d.webrtcCapable ? 'yes' : 'no'}</td>
          <td><span class="badge" class:ok={d.autoDial === 'ok'} class:bad={d.autoDial === 'error'}>{d.autoDial}</span></td>
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

<section class="panel">
  <h2>Pairing room (ephemeral)</h2>
  <p class="sub">Public <code>POST /pair/&lt;room&gt;</code> JSON body, then <code>GET</code> from another client. ~2 min TTL.</p>
  <div class="row">
    <input type="text" bind:value={pairRoom} placeholder="room id" />
    <button type="button" onclick={() => void pairPost()}>POST</button>
    <button type="button" onclick={() => void pairGet()}>GET</button>
  </div>
  <textarea bind:value={pairJson} rows="4" style="width:100%; margin-top:0.5rem"></textarea>
  {#if pairOut}
    <pre class="ma" style="white-space:pre-wrap">{pairOut}</pre>
  {/if}
</section>
