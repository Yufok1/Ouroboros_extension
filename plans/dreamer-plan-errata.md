# Dreamer Plan Errata — Corrections & Fixes (v3)

*Audit findings from code verification. Updated for v2 plan (zero new tools, config-driven). Apply these corrections during implementation.*

---

## CRITICAL ISSUE 1: `_get_latent_vector()` Does Not Exist on EmbeddedDreamerBrain

**Status:** Still applies. Unchanged from v2.

**Problem:** The critic spec calls `self.dreamer_world_model._get_latent_vector()` throughout. This method exists on `dreamer_brain.py:395` (standalone file) but was NOT compiled into `EmbeddedDreamerBrain` in champion_gen8.py.

**Fix:** Add the method to EmbeddedDreamerBrain. In agent_compiler.py Level 1 template:

```python
def _get_latent_vector(self):
    """Get flattened latent state [deter | stoch] = 5120 dims."""
    return np.concatenate([self._deter.flatten(), self._stoch.flatten()])
```

No braces — passes through unchanged. Target: Phase 2.1 of checklist.

---

## CRITICAL ISSUE 2: Reward Hook Point — `logged_tool()`, NOT `_bus_call`

**Status:** Still applies. Updated for config-driven rewards.

**Problem:** `_bus_call` only exists inside TUI proxy mode. In normal MCP mode (extension), tools go through `logged_tool()`.

**Fix:** Hook reward capture into `logged_tool()` wrapper.

**Key change from v1:** Now uses `source_key` (config key) instead of hardcoded reward value:

```python
# Success path (after ~line 25002):
_rbrain._capture_reward(
    source_key='tool_success',  # Reads weight from config
    event_id=str(_MCP_TOOL_STEP),
    metadata={{'tool': func.__name__, 'status': 'success'}}
)

# Error path (after ~line 25030):
_rbrain._capture_reward(
    source_key='tool_error',
    event_id=str(_MCP_TOOL_STEP),
    metadata={{'tool': func.__name__, 'status': 'error', 'error': str(e)[:200]}}
)
```

Brain accessor pattern (verified at champion line 24312-24315):
```python
_ragent = get_agent()
_router = _ragent._brain if hasattr(_ragent, '_brain') else getattr(_ragent, 'brain', None)
_rbrain = getattr(_router, '_brain', _router)
```

**In agent_compiler.py (Level 1):** Double all braces in dict literals.

---

## CRITICAL ISSUE 4: EmbeddedDreamerBrain.imagine() Doesn't Branch Per-Action

**Status:** Still applies. Unchanged from v2.

**Problem:** Current `imagine()` returns a single flat trajectory with hardcoded `action_val=0`. The training loop needs per-action branching.

**Fix:** Replace with branching version + `_copy_nj_state()` for RSSM parameter isolation between branches.

```python
@staticmethod
def _copy_nj_state(nj_state):
    """Copy ninjax state dict for branch isolation."""
    return {k: v.copy() if hasattr(v, 'copy') else v for k, v in nj_state.items()}
```

Key points:
- Save `_nj_state` BEFORE branching
- Reset to saved state at start of each branch
- Restore ALL state after imagination (deter, stoch, AND nj_state)
- Store result in `self._last_imagination`
- `n_actions` comes from config: `self.config.get('action_dim', 8)`

**CODEX NOTE:** Dict comprehension `{k: v.copy() ...}` becomes `{{k: v.copy() ...}}`. Dict literals `{'deter': ..., 'stoch': ...}` become `{{'deter': ..., 'stoch': ...}}`.

---

## MODERATE ISSUE 3: LoRA Parameter Count Mismatch

**Status:** Documentation only. Corrected in v2 spec.

Actual LoRA dimensions: `lora_A` (384,16) + `lora_B` (16,384) + `lora_bias` (384) = ~12,672 params (not 82K).

---

## MODERATE ISSUE 5: HOLD resolve() Field Names

**Status:** Still applies. Updated for config-driven rewards.

**Problem:** Actual `_HoldState.resolve()` uses `was_override` bool, not `resolution_type` string. No `hold_id` field exists.

