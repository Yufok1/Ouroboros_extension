# Dreamer Integration Master Plan (v2)
## World Model Training Pipeline, Critic Head, Reward Capture, and Extension Display

*Revised 2026-02-23. **ZERO new MCP tools.** Config-driven architecture. All dreamer data exposed through enriched existing tools + config file.*

---

## 0. EXECUTIVE SUMMARY

The DreamerV3 RSSM architecture is in place (4096 deter + 32x32 stoch = 5120 latent). The observe/imagine mechanics work. What's missing:

1. **Reward signal capture** — turning concrete actions into scalar rewards (configurable weights)
2. **Critic head** — small MLP (5120->256->256->1, ~1.4M params) estimating latent state value
3. **Actor training via imagination** — replacing random perturbation with REINFORCE on imagined trajectories
4. **World model training** — proper prediction + KL losses instead of MSE-only
5. **Extension display** — config UI + live telemetry in sidebar and control panel

The cascade-lattice observation infrastructure already captures everything needed. The HOLD protocol already pauses at decision boundaries. We're wiring, not building.

### KEY DESIGN CONSTRAINT: ZERO NEW MCP TOOLS

Adding an MCP tool to agent_compiler.py involves registration, compilation, testing, and the full quine regeneration pipeline. This is a massive process. Instead:

- **Enrich existing tool responses** — `get_status`, `show_rssm`, `imagine` already exist. Add dreamer fields to their JSON output.
- **Config file** — `dreamer_config.json` lives alongside the champion. Brain reads it. Extension writes it. No MCP roundtrip for config changes.
- **Internal-only methods** — All training logic, reward capture, critic, etc. are internal brain methods. They run automatically. No manual trigger tools needed.

---

## 1. WHAT EXISTS TODAY (Inventory)

### 1.1 Dreamer Brain (dreamer_brain.py / champion_gen8.py)

| Component | Status | Location |
|-----------|--------|----------|
| RSSM (DeepMind DreamerV3) | Working | dreamer_brain.py:190-241 / champion L5079-5127 |
| RSSM.observe() | Working | dreamer_brain.py:344-393 / champion L5161-5194 |
| RSSM.imagine() | Working | dreamer_brain.py:671-778 / champion L5226-5308 |
| LoRA actor (A, B, bias) | Working | dreamer_brain.py:276-294 / champion L5057-5078 |
| Latent state (deter + stoch) | Working | 5120 dims, properly maintained |
| Experience buffer | Working | 1000-item deque of (emb_t, action_t, emb_next) |
| Training (_train_step) | **Misaligned** | Gradient-free perturbation on MSE prediction loss |
| Reward head | **Missing** | Not implemented |
| Continue head | **Missing** | Not implemented |
| Critic head | **Missing** | Not implemented |
| Decoder | **Missing** | Not implemented (optional — see Section 4) |
| Serialization | Working | Full nj_state with gzip+base64, pickle-free |

### 1.2 Existing MCP Tools We Will Enrich

> **NOTE:** Each of these tools has TWO implementations in agent_compiler.py: proxy mode (TUI, reads state file) and normal mode (MCP server, live brain access). Only the normal mode versions are enriched. The extension uses normal mode. See Errata Issue 16.

| Tool | Current Output | Will Add |
|------|---------------|----------|
| `get_status` | slots, bag, interfaces, brain state | + dreamer section (critic value, fitness, reward stats, training cycles, imagination summary) |
| `show_rssm` | RSSM dims, deter/stoch norms | + critic value, value history, reward buffer stats, training loss, full config dump |
| `imagine` | Single flat trajectory | Branching per-action trajectories + critic values per branch + reward predictions |

### 1.3 Extension UI

| Component | Status | Location |
|-----------|--------|----------|
| Sidebar panel | Working | extension.ts:564-608, shows MCP status snapshot |
| Control panel (8 tabs) | Working | panel.ts, main.js |
| Overview tab | Working | Shows static dreamer tier text |
| Diagnostics tab | Working | show_rssm, show_dims, show_lora buttons |
| Workflows tab | Working | SVG flow chart + execution panel |
| Activity tab | Working | Tool call event stream |
| Message bridge (webview <-> extension) | Working | postMessage / onDidReceiveMessage |
| MCP tool calling from webview | Working | callTool command type |

---

## 2. THE FIVE INTEGRATION TRACKS

