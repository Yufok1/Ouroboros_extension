# Changelog

All notable changes to the "Champion Council" extension will be documented in this file.

## [0.8.1] - 2026-02-23

### Dreamer-Hold Transmission — Bidirectional Bridge

Wires the dreamer training pipeline to the cascade-lattice HOLD system. Hold resolutions now feed rewards back to the dreamer. Dreamer imagination populates hold points with human-readable decision matrices. Config-driven gates control when holds fire. CausationHold sessions enable temporal navigation. Dreamer state persists across restarts.

**Layer 1: Hold Resolution → Dreamer Reward**
- MCP `hold_resolve` now fires `_capture_reward()` on accept/override, closing the feedback loop so the dreamer learns from human decisions at hold gates.
- Internal `_HoldState.yield_point()` reward capture already wired (uses local `result` variable per errata Issue 20).
- Response enriched with `dreamer_reward_captured` and `reward_source` fields.

**Layer 2: Dreamer → Hold (Imagination into HoldPoints)**
- `_dreamer_hold_point()` runs imagination, scores branches via critic, normalizes to action_probs via temperature-scaled softmax.
- MCP `hold_yield` now uses real dreamer action_probs/value instead of static `[1.0, 0.0]`.
- Response includes `decision_matrix` with per-action labels, values, confidence, and world prediction.
- All imagination data is ASSOCIATIVE (human-readable strings and primitives, no raw numpy).

**Layer 3: Dynamic Hold Gates**
- New `hold` section in `dreamer_config.json` with `confidence_threshold`, `expose_imagination`, `blocking`, `auto_resolve_timeout`, `max_branches_displayed`.
- Auto-pass when best branch confidence exceeds threshold (default 0.85).
- Config re-read on each hold — tune at runtime without restart.

**Layer 4: CausationHold Session Integration**
- `_init_causation_hold()` creates a CausationHold session at capsule startup.
- `_capture_hold_step()` records inference steps for temporal navigation (rewind, branch_from, forward, jump_to).
- Graceful degradation: import failure sets `_causation_hold = None`, all calls become no-ops.

**Layer 5: Persistence**
- `_save_dreamer_state()` serializes critic, reward head, continue head, training stats, and last 100 reward buffer events via base64+gzip.
- `_load_dreamer_state()` restores on startup. Missing/corrupt files return False, components start fresh.
- Auto-save after every `_train_step()`.

**Enriched Tool Responses (backward compatible)**
- `get_status`: Added `hold_config`, `causation_hold_active`, `causation_hold_steps`, `persistence_file_exists` to dreamer section.
- `show_rssm`: Added `hold_gate` section with threshold, expose_imagination, blocking, causation_hold status.
- `imagine`: Already enriched with `critic_value` and `pred_reward` per step (from v0.8.0).
- All new data under new keys only — no existing fields modified.

## [0.8.0] - 2026-02-23

### DreamerV3 Full Integration — Critic, Rewards, Training & Display

Major release wiring the complete DreamerV3 learning loop: reward signal capture from live MCP operations, critic/reward/continue heads for value estimation, 4-phase gradient-free training, branching imagination with per-action trajectories, and a sidebar dreamer widget with diagnostics display. All dreamer parameters are config-driven via `dreamer_config.json` with runtime hot-reload.

**Critic & Value Heads (3 new modules)**
- **CriticHead**: MLP (5120->256->256->1) with SiLU activation and EMA target network for TD learning. ~1.4M params. Serializable via base64+gzip for state persistence.
- **RewardHead**: MLP (5120->128->1) predicts reward from latent state during imagination rollouts.
- **ContinueHead**: MLP (5120->64->1) with sigmoid output predicts episode continuation probability.

**Reward Signal Capture (6 hook points)**
- Tool success/failure in `logged_tool()` decorator
- HOLD protocol accept/override in `yield_point()`
- FelixBag `bag_induct` and `bag_forget` operations
- Workflow execution success/failure and workflow creation
- All rewards are config-weighted, symlog-normalized (optional), and paired with latent state vectors for critic training.

