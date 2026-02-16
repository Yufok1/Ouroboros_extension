# Champion Council - AI Model Orchestrator

Local-first AI orchestration for VS Code and compatible editors. Run multi-model workflows, semantic memory, diagnostics, and community collaboration from one extension.

## What's New

### 0.6.5
- **Activity feed stability** — Expanded detail views no longer reset on every sync tick. Text selection and copy/paste now work inside drill-downs.

### 0.6.4
- **Workflow DX overhaul** — Error messages now show exactly which expressions failed, what output keys are available, and what nodes are missing. Embedded `workflow_automation_guide` expanded with two-pass resolution rules, output key reference table, and common mistake patterns.

### 0.6.2
- **12 MCP tool fixes** — `get_status`, `bag_catalog`, `get_artifacts`, `bag_export`, `symbiotic_interpret`, `trace_root_causes`, `forensics_analyze`, `cascade_system` (analyze + ingest_file), `cascade_data` (license_check + schema), and `rerun_log_inference` all repaired. Fixes include sorted() type safety, correct CASCADE class instantiation, proper module paths, and recursive numpy serialization.

### 0.6.0
- **Web Search workflow node** — First-class `web_search` node type for workflow DAGs. Query Brave, SearXNG, or Serper directly from automated pipelines. Set `BRAVE_API_KEY` env var and go.
- **Workflow Engine v2.1.0** — 9 node types (added `web_search`). Pre-baked FelixBag guide with 4 ready-to-use workflow templates: basic search, research pipeline with rerank, multi-provider fan-out, and entropy loop + web.
- **Marathon session hardening** — SSE heartbeat detects silent connection death (60s). Auto-restart after 10 failed reconnects (one full process restart attempt before giving up). Periodic Python cache cleanup every 30 minutes. MCP log rotation at 5MB.
- **Bounded resource caches** — Nostr profiles (500 max), zap totals (1000), reputation (2000), IPFS pins (500), rep chains (100). Prevents memory growth during extended sessions.
- **GitHub API timeouts** — All GitHub requests now have 30-second AbortController timeout.
- **Marketplace storage optimization** — Embedding vectors stripped from globalState persistence, saving ~6MB from VS Code's SQLite store.

### 0.5.5
- **Public Gist marketplace** — Search and browse GitHub's public gist database alongside Nostr items. Source badges (NOSTR/GIST/LOCAL), source filter, gist detail view with fork/import/save actions.
- **Background gist indexing** — Pre-seeded queries auto-populate marketplace with public workflows, smart contracts, DeFi protocols, and automation scripts.
- **Web3 auto-population** — Solidity, Vyper, Hardhat, Chainlink, NFT, and DAO gists indexed automatically.

### 0.5.4
- **Live execution tracing** — Running nodes pulse amber, completed glow green, failed flash red. Edge wavefront animates with marching dashes.
- **Draggable flowchart nodes** — Drag to rearrange, edges follow live. Positions saved per workflow.
- **Workflow identity colors** — Golden-angle HSV distribution gives each workflow a unique color across list, graph border, and execution pulse.

### 0.5.3
- **Glass-box tool metadata** — Tools tab now expands each tool to show full description, every parameter with type/required/default/enum, and category info.
- **Activity drill-down** — Click any tool call to see full provenance: timestamp, args, result payload, duration, source.
- **Model loading progress** — Animated progress banner during model plug operations with elapsed timer.

### 0.5.2
- **Dynamic slot grid** — Council tab now renders slots from capsule data. Custom builds with any slot count display correctly.
- **Marketplace detail fix** — Detail view no longer resets when relay events arrive.
- **Capsule upgrade fix** — VSIX installs now properly re-extract updated capsules.

### 0.5.1
- **Expanded Model Council** — Backend updated to support more model slots for larger multi-model orchestration.

### 0.5.0
- **Cross-model evaluation metrics** — Track latency, consistency, success rate, and throughput per model slot. Council-level scoring identifies optimal model combinations automatically.
- **Verifiable reputation chains** — Merkle-linked W3C Verifiable Credentials create tamper-evident reputation history with Nostr serialization.
- **Semantic marketplace search** — Cosine-similarity search over marketplace items using MCP embeddings, with reputation-weighted ranking.
- **IPFS pinning integration** — Pin content to Pinata or web3.storage directly from the extension. Configure via `champion.ipfs.*` settings.

### 0.4.x Highlights
- MCP cache-aware tool calls across the entire extension (0.4.6).
- Flowchart zoom/pan navigation for large workflows (0.4.5).
- Live council slot state feedback (0.4.4).
- Hardened zap flow with strict validation (0.4.3).
- Web3 cryptographic utilities: IPFS CID, DID:key, Verifiable Credentials, Safety Attestations (0.4.0).

## Core Features

- **Multi-Slot Model Council** - Plug HuggingFace models into council slots and run inference, debate, consensus, and chaining. Slot count is capsule-driven.
- **140+ MCP Tools** - Full MCP/SSE tool surface for IDE agents and automation.
- **Workflow Engine v2.1** - 9 node types including `web_search` for live web queries in automated DAGs. Brave, SearXNG, and Serper providers supported out of the box.
- **Semantic Memory (FelixBag)** - Local embedding store with search, catalog, and export.
- **Community (Nostr)** - Marketplace, live chat, encrypted DMs, and privacy controls.
- **Model Evaluation** - Per-slot and council-level inference quality tracking with comparison and export.
- **Reputation Chains** - Merkle-linked W3C VC history for verifiable publisher trust.
- **IPFS Pinning** - Optional persistence of content-addressed data via Pinata or web3.storage.

## Quick Start

1. Install the extension.
2. Ensure **Python 3.10+** is available on PATH.
3. Open **Champion Council** in the Activity Bar.
4. The MCP server auto-starts (default port `8765`).
5. Open **Control Panel** to manage models, workflows, memory, and community.

## Requirements

- **Python 3.10+**
- **numpy** (auto-installed by backend)
- **torch** (optional, for GPU inference)
- **transformers** (optional, for HuggingFace model loading)

## Configuration

All settings live under `champion.*` in VS Code Settings.

Common settings:
- `champion.pythonPath`
- `champion.mcpPort`
- `champion.autoStartMCP`
- `champion.tools.*` (per-category toggles)
- `champion.nostrEnabled`
- `champion.evaluation.enabled` / `champion.evaluation.autoRecord`
- `champion.ipfs.provider` (`none`, `pinata`, `web3storage`)
- `champion.ipfs.apiKey` / `champion.ipfs.gateway`

## Commands

- `Champion: Open Control Panel`
- `Champion: Start MCP Server`
- `Champion: Stop MCP Server`
- `Champion: Generate MCP Config for IDE`

## License

MIT
