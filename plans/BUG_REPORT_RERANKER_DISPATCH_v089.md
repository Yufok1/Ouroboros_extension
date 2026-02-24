# Bug Report: RERANKER Model Type Missing From All Dispatch Tables

**Version:** 0.8.8 (targeting 0.8.9 fix)
**Severity:** High — breaks `forward`, `infer`, `deliberate`, and degrades 6+ MCP tools
**Filed:** 2026-02-24
**Status:** Research complete, edits pending

---

## Symptoms

1. `deliberate` tool returns: `{"error": "Deliberation failed: RERANKER", "details": "council_deliberate exception"}`
2. `forward` tool returns: `{"action": 0, "value": 0.0, "error": "RERANKER"}`
3. `infer` tool returns same as forward
4. Tools like `compare`, `all_slots`, `pipe`, `debate`, `broadcast`, `chain` show errors for the reranker slot when iterating councilors

## Root Cause

CrossEncoder (sentence-transformers reranker) extends `nn.Module`. The codebase correctly detects it as `ModelType.RERANKER` but then has **no handling for that type** in any of the three dispatch table patterns used throughout the champion.

The `ModelType.RERANKER` enum value exists. The detection works. But every place that acts on model type either:
- Has no `elif model_type == ModelType.RERANKER` case (falls to generic/crash)
- Uses `hasattr` probing that misroutes the CrossEncoder into wrong call patterns

### CrossEncoder's Attribute Profile

```
hasattr(model, 'forward')   → True   (inherited from nn.Module, delegates to self.model)
hasattr(model, 'config')    → True   (property that returns self.model.config)
hasattr(model, 'encode')    → False
hasattr(model, 'generate')  → False
hasattr(model, 'predict')   → True   (primary method — expects List[List[str,str]] pairs)
hasattr(model, 'classify')  → False
callable(model)              → True   (nn.Module.__call__ invokes forward)
model._model_type_hint       → 'RERANKER'
```

### Why CrossEncoder Can't Be Called With Arbitrary Input

CrossEncoder.predict() expects sentence pairs: `[[query, doc], [query, doc2], ...]`
CrossEncoder.forward() delegates to the underlying HF model which expects tokenized tensors.
CrossEncoder(numpy_array) → crashes because nn.Module.__call__ routes to forward.

There is NO safe way to invoke a CrossEncoder with a single string or numpy array. It must always receive sentence pairs or be handled via hash-based voting in deliberation contexts.

---

## Affected Dispatch Tables

### Dispatch Table 1: `_invoke_model` — ModelType-based dispatch

**Location (L0):** `agent_compiler.py` line ~481
**Location (L1):** compiled champion line ~925
**Pattern:** `if model_type == ModelType.X: ...`

Handles: LLM, EMBEDDING, RL, VISION, PLANNER, SLAM, CONTROL, SENSOR, COMMS, STATE_MACHINE, INFINITY_EMBED, INFINITY_RERANK, INFINITY_CLASSIFY, INFINITY_CLIP, INFINITY_CLAP

**Missing:** RERANKER, CLASSIFIER, VLM, AUDIO_LLM, IMAGE_GEN, TTS, DEPTH, WORLD_MODEL, POLICY

When `ModelType.RERANKER` hits this function, it falls to:
```python
else:
    if hasattr(model, '__call__'):
        result = model(inputs)  # ← CrossEncoder(dict) → crash
```

**Called by:** `QuineSlot.forward()` which is used by `invoke_slot` with `mode=auto`

**Fix:** Add `elif model_type == ModelType.RERANKER:` case. Since rerankers need sentence pairs and can't process arbitrary input, return a hash-based embedding (same pattern as LLM in council). Also add CLASSIFIER case.

---

### Dispatch Table 2: `_council_deliberate` — hasattr-based dispatch with ModelType pre-check

**Location (L0):** `agent_compiler.py` line ~4510
**Location (L1):** compiled champion line ~6765
**Pattern:** ModelType.LLM check first, then hasattr chain

Current dispatch order:
1. `model_type == ModelType.LLM` → hash vote ✓
2. `hasattr(model, 'encode')` → embedding vote
3. `hasattr(model, 'forward') and not hasattr(model, 'encode')` → check `config` → hash vote
4. `hasattr(model, 'classify')` → hash vote
5. `callable(model)` → direct call ← **DANGER ZONE**
6. else → hash fallback

