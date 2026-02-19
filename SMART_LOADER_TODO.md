# Smart Loader Expansion — Deferred from 0.7.3

## Context
The `_load_model_smart` function in `agent_compiler.py` routes HuggingFace models to the correct loader based on pipeline_tag and tag detection. Several pipeline tags have zero routing, causing models to either fail to load or take the wrong path.

## Files
- **Level 0 copy**: `agent_compiler.py` line ~628 (normal Python)
- **Level 1 copy**: `agent_compiler.py` line ~8616 (template with `{{}}` escaping)
- Both copies MUST be edited in sync per the Ouroboros Codex

## Pipeline Tags Missing From Routing (Level 1, lines ~8661-8679)

| Pipeline Tag | Models | Correct Loader |
|---|---|---|
| `zero-shot-classification` | facebook/bart-large-mnli, deberta-nli | `AutoModelForSequenceClassification` |
| `text-classification` | distilbert-sst2, roberta-base | `AutoModelForSequenceClassification` |
| `summarization` | bart-large-cnn, pegasus | `AutoModelForSeq2SeqLM` (already exists) |
| `translation` | marian-mt, opus-mt | `AutoModelForSeq2SeqLM` (already exists) |
| `image-text-to-text` | LLaVA, PaliGemma, Qwen-VL | `AutoModelForVision2Seq` (NEW) |
| `visual-question-answering` | BLIP-2, InstructBLIP | `AutoModelForVision2Seq` (NEW) |
| `image-to-text` | BLIP, GIT | `AutoModelForVision2Seq` (NEW) |

## New Loader Functions Needed

### `_load_as_classifier` (insert after `_load_as_generic`, Level 1 ~line 8903)
- Uses `AutoModelForSequenceClassification` + `AutoTokenizer`
- Wrapper class with `.classify(text)` method
- Returns `(model, 'CLASSIFIER', None)` or `(None, 'ERROR', str(e))`

### `_load_as_vlm` (insert after `_load_as_vision`, Level 1 ~line 8868)
- Uses `AutoModelForVision2Seq` + `AutoProcessor`
- Wrapper class with `.generate(text=, image=)` method
- Returns `(model, 'VLM', None)` or `(None, 'ERROR', str(e))`
- `ModelType.VLM` enum already exists at line ~8932

## Routing Fix (Level 1, lines ~8698-8710)
Add new elif branches:
```python
elif detected_type == 'CLASSIFIER':
    return _load_as_classifier(model_id, verbose)
elif detected_type == 'VLM':
    return _load_as_vlm(model_id, verbose)
```

## Fallback Cascade Fix
When a detected type fails its specific loader, currently returns error directly.
Should fall through to `_load_as_generic` as last resort:
```python
elif detected_type == 'SEQ2SEQ':
    result = _load_as_seq2seq(model_id, verbose)
    if result[1] != 'ERROR':
        return result
    return _load_as_generic(model_id, verbose)  # fallback
```

## Pipeline Tag Expansion (Level 1, lines ~8661-8679)
Add to the detection:
```python
elif pipeline_tag in ('zero-shot-classification', 'text-classification'):
    detected_type = 'CLASSIFIER'
elif pipeline_tag in ('summarization', 'translation'):
    detected_type = 'SEQ2SEQ'
elif pipeline_tag in ('image-text-to-text', 'visual-question-answering', 'image-to-text'):
    detected_type = 'VLM'
```

## Codex Reminders
- Level 1 uses `{{}}` for dicts, `\"\"\"` for docstrings, `\\n` for literal newlines
- Every `{var}` injects from compiler; every `{{var}}` outputs literal `{var}`
- Read 50 lines context before editing
- `py_compile` after every edit
- Minimal diff, maximum intent


---

## Phantom Plugging State Issue — Discovered 2026-02-18

### Problem Statement
During concurrent model plugging operations, the UI can enter a desynchronized state where slots display as "PLUGGING" indefinitely, despite the backend reporting those slots as empty and unplugged.

### Reproduction Steps
1. Rapidly plugged 4 models in parallel using `plug_model` tool:
   - `HuggingFaceTB/SmolLM2-135M-Instruct` → slot 2
   - `google/gemma-3-270m-it` → slot 1
   - `BAAI/bge-small-en-v1.5` → slot 0
   - `cardiffnlp/twitter-roberta-base-sentiment-latest` → slot 3
2. Performed slot swap operation: `swap_slots(0, 2)`
3. Cloned slot 1 five times: `clone_slot(slot=1, count=5)` → created slots 4-8
4. Attempted broadcast operation to all plugged slots
5. UI displayed slots 10 and 11 as "PLUGGING" with active timers (231s, 228s)

### Observed Behavior
- **UI State**: Slots 10 and 11 showed "PLUGGING" status with loading indicators and incrementing timers
- **Backend State**: `slot_info(10)` and `slot_info(11)` both returned:
  ```json
  {
    "slot": N,
    "name": "slot_N",
    "plugged": false,
    "source": null,
    "model_type": null
  }
  ```
- **System Status**: `get_status()` reported `slots_filled: 9` (correct count, excluding phantom slots)
- **Cache State**: `clear_cache()` cleared 50 items but did not resolve UI desync

### Resolution Actions Taken
1. Called `clear_cache()` → cleared 50 cached items, no effect on phantom states
2. Called `unplug_slot(10)` → returned `{"status": "ok", "unplugged": 10, "was": "slot_10"}`
3. Called `unplug_slot(11)` → returned `{"status": "ok", "unplugged": 11, "was": "slot_11"}`
4. Called `get_status()` → confirmed 9 slots filled

### Root Cause Hypothesis
- UI polling/state management may create phantom "plugging" entries for slots that were never actually targeted by plug operations
- Possible race condition between rapid concurrent operations (plug → swap → clone → broadcast) and UI state updates
- Cache invalidation does not trigger UI state reconciliation for phantom loading states
- Backend slot state and UI slot state are not atomically synchronized during high-frequency operations

### Affected Components
- UI webview panel: Council grid slot status display
- Backend: `slot_info`, `list_slots`, `get_status` tools (all reported correct state)
- Cache system: Does not appear to be the source, as clearing cache had no effect
- State synchronization layer between MCP tool responses and UI updates

### Questions for Investigation
- Does the UI create optimistic "plugging" states before tool calls complete?
- Are there orphaned promises/callbacks from failed or cancelled plug operations?
- Should `clear_cache()` also trigger a full UI state reconciliation?
- Should `list_slots` or `get_status` include a force-refresh parameter to reset UI state?
- Do concurrent operations (swap, clone, broadcast) during active plugging create race conditions?