### Track A: Reward Signal Capture (internal methods, config-driven weights)
### Track B: Critic Head Implementation (internal class + methods)
### Track C: Actor-Critic Training Loop (internal, auto-triggered)
### Track D: World Model Training Improvements (internal heads)
### Track E: Extension Display + Config UI

Each track is detailed in its own section below. Tracks A-D require agent_compiler.py edits (Level 1 template changes, **enriching existing code only**). Track E is primarily extension-side (TypeScript + HTML/JS).

---

## 3. TRACK A: REWARD SIGNAL CAPTURE

### 3.1 Philosophy

The reward signal is simple: **every concrete action by any agent through the MCP system is a reward event**. You saving a workflow = positive. You rejecting output = negative. An agent completing a tool call successfully = small positive.

**All reward weights are configurable** via `dreamer_config.json`. No hardcoded values.

### 3.2 Reward Event Sources

| Source | Event | Default Weight | Config Key |
|--------|-------|---------------|------------|
| HOLD resolve: accept | Human/agent accepted AI choice | +1.0 | `rewards.hold_accept` |
| HOLD resolve: override | Human/agent overrode AI choice | -0.5 | `rewards.hold_override` |
| bag_put / bag_induct | Something worth remembering | +0.8 | `rewards.bag_induct` |
| bag_forget | Something worth forgetting | -0.3 | `rewards.bag_forget` |
| workflow_save | Workflow committed to concrete form | +1.0 | `rewards.workflow_save` |
| workflow_execute: success | Automation completed | +0.5 | `rewards.workflow_success` |
| workflow_execute: failure | Automation failed | -0.5 | `rewards.workflow_failure` |
| tool call: success | Any MCP tool returned result | +0.1 | `rewards.tool_success` |
| tool call: error | Any MCP tool threw error | -0.2 | `rewards.tool_error` |
| mutate_slot: kept | Mutation improved fitness | +0.3 | `rewards.mutation_kept` |
| mutate_slot: reverted | Mutation worsened fitness | -0.1 | `rewards.mutation_reverted` |

### 3.3 Config File: `dreamer_config.json`

Lives at the same directory as the running champion (or a configurable path). Brain reads on startup and re-reads periodically (every 60s or on `show_rssm` call).

```json
{
  "rewards": {
    "hold_accept": 1.0,
    "hold_override": -0.5,
    "bag_induct": 0.8,
    "bag_forget": -0.3,
    "workflow_save": 1.0,
    "workflow_success": 0.5,
    "workflow_failure": -0.5,
    "tool_success": 0.1,
    "tool_error": -0.2,
    "mutation_kept": 0.3,
    "mutation_reverted": -0.1,
    "normalize": true
  },
  "training": {
    "enabled": true,
    "auto_train": true,
    "world_model_frequency": 32,
    "critic_frequency": 32,
    "full_cycle_frequency": 64,
    "batch_size": 32,
    "noise_scale": 0.005,
    "gamma": 0.99,
    "lambda": 0.95,
    "critic_target_tau": 0.02,
    "timeout_budget_seconds": 30
  },
  "imagination": {
    "horizon": 15,
    "n_actions": 8,
    "auto_imagine_on_train": true
  },
  "buffers": {
    "reward_buffer_max": 5000,
    "obs_buffer_max": 1000,
    "value_history_max": 200,
    "reward_rate_window": 100
  },
  "architecture": {
    "critic_hidden_dim": 256,
    "reward_head_hidden_dim": 128,
    "continue_head_hidden_dim": 64,
    "latent_dim": 5120
  }
}
```

**Architecture section is read-only after first initialization** — changing dims after weights exist would require reinit. Extension UI shows these as disabled/locked fields.

### 3.4 Implementation: RewardBuffer

A new internal structure alongside the existing `_obs_buffer`:

```python
class RewardEvent:
    timestamp: float
    reward: float           # scalar reward value (after config weight applied)
    raw_reward: float       # weight from config before normalization
    source: str             # 'hold', 'bag', 'workflow', 'tool', 'mutation'
    event_id: str           # links to CausationGraph event_id
    latent: np.ndarray      # 5120-dim dreamer latent at capture time
    action: int             # action index (0-7) if applicable
    context_hash: str       # SHA256 of surrounding context for dedup
    metadata: dict          # source-specific details
```

Storage: Rolling deque (maxlen from config, default 5000).

### 3.5 Files to Edit

