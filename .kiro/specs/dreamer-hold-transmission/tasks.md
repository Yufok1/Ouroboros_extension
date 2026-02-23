# Tasks: Dreamer-Hold Transmission

All tasks modify `ouroboros-key/agent_compiler.py` only. Level 1 escaping rules apply throughout.

## Task 1: Add hold config defaults to _DREAMER_CONFIG_DEFAULTS
- [x] Add `"hold"` section to `_DREAMER_CONFIG_DEFAULTS` (~line 3464)
- [x] Keys: `confidence_threshold` (0.85), `expose_imagination` (True), `blocking` (False), `auto_resolve_timeout` (30), `max_branches_displayed` (4), `include_trajectory_detail` (True)
- [x] All braces doubled for Level 1

Requirements: 3, 7

## Task 2: Add reward capture to MCP hold_resolve tool
- [x] In `hold_resolve()` (~line 36720), after accept/override/cancel, add reward capture block
- [x] Get brain ref via standard accessor: `get_agent()` → `_brain` → `_brain`
- [x] Map action to source_key: `"accept"` → `'hold_accept'`, `"override"` → `'hold_override'`
- [x] Call `_capture_reward(source_key=..., event_id=hold_id, metadata=...)`
- [x] Wrap in try/except — never break hold_resolve
- [x] Add `dreamer_reward_captured`, `reward_source` to response JSON

Requirements: 1, 6

## Task 3: Implement _dreamer_hold_point() on QuineOuroborosBrain
- [x] Method at ~line 3766, runs imagination, scores branches via critic
- [x] Softmax normalization to action_probs
- [x] Confidence gate: if best >= threshold, return None (auto-pass)
- [x] ASSOCIATIVE imagination dict with trajectory_summary, expected_value, predicted_reward, confidence, reasoning, risk_level
- [x] world_prediction from best branch
- [x] No raw numpy in output — all Python primitives

Requirements: 2, 3

## Task 4: Enrich MCP hold_yield with dreamer decision matrix
- [x] hold_yield (~line 36620) gets brain ref, calls `_dreamer_hold_point()`
- [x] Uses dreamer action_probs/value instead of static [1.0, 0.0]
- [x] `decision_matrix` in response with action_count, best_action, confidence, per-action summaries
- [x] Falls back to static behavior on failure

Requirements: 2, 3, 6

## Task 5: Implement _save_dreamer_state() and _load_dreamer_state()
- [x] `_save_dreamer_state()` at ~line 3925: critic, reward_head, continue_head, training_stats, reward_buffer sample
- [x] `_load_dreamer_state()`: restore all above; missing/corrupt file → False
- [x] Called in `__init__` (~line 3574) and after `_train_step` (~line 4826)

Requirements: 5, 7

## Task 6: Implement CausationHold session integration
- [x] `_init_causation_hold()` at ~line 4024
- [x] `_capture_hold_step()` and `_end_causation_hold()` implemented
- [x] Import failure sets `_causation_hold = None` — all calls become no-ops
- [x] Called in `__init__` (~line 3577)

Requirements: 4, 7

## Task 7: Enrich get_status with dreamer hold data
- [x] Normal-mode `get_status` (~line 34960) has hold_config, causation_hold_active, causation_hold_steps, persistence_file_exists
- [x] Under existing `"dreamer"` key

Requirements: 6, 7

## Task 8: Enrich show_rssm and imagine with dreamer hold data
- [x] `show_rssm` (~line 35355) has `hold_gate` section with threshold, expose_imagination, blocking, causation_hold status
- [x] `imagine` (~line 32476) has critic_value and pred_reward per step
- [x] All new data under new keys only

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