**4-Phase Training Loop**
- Phase 1: World model perturbation (gradient-free evolutionary)
- Phase 1b: Reward head training on buffer
- Phase 2: Imagination rollout with reward/critic prediction per step
- Phase 3: Critic update with TD error and EMA target sync
- Phase 4: Actor update via LoRA perturbation guided by lambda-return advantage
- Timeout budget enforced between phases for pipeline safety.

**Branching Imagination**
- `imagine()` now takes `n_actions` parameter for multi-branch rollouts
- Each action gets isolated trajectory with `nj_state` deep-copied per branch
- Full state save/restore (deter, stoch, nj_state) around imagination
- Results stored in `_last_imagination` for critic evaluation

**Config-Driven Parameters**
- `dreamer_config.json` controls all reward weights, training hyperparameters, imagination settings, buffer sizes, and architecture dimensions
- Hot-reload on every `show_rssm` call — tune at runtime without restart
- Deep merge with built-in defaults for forward compatibility

**Enriched MCP Tool Responses (zero new tools)**
- `get_status`: Added `dreamer` section (fitness, critic_value, reward_count, training_cycles, buffer sizes, reward_rate, imagination_branches)
- `show_rssm`: Added full dreamer diagnostics (critic value/target/params/history, reward stats, training metrics, full config dump)
- `imagine`: Added per-step `critic_value`, `pred_reward`, `action` fields and branch count

**Extension UI**
- Sidebar dreamer widget in Control Panel with status polling
- Diagnostics tab with imagination trigger and config editor
- Dreamer status/config message handlers in extension host

## [0.7.14] - 2026-02-22

### RSSM Imagination Rewrite — Single-Step Architecture

Rewrote the DreamerV3 RSSM imagination system in both `dreamer_brain.py` and the compiled capsule (`agent_compiler.py`). The previous batch-mode `nj.scan` approach hit ninjax `create=False` state key errors when imagine-path parameters (prior0, prior0norm, priorlogit) weren't initialized during the observe-only init pass. Now uses single-step RSSM calls in a Python loop, which is more reliable and gives per-step control over action selection.

**DreamerBrain (dreamer_brain.py) — 5 changes**
- **Rewritten**: `imagine()` now uses single-step RSSM calls via `_pure_imagine_single` in a Python loop instead of batch `nj.scan` with `single=False`. Each step feeds its output carry into the next, giving per-step greedy action selection from the LoRA head after the initial branch action.
- **Added**: `_imagine_fn_single` and `_pure_imagine_single` defined once at RSSM init time. The policy is a parameter, not a closure — avoids the closure-over-loop-variable bug that caused all branches to use the same action.
- **Added**: Imagine-path ninjax keys (prior0, prior0norm, priorlogit) merged into `_nj_state` during `_ensure_rssm_initialized()`. These keys are needed by `rssm.imagine` but weren't created by the observe-only init, causing `create=False` crashes.
- **Fixed**: Carry dtype changed from `bfloat16` to `float32` throughout imagination. The bfloat16 cast was unnecessary (RSSM handles its own internal precision) and caused silent precision loss in trajectory value computation.
- **Fixed**: State restoration now happens in a `try/except` block — `_deter` and `_stoch` are restored even if imagination fails mid-trajectory.

**EmbeddedDreamerBrain (agent_compiler.py / capsule) — 8 changes**
- **Rewritten**: `imagine()` mirrors the same single-step architecture as DreamerBrain. Batch `nj.scan` replaced with per-step `_pure_imagine_single` calls. State restoration wrapped in try/except.
- **Rewritten**: `forward()` now calls `_update_rssm_state(x)` on every pass, building latent from real RSSM deter+stoch concatenation instead of just the LoRA output.
- **Fixed**: `_embed_to_dreamer` projection changed from lossy `randn(384,64)` to identity-preserving `randn(384,384)` with seeded RNG (`RandomState(42)`).
- **Removed**: Dead `_dreamer_to_embed` reverse projection.

