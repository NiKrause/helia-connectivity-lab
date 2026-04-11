import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const currentDir = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(currentDir, '../..')
const defaultRelayBase = 'http://127.0.0.1:38008'
const relayBase = process.env.PLAYWRIGHT_RELAY_BASE?.trim() || defaultRelayBase
const webBase = process.env.PLAYWRIGHT_WEB_BASE?.trim() || 'http://127.0.0.1:4173'
const remoteRelay = (process.env.PLAYWRIGHT_RELAY_MODE?.trim() || '').toLowerCase() === 'remote'
const useLocalRelayServer = !remoteRelay && relayBase === defaultRelayBase

const webServers = []

if (useLocalRelayServer) {
  webServers.push({
    command: 'npm run server:e2e',
    cwd: rootDir,
    url: `${relayBase}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  })
}

webServers.push({
  command: 'npm run dev -- --host 127.0.0.1 --port 4173',
  cwd: currentDir,
  url: webBase,
  reuseExistingServer: false,
  timeout: 180_000,
  env: {
    ...process.env,
    VITE_RELAY_HTTP_BASE: relayBase,
  },
})

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {
    timeout: 60_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: webBase,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: webServers,
})