**Fix (config-driven):**
```python
if self._brain_ref and hasattr(self._brain_ref, '_capture_reward'):
    was_override = self.resolution.get('was_override', False)
    source_key = 'hold_override' if was_override else 'hold_accept'
    self._brain_ref._capture_reward(
        source_key=source_key,
        action=self.current_hold.get('ai_choice', 0) if self.current_hold else 0,
        event_id=f"hold_{self.hold_count}",
        metadata={
            'was_override': was_override,
            'source': self.resolution.get('source', 'unknown'),
        }
    )
```

**Brain accessor:** Add `self._brain_ref = None` to `_HoldState.__init__`. Wire during capsule setup.

**Injection point:** In `yield_point()`, AFTER `sdk_observe()` but BEFORE `self.current_hold = None`.

---

## LOW ISSUE 6: Sidebar Has MCP Status, Not Blank Canvas

**Status:** Revised from v1. Sidebar has full MCP status (port, tools count, categories, nostr relays).

**Impact:** Dreamer Pulse widget goes AFTER the existing MCP status section, not as a replacement. There IS space below it.

---

## LOW ISSUE 7: `_last_imagination` Doesn't Exist on EmbeddedDreamerBrain

**Status:** Fixed by Issue 4 — branching imagine stores `self._last_imagination = all_trajectories`. Also init `self._last_imagination = []` in `__init__`.

---

## LOW ISSUE 8: SSE Heartbeat Risk for Training

**Status:** Still applies. Now config-driven.

**Fix:** Timeout budget from config (`training.timeout_budget_seconds`, default 30s). The 4-phase `_train_step` checks `time.time() > deadline` between each phase and returns partial results if budget exceeded.

---

## OBSERVATION 9: Reward Normalization — Now Config-Driven

**Status:** Updated. Normalization is controlled by `rewards.normalize` config flag.

When enabled (default `true`), applies symlog:
```python
reward = float(np.sign(raw_weight) * np.log1p(np.abs(raw_weight)))
```

User can disable normalization from the config UI if they want raw weights.

---

## OBSERVATION 10: Critic Serialization — Use base64+gzip

**Status:** Unchanged. Use `base64.b64encode(gzip.compress(arr.tobytes()))` pattern.

---

## NEW ISSUE 11: Config File Race Condition

**Problem:** Extension writes `dreamer_config.json`, brain reads it. If both happen simultaneously, the brain could read a partially-written file.

**Fix:** Brain uses try/except around config load and falls back to cached config on parse error. The file is small (<2KB) so partial writes are unlikely but not impossible on Windows.

```python
try:
    with open(config_path, 'r') as f:
        user_config = json.load(f)
except (json.JSONDecodeError, IOError):
    return self._dreamer_config  # Keep cached config
```

---

## NEW ISSUE 12: Enriched Tool Responses Must Not Break Existing Consumers

**Problem:** Other agents (Kiro, Claude Code MCP) already parse `get_status` and `show_rssm` responses. Adding a `dreamer` section must not break them.

**Fix:** Add dreamer data as a NEW top-level key `"dreamer"` in the JSON response. Never modify or remove existing fields. Consumers that don't know about `dreamer` will simply ignore it.

```python
# CORRECT: Add new key
result["dreamer"] = dreamer_section

# WRONG: Don't modify existing fields
# result["brain"]["critic_value"] = ...  # This could break consumers
```

---

## NEW ISSUE 13: Config File Location Discovery

**Problem:** The extension needs to know WHERE to write `dreamer_config.json`. The brain's working directory may not be obvious.

**Fix options (choose during implementation):**
1. **(Recommended)** Hardcode to same directory as champion_gen8.py. Extension knows this path from its own workspace.
2. Brain reports its working directory in `get_status` enriched response. Extension reads it from there.
3. Use a known shared location (e.g., `F:\End-Game\vscode-extension\dreamer_config.json`).

---

## ~~ISSUE 14~~ — RESOLVED: Prior session code was git-restored to clean state. No longer applies.

## ~~ISSUE 15~~ — RESOLVED: Prior session code was git-restored to clean state. No longer applies.

---

## NEW ISSUE 16: Two `get_status` Implementations — Only Enrich Normal Mode

**Problem:** agent_compiler.py has two `get_status` tools:
1. **Proxy mode** (~line 31181): reads from `state_file` — no live brain access
2. **Normal mode** (~line 33919): live brain access — can compute dreamer data

