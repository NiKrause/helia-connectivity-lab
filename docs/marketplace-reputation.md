# Later phase: paid relay testing marketplace & reputation (design)

This document sketches a **business model** (no on-chain implementation in the connectivity-lab milestone) and **five** reputation / anti-bot directions with different trade-offs on **independence**, **open standards**, and **decentralisation** (including optional **zero-knowledge** ideas).

## Business model (outline)

1. **Relay operators** who want independent connectivity reports from many locations stake **ETH** (or an L2 equivalent) in a **smart contract**. They define what tests count and how rewards are released.
2. **Testers** register with a **wallet address** and **location metadata** (IP-derived or self-asserted country/city, venue name such as hotel or café). They run the lab client/PWA from those places and submit signed results.
3. **Aggregation** matches tests to relay operators; payouts or reputation updates follow contract rules. Venue-level notes (e.g. “WebRTC blocked at hotel X”) become searchable **without** trusting a single central database if attestations are public or federated.

## Five reputation / anti-bot proposals

### 1. W3C Verifiable Credentials (VC) + DIDs

- **Idea:** Testers hold **DIDs**; issuers (or the relay operator) sign **VCs** that claim “test T completed at time X with outcome Y”.
- **Independence:** Multiple issuers reduce reliance on one vendor; credentials are standard-shaped.
- **Open standards:** W3C VC Data Model, DID methods (did:key, did:pkh, …).
- **Decentralisation:** High if verification is local and issuer set is plural; low if one issuer dominates.
- **ZK:** Optional later (e.g. prove VC validity without revealing raw IP).

### 2. On-chain attestations (e.g. EAS) + optional ZK

- **Idea:** Commitments or attestations on L2: `(wallet, geo hash, test id, result hash)`. **ZK proofs** can show “unique human / unique payout slot” without revealing exact IP.
- **Independence:** Contract + indexer ecosystem; not tied to one app’s database.
- **Open standards:** Ethereum Attestation Service patterns, emerging ZK identity stacks.
- **Decentralisation:** Strong for censorship resistance; weaker if a single rollup or verifier gate dominates.
- **ZK:** Natural fit for privacy-preserving uniqueness and location granularity.

### 3. Privacy Pass–style blind signatures + economic stake

- **Idea:** After staking, testers obtain **unlinkable tokens** (blind issuance) to submit one report per epoch without the relay correlating wallet ↔ raw sessions.
- **Independence:** Cryptography is RFC-oriented; issuers can be rotated.
- **Open standards:** Privacy Pass family, VOPRFs.
- **Decentralisation:** Medium—depends on who runs the issuer and how tokens are redeemed on-chain.
- **ZK:** Can combine with ZK proofs of stake or geo without linking all sessions.

### 4. Federated mirrors (Nostr / ActivityPub-style)

- **Idea:** Signed test logs are published to **open protocols**; aggregators mirror; consumers pick feeds they trust.
- **Independence:** No single API owner; censorship requires attacking many relays.
- **Open standards:** Nostr events, ActivityPub, plain signed JSON.
- **Decentralisation:** High for distribution; **Sybil** resistance still needs **web-of-trust**, **stake**, or **VCs** layered on top.
- **ZK:** Usually off-chain first; ZK could attest “this Nostr pubkey had a valid VC” without revealing it.

### 5. Hardware / carrier attestation (caution)

- **Idea:** Device or SIM attests “real handset on real network” to block cheap bots.
- **Independence:** Low in practice—trust concentrates on **OEMs** and **MNOs**.
- **Open standards:** Limited; attestation APIs are often proprietary.
- **Decentralisation:** Poor fit for a credibly neutral marketplace unless strictly optional and clearly labelled.
- **ZK:** Rarely applicable in a user-friendly way; included here as a **contrast** to open, community-verifiable approaches.

## Pairing API note

The relay exposes simple **`GET/POST /pair/<roomId>`** (short TTL) for ad hoc handoff between two browsers. It is **not** a reputation layer; it is only a convenience transport for exchanging peer hints before libp2p/WebRTC completes.