**MCP Tool Improvements (agent_compiler.py) — 4 changes**
- **Fixed**: `imagine` tool now returns a compact trajectory summary (step, latent_norm, stoch_std, real_rssm, norm_trend) instead of serializing full numpy arrays. Prevents the 614KB context bomb that was blowing up MCP client context windows.
- **Fixed**: `get_status` now reads dynamic `_fitness` from the brain object instead of returning the static initial value.
- **Enhanced**: `feed()` tool now returns `obs_buffer_events` with per-transition data (prev_emb_norm, action_sample, cur_emb_norm) for observation pipeline debugging.
- **Enhanced**: `session_stats` now includes `obs_buffer_size` from the brain's observation buffer.

## [0.7.13] - 2026-02-22

### Dreamer Pipeline Wiring Fixes

Three fixes discovered during live MCP verification of the v0.7.12 Dreamer integration. The RSSM was running but its output was being discarded, and observation telemetry was unreachable.

- **Fixed**: `_dreamer_simulate` latent_state construction now uses real RSSM state. Previously built `latent_state` from the 384-dim LoRA `output` key padded with 4736 zeros — meaning dims 4096-5120 were always zero and `uncertainty` was always `0.0`. Now concatenates `latent` (4096-dim deter) + `stoch` (1024-dim categorical) when both keys exist in the forward result, producing a genuine 5120-dim RSSM state with real stochastic uncertainty.
- **Fixed**: `feed()` handler brain access — used `getattr(agent, '_brain', None)` but `CapsuleAgent` has `self.brain` (no underscore). Always returned `None`, so `obs_buffer_size` was unreachable. Now uses the two-step unwrap pattern (`agent.brain` → `CapsuleBrain._brain` → `QuineOuroborosBrain`) matching the other MCP tool handlers.
- **Fixed**: `session_stats` handler same brain access bug as `feed()` — same fix applied.

## [0.7.12] - 2026-02-22

### DreamerV3 RSSM Integration — Live Neural Substrate

Seventeen edits across 5 phases wiring the DreamerV3 RSSM (Recurrent State-Space Model) into the live inference pipeline. The outer EmbeddedDreamerBrain — previously a dead stub returning random latents — now maintains real recurrent state, accumulates observations, trains via gradient-free evolution, and gates output through human oversight.

**Phase 0 — Wire Existing RSSM (7 edits)**
- **Fixed**: `forward()` now accepts the `'obs'` key passed by `_dreamer_simulate`, resolving a key mismatch that caused all observations to be silently dropped.
- **Fixed**: Ported `_ensure_rssm_initialized()` and `_update_rssm_state()` from the inner (working) EmbeddedDreamerBrain to the outer (broken) class. The RSSM GRU (4096 deter) and categorical posterior (32x32 stoch) now update on every forward pass.
- **Fixed**: `forward()` returns real RSSM latent state (5120-dim: 4096 deterministic + 1024 stochastic) instead of random noise.
- **Fixed**: `_embed_to_dreamer` projection changed from lossy `randn(384,64)` to identity-preserving `randn(384,384)` with seeded RNG (`RandomState(42)`).
- **Removed**: Dead `_dreamer_to_embed` reverse projection that was never called.
- **Updated**: Documentation at two locations to reference `_update_rssm_state()` instead of the non-existent methods.

**Phase 1 — Observation Accumulation (3 edits)**
- **Added**: `_obs_buffer` (deque, maxlen=1000) accumulates `(embedding, latent_state)` tuples between Stage 2 (dreamer simulate) and Stage 3 (scarecrow adapt). Provides training data for gradient-free evolution.
- **Added**: `_prev_embedding` tracks the last observation for HOLD divergence checking.
- **Added**: `obs_buffer_size` exposed in CASCADE `session_stats` and `feed()` return values for observability.

**Phase 2 — Scarecrow Full-Latent (3 edits)**
- **Fixed**: `_scarecrow_adapt` now receives the full 5120-dim RSSM latent via a seeded projection matrix (`RandomState(43).randn(5120,384) * 0.01`) instead of truncating to the first 384 elements and discarding 4736 dimensions.
- **Added**: 3-tier fallback in `_scarecrow_adapt` — full projection (>=5120), truncation (>=384), pad (else) — handles any latent size gracefully.
- **Added**: `uncertainty` field in scarecrow output computed from `np.std(latent[4096:5120])` — real stochastic uncertainty from the categorical posterior.