| File | What | Level |
|------|------|-------|
| agent_compiler.py | Add RewardEvent class in Level 1 template | L1 |
| agent_compiler.py | Add reward hooks in `logged_tool()` wrapper, HOLD resolve, FelixBag.induct/forget | L1 |
| agent_compiler.py | Add reward_buffer to QuineOuroborosBrain.__init__ | L1 |
| agent_compiler.py | Add config file reader (`_load_dreamer_config()`) | L1 |
| agent_compiler.py | Wire reward events to dreamer training | L1 |

### 3.6 NO New MCP Tools

~~`dreamer_rewards`~~ — Reward data is included in enriched `show_rssm` response.
~~`dreamer_reward_manual`~~ — Manual rewards can be added later if needed; not in v0.8.0 scope.

---

## 4. TRACK B: CRITIC HEAD IMPLEMENTATION

### 4.1 Architecture

The critic is a small MLP that maps latent state to a value estimate.

```
latent (5120) -> Linear(5120, hidden_dim) -> SiLU -> Linear(hidden_dim, hidden_dim) -> SiLU -> Linear(hidden_dim, 1) -> scalar value
```

`hidden_dim` comes from config (default 256). ~1.4M parameters. Stored as numpy arrays like the LoRA actor.

### 4.2 Implementation

Internal class `CriticHead` added to the Level 1 template. No MCP tools — critic value is exposed through:

- **`get_status`** — adds `dreamer.critic_value` field
- **`show_rssm`** — adds full critic section (value, target value, training count, value history)
- **`imagine`** — adds critic value per branch in the trajectory output

### 4.3 Critic Training

On every N reward events (N from config, default 32):
1. Sample batch from reward buffer
2. Compute TD target: `r + gamma * critic_target(next_state)`
3. Perturb critic weights, keep if TD error improved
4. Soft-update target network (EMA)

All parameters (gamma, noise_scale, target_tau) from config.

### 4.4 Serialization

Add critic weights to `to_full_dict()` / `from_full_dict()`. Use base64+gzip (same as nj_state).

### 4.5 Files to Edit

| File | What | Level |
|------|------|-------|
| dreamer_brain.py | Add CriticHead class (standalone, L0) | L0 |
| agent_compiler.py | Add CriticHead class in Level 1 template | L1 |
| agent_compiler.py | Add critic to serialization | L1 |
| agent_compiler.py | Enrich `get_status` with dreamer section | L1 |
| agent_compiler.py | Enrich `show_rssm` with critic + training stats | L1 |

### 4.6 NO New MCP Tools

~~`dreamer_value`~~ — Value is in `show_rssm` response.
~~`dreamer_value_history`~~ — History is in `show_rssm` response.

---

## 5. TRACK C: ACTOR-CRITIC TRAINING LOOP

### 5.1 Current vs Target

**Current _train_step():**
```
Sample 32 (emb_t, action_t, emb_next) transitions
Compute MSE prediction loss
Perturb LoRA randomly
Keep perturbation if MSE improved
```

**Target _train_step():**
```
Phase 1: World Model Update
  Sample batch_size transitions (batch_size from config)
  Compute prediction loss
  Perturb RSSM LoRA, keep if prediction improved

Phase 2: Imagination Rollout
  From sampled states, imagine horizon steps each (horizon from config)
  At each step: actor proposes action, RSSM transitions, critic estimates value
  Compute lambda-returns (gamma, lambda from config)

Phase 3: Critic Update
  Compute TD targets from imagination rollouts
  Perturb critic (noise_scale from config), keep if value prediction improved

Phase 4: Actor Update
  Compute advantages (lambda-return - critic value)
  Perturb actor LoRA, keep if advantage-weighted score improved
```

### 5.2 Training Frequency (All from Config)

| Event | Training Action | Config Key |
|-------|----------------|------------|
| Every N observations | World model update (Phase 1) | `training.world_model_frequency` |
| Every M reward events | Critic update (Phase 3) | `training.critic_frequency` |
| Every P observations | Full 4-phase cycle | `training.full_cycle_frequency` |
| Auto-train toggle | Enable/disable all auto-training | `training.auto_train` |

### 5.3 Files to Edit

| File | What | Level |
|------|------|-------|
| dreamer_brain.py | Rewrite _train_step() with 4-phase loop | L0 |
| agent_compiler.py | Mirror new _train_step() in Level 1 | L1 |
| agent_compiler.py | Add lambda-return computation | L1 |
| agent_compiler.py | Add imagination-based actor training | L1 |

### 5.4 NO New MCP Tools

~~`dreamer_train`~~ — Training is automatic. Extension can toggle `training.auto_train` in config file.
~~`dreamer_training_stats`~~ — Stats are in enriched `show_rssm` response.

