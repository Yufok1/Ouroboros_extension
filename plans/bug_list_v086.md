# Bug List — v0.8.6 Candidates

Post-0.8.5 verification testing. Smart loader now works. Three bugs remain, one is a regression from v0.8.5.
Date: 2026-02-23

---

## Status of v0.8.5 Fixes

| Bug | Status | Notes |
|-----|--------|-------|
| Bug B (smart loader) | ✅ FIXED | EMBEDDING and CLASSIFIER types now detected from local paths |
| Bug A (skip propagation) | ✅ FIXED | merge/output nodes execute correctly, unrouted branches skipped |
| Bug C (deliberate non-LLM) | ❌ REGRESSION | `deliberate` crashes with `"Deliberation failed: CLASSIFIER"` |
| Bug D (pipe slot 0) | ⚠️ NEEDS RETEST | Code looks correct in current source — may have been fixed by v0.8.5 pipeline freeze |
| Bug E (chain empty) | ⚠️ FRAMEWORK LIMIT | Pydantic validation drops empty list before handler — not fixable in agent_compiler.py |
| Classify tool | ✅ PARTIALLY FIXED | Finds classifier but picks wrong slot (slot 2 cross-encoder instead of slot 3 emotion classifier) |
| Rerank | ⚠️ DEPENDS ON BUG 3 | Still uses cosine-similarity because cross-encoder loaded as CLASSIFIER not RERANKER |

---

## BUG 1 (REGRESSION): `deliberate` Crashes with "Deliberation failed: CLASSIFIER"

**Severity**: HIGH (blocks all deliberation when any CLASSIFIER model is plugged)
**Component**: `_council_deliberate` method
**File**: `agent_compiler.py` (Level 1 template, ~line 4463)

**Description**:
The v0.8.5 fix added `_model_type_hint` checking to `_council_deliberate`. When a model has `_model_type_hint == 'CLASSIFIER'`, the code sets `model_type = ModelType.CLASSIFIER`. However, the `ModelType` enum (defined at ~line 5071) does NOT have a `CLASSIFIER` member. This causes an `AttributeError` (or `ValueError`) that gets caught by the outer exception handler and reported as `"Deliberation failed: CLASSIFIER"`.

**Evidence**:
```
deliberate("What is 2+2?") → {"error": "Deliberation failed: CLASSIFIER"}
```

**Root Cause**:
Line ~4463 in Level 1 template:
```python
elif _hint == 'CLASSIFIER':
    model_type = ModelType.CLASSIFIER  # ← CRASH: ModelType has no CLASSIFIER member
```

The `ModelType` enum at line 5071 has: `EMBEDDING`, `LLM`, `VISION`, `RL`, `PLANNER`, `SLAM`, `CONTROL`, `SENSOR`, `COMMS`, `STATE_MACHINE`, `GENERIC`, `INFINITY_EMBED` — but NO `CLASSIFIER`.

**Fix Required**:
Replace `model_type = ModelType.CLASSIFIER` with `model_type = ModelType.GENERIC` (or any valid enum member), and then add a separate check for CLASSIFIER hint in the if/elif chain below. The simplest fix: when `_hint == 'CLASSIFIER'`, skip the `model_type` assignment entirely and jump directly to the classifier hash-based vote path (which already exists at ~line 4540).

Specifically, change lines ~4462-4464 from:
```python
elif _hint == 'CLASSIFIER':
    model_type = ModelType.CLASSIFIER
```
to:
```python
elif _hint == 'CLASSIFIER':
    model_type = ModelType.GENERIC  # No CLASSIFIER in ModelType enum; route via hint check below
```

AND add a CLASSIFIER check BEFORE the `model_type == ModelType.LLM` check:
```python
# Check CLASSIFIER hint FIRST (before model_type routing)
if _hint == 'CLASSIFIER':
    # Hash-based vote for classifiers
    import hashlib
    hash_input = adapted.get('text', adapted.get('query', 'deliberation'))
    h = hashlib.sha256(hash_input.encode()).digest()
    hash_bytes = np.frombuffer(h, dtype=np.uint8).astype(np.float32)
    vote = (hash_bytes / 255.0) * 2 - 1
    vote = np.tile(vote, 12)[:384]
    confidence = 0.5
elif model_type == ModelType.LLM:
    ...
```

---

## BUG 2: `classify` Tool Picks Wrong Slot (Cross-Encoder Instead of Emotion Classifier)

