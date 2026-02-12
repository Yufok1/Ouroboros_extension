# Champion Council

The opposite of a black box. 140+ MCP tools. 8-slot model council. Semantic memory. Workflow engine. Decentralized community. All in one extension.

## 7 Tabs

- **Overview** — Architecture diagram, generation stats, quine hash, tool category breakdown
- **Council** — 8-slot grid. Plug/unplug HuggingFace models. Invoke, clone, mutate, swap.
- **Memory** — FelixBag semantic vector store. Search, induct, catalog, export.
- **Activity** — Live feed of every MCP tool call with timing, args, results.
- **Tools** — Full registry of 140+ tools across 21 categories. Invoke any tool directly.
- **Diagnostics** — Integrity verification, hash checks, CASCADE lattice, provenance chains.
- **Community** — Decentralized workflow marketplace and live chat via Nostr protocol.

## 140+ MCP Tools

Council/Slot Management (10) | FelixBag Memory (10) | HuggingFace Hub (8) | Workflow Automation (9) | Council Operations (7) | Batch Operations (5) | LLM Ops (3) | Diagnostics (6) | CASCADE Observability (7) | Status & Introspection (13) | Export (8) | Replication & Evolution (5) | Vast.AI GPU (13) | Visualization (5) | HOLD Protocol (2) | Security (3) | Cache (2) | Advanced (5)

Toggle any category on/off: `Ctrl+,` > search "Champion"

## Workflow Engine

DAG execution with 8 node types: `tool`, `fan_out`, `if`, `set`, `merge`, `http`, `input`, `output`. Any MCP tool is a workflow node. Parallel fan-out, conditional branching, auto-wiring.

## Community Marketplace

Workflow sharing and live chat via Nostr. No server. No accounts. No Discord. Your identity is a cryptographic keypair stored in your OS keychain. Browse, publish, import, react.

## Architecture

```
  IDE (Windsurf / VS Code) ── JSON-RPC over SSE ──> MCP Server
  Extension WebView (7 tabs) ── postMessage ──> TypeScript backend
  Nostr relays ── WebSocket ──> Community features
  champion_gen8.py ── 8-slot council, FelixBag, CASCADE provenance
```

## Built on OUROBOROS

Gen 8 quine architecture. Sentence-Transformers embedding. DreamerV3 RSSM world model. Scarecrow adapter. Council consensus. CASCADE-LATTICE provenance. Self-replicating. Fully transparent.

By [Yufok1](https://github.com/Yufok1) | MIT
