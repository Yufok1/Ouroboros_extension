# Changelog

All notable changes to the "Champion Council" extension will be documented in this file.

## [0.3.5] - 2026-02-13
- **Fixed**: Memory tab Export now opens a format picker instead of routing to unrelated UI behavior.
- **Added**: Memory export formats for JSON, Markdown, TXT, and CSV.
- **Improved**: Export files are written directly into the active workspace folder.

## [0.3.4] - 2026-02-13
- **Fixed**: Memory tab now refreshes FelixBag catalog when external bag mutations occur (`bag_put`, `bag_induct`, `bag_forget`, `pocket`, `load_bag`).
- **Fixed**: Memory stats/count and item list now update dynamically after external inductions without manual catalog click.

## [0.3.3] - 2026-02-13
- **Fixed**: Activity feed no longer loops periodic internal `get_status`/`list_slots` polling from the webview panel.
- **Fixed**: Internal/suppressed MCP calls are better deduplicated against log echoes, reducing false external activity spam.
- **Improved**: Activity tab now prioritizes real MCP tool usage events from external IDE agents.

## [0.3.2] - 2026-02-13
- **Fixed**: Rerun viewer now killed on extension stop/IDE close (process tree kill).
- **Fixed**: Orphan Rerun processes cleaned up on startup.

## [0.3.1] - 2026-02-13
- **Fixed**: Activity feed now detects external MCP client operations (model plugging, memory changes, inference).

## [0.3.0] - 2026-02-13
- **Added**: esbuild bundling for faster load times and smaller package size.
- **Added**: Community tab with chat, DMs, workflow marketplace, and privacy controls.
- **Fixed**: Community tab initialization with bundled dependencies.
- **Fixed**: Tool call polling performance improvements.
- **Fixed**: Visualization entity path resolution.
- **Improved**: Safety tool naming (crystallize, resume_agent).

## [0.2.0] - 2026-02-10
- **Added**: Full Rerun integration (Glass Box Visualization).
- **Added**: FelixBag semantic memory system.
- **Added**: Council deliberation tools (consensus, debate).

## [0.1.1] - 2026-02-05
- **Fixed**: Python process cleanup on Windows.
- **Improved**: MCP server startup reliability.

## [0.1.0] - 2026-01-30
- Initial release.
- 8-slot council system.
- 140+ MCP tools.
- HuggingFace integration.
