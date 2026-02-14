# Cryptographic & Web3 Infrastructure Facility Map

## The Alignment Thesis

Nostr was the bonk on the head. Here's why: **every layer of the Champion/Ouroboros stack has a cryptographic counterpart that wasn't designed for it but fits like a glove.** The key insight is that our 140+ MCP tools already operate on patterns — merkle hashing, content-addressed storage, signed events, peer-to-peer relay — that are the *native primitives* of decentralized infrastructure. We're not bolting crypto onto a dev tool. The dev tool was already speaking the language.

This document maps every observable facility in our system to its cryptographic/Web3 counterpart, organized by domain.

---

## 1. IDENTITY & AUTHENTICATION

### What We Have
- **Nostr keypairs** (NIP-01): secp256k1 pub/priv, npub/nsec
- **NIP-05** verification (user@domain)
- **Profile system** (kind 0): name, about, picture, lud16

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **DID (Decentralized Identifiers)** | W3C standard for self-sovereign identity. DID documents contain verification methods (crypto keys), service endpoints. | Our Nostr keypair IS a DID. `did:nostr:<npub>` could resolve to our profile. Verifiable Credentials could attest to reputation level (Trusted, Verified). |
| **ENS (Ethereum Name Service)** | .eth names that resolve to wallets, content hashes, metadata. | A publisher's `champion.eth` could resolve to their Nostr pubkey + lud16 + stall ID. Cross-chain identity anchor. |
| **Lit Protocol** | Decentralized key management + threshold cryptography. Programmable signing. | Could replace our secret storage for Nostr keys with distributed threshold keys — no single point of failure. Programmable access control for premium marketplace content. |
| **Handshake (HNS)** | Decentralized root DNS. Own TLDs like `.champion`. | Vanity TLDs for the ecosystem. `yourname.champion` resolving to your Nostr profile + stall. |

### Security Note
DID + Verifiable Credentials is the most mature and standards-compliant path. ENS adds Ethereum dependency but massive discoverability. Lit Protocol is powerful but adds complexity. **Recommendation: DID first, ENS optional.**

---

## 2. STORAGE & PERSISTENCE

### What We Have
- **FelixBag**: In-memory key-value store with `bag_get`, `bag_put`, `bag_search`, `bag_catalog`, `bag_induct`
- **GitHub Gists**: Versioned document backing
- **CASCADE Lattice**: Merkle-hashed CID receipts, content-addressed observation store
- **globalState**: VS Code extension persistence

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **IPFS (InterPlanetary File System)** | Content-addressed, peer-to-peer file storage. Every file gets a CID (Content Identifier) based on its hash. | **This is FelixBag's natural evolution.** `bag_induct` already computes content digests. IPFS CIDs ARE content digests. Pin workflows/skills to IPFS = permanent, verifiable, globally addressable. Our `contentDigest` field in publishDocument maps 1:1 to IPFS CIDs. |
| **Filecoin** | Incentivized IPFS. Pays miners to store your data with cryptographic proofs of storage. | Long-term persistence for marketplace listings. Pay once, stored forever with mathematical proof it's still there. Filecoin Onchain Cloud (launched Nov 2025) has JS SDK. |
| **Arweave** | Permanent storage. Pay once, data lives forever on the permaweb. JS SDK (`arweave-js`). | **Perfect for published marketplace documents.** A skill or workflow published to Arweave is literally permanent. The permaweb IS the marketplace's long-term memory. |
| **Ceramic Network / ComposeDB** | Decentralized mutable data streams. Composable data models. Built on IPFS + blockchain anchoring. | Could replace globalState with a decentralized, cross-device profile/reputation store. ComposeDB's graph database maps perfectly to our reputation entries and profile data. |
| **GUN.js** | Peer-to-peer, real-time, offline-first graph database. Pure JavaScript. | Lightweight alternative to Ceramic. Could power real-time marketplace state sync without central servers. Zero infrastructure overhead — peers sync directly. |

### Security Note
IPFS is the safest bet — content-addressed by design, our system already speaks this language. Arweave for permanence. GUN.js for real-time sync. **Recommendation: IPFS for document storage, Arweave for permanent marketplace archive, GUN.js for live state.**

---

## 3. COMPUTE & INFERENCE

