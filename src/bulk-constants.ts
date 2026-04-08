/** Max single-frame payload the server will accept (256 KiB). */
export const BULK_MAX_CHUNK_BYTES = 256 * 1024

/** Default random payload bounds (inclusive min, inclusive max). */
export const BULK_DEFAULT_MIN_CHUNK = 512
export const BULK_DEFAULT_MAX_CHUNK = 32 * 1024

/** Escalation ladder in seconds: 30s → 1m → 2m → 3m → 5m → 10m */
export const BULK_LADDER_SEC = [30, 60, 120, 180, 300, 600] as const
