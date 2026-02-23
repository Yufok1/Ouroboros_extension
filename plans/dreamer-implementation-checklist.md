# Dreamer Integration — Implementation Checklist (v2)

*Ordered edit-by-edit guide. **ZERO new MCP tools.** Config-driven. Follow the Codex for all agent_compiler.py edits.*

---

## PHASE 1: Config File + Extension UI Shell (No backend changes needed)

### 1.0 Create Default Config File
- [ ] Create `dreamer_config.json` with all default values
  - Location: `F:\End-Game\vscode-extension\` (alongside champion_gen8.py)
  - See: `dreamer-critic-and-reward-spec.md` Section 1.1

### 1.1 Sidebar Dreamer Widget
- [ ] **extension.ts** — Enable scripts: change `enableScripts: false` to `true`
- [ ] **extension.ts** — Add dreamer HTML section to sidebar `resolveWebviewView`
  - Location: After the existing MCP status section, before closing `</body>`
  - Add the `dreamer-section` div with value, fitness, buffer, rewards, imagination bars, buttons
  - See: `dreamer-extension-display-spec.md` Section 2.2

- [ ] **extension.ts** — Add `dreamerStatus` message handler in webview message switch
  - Calls EXISTING `get_status` tool, extracts `parsed.dreamer` section
  - See: `dreamer-extension-display-spec.md` Section 2.4

- [ ] **extension.ts** — Add `callTool` message handler bridge for webview tool calls

- [ ] **extension.ts** — Add `saveDreamerConfig` and `resetDreamerConfig` message handlers
  - Writes/deletes `dreamer_config.json` file
  - See: `dreamer-extension-display-spec.md` Section 4.3

- [ ] **extension.ts** — Add sidebar script with `updateDreamerDisplay()` and poll logic
  - Polls every 5s via `dreamerStatus` command
  - See: `dreamer-extension-display-spec.md` Section 2.3

### 1.2 Diagnostics Tab Enhancements
- [ ] **panel.ts** — Add DREAMER WORLD MODEL section header + IMAGINATION button
  - Location: After existing CASCADE LATTICE section
  - Only 2 buttons: "RSSM + DREAMER" (uses existing show_rssm) and "IMAGINATION" (uses existing imagine)
  - See: `dreamer-extension-display-spec.md` Section 3.1

- [ ] **panel.ts** — Add Dreamer Config collapsible section
  - All tunable parameters as form inputs with ranges
  - Save/Reset buttons
  - Architecture section read-only
  - See: `dreamer-extension-display-spec.md` Section 4.1

- [ ] **main.js** — Add `runImagination()` function
  - Location: After existing `runDiagnostic()` function
  - Calls EXISTING `imagine` tool
  - See: `dreamer-extension-display-spec.md` Section 3.2

- [ ] **main.js** — Add `renderImaginationResult()` renderer
  - Trajectory table with per-branch values, progress bars, sparklines
  - Route `imagine` results to custom renderer in `handleToolResult()`
  - See: `dreamer-extension-display-spec.md` Section 3.2

- [ ] **main.js** — Add config UI functions
  - `toggleDreamerConfig()`, `loadDreamerConfig()`, `renderDreamerConfig()`
  - `renderConfigSection()`, `updateConfigField()`, `saveDreamerConfig()`, `resetDreamerConfig()`
  - See: `dreamer-extension-display-spec.md` Section 4.2

### 1.3 Test Extension UI
- [ ] Verify sidebar renders with placeholder data (dreamer section shows dashes)
- [ ] Verify IMAGINATION button sends `imagine` tool call
- [ ] Verify config panel opens, renders form fields, saves/loads JSON
- [ ] Verify `npx tsc --noEmit` passes clean

---

## PHASE 2: Backend — Brain Internal Methods (NO new tools)

### 2.1 EmbeddedDreamerBrain Fixes

> **Use search patterns, not line numbers.** The file shifts during edits. Search for `class EmbeddedDreamerBrain` to find the class. There are TWO instances — target the FIRST one (full version with `imagine`), not the one inside `CapsuleBrain` factory.

- [ ] **agent_compiler.py** (L1) — Add `_get_latent_vector()` to EmbeddedDreamerBrain
  - Search: `class EmbeddedDreamerBrain` (first instance)
  - No braces — passes through unchanged
  - See: `dreamer-plan-errata.md` Issue 1

- [ ] **agent_compiler.py** (L1) — Add `self._last_imagination = []` to `__init__`
  - See: `dreamer-plan-errata.md` Issue 7

- [ ] **agent_compiler.py** (L1) — Replace `imagine()` with branching version + `_copy_nj_state()`
  - CRITICAL: Save/restore `_nj_state` per branch
  - See: `dreamer-plan-errata.md` Issue 4

### 2.1b LoRA Accessor Wiring Fix (3 locations)

- [ ] **agent_compiler.py** (L1) — Fix `show_lora` to check `brain.dreamer_world_model` for LoRA attributes
  - Add `lora_source` fallback pattern before the `hasattr(brain, 'lora_rank')` check
  - See: `dreamer-plan-errata.md` Issue 18a

- [ ] **agent_compiler.py** (L1) — Fix `show_weights` to check `dreamer_world_model` for `lora_A`/`lora_B`
  - Same fallback pattern
  - See: `dreamer-plan-errata.md` Issue 18b

- [ ] **agent_compiler.py** (L1) — Fix `mutate_slot` brain-level path to check `dreamer_world_model`
  - Add dreamer fallback after `inner_brain` resolution
  - See: `dreamer-plan-errata.md` Issue 18c

### 2.2 Config File Reader
- [ ] **agent_compiler.py** (L1) — Add `_DREAMER_CONFIG_DEFAULTS` dict
  - Location: Near top of QuineOuroborosBrain class or module-level
  - **CODEX ALERT:** Every `{` in the dict literal becomes `{{`
  - See: `dreamer-critic-and-reward-spec.md` Section 1.1

- [ ] **agent_compiler.py** (L1) — Add `_load_dreamer_config()`, `_get_reward_weight()`, `_get_training_param()` methods
  - Location: In QuineOuroborosBrain class
  - See: `dreamer-critic-and-reward-spec.md` Section 1.2

### 2.3 Reward Signal Capture
- [ ] **agent_compiler.py** (L1) — Add `RewardEvent` dataclass
  - Location: Near existing obs_buffer code
  - **CODEX ALERT:** Double all braces in `to_dict()` return
  - See: `dreamer-critic-and-reward-spec.md` Section 1.3

- [ ] **agent_compiler.py** (L1) — Add `_reward_buffer` + init code to `__init__`
  - Reads buffer max from config
  - See: `dreamer-critic-and-reward-spec.md` Section 1.4

- [ ] **agent_compiler.py** (L1) — Add `_capture_reward()` method
  - Takes `source_key` (config key), NOT raw reward value
  - Reads weight from config, applies normalization if enabled
  - Auto-triggers critic training
  - See: `dreamer-critic-and-reward-spec.md` Section 1.5

### 2.4 Reward Hook Points
- [ ] **agent_compiler.py** (L1) — Hook into `logged_tool()` wrapper for tool success/failure
  - Uses `source_key='tool_success'` and `source_key='tool_error'`
  - Per errata Issue 2: use `get_agent()` unwrap pattern, NOT `_bus_call`
  - See: `dreamer-critic-and-reward-spec.md` Section 1.6.1

- [ ] **agent_compiler.py** (L1) — Hook into HOLD `yield_point` for accept/override
  - Uses `source_key='hold_accept'` and `source_key='hold_override'`
  - Per errata Issue 5: add `_brain_ref` to `_HoldState`, inject before line 1084
  - **Per errata Issue 20:** Use local `result` variable, NOT `self.resolution` (None on timeout)
  - See: `dreamer-critic-and-reward-spec.md` Section 1.6.2

- [ ] **agent_compiler.py** (L1) — Hook into `bag_put`/`bag_induct` and `bag_forget`
  - Uses `source_key='bag_induct'` and `source_key='bag_forget'`
  - See: `dreamer-critic-and-reward-spec.md` Section 1.6.3

- [ ] **agent_compiler.py** (L1) — Hook into WorkflowExecutor completion
  - Uses `source_key='workflow_success'` and `source_key='workflow_failure'`
  - See: `dreamer-critic-and-reward-spec.md` Section 1.6.4

- [ ] **agent_compiler.py** (L1) — Hook into `workflow_create` tool handler (not `workflow_save` — that tool doesn't exist)
  - Uses `source_key='workflow_save'` (config key name is fine, just the hook target changes)
  - See: `dreamer-critic-and-reward-spec.md` Section 1.6.5, errata Issue 23

### 2.5 Compile & Test
- [ ] `python -m py_compile agent_compiler.py`
- [ ] Generate new champion: `python agent_compiler.py`
- [ ] `python -m py_compile champion_gen8.py`
- [ ] Start MCP server, verify no crashes
- [ ] Call a few tools, verify no errors (rewards captured silently)

---

## PHASE 3: Backend — Critic Head + Training Upgrade (NO new tools)

### 3.1 Head Classes
- [ ] **dreamer_brain.py** — Add CriticHead class (standalone file, L0)
- [ ] **dreamer_brain.py** — Add RewardHead class (L0)
- [ ] **dreamer_brain.py** — Add ContinueHead class (L0)
- [ ] **agent_compiler.py** (L1) — Add all three classes in Level 1 template
  - Location: Near EmbeddedDreamerBrain class
  - **CODEX ALERT:** Double all braces in class bodies

### 3.2 Critic Integration
- [ ] **agent_compiler.py** (L1) — Add `_critic`, `_reward_head`, `_continue_head` to `__init__`
  - Dims from config: `arch['critic_hidden_dim']`, etc.
  - See: `dreamer-critic-and-reward-spec.md` Section 2.2

- [ ] **agent_compiler.py** (L1) — Wire critic into forward pass
  - After _dreamer_simulate, compute and store critic value
  - See: `dreamer-critic-and-reward-spec.md` Section 2.2

- [ ] **agent_compiler.py** (L1) — Add `_train_critic()` method
  - All params from config (batch_size, gamma, noise_scale)
  - See: `dreamer-critic-and-reward-spec.md` Section 2.3

### 3.3 Training Loop Upgrade
- [ ] **agent_compiler.py** (L1) — Replace `_train_step()` with 4-phase version
  - Phase 1: World model (keep existing)
  - Phase 2: Imagination rollout with reward prediction + critic values
  - Phase 3: Critic update
  - Phase 4: Actor update via imagination-based advantage
  - All params from config, timeout budget enforced
  - See: `dreamer-critic-and-reward-spec.md` Part 4

- [ ] **agent_compiler.py** (L1) — Add lambda-return computation
  - gamma and lambda from config
  - See: Master Plan Section 5.2

### 3.4 Serialization
- [ ] **agent_compiler.py** (L1) — Add critic/reward/continue heads to `to_full_dict()`
  - Use base64+gzip (same as nj_state)
  - See: `dreamer-critic-and-reward-spec.md` Part 6

- [ ] **agent_compiler.py** (L1) — Add head restore to `from_full_dict()`
  - See: `dreamer-critic-and-reward-spec.md` Part 6

### 3.5 Compile & Test
- [ ] `python -m py_compile agent_compiler.py`
- [ ] Generate new champion
- [ ] `python -m py_compile champion_gen8.py`
- [ ] Start MCP, call tools for a few minutes
- [ ] Verify no crashes, training runs silently in background

---

## PHASE 4: Enrich Existing Tool Responses (NO new tools)

> **IMPORTANT — Proxy vs Normal Mode:** There are TWO `get_status` implementations in agent_compiler.py. Only enrich the **normal mode** version (search for `get_status` that calls `_get_capsule()` or `get_agent()`, NOT the one reading `state_file`). Same applies to `show_rssm` and `imagine`. See Errata Issue 16.
>
> **NOTE on stale champion:** The workspace champion_gen8.py may not have `show_rssm` or `imagine` tools if it was compiled before they were added. Ensure Phase 2.5 generates a fresh champion. See Errata Issue 17.

### 4.1 Enrich `get_status`
- [ ] **agent_compiler.py** (L1) — Add `dreamer` section to NORMAL MODE get_status return JSON
  - Search pattern: `def get_status()` that contains `_get_capsule()` or `get_agent()`
  - Fields: active, fitness, critic_value, reward_count, training_cycles, buffer sizes, reward_rate, last_imagination summary, last_train stats
  - **CODEX ALERT:** Heavy dict literal section — double ALL braces
  - See: `dreamer-critic-and-reward-spec.md` Part 5.1

### 4.2 Enrich `show_rssm`
- [ ] **agent_compiler.py** (L1) — Add `dreamer` section to show_rssm return JSON
  - Fields: critic (value, target, params, history), rewards (total, breakdown, recent events), training stats, full config dump
  - **CODEX ALERT:** Heavy dict literal section — double ALL braces
  - See: `dreamer-critic-and-reward-spec.md` Part 5.2

### 4.3 Enrich `imagine`
- [ ] **agent_compiler.py** (L1) — Add critic values + reward predictions to imagine output
  - Per-branch, per-step critic_value and pred_reward fields
  - See: `dreamer-critic-and-reward-spec.md` Part 5.3

### 4.4 Compile & Test
- [ ] `python -m py_compile agent_compiler.py`
- [ ] Generate new champion
- [ ] `python -m py_compile champion_gen8.py`
- [ ] Start MCP, call `get_status` → verify `dreamer` section in JSON
- [ ] Call `show_rssm` → verify critic, rewards, training, config sections
- [ ] Call `imagine` → verify per-branch critic values

---

## PHASE 5: Wire Extension to Real Data

### 5.1 Sidebar
- [ ] **extension.ts** — Verify `get_status` poll returns real dreamer data
- [ ] Verify value bar animates on state change
- [ ] Verify imagination bars update after imagine call
- [ ] Verify reward count/rate update as tools are called

### 5.2 Diagnostics
- [ ] Verify "RSSM + DREAMER" button shows enriched response with critic/rewards/training
- [ ] Verify IMAGINATION button renders trajectory table with sparklines

### 5.3 Config
- [ ] Verify config panel loads current values from `show_rssm` enriched response
- [ ] Verify saving config writes `dreamer_config.json`
- [ ] Verify brain picks up config changes (call `show_rssm` again, check config section)
- [ ] Verify changing reward weight affects next reward capture value

---

## PHASE 6: Final Compile & Package

- [ ] **agent_compiler.py** — Full compile: `python agent_compiler.py`
- [ ] **champion_gen8.py** — Verify quine: `python champion_gen8.py --verify-quine`
- [ ] Start MCP server, full smoke test of enriched tools
- [ ] Build extension: `npm run compile` (or equivalent)
- [ ] Package: `vsce package`
- [ ] Install and test in clean VSCode window
- [ ] Update CHANGELOG.md
- [ ] Update version in package.json to 0.8.0
- [ ] Git commit

---

## QUICK REFERENCE: Level 1 Escaping Patterns Needed

| Champion Output | Write in agent_compiler.py |
|----------------|---------------------------|
| `self._reward_buffer = collections.deque(maxlen=5000)` | `self._reward_buffer = collections.deque(maxlen=5000)` (no braces) |
| `{'tool': tool_name, 'status': 'success'}` | `{{'tool': tool_name, 'status': 'success'}}` |
| `result = {"error": "not available"}` | `result = {{"error": "not available"}}` |
| `f"Rewards: {count}"` | `f"Rewards: {{count}}"` |
| `json.dumps({"key": val})` | `json.dumps({{"key": val}})` |
| `def to_dict(self):` | `def to_dict(self):` (no braces) |
| `return {'value': v}` | `return {{'value': v}}` |
| `{k: v for k, v in d.items()}` | `{{k: v for k, v in d.items()}}` |
| `_DREAMER_CONFIG_DEFAULTS = {...}` | `_DREAMER_CONFIG_DEFAULTS = {{...}}` |

**Rule of thumb:** If the line contains `{` that should appear in champion output, double it. If the line has no braces, it passes through unchanged.

---

## TOTAL EDIT COUNT

| File | Edits | Type |
|------|-------|------|
| extension.ts | 5 | TypeScript (sidebar HTML, message handlers, polling, config file I/O) |
| panel.ts | 2 | HTML (IMAGINATION button, config section) |
| main.js | 5 | JavaScript (imagination handler, renderer, config UI, routing) |
| dreamer_brain.py | 3 | Python L0 (CriticHead, RewardHead, ContinueHead) |
| agent_compiler.py | ~17 | Python L1 (brain methods, hooks, enriched responses, config, serialization) |
| dreamer_config.json | 1 | JSON (default config file) |
| **TOTAL** | **~33 edits** | |

**MCP tools added: 0**
**MCP tools enriched: 3** (`get_status`, `show_rssm`, `imagine`)

---

*The Codex applies to every agent_compiler.py edit. Read 50 lines of context. Count your braces. Test after every edit.*