**Phase 3 — Gradient-Free Training (3 edits)**
- **Added**: `_train_step()` implements gradient-free evolutionary training. Samples 32 observation pairs from buffer, computes baseline prediction loss, perturbs LoRA weights with scaled noise, keeps perturbation if fitness improves. No backprop required — works with the existing all-zeros embryonic brain.
- **Added**: `_fitness` attribute dynamically updated and exposed via MCP `get_status` for live training observability.
- **Added**: Training triggers automatically every 32 accumulated observations, wrapped in try/except for pipeline safety.

**Phase 4 — HOLD Protocol Integration (3 edits)**
- **Added**: `_hold_threshold = 0.5` and `_imagined_trajectory` state for divergence-based human oversight gating.
- **Added**: Trajectory capture from `_dreamer_simulate` — stores latent state from both real RSSM and fallback paths.
- **Fixed**: `_hold_gate` (Stage 5) now computes MSE divergence between `_prev_embedding` and `_imagined_trajectory`. When divergence exceeds threshold, the gate yields to human oversight instead of blindly passing through. Previously was a no-op passthrough.

## [0.7.11] - 2026-02-22

### Pipeline Safety, Swarm Persistence & Council Mutation Fixes

Six fixes addressing the critical ouroboros inference pipeline crash, swarm lifecycle persistence, council slot management parity, and CASCADE identity accuracy.

- **Fixed**: Ouroboros 4-tier pipeline crash (B14, CRITICAL). `forward`, `infer`, and `deliberate` all crashed with "index out of range in self" because `_forward_with_internals` had no explicit `ouroboros` branch — the ouroboros brain type fell into the catch-all `else` with no error handling. Added dedicated `ouroboros` branch with try/except graceful fallback. Pipeline errors now return structured error output instead of crashing the MCP server.
- **Fixed**: `cascade_chain` genesis operation crash (B15). `verify_lineage_to_genesis()` was called with zero arguments but requires `(chain, known_chains)`. Replaced with safe genesis info response returning genesis root, capsule hash, generation, and lineage link status.
- **Fixed**: `spawn_swarm` → `orchestra` lifecycle (B16). The MCP `spawn_swarm` tool created the swarm but never stored it on `agent._swarm`. The `orchestra` tool then found no swarm. Added `agent._swarm = swarm` assignment in both the `spawn_swarm` and `replicate` fallback paths.
- **Fixed**: `clone_slot` / `cull_slot` parity (B17). The MCP `clone_slot` tool copied model references to empty council slots but never tracked them in `source._clones`. The `cull_slot` tool read `_clones` and always found it empty. Now initializes `_clones` list on source and appends target slot indices during cloning.
- **Fixed**: `mutate_slot` adapter resolution (B18). Checked `councilor.adapter` which doesn't exist on `QuineSlot` objects — always returned "no adapter to mutate". Now falls through to check brain-level adapter weights (`adapter_in`, `adapter_out`, `lora_A`, `lora_B`, etc.) on the inner `_brain` object when councilor-level adapter is absent.
- **Fixed**: CASCADE identity generation number (B19). `cascade_chain(operation='identity')` reported `generation: 0` because it read `_BRAIN_CONFIG.get('generation', 0)` — but `_BRAIN_CONFIG` has no `generation` key. Changed to read `_GENERATION` directly (value: 8).
- **Enhanced**: `bag_forget` now supports pattern-based bulk deletion via `pattern` parameter. Pass a prefix with trailing `*` (e.g., `"workflow_exec:*"`) to delete all matching items in one call. Returns count of deleted items. Works across all 5 parity points (MCP, SSE, TUI, FelixBag class, HTTP).

## [0.7.10] - 2026-02-22

### Agent Parity, SSE Resilience & Operational Hardening

