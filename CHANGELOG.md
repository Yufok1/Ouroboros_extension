# Changelog

All notable changes to the "Champion Council" extension will be documented in this file.

## [0.7.3] - 2026-02-18

### Plug/Unplug System Overhaul
- **Fixed**: Chained model plugs no longer wipe each other's loading state. Each plug operation now tracks independently — plug 3 models in sequence and all 3 show real-time progress.
- **Fixed**: Double-clear race condition where both the activity feed and tool result handler would simultaneously clear plug state and fire duplicate `list_slots` calls.
- **Fixed**: Backend crash when models with `trust_remote_code=True` call `sys.exit()` — `SystemExit` now caught and returned as structured error instead of killing the process.
- **Added**: Unplug loading state — clicking UNPLUG immediately shows amber-pulse "UNPLUGGING" animation until the slot confirms empty.
- **Added**: Rich metadata cards on plugged slot cards — author, task, downloads, likes, license, and size fetched from HuggingFace Hub and displayed as tag badges.
- **Added**: `model_type` field in `list_slots` response for occupied slots (EMBEDDING, LLM, SEQ2SEQ, etc.).
- **Added**: Council output panel now clears and shows "Running..." on new operations instead of displaying stale results.

## [0.7.2] - 2026-02-17

### Missing NIP UI Expansion
- **Added**: NIP-88 Polls — create and vote on polls directly in the community chat.
- **Added**: NIP-A0 Voice Messages — record and send public voice notes with IPFS-backed storage.
- **Added**: NIP-58 Badges — create badge definitions, award badges to other users, and view badge galleries.
- **Added**: NIP-90 Data Vending Machines — submit AI jobs (text, code, translation, etc.) and track results via the new AI JOBS tab.
- **Added**: NIP-39 External Identity — link and verify GitHub, Twitter, Discord, and other identities in the Privacy tab.
- **Added**: NIP-42 Relay Authentication — status indicator for successful AUTH challenges with private relays.
- **Updated**: Community Chat now interleaves polls, voice notes, and identity badges with regular messages.

## [0.7.1] - 2026-02-17

### Voice Audio Streaming Fix
- **Fixed**: Peers can now hear your microphone audio. Implemented WebSocket + AudioWorklet bridge that streams ffmpeg PCM audio from the extension host to the webview, where it's converted to a `MediaStream` and handed to PeerJS for WebRTC transmission.
- **Added**: Real-time PCM-to-MediaStream pipeline via `AudioWorkletProcessor` with linear interpolation resampling (16kHz → AudioContext rate).
- **Added**: `RTCRtpSender.replaceTrack()` support — mic can be toggled after peers are already connected.
- **Added**: Content-Security-Policy meta tag for webview (allows `ws://127.0.0.1:*` for audio bridge, `blob:` for AudioWorklet).
- **Removed**: Dead iframe-based mic capture code (HTTP server, mic iframe, duplicate Privacy tab settings).
- **Removed**: `naudiodon` native audio dependency (ffmpeg is the sole capture method).
- **Consolidated**: Voice settings now only in the in-room settings panel (removed duplicate from Privacy tab).

## [0.7.0] - 2026-02-17

### P2P Voice Communications
- **Added**: NIP-53 Voice Rooms — full voice room lifecycle: create, join, leave, raise hand, live chat (kind 30312, 1311, 10312).
- **Added**: PeerJS/WebRTC P2P voice transport — real-time audio via peer-to-peer connections. No server hosting required. Signaling via Nostr relay ephemeral events (kind 25050).
- **Added**: Voice Room UI — onboarding screen, room list with status pills, active room view with participant cards, mic toggle, live chat input, room timer.
- **Added**: Real-time mic feedback — live level bar (green → yellow → red) using ffmpeg native audio capture with RMS level computation.
- **Added**: Voice room settings panel — mic sensitivity slider (0.5x–4.0x), noise gate threshold (0–30) in the active room view.
- **Added**: Speaking detection — per-participant audio level monitoring with visual indicators on participant cards.
- **Added**: `champion.communityVoice` setting to enable/disable voice features.

