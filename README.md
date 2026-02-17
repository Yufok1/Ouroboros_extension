# Champion Council - AI Model Orchestrator

Local-first AI orchestration for VS Code and compatible editors. Run multi-model workflows, semantic memory, diagnostics, and community collaboration from one extension.

## Core Features

- **Multi-Slot Model Council** — Plug HuggingFace models into council slots and run inference, debate, consensus, and chaining. Up to 32 slots, capsule-driven.
- **140+ MCP Tools** — Full MCP/SSE tool surface for IDE agents and automation. Works with any MCP client (Claude Code, Cursor, Windsurf, etc.).
- **Workflow Engine v2.1** — 9 node types: `invoke_slot`, `bag_search`, `hub_search`, `embed_text`, `classify`, `rerank`, `observe`, `conditional`, and `web_search`. Build DAGs with expression interpolation, conditional branching, and live execution tracing.
- **Semantic Memory (FelixBag)** — Local embedding store with search, catalog, induction, and export. Persistent across sessions.
- **Activity Feed** — Real-time tool call monitoring from all connected MCP clients. Click to expand full args, results, and timing. External agent activity detected via log polling across Windsurf, Cursor, VS Code, Kiro, and Antigravity.
- **Community (Nostr)** — Decentralized marketplace, live chat, encrypted DMs, NIP-57 zaps, and privacy controls.
- **P2P Voice Rooms** — Real-time voice communication via PeerJS/WebRTC with Nostr relay signaling (NIP-53). No server hosting required — fully peer-to-peer.
- **Model Evaluation** — Per-slot and council-level inference quality tracking with latency percentiles, consistency scoring, and best-combination analysis.
- **Reputation Chains** — Merkle-linked W3C Verifiable Credential history for tamper-evident publisher trust.
- **Web3 Utilities** — IPFS CID generation, DID:key derivation, Verifiable Credentials, Safety Attestations. Zero external APIs.
- **IPFS Pinning** — Pin content to Pinata or web3.storage directly from the extension.
- **Glass Box Visualization** — Optional Rerun integration for real-time inference pipeline visualization.

## Voice Communications

Champion Council includes fully decentralized P2P voice rooms — no server hosting, no accounts, no third-party dependencies.

### How It Works

1. **Room Discovery** — NIP-53 voice room events (kind 30312) published to Nostr relays
2. **Peer Signaling** — WebRTC signaling via Nostr ephemeral events (kind 25050)
3. **Mic Capture** — ffmpeg captures raw PCM audio from the OS mic in the extension host (Node.js)
4. **Audio Bridge** — PCM streams over a local WebSocket to the webview, where an AudioWorklet converts it to a MediaStream
5. **Audio Transport** — PeerJS sends the MediaStream over WebRTC peer connections with public STUN servers
6. **Speaking Detection** — Real-time audio level analysis via Web Audio API `AnalyserNode`

### Voice Features

- **Create & Join Rooms** — Create voice rooms visible to all connected Nostr users, or join existing ones
- **Real-Time Mic Feedback** — Live level bar (green → yellow → red) shows your mic input in real-time
- **Voice Settings** — Mic sensitivity slider (0.5x–4.0x) and noise gate threshold (0–30) in the active room settings panel
- **Speaking Indicators** — See who's talking with per-participant audio level detection
- **Live Chat** — Text chat alongside voice in active rooms (kind 1311)
- **Raise Hand** — Signal to speak in moderated rooms
- **Privacy Toggle** — Enable/disable voice features entirely from the Privacy tab

### Nostr Protocol Coverage

| NIP | Feature | Status |
|-----|---------|--------|
| NIP-01 | Keypair, events, relay protocol | ✅ Implemented |
| NIP-05 | DNS-based identity verification | ✅ Implemented |
| NIP-07 | Browser signer integration | ✅ Implemented |
| NIP-39 | External identity claims (GitHub, Discord, etc.) | ✅ Implemented |
| NIP-42 | Relay authentication (AUTH challenge) | ✅ Implemented |
| NIP-53 | Voice rooms (kind 30312, 1311, 10312) | ✅ Implemented |
| NIP-57 | Lightning zaps | ✅ Implemented |
| NIP-58 | Badges (kind 30009, 8, 30008) | ✅ Implemented |
| NIP-88 | Polls (kind 1018, 1068) | ✅ Implemented |
| NIP-90 | Data Vending Machines (AI job marketplace) | ✅ Implemented |
| NIP-98 | HTTP Auth (signed requests) | ✅ Implemented |
| NIP-A0 | Voice messages (kind 1222) | ✅ Implemented |
| Custom | WebRTC signaling (kind 25050) | ✅ Implemented |

