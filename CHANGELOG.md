# Changelog

All notable changes to the "Champion Council" extension will be documented in this file.

## [0.4.0] - 2026-02-13
- **Added**: `src/web3.ts` — Zero-cost cryptographic Web3 utilities (no subscriptions, no APIs, pure local computation).
- **Added**: IPFS CIDv1 generation — `computeCID()` produces proper content-addressed identifiers from any content. Published marketplace documents now include `contentCID` and an `['i', cid]` tag.
- **Added**: DID:key derivation — `deriveDIDKey()` produces W3C Decentralized Identifiers from existing Nostr secp256k1 keys. `getDID()`, `getDIDDocument()` on NostrService.
- **Added**: Verifiable Credentials — `issueReputationVC()` creates W3C VC Data Model credentials for reputation levels. Self-issued, locally computed, tamper-evident via SHA-256 proof.
- **Added**: Safety Attestations — `createSafetyAttestation()` generates EAS-inspired cryptographic receipts for safety scan results, linked to document CIDs.
- **Added**: Web3 marketplace document types: `smartcontract`, `dapp-template`, `testnet-config`, `audit-report`, `chain-recipe` — with per-type schema validation (Solidity keyword check, JSON structure validation, etc.).
- **Added**: 15 Web3/vibe-coding marketplace categories: `solidity`, `vyper`, `evm`, `defi`, `nft`, `dao`, `token`, `bridge`, `oracle`, `identity`, `storage`, `testing`, `security`, `gas-optimization`, `web3-tooling`.
- **Added**: WebLN Lightning wallet detection — detects Alby/Zeus/BlueWallet, upgrades zap buttons to one-click payment with manual fallback.
- **Added**: Web3 category filters in marketplace UI — dynamic `<optgroup>` injection for Web3 categories.
- **Added**: Panel message handlers: `web3GetDID`, `web3ComputeCID`, `web3IssueReputationVC`, `web3GetDocTypes`, `web3GetCategories`, `weblnPaymentResult`.

## [0.3.7] - 2026-02-13
- **Fixed**: Diagnostics compact view now dynamically extracts ALL fields from tool responses instead of a hardcoded subset that missed most data.
- **Fixed**: Nested tool response objects (weights, params, config, adapter shapes) are flattened and displayed in the KV grid.
- **Improved**: Small arrays (e.g. tensor shapes) now show actual values instead of "[N items]".
- **Improved**: Source/fallback provenance shown in diagnostic header metadata.

## [0.3.6] - 2026-02-13
- **Fixed**: Diagnostics tab now routes every diagnostics action through robust fallback orchestration (tool + fallback tools + MCP resources).
- **Fixed**: Dead-zone outputs in diagnostics (null/unknown/error-only states) are now normalized and enriched with available runtime data.
- **Improved**: Diagnostics output UI now shows compact health/fallback/probe summaries with expandable resolved payload and probe trace sections.

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