The extension uses normal mode (direct MCP via SSE). The enrichment only needs to target normal mode.

**Fix:** Enrich only the normal mode `get_status` (line ~33919). Document this clearly. Proxy mode enrichment is out of scope (would require TUI to write dreamer data to state file).

**Search pattern for normal mode:** Look for `get_status` that calls `_get_capsule()` or `get_agent()` directly, not the one that reads `state_file`.

---

## NEW ISSUE 17: `show_rssm` and `imagine` May Not Exist in Workspace Champion

**Problem:** The champion_gen8.py in the vscode-extension workspace may be stale (compiled before these tools were added). The extension can't call `show_rssm` or `imagine` until a new champion is compiled from the current agent_compiler.py.

**Fix:** This is a dependency, not a code fix. The implementation checklist Phase 2.5 already includes "Generate new champion." Ensure Phase 1 (extension UI) gracefully handles missing tools (show dashes/placeholders when tool calls fail).

The sidebar already handles this via the `catch` block that sends `{ error: 'not available' }`.

---

## REMOVED ISSUES (No Longer Applicable)

The following issues from v1/v2 errata are no longer relevant:

- ~~`dreamer_status` tool referencing `_last_imagination`~~ — No `dreamer_status` tool exists. Data flows through enriched `get_status`.
- ~~New tool registration order~~ — No new tools to register.
- ~~Tool count in doc comments~~ — Tool count unchanged.

---

## SUMMARY: Implementation Priority

| # | Issue | Severity | When to Fix |
|---|-------|----------|-------------|
| 1 | Add `_get_latent_vector()` | CRITICAL | Phase 2.1 |
| 2 | Hook rewards in `logged_tool()` with config keys | CRITICAL | Phase 2.4 |
| 4 | Branching imagine + `_nj_state` isolation | CRITICAL | Phase 2.1 |
| 16 | Two `get_status` implementations — only enrich normal mode | MODERATE | Phase 4 |
| 5 | Fix HOLD resolve field names + brain accessor | MODERATE | Phase 2.4 |
| 12 | Enriched responses — new key only, don't modify existing | MODERATE | Phase 4 |
| 13 | Config file location discovery | MODERATE | Phase 1 |
| 17 | `show_rssm`/`imagine` may not exist in stale champion | MODERATE | Phase 2.5 |
| 11 | Config file race condition guard | LOW | Phase 2.2 |
| 3 | Correct LoRA param count docs | LOW | Done |
| 10 | Binary serialization for critic | LOW | Phase 3.4 |
| 9 | Symlog normalization (config-driven) | LOW | Phase 2.3 |
| 8 | Training timeout guard (config-driven) | LOW | Phase 3.3 |
| 18 | LoRA wiring: `show_lora`, `show_weights`, `mutate_slot` miss `dreamer_world_model` | CRITICAL | Phase 2.1 |
| 19 | `show_dims` misses `_deter`/`_stoch` from dreamer (same pattern) | LOW | Phase 2.1 |
| 20 | HOLD reward capture uses `self.resolution` (None on timeout) — use local `result` | MODERATE | Phase 2.4 |
| 23 | `workflow_save` tool doesn't exist — hook `workflow_create` instead | LOW | Phase 2.4 |

---

## CRITICAL ISSUE 18: LoRA Accessor Wiring — 3 Locations

**Status:** New. Found during v5 audit.

**Problem:** `show_lora()`, `show_weights()`, and `mutate_slot()` brain-level path all resolve to `QuineOuroborosBrain` via the standard accessor chain, then check for `lora_rank`/`lora_A`/`lora_B` directly on it. But these attributes live on `brain.dreamer_world_model` (the `EmbeddedDreamerBrain`). All three silently fail or return incomplete data.

**Confirmed via live test:** `show_lora` returns `{"error": "No LoRA adapter available"}`. `show_weights` omits all LoRA stats. `mutate_slot` brain-level path falls through to "no adapter" error.

**Fix — add dreamer_world_model fallback in all three:**

### 18a: `show_lora` (agent_compiler.py ~line 34280)

