# Tasks: Dreamer-Hold Transmission

All tasks modify `ouroboros-key/agent_compiler.py` only. Level 1 escaping rules apply throughout.

## Task 1: Add hold config defaults to _DREAMER_CONFIG_DEFAULTS
- [ ] Add `"hold"` section to `_DREAMER_CONFIG_DEFAULTS` (~line 3467, after `"architecture"` section)
- [ ] Keys: `confidence_threshold` (0.85), `expose_imagination` (True), `blocking` (False), `auto_resolve_timeout` (30), `max_branches_displayed` (4), `include_trajectory_detail` (True)
- [ ] All braces doubled for Level 1

Requirements: 3, 7

## Task 2: Add reward capture to MCP hold_resolve tool
- [ ] In `hold_resolve()` (~line 36310), after `hold.accept()`/`hold.override()`/`hold.cancel()` but before the return, add reward capture block
- [ ] Get brain ref via standard accessor: `get_agent()` → `_brain` → `_brain`
- [ ] Map action to source_key: `"accept"` → `'hold_accept'`, `"override"` → `'hold_override'`
- [ ] Call `_capture_reward(source_key=..., event_id=hold_id, metadata=...)`
- [ ] Wrap in try/except — never break hold_resolve
- [ ] Add `dreamer_reward_captured`, `reward_source` to response JSON

Requirements: 1, 6

## Task 3: Implement _dreamer_hold_point() on QuineOuroborosBrain
- [ ] Add method after `_capture_reward` (~line 3755)
- [ ] Run imagination via `self.dreamer_world_model.imagine(horizon=...)`
- [ ] Score each branch via `self._critic.forward(latent)` and `self._reward_head.forward(latent)`
- [ ] Compute cumulative discounted values per branch
- [ ] Normalize to action_probs via temperature-scaled softmax
- [ ] Check confidence gate: if best >= threshold, return None (auto-pass)
- [ ] Build ASSOCIATIVE imagination dict: trajectory_summary (strings), expected_value, predicted_reward, confidence, reasoning, risk_level
- [ ] Build world_prediction from best branch
- [ ] Return dict matching Hold.yield_point() kwargs, or None
- [ ] No raw numpy in output — all converted to Python primitives

Requirements: 2, 3

## Task 4: Enrich MCP hold_yield with dreamer decision matrix
- [ ] In `hold_yield()` (~line 36259), before calling `hold.yield_point()`:
  - Get brain ref via standard accessor
  - Call `brain._dreamer_hold_point()` if available
  - If returns None (auto-pass), still yield but note confidence was high
  - If returns dict, use its `action_probs`, `value`, `imagination`, etc. instead of static `[1.0, 0.0]`
- [ ] Add `decision_matrix` to response JSON with: action_count, best_action, best_value, confidence, per-action summaries
- [ ] Pass `blocking` from config, `action_labels` from dreamer
- [ ] Wrap dreamer parts in try/except — fall back to current static behavior on failure

Requirements: 2, 3, 6

## Task 5: Implement _save_dreamer_state() and _load_dreamer_state()
- [ ] Add both methods to QuineOuroborosBrain (after _capture_reward area, ~line 3755)
- [ ] `_save_dreamer_state()`: serialize critic (via `to_dict()`), reward_head (W1/b1/W2/b2 via base64+gzip), continue_head, training_stats, last 100 reward buffer events (no latent), config snapshot
- [ ] `_load_dreamer_state()`: restore all above; missing file → False; corrupt file → False, no exceptions
- [ ] File path: `_P(__file__).parent / 'dreamer_state.json'` (using existing `_P` import)
- [ ] Call `_load_dreamer_state()` at end of `__init__` (~line 3590, after heads are initialized)
- [ ] Call `_save_dreamer_state()` at end of `_train_step()` (after training completes)

Requirements: 5, 7

## Task 6: Implement CausationHold session integration
- [ ] Add `_init_causation_hold()` method to QuineOuroborosBrain
- [ ] Try import `CausationHold` from cascade; on failure set `self._causation_hold = None`
- [ ] Call `begin_session()` at startup
- [ ] Add `_capture_hold_step()` — calls `capture()` with context, candidates, state snapshot
- [ ] Wire `_capture_hold_step()` into the forward path (where dreamer simulate runs)
- [ ] Add `_end_causation_hold()` for cleanup
- [ ] Call `_init_causation_hold()` in `__init__` after dreamer setup

Requirements: 4, 7

## Task 7: Enrich get_status with dreamer hold data
- [ ] In normal-mode `get_status` (~line 33919, the one with `get_agent()`), add to existing dreamer section:
  - `hold_config`: current hold gate settings from config
  - `causation_hold_active`: whether CausationHold session is running
  - `causation_hold_steps`: number of captured steps
  - `persistence_file_exists`: whether dreamer_state.json exists
  - `last_save_time`: timestamp of last save
- [ ] Add under existing `"dreamer"` key — don't create duplicate sections
- [ ] Don't modify any existing response fields

Requirements: 6, 7

## Task 8: Enrich show_rssm and imagine with dreamer hold data
- [ ] In `show_rssm` response: add `hold_gate_status` (current threshold, last auto-pass count, last hold count)
- [ ] In `imagine` response: add critic-scored branch values, best branch index, confidence distribution
- [ ] All new data under new keys only
- [ ] Don't modify existing response fields

Requirements: 6, 7

## Task 9: Build, test, and verify
- [ ] Compile new champion from agent_compiler.py
- [ ] Drop champion into vscode-extension
- [ ] `npm run compress-capsule` → `npm run compile` → `npx vsce package`
- [ ] Test: `get_status` returns dreamer hold config
- [ ] Test: `hold_yield` returns decision_matrix with imagination data
- [ ] Test: `hold_resolve` returns dreamer_reward_captured
- [ ] Test: `show_rssm` returns hold gate status
- [ ] Test: persistence round-trip (save → restart → load → verify)

Requirements: 1, 2, 3, 4, 5, 6, 7
