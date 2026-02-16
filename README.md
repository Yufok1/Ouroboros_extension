# Champion Council - AI Model Orchestrator

Local-first AI orchestration for VS Code and compatible editors. Run multi-model workflows, semantic memory, diagnostics, and community collaboration from one extension.

## Core Features

- **Multi-Slot Model Council** — Plug HuggingFace models into council slots and run inference, debate, consensus, and chaining. Up to 32 slots, capsule-driven.
- **140+ MCP Tools** — Full MCP/SSE tool surface for IDE agents and automation. Works with any MCP client (Claude Code, Cursor, Windsurf, etc.).
- **Workflow Engine v2.1** — 9 node types: `invoke_slot`, `bag_search`, `hub_search`, `embed_text`, `classify`, `rerank`, `observe`, `conditional`, and `web_search`. Build DAGs with expression interpolation, conditional branching, and live execution tracing.
- **Semantic Memory (FelixBag)** — Local embedding store with search, catalog, induction, and export. Persistent across sessions.
- **Activity Feed** — Real-time tool call monitoring from all connected MCP clients. Click to expand full args, results, and timing. External agent activity detected via log polling across Windsurf, Cursor, VS Code, Kiro, and Antigravity.
- **Community (Nostr)** — Decentralized marketplace, live chat, encrypted DMs, NIP-57 zaps, and privacy controls.
- **Model Evaluation** — Per-slot and council-level inference quality tracking with latency percentiles, consistency scoring, and best-combination analysis.
- **Reputation Chains** — Merkle-linked W3C Verifiable Credential history for tamper-evident publisher trust.
- **Web3 Utilities** — IPFS CID generation, DID:key derivation, Verifiable Credentials, Safety Attestations. Zero external APIs.
- **IPFS Pinning** — Pin content to Pinata or web3.storage directly from the extension.
- **Glass Box Visualization** — Optional Rerun integration for real-time inference pipeline visualization.

## Quick Start

1. Install the extension.
2. Ensure **Python 3.10+** is available on PATH.
3. Open **Champion Council** in the Activity Bar.
4. The MCP server auto-starts (default port `8765`).
5. Open **Control Panel** to manage models, workflows, memory, and community.

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
| `champion.evaluation.enabled` | Enable model evaluation tracking |
| `champion.ipfs.provider` | IPFS provider: `none`, `pinata`, `web3storage` |
| `champion.ipfs.apiKey` | API key for IPFS provider |

## Commands

- `Champion: Open Control Panel`
- `Champion: Start MCP Server`
- `Champion: Stop MCP Server`
- `Champion: Generate MCP Config for IDE`

## What's New in 0.6.6

- **Windows activity feed fix** — External tool calls now detected reliably on Windows (file sharing fix in log poller).
- **Activity feed stability** — Expanded views persist across sync ticks. Text selection works in drill-downs.
- **Workflow DX** — Error messages show which expressions failed, available output keys, and suggestions. Comprehensive expression syntax guide embedded.

See [CHANGELOG.md](CHANGELOG.md) for full release history.

## License

MIT
