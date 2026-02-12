# Champion Council - AI Model Orchestrator

An 8-slot AI model orchestration system with 140+ MCP tools, semantic memory, workflow automation, and a decentralized community marketplace. Built on the OUROBOROS architecture.

## Install

1. Download the latest `.vsix` from [Releases](https://github.com/Yufok1/Ouroboros_extension/releases)
2. In VS Code or Windsurf: `Extensions` > `...` > `Install from VSIX`
3. Ensure Python 3.8+ is installed with:
   ```
   pip install torch sentence-transformers huggingface-hub mcp fastmcp numpy
   ```
4. The MCP server starts automatically. You're done.

## What It Does

### 8-Slot Council System
Plug up to 8 HuggingFace models into council slots. Each slot is independently invocable for embedding, generation, classification, or deliberation. The council can broadcast, debate, and reach consensus across all plugged models simultaneously.

### 140+ MCP Tools (21 Categories)
Every tool is exposed via MCP and callable by Windsurf Cascade, VS Code Copilot, or any MCP client:

- **Council/Slot Management** (10) — plug, unplug, clone, mutate, swap, rename
- **FelixBag Memory** (10) — semantic vector store with search, induct, catalog
- **HuggingFace Hub** (8) — search models/datasets, download, plug directly
- **Workflow Automation** (9) — DAG engine with fan_out, conditionals, tool nodes
- **Council Operations** (7) — broadcast, debate, chain, consensus
- **Batch Operations** (5) — parallel inference, embedding, comparison
- **LLM Operations** (3) — generate, classify, rerank
- **Diagnostics** (6) — forensic analysis, root cause tracing
- **CASCADE Observability** (7) — provenance chains, causal graphs, tape recording
- **Status & Introspection** (13) — integrity verification, hash checks, structure tree
- **Export & Documentation** (8) — PyTorch, ONNX, quine capsule export
- **Replication & Evolution** (5) — self-replicating quine, swarm spawning
- **Vast.AI GPU Rental** (13) — remote GPU search, rent, distribute
- **Visualization** (5) — Rerun.io integration
- **HOLD Protocol** (2) — human-in-the-loop decision gates
- **Security** (3) — threat detection, self-destruct, freeze
- **Cache Management** (2) — response caching for large results
- **Advanced** (5) — universal relay, observation, experience feeding

### Community Tab (NEW in v0.2.0)
Decentralized workflow marketplace and live chat powered by the Nostr protocol:
- **Browse & import** workflows published by other users
- **Publish** your own workflows to the community
- **Live chat** with other Ouroboros users
- **Zero infrastructure** — connects to public Nostr relays
- **Anonymous by default** — identity is a cryptographic keypair stored in your OS keychain
- **No Discord, no accounts, no management burden**

### Workflow Engine
A built-in DAG execution engine with 8 node types (`tool`, `fan_out`, `if`, `set`, `merge`, `http`, `input`, `output`). Any of the 140+ tools can be used as a workflow node. Supports parallel fan-out, conditional branching, and auto-wiring.

## Quick Start

1. **Open the Control Panel** — Click "Champion" in the status bar, or `Ctrl+Shift+P` > "Champion: Open Control Panel"
2. **Plug a model** — Council tab > PLUG MODEL > enter a HuggingFace model ID
3. **Search the Hub** — `Ctrl+Shift+P` > "Champion: Search HuggingFace Hub"
4. **Configure tools** — `Ctrl+,` > search "Champion" > toggle tool categories on/off
5. **Join the community** — Community tab > chat or browse workflows

## Architecture

```
┌─────────────────────────────────────────────┐
│  Windsurf / VS Code (MCP Client)           │
│  Cascade calls 140+ MCP tools directly     │
└─────────────────┬───────────────────────────┘
                  │ JSON-RPC over HTTP + SSE
┌─────────────────▼───────────────────────────┐
│  Champion Extension (TypeScript)            │
│  WebView panel with 7 tabs                 │
│  Nostr relay client (community features)   │
└─────────────────┬───────────────────────────┘
                  │ Spawns + manages
┌─────────────────▼───────────────────────────┐
│  champion_gen8.py (Python MCP Server)       │
│  8-slot council | FelixBag memory          │
│  Workflow engine | CASCADE provenance      │
│  HuggingFace Hub | Vast.AI GPU cluster     │
└─────────────────────────────────────────────┘
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `champion.pythonPath` | `"python"` | Path to Python executable |
| `champion.mcpPort` | `8765` | MCP server port |
| `champion.autoStartMCP` | `true` | Auto-start on activation |
| `champion.maxSlots` | `8` | Council slot count (1-8) |
| `champion.nostrEnabled` | `true` | Enable community features |
| `champion.nostrRelays` | `[3 defaults]` | Nostr relay URLs |
| `champion.tools.*` | varies | Toggle each tool category |

## Environment Variables

Optional — create `.env` in the extension directory:

```
HF_TOKEN=hf_xxxxxxxxxxxxx
VAST_API_KEY=xxxxxxxxxxxxx
```

## Troubleshooting

- **Server won't start** — Check `python --version` and `pip list | grep torch`
- **Tools not showing** — Status bar should show green "CHAMPION". Check tool toggles in settings.
- **Model won't load** — Try `sentence-transformers/all-MiniLM-L6-v2` first. Set `HF_TOKEN` for gated models.

## License

MIT

## Credits

Built on the **OUROBOROS architecture** by [Yufok1](https://github.com/Yufok1):
- Sentence-Transformers embedding foundation
- DreamerV3 RSSM world model
- Scarecrow universal adapter
- Council multi-agent consensus
- CASCADE-LATTICE cryptographic provenance
- Nostr decentralized community protocol

Quine-capable, self-replicating, fully transparent AI system.