```python
lora_source = brain
if not hasattr(brain, 'lora_rank') and hasattr(brain, 'dreamer_world_model') and brain.dreamer_world_model:
    lora_source = brain.dreamer_world_model
if not hasattr(lora_source, 'lora_rank'):
    return json.dumps({{"error": "No LoRA adapter available", "brain_type": type(brain).__name__}})

return json.dumps({{
    "lora_rank": lora_source.lora_rank,
    "lora_alpha": getattr(lora_source, 'lora_alpha', 1.0),
    "lora_A_shape": list(lora_source.lora_A.shape) if hasattr(lora_source, 'lora_A') else None,
    "lora_B_shape": list(lora_source.lora_B.shape) if hasattr(lora_source, 'lora_B') else None,
    "lora_bias_shape": list(lora_source.lora_bias.shape) if hasattr(lora_source, 'lora_bias') else None,
}}, indent=2)
```

### 18b: `show_weights` (agent_compiler.py ~line 34150)

Same pattern — after resolving `brain`, add:
```python
lora_source = brain
if not hasattr(brain, 'lora_A') and hasattr(brain, 'dreamer_world_model') and brain.dreamer_world_model:
    lora_source = brain.dreamer_world_model
```
Then use `lora_source.lora_A` / `lora_source.lora_B` instead of `brain.lora_A` / `brain.lora_B`.

### 18c: `mutate_slot` brain-level path (agent_compiler.py ~line 33533)

The existing code checks `inner_brain` for `lora_A`. Add dreamer fallback:
```python
inner_brain = getattr(brain, '_brain', brain)
if not hasattr(inner_brain, 'adapter_in') and not hasattr(inner_brain, 'lora_A'):
    if hasattr(inner_brain, 'dreamer_world_model') and inner_brain.dreamer_world_model:
        inner_brain = inner_brain.dreamer_world_model
```

---

## LOW ISSUE 19: `show_dims` Misses Dreamer State

**Status:** New. Same root cause as Issue 18.

**Problem:** `show_dims()` checks `brain._deter` and `brain._stoch` — these live on `dreamer_world_model`. Live test confirms dims are missing from output.

**Fix:** Same dreamer_world_model fallback pattern. Not blocking for v0.8.0 but fix alongside Issue 18.

---

## MODERATE ISSUE 20: HOLD Reward Capture — `self.resolution` Is None on Timeout

**Status:** New.

**Problem:** The reward capture code in the errata Issue 5 fix uses `self.resolution.get('was_override', False)`. But on HOLD timeout (line 1073 of champion), `self.resolution` stays `None` — `yield_point` creates a local `result` variable instead. `None.get(...)` throws `AttributeError`.

**Fix:** Use the local `result` variable (which always exists at the injection point):
```python
was_override = result.get('was_override', False)
source_key = 'hold_override' if was_override else 'hold_accept'
```

Not `self.resolution.get(...)`.

---

## LOW ISSUE 23: `workflow_save` Tool Does Not Exist

**Status:** New.

**Problem:** Reward spec Section 1.6.5 hooks into `workflow_save` tool. The actual tools are `workflow_create` and `workflow_update`. There is no `workflow_save`.

**Fix:** Hook into `workflow_create` (which IS a save operation). The config key `rewards.workflow_save` is fine as-is — it's just a config key name, doesn't need to match a tool name.

---

## ERRATA AUDIT TRAIL

- **v1** (2026-02-23): Original errata — 10 issues identified
- **v2** (2026-02-23): Second-pass corrections — _nj_state isolation, get_agent() pattern, _brain_ref guidance
- **v3** (2026-02-23): Full revision for zero-new-tools approach. All hardcoded reward values replaced with config keys. Added Issues 11-13 (config race, response compatibility, file location). Removed tool registration issues.
- **v4** (2026-02-23): Cross-reference audit. Added Issues 14-17. Then git-restored extension files to clean state (b623089), making Issues 14-15 moot. Issues 16-17 remain.
- **v5** (2026-02-23): Live MCP validation. Added Issues 18-20, 23. Issue 18 (LoRA wiring) confirmed via live `show_lora` call returning error despite working dreamer brain. Issue 20 found via tracing timeout path in `yield_point()`. Issue 23 found via tool name audit.

---

*Apply these corrections alongside the v2 plan documents. The plans remain the primary reference; this errata provides verified fixes and gotchas.*
