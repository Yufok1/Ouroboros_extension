# v0.8.0 Bug List — Dreamer Integration Evaluation

Date: 2026-02-23

## Bug 1: CRITICAL — `pathlib` not imported, crashes ALL brain-dependent tools

- **Error**: `name 'pathlib' is not defined`
- **Location**: `_load_dreamer_config()` at champion line 5932 / agent_compiler.py line 3662
- **Code**: `config_path = pathlib.Path(__file__).parent / 'dreamer_config.json'`
- **Cause**: Uses `pathlib.Path(...)` (module-level access) but `import pathlib` was never added to the Level 1 template imports. The rest of the codebase uses `from pathlib import Path` (name-level) and references `Path(...)` directly.
- **Blast radius**: `_load_dreamer_config()` is called in `QOB.__init__()`, so the brain object fails to construct. Since `get_agent()` creates the brain lazily, ALL tools that call `get_agent()` crash. This includes:
  - get_status, show_rssm, imagine, heartbeat, forward, infer
  - get_capabilities, get_genesis, get_identity, get_about, get_provenance
  - show_weights, show_dims, show_lora, council_status, list_slots
  - verify_hash (uses brain for hash verification)
  - All inference tools, all council tools, all slot tools
- **Tools that STILL WORK** (bypass brain entirely):
  - verify_integrity (reads file hash only)
  - bag_catalog, bag_search, bag_induct, bag_forget, bag_get, bag_put
  - workflow_list, workflow_create, workflow_execute, workflow_delete
  - cascade_graph, cascade_record
- **Fix in agent_compiler.py**: Change line 3662 from:
  ```python
  config_path = pathlib.Path(__file__).parent / 'dreamer_config.json'
  ```
  to:
  ```python
  from pathlib import Path as _P
  config_path = _P(__file__).parent / 'dreamer_config.json'
  ```
  This matches the codebase convention of local `from pathlib import Path` imports rather than module-level `import pathlib`.
- **Severity**: CRITICAL — breaks ~80% of all MCP tools

## Non-Bug Notes

### Reward hooks — silently fail (CORRECT behavior)
All 6 reward hook points (tool_success, tool_error, hold, bag_induct, bag_forget, workflow_success/failure/save) are wrapped in `try/except: pass`. When the brain fails to initialize, the hooks fail silently and the underlying operations (bag_induct, workflow_execute, etc.) complete successfully. This is the correct degradation behavior.

### Brace escaping — verified correct
- `_copy_nj_state()` dict comprehension: `{k: v.copy() ...}` compiled correctly from `{{k: v.copy()...}}`
- `_DREAMER_CONFIG_DEFAULTS` dict: all braces compiled correctly
- `CriticHead.to_dict()` / `from_dict()`: not tested at runtime (blocked by Bug 1) but code inspection shows correct compilation

### Class ordering — verified correct
- `from dataclasses import dataclass` (line 5120) → before `@dataclass class RewardEvent` (5506)
- `CriticHead` (5530), `RewardHead` (5632), `ContinueHead` (5661) → all before `QOB` (5727)
- `_DREAMER_CONFIG_DEFAULTS` (5682) → before QOB `__init__` references it

### dreamer_config.json — included in VSIX
- File exists at workspace root, NOT in .vscodeignore, so it ships with the extension
- However: `_load_dreamer_config()` looks for it relative to `__file__` (champion_gen8.py location), not workspace root. If the user runs the capsule from a different directory, config won't be found and defaults are used (graceful fallback).