Ten fixes addressing SSE connection stability, agent instruction parity with MCP clients, workflow schema documentation, and operational reliability across CASCADE, Hub, and metrics facilities.

- **Fixed**: SSE heartbeat no longer kills in-flight requests. Added `_pendingRequests.size === 0` guard — heartbeat timeout only fires when there is genuinely zero activity (no pending requests AND no SSE data for 60s). Previously, long model operations (>60s) triggered false disconnects that destroyed all pending requests.
- **Added**: Dynamic agent instruction parity (B13). `_execute_agent` now assembles context blocks scoped to each agent node's `granted_tools` — 8 categories (FelixBag, CASCADE, Inference, Council, Workflows, HuggingFace, Diagnostics, Status) plus slot identity. Plugged models receive the same operational understanding as external MCP clients, proportional to their granted capabilities.
- **Fixed**: Workflow schema documentation rewritten with correct node formats. Tool nodes use top-level `tool_name` (not inside parameters), if-nodes use `conditions` array with `then`/`else` and `branch` connections (not `condition`), fan_out uses top-level `targets` array.
- **Fixed**: Workflow engine version string `"2.1.0"` → `"2.2.0"` matching documentation.
- **Fixed**: `get_capabilities` manifest expanded from 13 to 28 capabilities, covering workflows, classify, rerank, generate, batch, CASCADE, diagnostics, and hub operations.
- **Fixed**: Slot pre-flight validation now uses per-slot `slot_info(slot)` calls instead of `list_slots` (whose truncated/cached output lost the `slots` array). Each referenced agent slot is checked individually — small response, no truncation risk.
- **Fixed**: CASCADE `identity` operation returns capsule-native data (quine hash, generation, brain type, integrity) instead of failing external import.
- **Fixed**: `classify` tool returns both `"output"` (canonical) and `"classification"` (legacy) keys for backward compatibility with existing workflows.
- **Fixed**: `hub_info` size calculation uses safetensors metadata first, then `files_metadata=True` fallback, resolving `size_mb: 0.0` bug.
- **Fixed**: `metrics_analyze` replaced broken CASCADE import with native IQR anomaly detection, category inference from metric names, and health classification (healthy/unstable/warning/critical).

## [0.7.9] - 2026-02-21

### Workflow Engine Hardening — Agent Node & Execution Reliability

Six targeted fixes to the workflow execution engine, addressing the critical agent node conversation format bug and adding timeout/validation infrastructure for production workflow pipelines.

- **Fixed**: Agent node conversation format — `_execute_agent` now builds structured message lists (`[{"role": "system", ...}, {"role": "user", ...}]`) instead of flat string concatenation. Models receive proper chat template formatting via `apply_chat_template`, producing correct `{"final_answer": ...}` responses instead of infinite tool-call loops.
- **Fixed**: `invoke_slot` now accepts a `messages` parameter for caller-provided structured conversations. When provided, messages are passed directly to `apply_chat_template` instead of wrapping text in a default system/user pair.
- **Fixed**: `invoke_slot` now accepts a `max_tokens` parameter, allowing agent nodes and workflows to control generation budget per invocation. Previously hardcoded to the model's default `max_gen_tokens`.
- **Fixed**: `classify` MCP tool return key changed from `"classification"` to `"output"`, matching the key used by all other tool handlers (`invoke_slot`, `generate`, `compare`). Downstream workflows and agent nodes that parse tool results by the `"output"` key now receive classify results correctly.
- **Fixed**: Bus call timeout increased from 30s to 120s (both MCP and TUI paths). Complex workflows with multiple model invocations no longer hit false timeout failures during legitimate long-running operations.
- **Added**: Slot pre-flight validation in `WorkflowExecutor`. Before DAG execution begins, agent nodes referencing empty slots are caught with a clear error message (`"Slot N is empty - plug a model before running this workflow"`) instead of failing deep in the execution stack.
- **Added**: Per-node timeout with `ThreadPoolExecutor`. Each workflow node can specify a `timeout` parameter (default 300s). Nodes that exceed their timeout are cleanly terminated with a `TimeoutError` that respects the node's `on_error` policy (retry/skip/fail). Previously, hung nodes blocked the entire workflow indefinitely.