### Nostr Protocol Expansion (12 New NIP Methods)
- **Added**: NIP-39 External Identity Claims — `publishExternalIdentity()` for linking GitHub, Discord, Twitter, etc. to Nostr profile.
- **Added**: NIP-42 Relay Authentication — `handleRelayAuth()` for AUTH challenge/response with private relays.
- **Added**: NIP-58 Badges — `createBadge()` and `awardBadge()` for reputation-linked badge definitions and awards.
- **Added**: NIP-88 Polls — `createPoll()` and `votePoll()` for community governance.
- **Added**: NIP-90 Data Vending Machines — `submitDvmJob()` and `publishDvmResult()` for AI job marketplace via Nostr.
- **Added**: NIP-98 HTTP Auth — `signNip98Auth()` for signed HTTP requests.
- **Added**: NIP-A0 Voice Messages — `sendVoiceNote()` for audio message events.
- **Added**: WebRTC Signaling — `sendWebRTCSignal()` for P2P voice transport coordination via Nostr.

### Theme & UI
- **Added**: Theme Import — simple hex color input in Privacy tab for accent color customization. Apply/Reset with live preview swatch.
- **Added**: Nostr identity bar in Voice tab — shows pubkey + relay count.
- **Removed**: Discord OAuth2 dependency — no external OAuth, no API gatekeeping. All comms through Nostr relays.

### Persistence & Stability
- **Added**: FelixBag auto-persistence — bag state auto-loads from `.bag_state.json` on MCP server startup, auto-saves on shutdown (atexit), and background-saves every 5 minutes for marathon sessions.
- **Added**: Cascade chain & graph persistence — `cascade_chain` and `cascade_graph` operations are now backed by FelixBag. State survives process restarts via automatic fallback-on-lookup and re-persist-on-mutation.
- **Added**: Local git versioning — Memory tab drill-downs include a "Commit Version" button. Writes bag item to `bag_docs/<type>/` and commits to the workspace git repo. Full git history (log, diff, restore) available via standard git commands.
- **Added**: Publish-from-bag — "Publish to Marketplace" button in Memory drill-downs auto-fills the publish modal with item data. Non-workflow items auto-wrapped into executable workflow JSON.
- **Added**: Safety scan on publish — `scanDocSafety()` runs on prefilled content before the publish modal opens. Critical flags block publishing; warnings shown inline. Auto-redaction preview triggered when enabled.
- **Added**: Two-click commit confirmation — Commit Version button requires two clicks within 3 seconds to prevent accidental repo history clutter.
- **Added**: Git availability detection — probes `git --version` on first Memory tab open; disables versioning UI gracefully when Git is not installed.
- **Added**: Large diff protection — diffs >5000 chars truncated in webview with "Open Full Diff in Editor" button that launches VS Code's native diff viewer.
- **Fixed**: Model loading stability — `plug_model`, `hub_plug`, and `hub_download` now use 10-minute timeout (was 2 min). SSE heartbeat suppressed during long-running operations to prevent false disconnects.
- **Fixed**: External activity detection on Windows — log poller now uses `readFileSync` + buffer slice instead of `open()`/`read()` which failed silently due to Windows file sharing semantics.

## [0.6.6] - 2026-02-16
- **Fixed**: External activity detection on Windows (superseded by 0.7.0 entry above).
- **Fixed**: Poller errors now logged instead of silently swallowed.

## [0.6.5] - 2026-02-16
- **Fixed**: Activity feed expanded views no longer reset on sync tick. Text selection works in drill-downs.
- **Added**: Kiro and Antigravity IDE paths to MCP log discovery.

## [0.6.4] - 2026-02-16
- **Improved**: Workflow engine error messages now show exactly which `{{$expr}}` failed to resolve, what keys the referenced node actually has, and suggest corrections. Eliminates blind debugging of "unresolved expression" errors.
- **Added**: Comprehensive Expression Syntax reference in embedded `workflow_automation_guide` FelixBag doc — covers two-pass resolution rules (bare `$expr` vs `{{$expr}}`), output key table for 15+ tools, and 5 common mistakes with fixes.
- **Cleaned**: Added `living_research_mind.md` and `.mcp.json` to `.vscodeignore`.

## [0.6.3] - 2026-02-16
- **Cleaned**: Removed research/planning documents from VSIX package (18 files, down from 35).

