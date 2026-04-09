/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_HTTP_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
