# Champion Council - AI Model Orchestrator

An 8-slot AI model orchestration system with full MCP (Model Context Protocol) integration for Windsurf, VS Code, and other MCP-compatible IDEs.

## Features

### 🎰 **8-Slot Council System**
- Dynamically plug/unplug HuggingFace models into 8 council slots
- Visual slot management through WebView panel
- Real-time status monitoring
- Slot operations: clone, mutate, swap, rename

### 🛠️ **140+ MCP Tools** (21 Categories)

All tools are exposed via MCP and can be enabled/disabled through VS Code settings:

1. **Council/Slot Management** (10 tools) - Model lifecycle management
2. **FelixBag Memory** (10 tools) - Semantic vector memory system
3. **HuggingFace Hub** (8 tools) - Model discovery and download
4. **Vast.AI GPU Rental** (13 tools) - Remote GPU orchestration
5. **Replication & Evolution** (5 tools) - Self-replicating quine systems
6. **Export & Documentation** (8 tools) - Multi-format export (PyTorch, ONNX)
7. **Visualization** (5 tools) - Rerun.io integration
8. **Status & Introspection** (13 tools) - System diagnostics
9. **Council Operations** (7 tools) - Multi-agent deliberation
10. **LLM Operations** (3 tools) - Generate, classify, rerank
11. **Diagnostics** (6 tools) - Forensic analysis
12. **Workflow Automation** (9 tools) - Workflow orchestration
13. **Batch Operations** (5 tools) - Parallel processing
14. **HOLD Protocol** (2 tools) - Human-in-the-loop decisions
15. **Security** (3 tools) - Threat detection and response

### 🔌 **MCP Integration**

The extension spawns the Python MCP server (`champion_gen8.py`) and communicates via **JSON-RPC over SSE** (Server-Sent Events). This allows:

- **Windsurf Cascade** to use all 100+ tools during coding
- **VS Code Copilot** to access specialized AI models
- **Any MCP client** to orchestrate the council system

### ⚙️ **Granular Control**

Every tool category can be enabled/disabled in VS Code Settings (`Ctrl+,` → "Champion"):

```
Settings → Champion → Tools → [Enable/Disable Categories]
```

This gives you fine-grained control over which capabilities are exposed to MCP clients.

## Installation

### Prerequisites

- **Python 3.8+** with packages:
  ```bash
  pip install torch sentence-transformers huggingface-hub mcp fastmcp numpy
  ```

- **VS Code** or **Windsurf** IDE

### Install Extension

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile TypeScript:
   ```bash
   npm run compile
   ```
4. Press `F5` to launch extension in debug mode, OR:
5. Package as .vsix:
   ```bash
   npx vsce package
   ```
   Then install via `Extensions → Install from VSIX`

## Usage

### 1. Open the Council Panel

- **Command Palette**: `Ctrl+Shift+P` → "Champion: Open Council Panel"
- **Activity Bar**: Click the Champion icon (if visible)
- **Status Bar**: Click "Champion" in the bottom-right

### 2. Plug Models into Slots

**Via WebView Panel:**
- Click "➕ Plug Model"
- Enter HuggingFace model ID (e.g., `BAAI/bge-small-en`)
- Model downloads and loads into next available slot

**Via Search:**
- Click "🔍 Search HuggingFace"
- Type query (e.g., "embedding model")
- Click result to select

**Via Command:**
```
Ctrl+Shift+P → "Champion: Plug Model into Slot"
```

### 3. Use MCP Tools in Windsurf/VS Code

Once the MCP server is running (starts automatically), all enabled tools are available to MCP clients.

**Example in Windsurf Cascade:**
```
User: "Use the council to embed this text: 'Hello world'"
Cascade: [Calls champion MCP tool: embed_text]

User: "Search HuggingFace for sentiment models"
Cascade: [Calls champion MCP tool: hub_search with query='sentiment']

User: "Plug BAAI/bge-small-en into slot 1"
Cascade: [Calls champion MCP tool: plug_model]
```

### 4. Configure Enabled Tools

1. Open Settings: `Ctrl+,`
2. Search for "Champion"
3. Expand "Tools" section
4. Toggle categories on/off:
   - ✅ **Council/Slot Management** (recommended)
   - ✅ **FelixBag Memory** (recommended)
   - ✅ **HuggingFace Hub** (recommended)
   - ❌ **Vast.AI GPU** (disable if not using GPUs)
   - ❌ **Security** (disable if not needed)
   - etc.