## [0.7.8] - 2026-02-21

### Dynamic Model-Aware Token Budget

Replaced 41+ hardcoded token limit constants with live values read directly from each plugged model's config at connect time. No guesswork, no truncation heuristics — the model tells us its limits and we use them.

- **Added**: `_read_model_limits(model, tokenizer)` helper — extracts `max_position_embeddings`, `n_positions`, `max_sequence_length`, `model_max_length`, and `generation_config.max_new_tokens` from the model object at plug time. Reads only what the model actually reports.
- **Updated**: All wrapper classes (`LLMWrapper`, `Seq2SeqWrapper`, `VLMWrapper`, `ClassifierWrapper`, `GenericWrapper`) now store `self._limits` at `__init__` and use `_limits.get('context_length')` for tokenizer `max_length` and `_limits.get('max_gen_tokens')` for `max_new_tokens`. Hardcoded `4096`, `512`, `256`, `150`, `100` constants eliminated.
- **Updated**: `plug_model` (MCP tool + TUI command) now stores `c._limits` on each councilor after model attachment. Plug return JSON includes `"limits"` key with the resolved values.
- **Updated**: All MCP council operation handlers (`generate`, `chat`, `debate`, `invoke_slot`, `compare`, `broadcast`, `chain`, `pipe`, `consensus`) now read `_lim` from the councilor before calling the model, using actual context window and generation budget.
- **Updated**: All TUI commands (`chat`, `generate`, `pipe`, and interactive mode) use the same `_limits`-based budgets.
- **Updated**: `vast_generate` remote GPU script now reads `model.config.max_position_embeddings` and `generation_config.max_new_tokens` on the remote GPU before running inference.
- **Impact**: Models with small context windows (512, 1024) will no longer receive oversized inputs. Models with large context windows (32k, 128k) will no longer be artificially constrained to 256 tokens. Each model runs within the limits it actually supports.

### Embedder Wiring Fixes — Observation Layer Parity

Deep forensic audit identified and fixed a family of attribute name mismatches that caused the MCP observation layer to report incorrect embedder status while the system functioned correctly via fallback mechanisms.

- **Fixed**: `get_embedder_info` MCP tool now correctly reports the active embedding model. Previously returned `{"embedder": null}` due to checking the non-existent `bag._embedder` attribute instead of calling `bag.get_embedder_info()`.
- **Fixed**: `wire_bag_to_brain()` now checks `brain.embedding_foundation` (used by QuineOuroborosBrain) **before** falling back to `brain._embed_model` (used by CapsuleBrain). This eliminates the duplicate model loading (~130MB RAM saved) and establishes a proper shared embedder link.
- **Fixed**: `FelixBag._get_embedder()` step 2 resolution now prioritizes `brain_ref.embedding_foundation` over `brain_ref._embed_model`, matching the actual attribute name on Ouroboros brains.
- **Fixed**: NaN values in brain parameters sanitized at load time. `QuineOuroborosBrain.__init__()` now applies `np.nan_to_num()` to the decoded parameter array, cleaning ~6,140 NaN values (0.19%) from uninitialized council adapter slots. `show_weights` now reports `has_nan: false`.
- **Root Cause**: Three naming families for the embedding model (`brain.embedding_foundation`, `brain._embed_model`, `bag._embedder`) evolved independently across the codebase. The observation/reporting tools referenced the wrong family, creating a Kleene fixed-point divergence where the system state and observation state converged to different attractors.

## [0.7.7] - 2026-02-21

### Workflow Engine v2.2.0 — Agent Node Type

