/** Custom protocol for phase-1 connectivity (echo + server marker). */
export const CONNECTIVITY_ECHO_PROTOCOL = '/connectivity-echo/1.0.0'

/** Framed random payload echo: client sends [u32be len][payload], server replies with the same frame. */
export const CONNECTIVITY_BULK_PROTOCOL = '/connectivity-bulk/1.0.0'