**Theory on current behavior:** CrossEncoder has `forward` (True) and no `encode` (True) and has `config` (True, it's a property). So it SHOULD hit branch 3 → hash vote. But the exception string "RERANKER" suggests something goes wrong — possibly the `config` property access triggers an internal error, or the hash path has a subtle failure that causes fallthrough to `callable(model)` → `model(adapted['adapted_output'])` → CrossEncoder gets a numpy array → crash deep inside HuggingFace model internals.

**The exception path for `forward`/`infer`:**
```
CapsuleAgent.forward()
  → _forward_with_internals()
    → self.brain.forward(inputs)           # CapsuleBrain
      → self._brain.forward(inputs)        # QuineOuroborosBrain
        → _council_deliberate(adapted)     # throws Exception("RERANKER")
    except Exception as e:
      output = {"action": 0, "value": 0.0, "error": str(e)}  # ← this is what we see
```

**The exception path for `deliberate`:**
```
deliberate MCP handler
  → brain._council_deliberate(adapted)     # throws Exception("RERANKER")
  except Exception as e:
    return {"error": f"Deliberation failed: {e}", "details": "council_deliberate exception"}
```

**Fix:** Add explicit `model_type == ModelType.RERANKER` check as the SECOND check (right after LLM), using hash-based vote with confidence 0.3. This prevents any hasattr chain ambiguity. Also add per-councilor try/except so one bad model can't crash the entire council.

---

### Dispatch Table 3: hasattr-based dispatch in MCP tools (6+ tools)

**Affected tools and locations (L1 line numbers in agent_compiler.py):**
- `pipe` (~line 33410)
- `compare` (~line 33500)
- `broadcast` (~line 35080)
- `debate` (~line 36100)
- `chain` (~line 36220)
- `all_slots` (~line 36290)

**Pattern (all identical):**
```python
if hasattr(model, 'encode'):        # embedding
elif hasattr(model, 'generate'):    # LLM
elif hasattr(model, 'predict') or hasattr(model, 'classify'):  # classifier
    fn = getattr(model, 'predict', None) or getattr(model, 'classify', None)
    result = fn(input_text)         # ← CrossEncoder.predict("single string") → crash
elif callable(model):               # generic
```

CrossEncoder has `predict` → hits the predict/classify branch → `model.predict("some text")` → fails because predict expects `List[List[str, str]]` sentence pairs, not a single string.

These tools all have per-slot try/except, so they don't crash entirely — they just report an error for the reranker slot. But it's still wrong behavior.

**Fix:** Add a check before the predict branch:
```python
elif getattr(model, '_model_type_hint', None) == 'RERANKER':
    # Reranker needs sentence pairs — use hash-based vote or skip
```

Or check `model_type` if available on the slot object.

---

## Comprehensive Fix Plan

### Edit 1: `_invoke_model` — Add RERANKER + CLASSIFIER cases

**File:** `agent_compiler.py`
**Level:** L0 (line ~493, after EMBEDDING case) AND L1 (line ~10573, after EMBEDDING case)
**Brace escaping:** L0 uses `{}`, L1 uses `{{}}`

Add after the EMBEDDING elif:
```python
elif model_type == ModelType.RERANKER:
    # Cross-encoder reranker — needs sentence pairs, can't process arbitrary input
    # Use hash-based embedding for generic invocation contexts
    query = text if text else (str(obs) if obs is not None else "")
    docs = inputs.get('documents', inputs.get('docs', []))
    if docs and query:
        # Proper reranker invocation with pairs
        pairs = [[query, d] for d in docs]
        scores = model.predict(pairs)
        if hasattr(scores, 'tolist'):
            scores = scores.tolist()
        return {'output': scores, 'scores': scores, 'type': 'reranker'}
    else:
        # No documents — return hash-based embedding
        import hashlib
        h = hashlib.sha256(query.encode()).digest()
        hash_bytes = np.frombuffer(h, dtype=np.uint8).astype(np.float32)
        vec = (hash_bytes / 255.0) * 2 - 1
        vec = np.tile(vec, 12)[:384]
        return {'output': vec, 'embedding': vec, 'type': 'reranker_hash'}

elif model_type == ModelType.CLASSIFIER:
    # Classifier — needs text input, not numpy arrays
    to_classify = text if text else (str(obs) if obs is not None else "")
    if hasattr(model, 'predict'):
        result = model.predict([to_classify])
    elif hasattr(model, 'classify'):
        result = model.classify(to_classify)
    else:
        result = model(to_classify)
    return {'output': result, 'classification': str(result), 'type': 'classifier'}
```

### Edit 2: `_council_deliberate` — Add RERANKER check + per-councilor try/except

**File:** `agent_compiler.py`
**Level:** L0 (line ~4542)
**Brace escaping:** L0 uses `{{}}`

Add `ModelType.RERANKER` as second check after LLM:
```python
if model_type == ModelType.LLM:
    # ... existing hash vote ...
elif model_type == ModelType.RERANKER:
    # Reranker can't process arbitrary input — hash-based vote
    import hashlib
    hash_input = adapted.get('text', adapted.get('query', 'deliberation'))
    h = hashlib.sha256(hash_input.encode()).digest()
    hash_bytes = np.frombuffer(h, dtype=np.uint8).astype(np.float32)
    vote = (hash_bytes / 255.0) * 2 - 1
    vote = np.tile(vote, 12)[:384]
    confidence = 0.3
```

Wrap each councilor's dispatch in try/except:
```python
try:
    # ... entire dispatch chain for this councilor ...
except Exception as _slot_err:
    # One bad councilor shouldn't crash the whole council
    import hashlib
    hash_input = adapted.get('text', adapted.get('query', 'deliberation'))
    h = hashlib.sha256(hash_input.encode()).digest()
    hash_bytes = np.frombuffer(h, dtype=np.uint8).astype(np.float32)
    vote = (hash_bytes / 255.0) * 2 - 1
    vote = np.tile(vote, 12)[:384]
    confidence = 0.1
```

### Edit 3: hasattr-based tools — Add RERANKER guard

**File:** `agent_compiler.py`
**Level:** L1 (6 tools, all in the MCP tools section)
**Brace escaping:** L1 uses `{{}}`

In each of the 6 tools (pipe, compare, broadcast, debate, chain, all_slots), add before the `predict/classify` branch:
```python
elif getattr(model, '_model_type_hint', None) == 'RERANKER':
    # Reranker needs sentence pairs — report type, don't crash
    responses.append({"slot": i, "name": name, "type": "reranker", "note": "requires sentence pairs"})
```

### Edit 4: `invoke_slot` — Handle RERANKER in auto mode

**File:** `agent_compiler.py`
**Level:** L1 (invoke_slot handler)

Add before the classify/predict auto-detection:
```python
elif mode == "auto" and getattr(model, '_model_type_hint', None) == 'RERANKER':
    # Reranker in auto mode — inform user it needs documents
    return json.dumps({"slot": slot, "name": name, "mode": "reranker",
        "note": "Reranker requires sentence pairs. Use rerank tool instead.",
        "hint": "rerank(query='...', documents=['doc1', 'doc2'])"})
```

---

## Quine Edit Protocol (from Codex)

1. Read 50 lines above and below each edit point
2. Identify brace level (L0 = `{}`, L1 = `{{}}`)
3. Make minimal diffs
4. After each edit: `python -m py_compile ouroboros-key/agent_compiler.py`
5. After all edits: compile new champion, compress to capsule.gz, rebuild vsix
6. Test: plug all 4 model types, run `deliberate`, `forward`, `infer`, `compare`, `all_slots`

## Files to Edit

- `ouroboros-key/agent_compiler.py` — the quine compiler (ALL edits here)
  - L0 `_invoke_model`: line ~481 (add RERANKER + CLASSIFIER cases)
  - L0 `_council_deliberate`: line ~4542 (add RERANKER check + per-councilor try/except)
  - L1 `_invoke_model`: line ~10573 (same as L0 but with `{{}}` braces)
  - L1 MCP tools (pipe, compare, broadcast, debate, chain, all_slots): various lines ~33400-36300
  - L1 `invoke_slot`: line ~27751 equivalent in compiler

## Verification Matrix

| Tool | Current | Expected After Fix |
|------|---------|-------------------|
| `deliberate` | "Deliberation failed: RERANKER" | Returns council consensus with reranker hash vote |
| `forward` | "error": "RERANKER" | Returns full pipeline output, reranker contributes hash vote |
| `infer` | "error": "RERANKER" | Same as forward |
| `compare` | Error on reranker slot | "type": "reranker", graceful skip |
| `all_slots` | Error on reranker slot | "type": "reranker", graceful skip |
| `pipe` with slot 0 | Error | Graceful skip or hash passthrough |
| `debate` | Error on reranker slot | Graceful skip |
| `broadcast` | Error on reranker slot | Graceful skip |
| `invoke_slot(0)` | "string indices must be integers" | Helpful message pointing to rerank tool |
| `rerank` | Already works ✓ | No change needed |
| `classify` | Already works ✓ | No change needed |
| `generate` | Already works ✓ | No change needed |
| `embed_text` | Already works ✓ | No change needed |