---

## 6. TRACK D: WORLD MODEL TRAINING IMPROVEMENTS

### 6.1 What's Optional

The decoder and full KL-divergence training from DreamerV3 are **optional**. The prediction loss on next-embedding already provides similar signal.

### 6.2 What IS Needed

| Improvement | Priority | Config Key |
|-------------|----------|------------|
| Reward prediction head | HIGH | `architecture.reward_head_hidden_dim` |
| Continue prediction head | MEDIUM | `architecture.continue_head_hidden_dim` |
| Symlog on observations | LOW | `rewards.normalize` |

### 6.3 Files to Edit

| File | What | Level |
|------|------|-------|
| dreamer_brain.py | Add reward_head and continue_head | L0 |
| agent_compiler.py | Mirror heads in Level 1 template | L1 |
| agent_compiler.py | Add head training to _train_step | L1 |

---

## 7. TRACK E: EXTENSION DISPLAY + CONFIG UI

### 7.1 Sidebar: Dreamer Pulse Widget

Compact at-a-glance widget in sidebar bottom half. Polls `get_status` (enriched) every 5 seconds. Shows:
- Critic value + trend arrow
- Fitness
- Buffer fill levels
- Reward count + rate
- Last imagination action values (mini bars)
- Training cycle count + last result
- [Imagine] [Train] buttons

### 7.2 Control Panel: Dreamer Tab (NEW)

A dedicated section in the Diagnostics tab (or a new sub-section) with:

**Config Editor** — All `dreamer_config.json` fields as form inputs:
- Reward weights: number inputs with labels
- Training params: sliders for gamma/lambda, number inputs for frequencies
- Imagination: horizon slider, n_actions dropdown
- Buffer sizes: number inputs
- Architecture: read-only display (locked after init)
- [Save Config] [Reset Defaults] buttons

**Live Telemetry** — Read-only dashboard:
- Critic value sparkline (from `show_rssm` enriched response)
- Reward event log (from `show_rssm`)
- Training loss trend
- Imagination trajectory visualization (from `imagine`)

### 7.3 How Config Updates Work

1. User changes a value in the Dreamer config panel
2. Extension reads current `dreamer_config.json`, updates the field, writes it back
3. Brain re-reads config on next `show_rssm` call (or periodic timer)
4. No MCP roundtrip needed — it's just a file read/write

**Config file location:** Extension discovers it from MCP connection (brain reports its working directory in `get_status`). Or hardcode to same directory as champion.

### 7.4 Diagnostics Tab Enhancements

Add buttons that call EXISTING tools:

| Button | Existing Tool | What It Shows |
|--------|--------------|--------------|
| RSSM (existing) | `show_rssm` | Now enriched with critic + training + rewards |
| IMAGINATION | `imagine` | Branching trajectory visualization with critic values |
| STATUS (existing) | `get_status` | Now enriched with dreamer summary |

### 7.5 Files to Edit

| File | What |
|------|------|
| `src/extension.ts` | Add dreamer section to sidebar HTML |
| `src/extension.ts` | Modify polling to use `get_status` (already exists, just parse dreamer fields) |
| `src/webview/panel.ts` | Add Dreamer config section to diagnostics area |
| `media/main.js` | Add config form handlers, save/load logic |
| `media/main.js` | Add imagination trajectory renderer |
| `media/main.js` | Parse enriched `show_rssm` response for dreamer telemetry |

---

## 8. IMPLEMENTATION ORDER

### Phase 1: Config File + Extension UI Shell

**Goal:** Config file format defined, extension can read/write it, UI renders form fields.

1. **Define `dreamer_config.json`** — Create default config file
2. **extension.ts** — Add dreamer sidebar section (placeholder data)
3. **panel.ts** — Add Dreamer config section with form inputs
4. **main.js** — Config read/write through extension file system APIs
5. Test: config UI renders, saves, and loads correctly

### Phase 2: Backend Brain Methods (Internal Only)

**Goal:** Add dreamer internals to the brain without touching tool registration.

6. **agent_compiler.py** (L1) — Add `_get_latent_vector()` to EmbeddedDreamerBrain
7. **agent_compiler.py** (L1) — Add `_last_imagination` init + branching `imagine()` with `_copy_nj_state()`
8. **agent_compiler.py** (L1) — Add `_load_dreamer_config()` method (reads config JSON)
9. **agent_compiler.py** (L1) — Add `RewardEvent` class + `_reward_buffer` + `_capture_reward()`
10. **agent_compiler.py** (L1) — Hook reward capture into `logged_tool()` wrapper
11. **agent_compiler.py** (L1) — Hook reward capture into HOLD resolve, bag induct/forget, workflow
12. py_compile + generate champion + py_compile champion

