import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'libp2p Connectivity Lab',
        short_name: 'ConnLab',
        description: 'Test libp2p relay connectivity, echo, bulk, Helia, WebRTC discovery',
        theme_color: '#0a0e1a',
        background_color: '#050810',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'favicon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,png}'],
      },
    }),
  ],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: [
      'libp2p',
      'helia',
      '@helia/unixfs',
      '@chainsafe/libp2p-gossipsub',
      '@libp2p/pubsub-peer-discovery',
      '@multiformats/multiaddr',
    ],
  },
})