### What We Have
- **Council slots**: `plug_model`, `unplug_slot`, `list_slots`, `forward`
- **Vast.ai integration**: `vast_search`, `vast_rent`, `vast_connect`, `vast_broadcast`, `vast_distribute`
- **Inference pipeline**: `deliberate`, `imagine`, `embed_text`, `generate`, `council_infer`
- **Model management**: `clone_slot`, `mutate_slot`, `swap_slots`, `hub_search`, `hub_download`

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **Akash Network** | Decentralized compute marketplace. Kubernetes-based. 85% cheaper than AWS. **AkashML** launched 2025 for managed AI inference ($0.0001/token for 70B models). | **Direct replacement/supplement for Vast.ai.** Our `vast_search` → `akash_search`. Decentralized, censorship-resistant, and the pricing is absurd. AkashML's per-token billing maps perfectly to our inference pipeline. |
| **Bittensor (TAO)** | Decentralized AI inference marketplace. Miners compete to provide best inference. Subnets specialize by task (text, image, embeddings). | **This IS the decentralized council.** Each Bittensor subnet is a specialized inference provider. Our council slots could map to Bittensor subnets — plug a subnet instead of a local model. Validators ensure quality. |
| **Render Network (RNDR)** | Distributed GPU rendering + compute. Strong in AI inference workloads. | Alternative to Akash for GPU-heavy tasks. Good for image generation (`imagine` tool) and embedding computation. |
| **Livepeer** | Decentralized video transcoding + real-time AI video inference. GPU network. | Niche but relevant: if we add video/streaming capabilities, Livepeer's AI pipeline handles real-time inference on video streams. |
| **Gensyn** | Decentralized ML training verification. Proves that training was done correctly. | Could verify that council slot models were actually trained on claimed data. Provenance for model weights. |
| **Ritual Network** | Verifiable AI inference. ZK-proofs that inference was performed correctly on a specific model. | **Critical for trust.** If a council slot claims to be running GPT-4, Ritual can cryptographically prove it. Verifiable inference = trustworthy marketplace. |

### Security Note
Akash is production-ready and price-competitive. Bittensor is architecturally aligned but younger. Ritual's verifiable inference is the security gold standard. **Recommendation: Akash for compute, Bittensor for decentralized inference routing, Ritual for verification.**

---

## 4. PAYMENTS & VALUE TRANSFER

### What We Have
- **NIP-57 Lightning Zaps**: kind 9734/9735, lud16 resolution, zap splits
- **NIP-15 Commerce**: Stalls (30017), Products (30018), checkout via DM
- **Reputation points**: Non-monetary, local computation

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **Lightning Network (LN)** | Already integrated via NIP-57. Instant, near-zero-fee Bitcoin micropayments. | **We're already here.** WebLN standard could enable in-extension wallet integration via Alby browser extension bridge. |
| **WebLN** | Browser standard for Lightning wallet interaction. `webln.sendPayment()`, `webln.makeInvoice()`. | Could upgrade our zap flow from "copy invoice" to "one-click pay" if user has Alby or similar. The `window.webln` API is 5 lines of code. |
| **Ethers.js** | Ethereum wallet interaction. Tokens, NFTs, smart contracts. | Enables ETH/ERC-20 payments alongside Lightning. Some users prefer ETH. Could mint reputation as soulbound tokens (SBTs). |
| **Superfluid** | Token streaming. Pay-per-second. Real-time finance. | Subscription model: stream sats/tokens for premium marketplace access. Pay-per-use inference credits that flow in real time. |
| **Request Network** | Decentralized invoicing and payment tracking. | Structured payment records for marketplace transactions. Receipts that live on-chain. |
| **Orchid Protocol** | Nanopayment system for bandwidth. Probabilistic micropayments. | Interesting model: probabilistic payments for API calls. Each inference call has a small payment probability, averaging out to correct rate over time. Very low overhead. |

### Security Note
Lightning is proven, fast, and already integrated. WebLN is the natural next step. ETH via ethers.js adds optionality but complexity. **Recommendation: WebLN integration for one-click zaps, ethers.js for ETH payment option, Superfluid for subscriptions.**

---

## 5. MESSAGING & COORDINATION

### What We Have
- **Nostr Chat** (kind 1): Real-time relay-based messaging
- **NIP-04 DMs**: Encrypted direct messages
- **Presence system** (kind 10002): Online/offline heartbeats
- **Context menu**: Send DM, Block, Delete

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **Waku (now Logos Messaging)** | Decentralized P2P messaging. Modular. Censorship-resistant. Recognized by Vitalik. | Could supplement Nostr relays with a dedicated P2P messaging layer for marketplace negotiations. Lower latency, direct peer connection. |
| **Matrix Protocol** | Federated, E2E encrypted messaging. Rich client ecosystem. | Heavier than Nostr but has rooms, threads, bridging. Could bridge Nostr ↔ Matrix for users who prefer Matrix clients. |
| **XMTP** | Web3 messaging protocol. Wallet-to-wallet encrypted communication. | Native crypto messaging. Address books are wallet addresses. Perfect for commerce: buyer and seller communicate by pubkey. |

### Security Note
Nostr is already excellent for our needs. Waku adds P2P resilience. XMTP is wallet-native. **Recommendation: Stay with Nostr as primary, consider Waku for P2P fallback.**