## Quick Start

1. Install the extension.
2. Ensure **Python 3.10+** is available on PATH.
3. Open **Champion Council** in the Activity Bar.
4. The MCP server auto-starts (default port `8765`).
5. Open **Control Panel** to manage models, workflows, memory, and community.

### Voice Quick Start

1. Go to the **Community** tab → **Voice** sub-tab
2. Click **CREATE A ROOM** and give it a name
3. Click **MIC ON** — grant microphone access when prompted
4. The level bar shows your mic input in real-time
5. Other users joining the same room will auto-connect via P2P
6. Tune sensitivity and noise gate via the **gear icon** in the active room view

## Using with MCP Clients

The extension runs an MCP server on `http://127.0.0.1:8765/sse`. Any MCP-compatible client can connect:

- **Claude Code** — Add to `.claude/settings.json` or run `Champion: Generate MCP Config for IDE`
- **Cursor / Windsurf** — Add the SSE endpoint to your MCP configuration
- **Custom clients** — Connect via SSE transport to the endpoint above

All 140+ tools are available to any connected client. The Control Panel's activity feed shows tool calls from all sources.

## Requirements

- **Python 3.10+**
- **numpy** (auto-installed by backend)
- **torch** (optional, for GPU inference)
- **transformers** (optional, for HuggingFace model loading)

## Configuration

All settings live under `champion.*` in VS Code Settings.

| Setting | Description |
|---------|-------------|
| `champion.pythonPath` | Python interpreter path |
| `champion.mcpPort` | MCP server port (default: 8765) |
| `champion.autoStartMCP` | Auto-start server on activation |
| `champion.maxSlots` | Council slot count (1–32, default: 32) |
| `champion.tools.*` | Per-category tool toggles |
| `champion.nostrEnabled` | Enable Nostr community features |
| `champion.communityVoice` | Enable P2P voice rooms |
| `champion.evaluation.enabled` | Enable model evaluation tracking |
| `champion.ipfs.provider` | IPFS provider: `none`, `pinata`, `web3storage` |
| `champion.ipfs.apiKey` | API key for IPFS provider |

## Commands

- `Champion: Open Control Panel`
- `Champion: Start MCP Server`
- `Champion: Stop MCP Server`
- `Champion: Generate MCP Config for IDE`

## What's New in 0.7.0

- **P2P Voice Rooms** — Full NIP-53 voice rooms with PeerJS/WebRTC transport. Create rooms, join via Nostr relay discovery, real-time mic feedback with level bars, speaking detection, live chat. No server hosting required.
- **Communications Settings** — Mic sensitivity, noise gate, standalone mic test in Privacy tab.
- **12 New NIP Methods** — NIP-39 external identities, NIP-42 relay auth, NIP-58 badges, NIP-88 polls, NIP-90 Data Vending Machines, NIP-A0 voice messages, WebRTC signaling.
- **Theme Import** — Simple hex color theme customization in Privacy tab.
- **FelixBag auto-persistence** — Bag state survives process restarts. Auto-load on startup, atexit save, 5-minute background save.
- **Cascade state persistence** — Chains and graphs backed by FelixBag. No more lost state on restart.
- **Local git versioning** — Commit any FelixBag item to the workspace git repo from the Memory tab.
- **Model loading stability** — 10-minute timeout for large model loads. SSE heartbeat suppressed during long operations.

See [CHANGELOG.md](CHANGELOG.md) for full release history.

## Architecture

See [COMMS_ARCHITECTURE.md](COMMS_ARCHITECTURE.md) for the full communications and identity protocol roadmap.

## License

MIT