## [0.6.2] - 2026-02-16
- **Fixed**: `get_status` — sorted() crash on mixed dict/str types in FelixBag catalog.
- **Fixed**: `bag_catalog` — same sorted() crash as get_status (shared FelixBag.catalog() path).
- **Fixed**: `get_artifacts` — same sorted() crash (shared FelixBag.catalog() path).
- **Fixed**: `bag_export` — same sorted() crash (shared FelixBag.catalog() path).
- **Fixed**: `symbiotic_interpret` — SymbioticAdapter called as class method instead of instance.
- **Fixed**: `trace_root_causes` — Tracer instantiation missing required CausationGraph argument.
- **Fixed**: `forensics_analyze` — ArtifactDetector.detect() called with wrong argument signature; replaced with DataForensics.analyze() pipeline.
- **Fixed**: `cascade_system` (analyze) — wrong module path `cascade.system.moe` corrected to `cascade.system.moe_analyzer`.
- **Fixed**: `cascade_system` (ingest_file) — wrong module path `cascade.system.extractors` corrected to `cascade.system.universal_extractor`.
- **Fixed**: `cascade_data` (license_check) — LicenseAnalyzer.analyze() corrected to check_compatibility().
- **Fixed**: `cascade_data` (schema) — added type conversion for list-of-dicts input to columnar dict-of-lists format.
- **Fixed**: `rerun_log_inference` — nested numpy ndarray serialization now uses recursive sanitizer.

## [0.6.0] - 2026-02-15
- **Added**: `web_search` workflow node type — first-class web search in workflow DAGs. Supports Brave, SearXNG, and Serper providers.
- **Added**: Web Search Workflow Guide — pre-baked FelixBag documentation with 4 ready-to-use workflow templates (basic search, research pipeline, multi-provider fan-out, entropy loop + web).
- **Added**: Workflow Engine v2.1.0 — 9 node types (was 8).
- **Added**: Marathon session hardening — SSE heartbeat (60s dead connection detection), auto-restart after failed reconnects, periodic Python cache cleanup (30min), MCP log rotation (5MB cap).
- **Added**: Bounded resource caches — Nostr profiles (500), zap totals (1000), reputation (2000), IPFS pins (500), rep chains (100). Prevents unbounded memory growth during long sessions.
- **Fixed**: Presence heartbeat interval leak — timer now properly disposed when panel closes.
- **Fixed**: Stale online users pruned on access instead of accumulating forever.
- **Fixed**: Nostr relay reconnect capped at 20 retries per relay (was infinite).
- **Fixed**: GitHub API calls now have 30-second timeout (was unlimited).
- **Fixed**: Marketplace embeddings stripped from globalState persistence (saves ~6MB).
- **Fixed**: `listTools()` return type corrected (resolves TypeScript compilation warning).

## [0.5.5] - 2026-02-15
- **Added**: Public GitHub Gist marketplace integration — search and browse public gists alongside Nostr marketplace items in a unified view.
- **Added**: Source badges — marketplace cards display NOSTR (purple), GIST (gray), or LOCAL (green) origin badges.
- **Added**: Source filter dropdown — filter marketplace by All Sources, Nostr Only, or GitHub Gists.
- **Added**: Gist detail view with full file content, syntax info, and action buttons (Fork, Save to Memory, Import as Workflow, View on GitHub).
- **Added**: Background gist indexing — pre-seeded queries auto-populate marketplace with public workflows, smart contracts, and automation scripts on tab activation.
- **Added**: Debounced gist search — marketplace search queries GitHub in real-time (500ms debounce) alongside instant local index search.
- **Added**: Web3 auto-population — background queries for Solidity, Vyper, Hardhat, Chainlink, DeFi, NFT, and DAO gists.

## [0.5.4] - 2026-02-15
- **Added**: Workflow live execution tracing — running nodes pulse amber, completed nodes glow green, failed nodes flash red (CSS GPU-composited animations).
- **Added**: Edge flow animation — active edges (execution wavefront) show marching dash pattern with amber stroke and arrow.
- **Added**: Draggable flowchart nodes — drag nodes to rearrange, edges follow in real-time. Coexists with svg-pan-zoom (capture-phase interception). Positions persist per workflow.
- **Added**: Workflow identity colors — each workflow gets a unique HSV-distributed color (golden angle). Shown on list items, graph border, and executing pulse.
- **Added**: Workflow list execution highlighting — active workflow pulses with its identity color during execution.

## [0.5.3] - 2026-02-15
- **Added**: Tools tab drill-down — each tool expands to show full description, parameters (name, type, required, default, enum values, ranges), and category metadata. Schemas fetched live from MCP `tools/list`.
- **Added**: Activity tab click-to-expand — every tool call entry is now clickable, revealing full timestamp, source, category, duration, arguments, and result payload with rich formatting.
- **Added**: Council plug progress banner — animated loading indicator with elapsed timer appears during model loading operations, clears automatically on completion.
- **Improved**: All tabs fill available viewport height and resize dynamically (flex-fill layout).

