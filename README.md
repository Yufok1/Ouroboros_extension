# Champion Council — AI Model Orchestrator

A local AI orchestrator for VS Code and compatible editors. Manage multiple HuggingFace models, build workflows, and collaborate with other developers.

## Features

- **8-Slot Model Council** — Plug any HuggingFace model into up to 8 slots. Run inference, debate, and chain outputs between models.
- **140+ MCP Tools** — Full Model Context Protocol integration. Every function is an exposed tool for automation.
- **Semantic Memory** — Local vector store for embedding and retrieving text, code, and context by meaning.
- **Workflow Engine** — Create, execute, and share multi-step AI workflows.
- **Community** — Share workflows and chat with other developers via the Nostr protocol.

## Installation

1. Install the extension.
2. Ensure **Python 3.10+** is installed and available in your PATH.
3. Open the **Champion Council** tab in the Activity Bar.
4. The MCP server starts automatically.

## Requirements

- **Python 3.10+**
- **numpy** (installed automatically)
- **torch** (optional, for GPU inference)
- **transformers** (optional, for HuggingFace models)

## How It Works

The extension manages a local Python backend that provides AI inference, semantic search, and model management via the Model Context Protocol (MCP/SSE).

## License

MIT
