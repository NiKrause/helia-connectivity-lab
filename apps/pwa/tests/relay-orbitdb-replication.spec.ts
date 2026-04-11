import { test, expect } from '@playwright/test'

const relayBase = process.env.PLAYWRIGHT_RELAY_BASE?.trim() || 'http://127.0.0.1:38008'

function pickBrowserDialMultiaddr(addrs: string[]): string | null {
  const loopbackTlsWs = addrs.find((a) => a.includes('/ws') && a.includes('/tls/') && (a.includes('/ip4/127.') || a.includes('/ip6/::1')))
  if (loopbackTlsWs) return loopbackTlsWs
  const loopbackWs = addrs.find((a) => a.includes('/ws') && (a.includes('/ip4/127.') || a.includes('/ip6/::1')))
  if (loopbackWs) return loopbackWs
  const tlsWs = addrs.find((a) => a.includes('/ws') && a.includes('/tls/'))
  if (tlsWs) return tlsWs
  const ws = addrs.find((a) => a.includes('/ws') && !a.includes('/ip4/127.') && !a.includes('/ip6/::1'))
  if (ws) return ws
  const anyWs = addrs.find((a) => a.includes('/ws'))
  return anyWs ?? null
}

test('uploads a Helia file, writes an OrbitDB todo, and verifies relay pinning', async ({ page, request }) => {
  test.setTimeout(180_000)

  const unique = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`
  const todoText = `playwright orbitdb todo ${unique}`
  const dbName = `pwa-simple-todos-${unique}`
  const fileContent = `hello from playwright ${unique}\n`

  await page.goto('/')

  await expect.poll(async () => {
    const response = await request.get(`${relayBase}/health`)
    return response.ok()
  }).toBe(true)

  await expect.poll(async () => {
    const text = await page.getByTestId('peer-count').textContent()
    return Number(text ?? '0')
  }).toBeGreaterThan(0)

  const statusResponse = await request.get(`${relayBase}/status`)
  expect(statusResponse.ok()).toBe(true)
  const statusBody = (await statusResponse.json()) as { multiaddrs?: string[] }
  const relayMa = pickBrowserDialMultiaddr(Array.isArray(statusBody.multiaddrs) ? statusBody.multiaddrs : [])
  expect(relayMa, 'expected a browser-dialable relay multiaddr from /status').toBeTruthy()

  const relayRow = page.locator('tr').filter({ hasText: relayMa ?? '' }).first()
  if ((await relayRow.count()) === 0) {
    const showLocalButton = page.getByRole('button', { name: /Show local \/ non-public/ })
    if (await showLocalButton.count()) {
      await showLocalButton.click()
    }
  }
  await expect(relayRow).toBeVisible()

  await relayRow.getByRole('button', { name: 'Echo' }).click()
  await expect(relayRow).toContainText('echo:pwa-manual')

  await page.getByRole('spinbutton', { name: 'bulk duration seconds' }).fill('10')
  await relayRow.getByRole('button', { name: 'Bulk' }).click()
  await expect.poll(async () => ((await page.getByTestId('bulk-result').textContent()) ?? '').trim()).toMatch(
    /^rounds=\d+\s+~[\d.]+\s+MB bidirectional in ~10s$/
  )

  await page.getByTestId('helia-file-input').setInputFiles({
    name: `hello-${unique}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent, 'utf8'),
  })

  const heliaCidLocator = page.getByTestId('helia-cid')
  await expect.poll(async () => (await heliaCidLocator.textContent())?.trim() ?? '').toMatch(/^CID:\s+\S+/)
  const heliaCidText = ((await heliaCidLocator.textContent()) ?? '').trim()

  const heliaCidMatch = heliaCidText.match(/^CID:\s+(.+)$/)
  expect(heliaCidMatch, `expected CID text, got: ${heliaCidText}`).not.toBeNull()
  const heliaCid = heliaCidMatch?.[1]?.trim() ?? ''
  expect(heliaCid).not.toBe('')

  await page.getByPlaceholder('bafy… or Qm…').fill(heliaCid)
  await page.getByRole('button', { name: 'GET /ipfs on relay' }).click()
  await expect.poll(async () => ((await page.getByTestId('gateway-result').textContent()) ?? '').trim()).toMatch(
    new RegExp(`^HTTP 200 ok ${Buffer.byteLength(fileContent, 'utf8')} bytes`)
  )

  await expect.poll(async () => {
    const response = await request.get(`${relayBase}/ipfs/${encodeURIComponent(heliaCid)}`)
    if (!response.ok()) {
      return { ok: false, status: response.status(), text: '' }
    }
    return {
      ok: true,
      status: response.status(),
      text: await response.text(),
    }
  }).toMatchObject({ ok: true, status: 200, text: fileContent })

  await page.getByLabel('DB name').fill(dbName)
  await page.getByRole('button', { name: 'Open documents DB' }).click()

  const dbAddressLocator = page.getByTestId('todo-db-address')
  await expect.poll(async () => (await dbAddressLocator.textContent())?.trim() ?? '').toMatch(/^\/orbitdb\//)
  const dbAddress = ((await dbAddressLocator.textContent()) ?? '').trim()

  await page.getByLabel('Todo').fill(todoText)
  await page.getByRole('button', { name: 'Use last Helia CID' }).click()
  await page.getByRole('button', { name: 'Add todo' }).click()

  await expect(page.getByText(todoText, { exact: false })).toBeVisible()
  await expect(page.getByRole('cell', { name: heliaCid })).toBeVisible()

  const syncResponse = await request.post(`${relayBase}/pinning/sync`, {
    data: { dbAddress },
    timeout: 60_000,
  })
  expect(syncResponse.ok()).toBe(true)
  const syncBody = (await syncResponse.json()) as {
    ok?: boolean
    dbAddress?: string
    extractedMediaCids?: string[]
    coalesced?: boolean
  }
  expect(syncBody.ok).toBe(true)
  expect(syncBody.dbAddress).toBe(dbAddress)
  if (!syncBody.coalesced) {
    expect(syncBody.extractedMediaCids ?? []).toContain(heliaCid)
  }

  await expect.poll(async () => {
    const response = await request.get(`${relayBase}/pinning/databases`, {
      params: { address: dbAddress },
    })
    if (!response.ok()) {
      return { ok: false, status: response.status() }
    }
    const body = (await response.json()) as { databases?: Array<{ address?: string }> }
    return {
      ok: true,
      address: body.databases?.[0]?.address ?? '',
    }
  }).toMatchObject({ ok: true, address: dbAddress })

  await expect.poll(async () => {
    const response = await request.get(`${relayBase}/pinning/stats`)
    const body = (await response.json()) as {
      pinnedMediaCids?: string[]
    }
    return body.pinnedMediaCids?.includes(heliaCid) ?? false
  }).toBe(true)

  await expect.poll(async () => {
    const response = await request.get(`${relayBase}/pinning/stats`)
    const body = (await response.json()) as {
      syncOperations?: number
    }
    return body.syncOperations ?? 0
  }).toBeGreaterThan(0)

  const gatewayResponse = await request.get(`${relayBase}/ipfs/${encodeURIComponent(heliaCid)}`)
  expect(gatewayResponse.ok()).toBe(true)
  expect(await gatewayResponse.text()).toBe(fileContent)

  await page.getByRole('button', { name: 'Check relay replication' }).click()
  await expect(page.getByTestId('pinning-info')).toContainText('relay knows')
})