Changes take effect immediately (MCP server auto-restarts).

## Architecture

```
┌─────────────────────────────────────────────┐
│  Windsurf / VS Code (MCP Client)           │
│  - Cascade agent calls MCP tools           │
│  - Extension WebView shows slots/status    │
└─────────────────┬───────────────────────────┘
                  │ postMessage
┌─────────────────▼───────────────────────────┐
│  Extension (TypeScript)                     │
│  - MCPServerManager spawns Python process  │
│  - SSE connection for real-time events     │
│  - WebView panel (media/main.js)           │
│  - Settings → enable/disable tool categories│
└─────────────────┬───────────────────────────┘
                  │ JSON-RPC over HTTP + SSE
┌─────────────────▼───────────────────────────┐
│  champion_gen8.py (Python MCP Server)       │
│  - FastMCP server with 140+ tools          │
│  - 8-slot council system (OUROBOROS)       │
│  - FelixBag semantic memory (23+ items)    │
│  - HuggingFace Hub integration             │
│  - Vast.AI GPU orchestration               │
│  - Quine self-replication                  │
│  - CASCADE provenance chain                │
└─────────────────────────────────────────────┘
```

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `champion.pythonPath` | `"python"` | Path to Python executable |
| `champion.mcpPort` | `8765` | MCP server port (HTTP mode) |
| `champion.autoStartMCP` | `true` | Auto-start server on activation |
| `champion.maxSlots` | `8` | Max council slots (1-8) |
| `champion.tools.councilSlots` | `true` | Enable slot management tools |
| `champion.tools.felixbag` | `true` | Enable memory tools |
| `champion.tools.huggingface` | `true` | Enable Hub tools |
| `champion.tools.vastai` | `false` | Enable GPU rental tools |
| ... | ... | (15 categories total) |

## Commands

| Command | Description |
|---------|-------------|
| `Champion: Open Council Panel` | Show WebView control panel |
| `Champion: Start MCP Server` | Manually start MCP server |
| `Champion: Stop MCP Server` | Stop MCP server |
| `Champion: List Council Slots` | Show all slots |
| `Champion: Plug Model into Slot` | Add model to slot |
| `Champion: Get System Status` | Show full system status |

## Troubleshooting

### MCP Server Won't Start

1. Check Python is installed: `python --version`
2. Check dependencies: `pip list | grep -E "torch|mcp|sentence"`
3. Check extension logs: `Help → Toggle Developer Tools → Console`
4. Check Python logs: Look for `.mcp_server.log` in extension directory

### Tools Not Available in Windsurf

1. Ensure MCP server is running (status bar shows "✅ Champion")
2. Check enabled tools in settings (disabled categories don't expose tools)
3. Restart Windsurf/VS Code
4. Check MCP client configuration (varies by IDE)

### Slot Shows "Empty" But Model Was Plugged

1. Model may still be downloading (check logs)
2. Check HuggingFace token if model is gated: Set `HF_TOKEN` env var
3. Try smaller model first to test: `sentence-transformers/all-MiniLM-L6-v2`

## Advanced Usage

### Environment Variables

Create `.env` file in extension directory:

```env
HF_TOKEN=hf_xxxxxxxxxxxxx          # HuggingFace API token
VAST_API_KEY=xxxxxxxxxxxxx         # Vast.AI API key (if using GPUs)
```

### Custom Tool Workflows

Create workflows via MCP tools:

```json
{
  "name": "embed-and-search",
  "steps": [
    {"tool": "embed_text", "args": {"text": "{{input}}"}},
    {"tool": "bag_search", "args": {"query": "{{input}}"}}
  ]
}
```

Then execute: `workflow_execute` tool.

### Remote GPU Usage

1. Enable Vast.AI tools in settings
2. Set `VAST_API_KEY` in `.env`
3. Search GPUs: `vast_search` tool
4. Rent instance: `vast_rent` tool
5. Route inference: `vast_connect` tool

## License

MIT

## Credits

Built on the **OUROBOROS architecture** (Composite AI System) with:
- Sentence-Transformers (embedding foundation)
- DreamerV3 RSSM (world model)
- Scarecrow adapter (universal model wrapper)
- Council consensus (multi-agent deliberation)
- CASCADE-LATTICE provenance (cryptographic audit trail)

Quine-capable, self-replicating, fully transparent AI system.
