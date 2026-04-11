declare module '@orbitdb/core' {
  export type OrbitDbIdentitySystem = Record<string, unknown>
  export type OrbitDbLike = {
    open: (address: string, options?: Record<string, unknown>) => Promise<any>
    stop: () => Promise<void>
  }

  export function createOrbitDB(options: {
    ipfs: unknown
    identities?: OrbitDbIdentitySystem
    directory?: string
  }): Promise<OrbitDbLike>

  export function Documents(options?: { indexBy?: string }): (options: Record<string, unknown>) => Promise<unknown>

  export function MemoryStorage(): Promise<{
    put: (key: string, value: unknown) => Promise<void>
    del: (key: string) => Promise<void>
    get: (key: string) => Promise<unknown>
    iterator: (options?: Record<string, unknown>) => AsyncIterable<[string, unknown]>
    merge: (other: unknown) => Promise<void>
    clear: () => Promise<void>
    close: () => Promise<void>
  }>

  export function KeyStore(options?: {
    storage?: Awaited<ReturnType<typeof MemoryStorage>>
    path?: string
  }): Promise<Record<string, unknown>>

  export function Identities(options?: {
    keystore?: Record<string, unknown>
    path?: string
    storage?: Awaited<ReturnType<typeof MemoryStorage>>
    ipfs?: unknown
  }): Promise<OrbitDbIdentitySystem>
}
