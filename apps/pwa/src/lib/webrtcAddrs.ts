/** True if any multiaddr string looks WebRTC-related (browser auto-dial filter). */
export function multiaddrsIncludeWebRTC(addrs: string[]): boolean {
  return addrs.some(
    (s) =>
      s.includes('/webrtc') ||
      s.includes('/webrtc-direct') ||
      s.includes('/certhash/')
  )
}