---

## 6. DATA INDEXING & QUERYING

### What We Have
- **FelixBag search**: `bag_search` with semantic matching
- **Marketplace filters**: category, docType, search, sort
- **CASCADE observations**: Merkle-hashed event streams

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **The Graph (GRT)** | Decentralized indexing protocol. Subgraphs index blockchain data and serve it via GraphQL. | Could index marketplace events (published docs, zap receipts, reputation changes) into a queryable subgraph. `graphql { documents(category: "devops") { name, zapTotal, reputation } }` |
| **Chainlink** | Decentralized oracle network. Brings off-chain data on-chain. | Price feeds for marketplace (ETH/BTC/USD rates), external API data for smart contracts, verifiable randomness for featured listings rotation. |
| **Pyth Network** | High-frequency oracle. Sub-second price updates. | Real-time pricing for marketplace if we add dynamic pricing. |

### Security Note
The Graph is battle-tested and the natural fit for marketplace indexing. Chainlink oracles only needed if we go on-chain. **Recommendation: The Graph for marketplace indexing if we move to on-chain listings.**

---

## 7. PROVENANCE & VERIFICATION

### What We Have
- **CASCADE Lattice**: CausationGraph, merkle roots, CID receipts
- **Content digests**: SHA-256 hashes on published documents
- **Safety scanner**: Malicious pattern detection
- **Schema validation**: Per-docType rules

### Cryptographic Counterparts

| Protocol | What It Does | Alignment |
|----------|-------------|-----------|
| **IPFS CIDs** | Content-addressed identifiers. Same content = same CID, forever. | Our `computeContentDigest()` → IPFS CID. Pin the document body to IPFS = permanent, verifiable source of truth. If someone claims to have the original, the CID proves it. |
| **Ceramic Streams** | Mutable data with immutable history. Every change is anchored to a blockchain. | Version history for marketplace documents. Fork a workflow → new stream, but the lineage is cryptographically provable. |
| **Zero-Knowledge Proofs (ZKPs)** | Prove something is true without revealing the underlying data. | **Safety scanning without exposing content.** Prove a document passed safety scan without revealing the document itself. Prove reputation level without revealing point breakdown. |
| **Attestation protocols (EAS)** | Ethereum Attestation Service. On-chain attestations that anyone can verify. | "This document was safety-scanned and passed" — as a verifiable on-chain attestation. Reputation levels as attestations. |

### Security Note
IPFS CIDs are the foundation — we're 90% there already. ZKPs are the holy grail for privacy-preserving verification. **Recommendation: IPFS CIDs for content verification, EAS for reputation attestations.**

---

## 8. VIBE CODING ECOSYSTEM — THE PLAYGROUND

### The Landscape (2025-2026)

The vibe coding movement has hit Web3 hard. Key data points:
- **25% of YC Winter 2025 startups** have codebases 95%+ AI-generated
- Solo founders are scaling faster than 50-person teams
- Web3-specific vibe coding tools are emerging rapidly

### Web3 Vibe Coding Platforms

| Platform | What It Does | Our Angle |
|----------|-------------|-----------|
| **Dreamspace** (Space and Time + MakeInfinite) | Natural language → Solidity. ZK-proofs on every data query. | Marketplace listing: publish Dreamspace-compatible prompts as "recipes" that generate verified smart contracts. |
| **Thirdweb AI (Nebula)** | AI agents that interact with any EVM chain. `t1` reasoning model trained on thousands of smart contracts. | Our council could host a Thirdweb-trained slot that generates/audits smart contracts on demand. |
| **ChainGPT** | AI chatbot + smart contract generator + auditor + gas estimator. | Competition in the AI-for-crypto space. But also a potential inference provider for our pluggable system. |
| **AutonomyAI** | Agentic Context Engine (ACE). Figma prompt → full-stack dApp. 95% code acceptance rate. | Their ACE concept maps to our council's deliberation pattern. Could be a plugin architecture target. |
| **BuildBear** | Private testnet forks for dApp testing. Solidity scanning. | Marketplace listing: publish "environments" (testnet configurations) as a new docType. |
| **0xMinds** | AI Web3 development platform. Smart contract generation + deployment. | Another inference provider candidate for the pluggable system. |

### The Movie Theater Analogy

> "Like renting out a movie theater to play Xbox on with your crew"

This is exactly right. Vibe coders don't want to learn Solidity, they don't want to understand gas optimization, they don't want to audit for reentrancy attacks. They want to **describe what they want and have it appear**. 

Our marketplace is the movie theater. The tools (council slots, workflows, skills, playbooks) are the Xbox. The vibe coder walks in, browses the marketplace, imports a "Deploy ERC-20 Token" workflow, hits run, and they have a token. The council handles the complexity. The safety scanner catches the footguns. The reputation system tells them which workflows are battle-tested.