### Phase 3: Critic Head + Training Upgrade

**Goal:** Critic estimates value, training loop uses imagination.

13. **dreamer_brain.py** — Add CriticHead, RewardHead, ContinueHead classes (L0)
14. **agent_compiler.py** (L1) — Mirror all three heads in Level 1 template
15. **agent_compiler.py** (L1) — Add `_critic` + `_train_critic()` + training trigger wiring
16. **agent_compiler.py** (L1) — Replace `_train_step()` with 4-phase version
17. **agent_compiler.py** (L1) — Add lambda-return computation
18. **agent_compiler.py** (L1) — Add serialization for critic/reward/continue heads
19. py_compile + generate champion + py_compile champion

### Phase 4: Enrich Existing Tool Responses

**Goal:** Dreamer data flows through existing MCP tools.

20. **agent_compiler.py** (L1) — Enrich `get_status` with dreamer summary section
21. **agent_compiler.py** (L1) — Enrich `show_rssm` with critic, training, reward stats, config dump
22. **agent_compiler.py** (L1) — Enrich `imagine` with per-branch critic values + reward predictions
23. py_compile + generate champion + py_compile champion

### Phase 5: Wire Extension to Real Data

**Goal:** Extension parses enriched responses and displays live data.

24. **extension.ts** — Parse `get_status` dreamer fields for sidebar
25. **main.js** — Parse enriched `show_rssm` for telemetry dashboard
26. **main.js** — Render imagination trajectories with critic value bars
27. **panel.ts/main.js** — Config UI reads current config from `show_rssm` enriched response
28. Test full loop: change config -> brain picks it up -> behavior changes -> telemetry reflects it

### Phase 6: Final Compile & Package

29. Full compile via agent_compiler.py
30. Verify quine hash
31. Smoke test all enriched tool responses
32. Build extension (`npm run compile`)
33. Package (`vsce package`)
34. Install and test in clean VSCode window
35. Update CHANGELOG.md, version in package.json
36. Git commit

---

## 9. DEPENDENCY MAP

```
Phase 1 (Config + UI Shell) ──→ Independent, start first
                                    │
Phase 2 (Brain internals)    ──→ Needs config file format from Phase 1
                                    │
Phase 3 (Critic + Training)  ──→ Needs Phase 2 (reward buffer, imagine branching)
                                    │
Phase 4 (Enrich tools)       ──→ Needs Phase 3 (critic values to expose)
                                    │
Phase 5 (Wire display)       ──→ Needs Phase 4 (enriched responses to parse)
                                    │
Phase 6 (Package)            ──→ Needs everything
```

Phase 1 is fully independent. Start there.

---

## 10. RISK ASSESSMENT

| Risk | Impact | Mitigation |
|------|--------|------------|
| Quine brace corruption during L1 edits | HIGH | Follow Codex strictly, test py_compile after every edit |
| RSSM NaN during training | MEDIUM | Clamp values, NaN sanitization already in place |
| Reward signal too sparse | MEDIUM | Start with config defaults, user can tune via UI |
| Config file not found | LOW | Brain uses hardcoded defaults, logs warning |
| SSE heartbeat kills long training | HIGH | Timeout budget from config (default 30s) |
| Serialization size explosion (critic weights) | LOW | base64+gzip, ~1.2MB compressed |
| Enriched tool responses break existing consumers | MEDIUM | Add dreamer data as new top-level key, don't modify existing fields |

---

## 11. SUCCESS CRITERIA

When this is done:

1. Every MCP action generates a reward signal (visible in enriched `show_rssm`)
2. The dreamer's critic produces meaningful value estimates (not flat zeros)
3. Imagination trajectories show differentiated values across action branches
4. The actor starts preferring actions that historically led to positive rewards
5. The sidebar shows live dreamer state via polling `get_status`
6. The control panel config UI lets you tune every parameter without touching code
7. The whole thing trains naturally just from using the extension
8. **ZERO new MCP tools were added**

---

*This plan integrates with the Evolutionary Workflow Ecosystems plan (same folder). The dreamer's value estimates become fitness signals for evolutionary selection. The evolutionary workflows produce training data for the dreamer. They feed each other.*