## [0.5.2] - 2026-02-15
- **Fixed**: Council slot grid now renders dynamically from capsule data — no longer hardcoded to 8. Custom capsule builds with any slot count will display correctly.
- **Fixed**: Marketplace document detail view no longer resets when new Nostr events arrive while reading.
- **Fixed**: Capsule extraction (marketplace installs) now detects updated `.gz` and re-extracts instead of using stale copy from previous version.
- **Changed**: Removed hardcoded slot count references; UI is fully capsule-driven.

## [0.5.1] - 2026-02-15
- **Changed**: Council slots expanded from 8 to 32 — `champion.maxSlots` now supports 1–32 slots (default: 32).
- **Changed**: Updated `champion_gen8.py` backend to support 32-slot model council.
- **Improved**: Documentation updated to reflect 32-slot capacity across README and configuration descriptions.

## [0.5.0] - 2026-02-15
- **Added**: `src/evaluation.ts` — Cross-model evaluation metrics. Tracks latency (avg, p95, min, max), consistency, success rate, and throughput per model slot. Council-level metrics include consensus rate, diversity score, and best-combination scoring. Auto-records from MCP inference tool calls.
- **Added**: `src/reputationChain.ts` — Merkle-linked W3C Verifiable Credential chains for tamper-evident reputation history. SHA-256 hash-linked entries with append, verify, and Nostr serialization (kind 30078).
- **Added**: `src/marketplaceSearch.ts` — Semantic search for marketplace items using MCP `embed_text` embeddings with cosine similarity. Reputation-weighted ranking (0.7 relevance + 0.3 reputation). Falls back to tag-based substring matching when MCP is unavailable.
- **Added**: `src/ipfsPinning.ts` — IPFS pinning integration supporting Pinata and web3.storage (Storacha) APIs. Pin cache persisted in globalState. Configurable via `champion.ipfs.*` settings.
- **Added**: 19 new webview message handlers for evaluation, reputation chain, marketplace search, and IPFS pinning.
- **Added**: Settings: `champion.evaluation.enabled`, `champion.evaluation.autoRecord`, `champion.ipfs.provider`, `champion.ipfs.apiKey`, `champion.ipfs.gateway`.
- **Improved**: Extension activation now initializes ModelEvaluator, MarketplaceIndex, and IPFSPinningService alongside existing services.
- **Improved**: MCP tool call activity auto-records to evaluator for tracked inference tools (forward, infer, generate, classify, deliberate, etc.).

## [0.4.7] - 2026-02-14
- **Improved**: README now showcases recent changelog highlights (0.4.0–0.4.6) on marketplace listing pages.

## [0.4.6] - 2026-02-14
- **Fixed**: MCP tools returning >2KB responses now auto-resolve cached data across the entire extension — not just the webview.
- **Added**: `callToolParsed()` method on MCPServerManager for cache-aware tool calls from any extension component.
- **Fixed**: `hub_search`, `deliberate`, and `bag_catalog` commands now return full results instead of truncated cache summaries.
- **Fixed**: Rerun bridge `bag_catalog` refresh calls now resolve cached responses, ensuring correct item counts in visualization.

## [0.4.5] - 2026-02-14
- **Fixed**: Workflow flowchart now renders correctly from cached data — re-fetches definition when cached state is missing or incomplete instead of rendering a blank graph.
- **Added**: Flowchart zoom (mouse scroll) and pan (click-drag) navigation for large workflows.
- **Improved**: Click vs. drag detection prevents accidental node/edge deselection while panning.

## [0.4.4] - 2026-02-14
- **Fixed**: Council slot cards no longer show `EMPTY` when slot names update during model plug operations.
- **Added**: Basic slot state visuals in Council tab (`PLUGGED`, `PLUGGING`, `EMPTY`) with color/status dot feedback.
- **Improved**: Slot grid now auto-refreshes after council mutation actions (plug, unplug, clone, rename, swap).

## [0.4.3] - 2026-02-14
- **Fixed**: NIP-57 zap flow now enforces strict validation (relay connection, valid IDs, no self-zap, valid sats, LNURL checks, invoice required).
- **Fixed**: Removed fakeable client-side zap side effects (no click-only reputation/reaction inflation before real payment).
- **Fixed**: Profile updates now merge instead of overwrite, preventing accidental loss of `lud16` or display name fields.
- **Added**: Relay-backed recipient profile fetch fallback during zap flow for better reliability.
- **Added**: "RUN ZAP CHECK" readiness panel with plain pass/fail output and fix hints.
- **Improved**: Champion Activity Bar sidebar now shows informative status snapshot (MCP status, port, tool/category counts, relay count, quick actions).

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