**The dream they never knew they had**: A marketplace where AI agents write, verify, and deploy crypto infrastructure through natural language, with cryptographic proof that every step was done correctly.

---

## 9. TOOL-TO-PROTOCOL MAPPING (140+ Tools)

### Direct Cryptographic Counterparts

| Tool Category | Our Tools | Crypto Protocol | Integration Depth |
|--------------|-----------|-----------------|-------------------|
| **Inference** | `forward`, `deliberate`, `generate`, `council_infer` | Bittensor subnets, Akash ML, Ritual verifiable inference | Deep — pluggable providers |
| **Embedding** | `embed_text` | Bittensor subnet 4 (text embeddings) | Medium — API swap |
| **Storage** | `bag_get/put/search/catalog/induct` | IPFS, Arweave, Ceramic | Deep — content-addressed native |
| **Compute** | `vast_search/rent/connect/broadcast/distribute` | Akash Network, Render Network | Deep — marketplace swap |
| **Versioning** | GitHub Gist CRUD | IPFS + Ceramic Streams | Medium — content history |
| **Identity** | Nostr keypairs, profiles | DID, ENS, Lit Protocol | Medium — standards bridge |
| **Payments** | NIP-57 zaps, NIP-15 commerce | Lightning/WebLN, ethers.js, Superfluid | Already started |
| **Messaging** | Nostr chat/DMs | Waku, XMTP | Low — Nostr sufficient |
| **Observation** | `observe`, `cascade_status`, CASCADE Lattice | IPFS CIDs, The Graph subgraphs | Deep — merkle native |
| **Provenance** | Merkle roots, CausationGraph | ZK-proofs, EAS attestations | High — verification layer |
| **Model Mgmt** | `plug_model`, `hub_search/download`, `clone_slot`, `mutate_slot` | Bittensor model registry, HuggingFace on IPFS | Medium — registry bridge |
| **Workflows** | `workflow_create/execute/status/history` | Dreamspace, Thirdweb AI | Medium — recipe integration |
| **State** | `save_state`, `export_config` | Ceramic Streams, GUN.js | Medium — decentralized sync |
| **Diagnostics** | `diagnose_file`, `verify_integrity` | Ritual verifiable compute, ZK-proofs | High — proof generation |
| **Replication** | `demo`, `replicate`, `spawn_quine` | Akash deployment, IPFS pinning | Medium — decentralized spawn |

---

## 10. PRIORITY INTEGRATION ROADMAP

### Tier 1 — Natural Fits (Security: HIGH, Effort: LOW-MEDIUM)
1. **IPFS for document storage** — Our content digests already ARE CIDs conceptually. Pin marketplace docs to IPFS. `js-ipfs` or Helia SDK.
2. **WebLN for one-click zaps** — 5 lines of code. `window.webln.sendPayment(invoice)`. Massive UX upgrade.
3. **Arweave for permanent archive** — `arweave-js` SDK. Publish-once, exists-forever marketplace listings.

### Tier 2 — Strategic Expansions (Security: HIGH, Effort: MEDIUM)
4. **Akash Network for decentralized compute** — Replace/supplement Vast.ai with censorship-resistant GPU marketplace.
5. **Bittensor for decentralized inference** — Map council slots to Bittensor subnets. Pluggable inference providers.
6. **ethers.js for ETH payments** — Add ERC-20 token payments alongside Lightning. Broader audience.

### Tier 3 — Advanced Architecture (Security: HIGH, Effort: HIGH)
7. **DID + Verifiable Credentials** — Formalize identity. Reputation as VCs.
8. **The Graph subgraph** — Decentralized marketplace indexing.
9. **Ritual verifiable inference** — ZK-proof that inference was done correctly.
10. **Ceramic ComposeDB** — Decentralized profile + reputation sync across devices.

### Tier 4 — Future Vision (Security: EVALUATE, Effort: HIGH)
11. **ENS names** — `yourname.champion` identity.
12. **Superfluid streaming** — Real-time payment streams for subscriptions.
13. **ZK-proofs for safety scanning** — Prove document safety without revealing content.

---

## Security Principle

> "When in question, choose security over potentially unsafe facilities."

Every integration above was evaluated security-first:
- **IPFS/Arweave**: Content-addressed = tamper-evident by design
- **Lightning/WebLN**: Mature, battle-tested, non-custodial
- **Akash/Bittensor**: Open-source, auditable, decentralized
- **DID/VCs**: W3C standards, no vendor lock-in
- **ZK-proofs**: Privacy by mathematics, not by policy

Protocols marked for evaluation (Tier 4) need more security auditing before integration.

---

*Generated from recon session Feb 13, 2026. 14 web searches, tool inventory analysis of 140+ MCP tools, cross-referenced with current extension architecture.*
