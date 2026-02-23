# Requirements: Dreamer-Hold Transmission

## Requirement 1: Hold Resolution Reward Capture

### Requirement
When `hold_resolve` is called (accept or override), the system must fire `_capture_reward()` with the correct source key, closing the feedback loop so the dreamer learns from human decisions.

### Acceptance Criteria
- [ ] `hold_resolve` with accept fires `_capture_reward('hold_accept', ...)` with weight from config (default 1.0)
- [ ] `hold_resolve` with override fires `_capture_reward('hold_override', ...)` with weight from config (default -0.5)
- [ ] Uses local `result` variable, NOT `self.resolution` (which is None on timeout)
- [ ] `_brain_ref` is wired to `_HoldState` during capsule setup
- [ ] Reward capture failure never breaks `hold_resolve` (wrapped in try/except)
- [ ] `hold_resolve` response includes `dreamer_reward_captured: true` and reward metadata

## Requirement 2: Dreamer Imagination into Hold Points

### Requirement
When a hold point fires, the dreamer's imagination results (branch trajectories, critic values, confidence scores) must be packaged as ASSOCIATIVE human-readable data in the HoldPoint, replacing the current static `action_probs=[1.0, 0.0]` and `value=0.0`.

### Acceptance Criteria
- [ ] `_dreamer_hold_point()` method runs imagination, scores branches via critic, and normalizes to action_probs via softmax
- [ ] `imagination` dict contains ASSOCIATIVE data per action: trajectory_summary (strings), expected_value, predicted_reward, confidence, reasoning, risk_level
- [ ] No raw numpy arrays or latent vectors in imagination data — only JSON-serializable Python primitives
- [ ] `world_prediction` populated from best branch
- [ ] `reasoning` is a list of human-readable strings
- [ ] `action_labels` are meaningful names
- [ ] `hold_yield` response includes a `decision_matrix` with action count, best action, confidence, and per-action summaries

## Requirement 3: Dynamic Hold Gates

### Requirement
Config-driven gates must control when holds fire and what data they expose, readable from the `hold` section of `dreamer_config.json`.

### Acceptance Criteria
- [ ] `confidence_threshold` (default 0.85): if best branch confidence >= threshold, hold is skipped (auto-pass)
- [ ] `expose_imagination` (default true): if false, imagination data stripped from hold point
- [ ] `blocking` (default false): passed to `Hold.yield_point()` blocking parameter
- [ ] `auto_resolve_timeout` (default 30): seconds before auto-resolve
- [ ] `max_branches_displayed` (default 4): limits how many branches appear in imagination
- [ ] Config re-read on each hold (no restart needed for config changes)
- [ ] New `hold` section added to `_DREAMER_CONFIG_DEFAULTS`

## Requirement 4: CausationHold Session Integration

### Requirement
The capsule must maintain a CausationHold session for temporal navigation of decision history, using the cascade-lattice CausationHold API.

### Acceptance Criteria
- [ ] `_init_causation_hold()` called at capsule startup, creates session via `begin_session()`
- [ ] Each forward pass calls `capture()` with context, candidates, and state snapshot
- [ ] `branch_from()` used when imagination creates alternative futures
- [ ] `rewind()`, `forward()`, `jump_to()` available for temporal navigation
- [ ] `end_session()` called on capsule shutdown
- [ ] Import failure sets `_causation_hold = None` — all calls become no-ops, no exceptions

## Requirement 5: Dreamer State Persistence

### Requirement
Critic weights, reward head, continue head, training stats, and reward buffer must survive capsule restarts via save/load to a JSON file.

### Acceptance Criteria
- [ ] `_save_dreamer_state()` serializes critic (with target network), reward head, continue head using base64+gzip
- [ ] Training stats (counts, sums) included in save
- [ ] Last 100 reward buffer events saved (without latent vectors)
- [ ] Config snapshot saved for drift detection
- [ ] `_load_dreamer_state()` restores all above on capsule startup
- [ ] Missing file returns False, components start fresh
- [ ] Corrupt file returns False, components start fresh, no exceptions
- [ ] File location: same directory as champion (`Path(__file__).parent / 'dreamer_state.json'`)
- [ ] Round-trip preserves critic output within float32 precision

## Requirement 6: Enriched Tool Responses (Backward Compatible)

### Requirement
Existing tool responses (`hold_yield`, `hold_resolve`, `get_status`, `show_rssm`, `imagine`) must be enriched with dreamer data under NEW top-level keys, without modifying or removing any existing fields.

### Acceptance Criteria
- [ ] All new dreamer data added under new keys only (e.g., `"dreamer"`, `"decision_matrix"`, `"dreamer_reward_captured"`)
- [ ] No existing response fields modified or removed
- [ ] Consumers that don't know about dreamer keys simply ignore them
- [ ] Only normal-mode `get_status` enriched (not proxy-mode)
- [ ] `get_status` dreamer section includes: active, critic_value, reward_count, training_cycles, reward_rate
- [ ] `show_rssm` includes critic and reward head data
- [ ] `imagine` includes critic-scored branch values

## Requirement 7: All Changes in agent_compiler.py Only

### Requirement
The entire implementation must live in `ouroboros-key/agent_compiler.py`. No new MCP tools. No new files. Level 1 escaping rules apply.

### Acceptance Criteria
- [ ] Zero new MCP tools added
- [ ] All code changes in `agent_compiler.py` only
- [ ] Level 1 template escaping: `{` → `{{`, `}` → `}}`, `"""` → `\"\"\"`
- [ ] Minimal diff — only touch lines that need changing
- [ ] No debug logging bloat