- **Added**: `agent` workflow node type — the 10th node type in the workflow engine. Plugged models now have direct, controlled access to MCP tools within workflow nodes.
- **Added**: `_execute_agent()` handler in `WorkflowExecutor`. A plugged model is given a task and a `granted_tools` whitelist, then operates those tools in a reasoning loop (ReAct-style: reason → call tool → observe result → repeat) until it produces a `final_answer` or hits `max_iterations`.
- **Added**: Per-node tool whitelisting. Each `agent` node declares exactly which MCP tools the model can access via `granted_tools`. The commanding agent (IDE, Claude, Cursor, etc.) controls all grants at workflow design time. Models cannot escape their sandbox.
- **Added**: Upstream context auto-injection. Previous node outputs flow automatically into the agent's task context, enabling multi-stage pipelines where each agent node builds on prior work.
- **Added**: Tool signature introspection in agent prompts. The model receives live-generated tool descriptions (name, parameter types, defaults, docstring) so it knows exactly how to call each granted tool.
- **Added**: Denied tool enforcement. If the model attempts to call a tool outside its `granted_tools` list, the call is blocked, the model is notified, and execution continues — no crash.
- **Added**: `agent_node_guide` document inducted into FelixBag at startup — full reference with schema, examples, and multi-stage pipeline pattern.
- **Updated**: All documentation surfaces updated to reflect v2.2.0 and 10 node types.
- **Fixed**: Pre-existing version drift across documentation — all surfaces now consistently report v2.2.0/10 node types.

## Prior Releases (0.1.0 – 0.7.6)

<details>
<summary>Click to expand full history</summary>

### 0.7.6 — Council Invocation Path Fixes
Full model type coverage across all 8 council invocation paths (debate, chain, broadcast, compare, pipe, all_slots). VLM processor stored on councilor. Council system prompt simplified.

### 0.7.5 — AI Onboarding
MCP `instructions` field at handshake. Council system prompt auto-injection across all 5 inference paths. Live snapshot in MCP instructions.

### 0.7.4 — Voice Processing, UX Engine, Brain Introspection
Voice sensitivity/noise gate wired to actual audio stream. Semantic color override fix. `show_dims`/`show_rssm` fixed. Classifier loader RoBERTa fix. Unplug state fix. Plug/unplug system overhaul. Smart loader expansion (classifier, VLM, SEQ2SEQ routes). Rerun conditional init. FelixBag persistence. TUI chat echo fix. Phantom plugging state fix.

### 0.7.2 — NIP UI Expansion
NIP-88 Polls, NIP-A0 Voice Messages, NIP-58 Badges, NIP-90 Data Vending Machines, NIP-39 External Identity, NIP-42 Relay Auth.

### 0.7.1 — Voice Audio Streaming
WebSocket + AudioWorklet PCM bridge. RTCRtpSender.replaceTrack(). Removed naudiodon dependency.

### 0.7.0 — P2P Voice Communications
NIP-53 voice rooms. PeerJS/WebRTC transport. 12 new Nostr NIP methods. Theme import. FelixBag auto-persistence. Cascade state backing. Git versioning. Publish-from-bag. Safety scan on publish.

### 0.6.x — Workflow Engine, Marathon Hardening, Diagnostics
Web search node type (v2.1.0). SSE heartbeat. Bounded resource caches. GitHub Gist marketplace. Workflow live execution tracing. Tools tab drill-down. Activity tab click-to-expand. Dynamic slot grid. 32-slot expansion.

### 0.5.x — Evaluation, Reputation, IPFS, Web3
ModelEvaluator. Merkle-linked reputation chains. Semantic marketplace search. IPFS pinning (Pinata, web3.storage). Web3 utilities (CID, DID:key, VCs). WebLN zaps.

### 0.4.x — Cache, Flowchart, Slots, Zaps, Diagnostics
Cache-aware tool calls. Flowchart zoom/pan. Slot state visuals. NIP-57 zap validation. Diagnostics compact view and fallback orchestration. Memory export formats.

### 0.3.x — Community, Activity Feed, Rerun, esbuild
esbuild bundling. Community tab. Activity feed external detection. Rerun process cleanup. Memory tab refresh.

### 0.2.0 — Rerun, FelixBag, Council Deliberation
Full Rerun integration. FelixBag semantic memory. Consensus and debate tools.

### 0.1.x — Initial Release
8-slot council. 140+ MCP tools. HuggingFace integration. Python process cleanup.

</details>