**Severity**: MEDIUM (classify works but returns wrong model's output)
**Component**: `classify` MCP tool handler
**File**: `agent_compiler.py` (Level 1 template, ~line 35033)

**Description**:
The `classify` handler iterates through councilors and picks the FIRST model with a `predict()` method. Both the cross-encoder (slot 2, ms-marco-MiniLM) and the emotion classifier (slot 3, roberta-go_emotions) have `predict()`. The cross-encoder is found first and used for classification, but it's a reranker — it expects sentence pairs, not single text inputs.

**Evidence**:
```
classify("I am so happy") → picks slot 2 (cross-encoder) instead of slot 3 (emotion classifier)
invoke_slot(slot=3, mode="classify") → works perfectly with proper emotion labels
```

**Root Cause**:
Line ~35050:
```python
for i, c in enumerate(brain.councilors):
    model = getattr(c, 'model', None)
    if model and hasattr(model, 'predict'):
        # Picks FIRST model with predict() — no preference for actual classifiers
```

**Fix Required**:
Add a two-pass search:
1. First pass: look for models with `_model_type_hint == 'CLASSIFIER'` (not RERANKER)
2. Second pass (fallback): look for any model with `predict()`

```python
# Pass 1: Prefer actual classifiers (not rerankers)
for i, c in enumerate(brain.councilors):
    model = getattr(c, 'model', None)
    _hint = getattr(model, '_model_type_hint', getattr(c, '_model_type', None))
    if model and _hint == 'CLASSIFIER' and hasattr(model, 'predict'):
        result = model.predict([text])
        return json.dumps({"slot": i, "input": text, "output": str(result), "classification": str(result)})

# Pass 2: Fallback to any model with predict()
for i, c in enumerate(brain.councilors):
    model = getattr(c, 'model', None)
    if model and hasattr(model, 'predict'):
        result = model.predict([text])
        return json.dumps({"slot": i, "input": text, "output": str(result), "classification": str(result)})
```

---

## BUG 3: Cross-Encoder Detected as CLASSIFIER Instead of RERANKER

**Severity**: MEDIUM (blocks cross-encoder reranking, forces cosine-similarity fallback)
**Component**: Smart loader — local config.json detection
**File**: `agent_compiler.py` (Level 1 template, ~line 9970)

**Description**:
The smart loader's local config.json detection correctly identifies `ForSequenceClassification` models, but the RERANKER vs CLASSIFIER distinction is broken. Both branches of the `id2label` check set `detected_type = 'CLASSIFIER'`:

```python
_id2label = _local_cfg.get('id2label', {})
if len(_id2label) <= 2 or 'sbert_ce_default_activation_function' in _local_cfg:
    detected_type = 'CLASSIFIER'  # ← WRONG: should be 'RERANKER'
else:
    detected_type = 'CLASSIFIER'  # ← correct for multi-label classifiers
```

The first branch (≤2 labels OR has `sbert_ce_default_activation_function`) should set `detected_type = 'RERANKER'`, not `'CLASSIFIER'`.

**Evidence**:
- ms-marco-MiniLM has `id2label: {"0": "LABEL_0"}` (1 label) and `sbert_ce_default_activation_function` in config
- It gets detected as CLASSIFIER instead of RERANKER
- The `rerank` tool's Priority 1 search looks for `_model_type_hint == 'RERANKER'` and never finds it
- Falls through to cosine-similarity (Priority 2)

**Fix Required**:
Change line ~9970 from:
```python
detected_type = 'CLASSIFIER'  # cross-encoder reranker (uses same loader)
```
to:
```python
detected_type = 'RERANKER'
```

BUT ALSO: The routing section below needs a RERANKER case. Currently only `CLASSIFIER` routes to `_load_as_classifier`. Need to add:
```python
elif detected_type == 'RERANKER':
    return _load_as_classifier(model_id, verbose)  # Cross-encoders use same loader as classifiers
```

AND: The `_load_as_classifier` function needs to set `_model_type_hint = 'RERANKER'` when the detected type is RERANKER. This requires passing the detected_type through, OR setting the hint after loading based on the config.

**Simpler approach**: Keep detecting as 'CLASSIFIER' but set `_model_type_hint` to 'RERANKER' on the loaded model when the config has cross-encoder markers. This avoids changing the routing logic.

---

## BUG 4 (NEEDS RETEST): `pipe` Appends Unrequested Slot 0

**Severity**: MEDIUM (if still present)
**Component**: `pipe` MCP tool handler
**File**: `agent_compiler.py` (Level 1 template, ~line 33393)

**Description**:
Previously reported as persistent through v0.8.5. However, code review shows the pipe handler now has:
1. `pipeline = list(pipeline)` freeze
2. Empty list guard
3. Clean for-loop over only requested slots
4. No slot 0 fallback logic

**Status**: NEEDS RETEST. The code looks correct. If the bug persists, it may be in the MCP framework's parameter serialization (e.g., pydantic adding a default value).

---

## BUG 5 (FRAMEWORK LIMIT): `chain` Empty Sequence

**Severity**: LOW
**Component**: `chain` MCP tool handler / MCP framework pydantic validation
**File**: `agent_compiler.py` (Level 1 template, ~line 36329)

**Description**:
The chain handler has a correct empty-list guard, but pydantic validation in the MCP framework drops empty lists before the handler is called. The handler's fix is unreachable.

**Status**: NOT FIXABLE in agent_compiler.py. Would require MCP framework changes.

---

## Summary & Priority

| # | Bug | Severity | Status | Fix Location |
|---|-----|----------|--------|-------------|
| 1 | deliberate crashes with CLASSIFIER | HIGH | REGRESSION | `_council_deliberate` ~line 4463 |
| 2 | classify picks wrong slot | MEDIUM | NEW | `classify` handler ~line 35050 |
| 3 | cross-encoder detected as CLASSIFIER not RERANKER | MEDIUM | PERSISTENT | smart loader ~line 9970 + routing |
| 4 | pipe appends slot 0 | MEDIUM | NEEDS RETEST | — |
| 5 | chain empty sequence | LOW | FRAMEWORK LIMIT | — |

**Priority order**: Bug 1 → Bug 3 → Bug 2 → Bug 4 (retest) → Bug 5 (won't fix)

Bug 1 is the most impactful — it crashes ALL deliberation when any CLASSIFIER model is plugged, which blocks workflow routing.
Bug 3 cascades to fix reranking (the rerank tool will find the cross-encoder via `_model_type_hint == 'RERANKER'`).
Bug 2 ensures classify picks the right model.
