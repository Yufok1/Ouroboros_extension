# Bug List — v0.8.8 Candidates (DEEP DIVE REVISION)

Post-0.8.7 verification testing. Full council plugged (Gemma 3 1B, BGE Small, MS-MARCO MiniLM, RoBERTa GoEmotions). Systematic test of all v0.8.4–v0.8.6 fixes plus workflow routing.

Original date: 2026-02-23
Deep dive revision: 2026-02-23

---

## Status of v0.8.6 Fixes (verified in v0.8.7 build)

| Bug | Status | Notes |
|-----|--------|-------|
| Bug 1 (deliberate CLASSIFIER crash) | ✅ FIXED | Mixed council deliberation works. CLASSIFIER models route to hash-based vote path. |
| Bug 2 (classify wrong slot) | ✅ FIXED | Two-pass search picks slot 3 (emotion classifier) over slot 2 (cross-encoder). |
| Bug 3 (cross-encoder as CLASSIFIER) | ❌ DIFFERENT ROOT CAUSE | Cross-encoder now loads as EMBEDDING, not CLASSIFIER — see Bug 1 below. |
| Bug 4 (pipe slot 0 append) | ✅ FIXED (non-empty) | `pipe([1])` executes only slot 1 with correct `embed` mode. |
| Bug 5 (chain empty sequence) | ⚠️ SEE BUG 3 BELOW | Revisited — not a framework limit, see deep dive. |

### Additional v0.8.4 fixes verified:

| Bug | Status |
|-----|--------|
| Bug 7 (cull name reset) | ✅ FIXED — slot resets to `slot_N` after cull/unplug |
| Bug A (skip propagation) | ✅ FIXED — merge/output nodes execute when any upstream completes |
| Bug B (smart loader) | ✅ FIXED — EMBEDDING and CLASSIFIER detected from local paths |
| Bug C (deliberate non-LLM) | ✅ FIXED — embedders/rerankers contribute embeddings only, no garbage text |
| Pipe type detection | ✅ FIXED — `pipe([1])` uses `embed` mode for embedding model, not `generate` |

---

## BUG 1: 4 Competing Model Identification Systems — Unify or Die

**Severity**: HIGH
**Component**: Model type detection across the entire codebase
**File**: `champion_gen8.py` — 4 separate locations

### The Problem

There are FOUR independent systems that try to figure out what type a model is. They don't agree with each other, they don't share results cleanly, and the cross-encoder misdetection is a symptom of this mess.

### System Map (all 4 detection paths)

**System 1 — Hub API detection** (lines ~325-370, inside `_load_model_smart`)
- Calls `huggingface_hub.model_info()` to get `pipeline_tag` and `tags`
- Maps `pipeline_tag` to type: `sentence-similarity` → EMBEDDING, `text-generation` → LLM, `text-classification` → CLASSIFIER, etc.
- Fallback: scans tags for keywords like `causal`, `gpt`, `sentence`, `embed`
- ONLY works for remote Hub models. Fails silently for local paths.
- Does NOT know about RERANKER at all — `pipeline_tag` has no reranker category.

**System 2 — Local config.json detection** (lines ~375-410, inside `_load_model_smart`)
- Reads `config.json` from local model directory
- Checks file markers: `modules.json` → EMBEDDING, `config_sentence_transformers.json` → EMBEDDING
- Checks architectures: `ForSequenceClassification` → CLASSIFIER or RERANKER (via `id2label` count + `sbert_ce` key)
- **THIS IS WHERE THE CROSS-ENCODER BUG LIVES**: `modules.json` check (line ~381) fires BEFORE the `ForSequenceClassification` + `sbert_ce` check (line ~386)
- Only runs when System 1 fails (local paths)

**System 3 — Runtime detection** (lines 765-840, `_detect_model_type_runtime`)
- Inspects the loaded model object via `hasattr` checks
- `hasattr(model, 'generate')` → LLM, `hasattr(model, 'encode')` → EMBEDDING, etc.
- Returns `ModelType` enum values (different type system than Systems 1-2 which return strings)
- Cannot distinguish RERANKER from EMBEDDING — both have `.encode()`
- Cannot distinguish CLASSIFIER from GENERIC — ClassifierWrapper has `.classify()` but the runtime detector doesn't check for it

**System 4 — Consensus-time re-detection** (lines ~6772-6860, inside deliberation voting loop)
- Re-checks `_model_type_hint` (string from loader) AND `hasattr` (runtime) at vote time
- Has its own branching logic: `_hint == 'CLASSIFIER'` → hash vote, `hasattr(model, 'encode')` → embedding vote, `hasattr(model, 'generate')` → LLM text generation
- Duplicates logic from Systems 2 and 3
- Has a CLASSIFIER check at line ~6855 that's unreachable because the `hasattr(model, 'encode')` check at line ~6833 catches ClassifierWrappers first (they inherit from models that have `.encode()` via the underlying transformer)

### The Cross-Encoder Bug (specific, VERIFIED LIVE)

The cross-encoder model (`cross-encoder/ms-marco-MiniLM-L-6-v2`) is loaded as SentenceTransformer with no type hint.

Live test (v0.8.7):
```
slot_info(slot=2)
→ name: "reranker-marco", model_type: null, model_class: "SentenceTransformer"
```

And the rerank tool confirms it uses cosine-similarity, not cross-encoder scoring:
```
rerank(query="efficient transformer inference optimization", documents=[...])
→ method: "cosine-similarity"  ← should be "cross-encoder"
```

The model hits System 2's local detection. The detection order is:

```
1. modules.json exists?        → YES → EMBEDDING (STOPS HERE)
2. ForSequenceClassification?  → never reached
3. sbert_ce key?               → never reached
```

Current code (lines ~380-389):
```python
# 1. Check for sentence-transformer markers → EMBEDDING
if os.path.isfile(os.path.join(model_id, 'modules.json')):
    detected_type = 'EMBEDDING'                              # ← cross-encoder trapped here
elif os.path.isfile(os.path.join(model_id, 'config_sentence_transformers.json')):
    detected_type = 'EMBEDDING'
# 2. ForSequenceClassification → CLASSIFIER or RERANKER
elif 'forsequenceclassification' in _arch_str:               # ← never reached for cross-encoder
    _id2label = _local_cfg.get('id2label', {})
    if len(_id2label) <= 2 or 'sbert_ce_default_activation_function' in _local_cfg:
        detected_type = 'RERANKER'
    else:
        detected_type = 'CLASSIFIER'
```

### Additional Problem: `rerank` Tool Has No Cross-Encoder Path

Even if detection were fixed, the `rerank` tool handler (lines ~18937-18980) doesn't use cross-encoder scoring. It:
1. Finds the first model with `.encode()` — any embedder
2. Embeds query and docs separately
3. Computes cosine similarity

It never:
- Looks for `_model_type_hint == 'RERANKER'`
- Uses sentence-pair scoring (`model.predict([(query, doc)])`)
- Distinguishes between embedders and cross-encoders

### Fix Required (two parts)

**Part A — Detection order fix** in `_load_model_smart` local config.json section:
```python
# Read config.json FIRST, then check markers with config awareness
_local_cfg = json.loads(open(_local_cfg_path).read())
_archs = _local_cfg.get('architectures', [])
_arch_str = ' '.join(_archs).lower()

# 1. Cross-encoder check FIRST (before sentence-transformer markers)
if 'sbert_ce_default_activation_function' in _local_cfg:
    detected_type = 'RERANKER'

# 2. Sentence-transformer markers, but exclude ForSequenceClassification with ≤2 labels
elif os.path.isfile(os.path.join(model_id, 'modules.json')):
    if 'forsequenceclassification' in _arch_str and len(_local_cfg.get('id2label', {})) <= 2:
        detected_type = 'RERANKER'  # cross-encoder distributed as sentence-transformers
    else:
        detected_type = 'EMBEDDING'

# 3. Rest of chain unchanged...
```

**Part B — `rerank` tool handler** needs a cross-encoder path:
```python
# Priority 1: Find RERANKER model (cross-encoder sentence-pair scoring)
reranker = None
for c in brain.councilors:
    model = getattr(c, 'model', None)
    if model and getattr(model, '_model_type_hint', None) == 'RERANKER':
        reranker = model
        break

if reranker and hasattr(reranker, 'predict'):
    # Cross-encoder: score each (query, doc) pair directly
    pairs = [(query, doc) for doc in documents]
    scores = reranker.predict(pairs)
    ranked = sorted(zip(range(len(documents)), scores, documents), key=lambda x: x[1], reverse=True)
    result = {'query': query, 'method': 'cross-encoder', 'ranked': [...]}
else:
    # Priority 2: Cosine similarity fallback (existing code)
    ...
```

**Part C — Longer term: unify the 4 systems.** The `_model_type_hint` string set by the loader should be the single source of truth. System 3 (`_detect_model_type_runtime`) and System 4 (consensus re-detection) should read `_model_type_hint` first and only fall back to `hasattr` checks if it's missing. The `ModelType` enum should include RERANKER and CLASSIFIER so there's one type system, not two (strings vs enum).

---

## BUG 2: Workflow `if` Node `contains` Operator Too Greedy for Classification

**Severity**: MEDIUM
**Component**: Workflow Engine `_execute_if` + `deliberate` tool output format
**File**: `champion_gen8.py` (WorkflowExecutor._execute_if, lines ~12422-12490)

### The Problem

When a workflow uses `deliberate` for intent classification and routes via `if` nodes with `contains` conditions, the routing always matches the first branch because the deliberation output includes reasoning text that mentions all categories.

This is NOT a Hydra Router-specific bug. It affects ANY workflow that uses `deliberate` + `if` node + `contains` for classification routing.

### Root Cause (confirmed from code + LIVE TEST)

Live test of `deliberate` for classification (v0.8.7):
```
deliberate(question="Classify into ARCHITECT, SCRIBE, or SCOUT: 'Write comprehensive documentation about FelixBag'")
→ consensus_output: "Architect"
→ text_output (from Gemma): "Architect"
```

The Gemma 1B model returned "Architect" for a documentation request that should be SCRIBE. This reveals a THIRD issue beyond the two in the original doc: the small model itself is bad at classification. It's not just a `contains` operator problem — the model genuinely misclassifies.

The `deliberate` tool returns a dict with:
- `consensus_output`: "Architect" (the text from the LLM, embedded by other models for consensus)
- `consensus_vector`: [384-dim float array]
- `deliberation`: per-slot vote details
- `councilor_votes`: 4
- `consensus_method`: "bayesian"

When a workflow references `$node.classify_intent.result`, the `_resolve_ref` walks to the `result` key of this dict. If there's no `result` key, it returns `None`, and `str(None)` = `"None"` — which wouldn't match anything. But if the workflow references `$node.classify_intent.consensus_output`, it gets `"Architect"`.

Two concrete issues found:

**Issue A — `contains` is case-sensitive but reasoning text matches anyway**

The `_execute_if` method (line ~12459):
```python
elif operator == "contains":
    result = str(right) in str(left)
```

This is a plain Python `in` check — case-SENSITIVE. But the deliberation output from small models includes reasoning like:
```
"**SCOUT** ... Let's consider why the other options are less suitable:
*   **Architect:** Doesn't directly involve..."
```

The word "Architect" (capitalized) appears in the reasoning. If the workflow condition checks for `'ARCHITECT'` (all caps), it won't match "Architect" — so the original bug doc's Hypothesis B is only partially correct. The match depends on exact casing in the workflow definition.

However, if the workflow checks for `'Architect'` or `'architect'`, it WILL match reasoning text.

**Issue B — `$node.X.result` resolves to the full tool output dict, not just the answer**

The `_resolve_ref` method (lines ~11899-11965) walks `context["$node"][node_id]` by dot-separated keys. For `$node.classify_intent.result`:
- `context["$node"]["classify_intent"]` = the full output dict from the `deliberate` tool
- `.result` = the `result` key in that dict

The `deliberate` tool handler (line ~18735) returns `serialize(out)` where `out` is the brain's `deliberate()` return value. This is the FULL deliberation output including reasoning, not just the classification label.

When `str(left)` is called on this (which `contains` does), it stringifies the entire dict, which contains all category names in the reasoning text. So `contains 'ARCHITECT'` matches on the stringified reasoning.

### Fix Required (pick one or combine)

**Option 1 — Use `starts_with` or `regex` in workflow definitions** (no code change):
Workflow authors should use:
```json
{"operator": "starts_with", "right": "**ARCHITECT"}
```
or:
```json
{"operator": "regex", "right": "^\\*{0,2}ARCHITECT"}
```
instead of `contains`. This is a workflow design issue, not an engine bug.

**Option 2 — Add a `classify` node type to the workflow engine**:
Instead of abusing `deliberate` + `if` for classification, add a dedicated `classify` node that:
- Takes a prompt and a list of labels
- Returns ONLY the label (no reasoning)
- Uses the plugged classifier or a simple prompt-based approach

This is better for small models that can't reliably separate reasoning from answers.

**Option 3 — Make `deliberate` support a `format` parameter**:
Add `format: "label_only"` to the `deliberate` tool that strips reasoning and returns just the classification label. This keeps the existing workflow pattern but gives control over output format.

**Recommendation**: Option 1 is the immediate fix (workflow definition change). Option 2 or 3 is the proper fix for making classification routing reliable with small models. Small models produce unpredictable reasoning text — the system should not depend on parsing free-form text for routing decisions.

**NEW FINDING**: Even with perfect `if` conditions, Gemma 1B misclassifies intents. A documentation request was classified as "Architect" instead of "Scribe." For reliable intent routing with small models, consider:
- Using the embedder for semantic similarity against label descriptions instead of LLM text generation
- Using the classifier model (RoBERTa GoEmotions is wrong domain, but the pattern is right) with fine-tuned labels
- Hardcoding a simple keyword/regex router instead of using LLM deliberation for intent classification

---

## BUG 3: Empty Pipeline/Chain — Pydantic Drops Empty Lists (VERIFIED)

**Severity**: LOW
**Component**: `pipe` and `chain` MCP tool handlers + Pydantic schema validation
**File**: `champion_gen8.py` (lines ~20377-20420) + MCP tool schema

### Previous Claim

"Pydantic drops empty lists before the handler is called. NOT FIXABLE in champion code."

### Live Test Results (v0.8.7)

```
pipe(input_text="Hello", pipeline=[])
→ Pydantic error: "Field required [type=missing, input_value={'input_text': 'Hello'}, input_type=dict]"

chain(slot_sequence=[], text="test")
→ Pydantic error: "Field required [type=missing, input_value={'text': 'test'}, input_type=dict]"
```

**Confirmed**: Pydantic strips the empty list `[]` from the input entirely, then fails validation because the field is now missing. The handler code never executes.

The "defaults to slot 0" claim from the original bug doc is WRONG — it doesn't default to anything, it throws a Pydantic validation error before the handler runs.

### The Actual Bug

The error message is confusing and unhelpful. The user sends `pipeline=[]` and gets back "Field required" — which makes it look like they forgot the parameter entirely. The real issue is that Pydantic treats `[]` as equivalent to "not provided" for required list fields.

### Fix Options

**Option 1 — Make the field Optional with a default in the Pydantic schema:**
Change the schema so `pipeline` defaults to `None` (not `[]`), then handle `None` and `[]` the same way in the handler:
```python
# Schema: pipeline: Optional[List[int]] = None
# Handler:
pipeline = args.get('pipeline') or []
if not pipeline:
    result = {'error': 'pipeline must contain at least one slot index', 'hint': 'Example: pipe(input_text="Hello", pipeline=[0, 1])'}
```

**Option 2 — Use `min_length=1` in the Pydantic schema:**
```python
# Schema: pipeline: List[int] = Field(..., min_length=1)
```
This gives a clear error: "List should have at least 1 item" instead of "Field required."

**Option 3 — Wrap the MCP handler to catch Pydantic errors and return friendly messages:**
Intercept the validation error before it reaches the caller and return a proper JSON error response instead of a raw Pydantic traceback.

### Status: FIXABLE — Pydantic schema change + better error message

The previous "won't fix" was premature. The handler code is correct. The issue is either:
- Already fixed (handler returns error for empty list)
- In the MCP schema definition (fixable)
- A stale bug report that no longer reproduces

---

## Summary & Priority

| # | Bug | Severity | Type | Fix Location |
|---|-----|----------|------|-------------|
| 1 | 4 competing model ID systems; cross-encoder misdetected | HIGH | PERSISTENT | Smart loader detection order + rerank handler + unify type systems |
| 2 | Workflow `if` + `contains` too greedy for classification | MEDIUM | DESIGN ISSUE | Workflow definitions (immediate) + classify node or deliberate format param (proper) |
| 3 | Empty pipeline/chain behavior | LOW | NEEDS VERIFICATION | MCP schema definition OR already fixed |

**Priority order**: Bug 1 → Bug 2 → Bug 3

### Bug 1 Action Items
1. Reorder local config.json detection: `sbert_ce` check BEFORE `modules.json` check
2. Add cross-encoder scoring path to `rerank` tool handler
3. Longer term: unify 4 detection systems into one, add RERANKER/CLASSIFIER to ModelType enum

### Bug 2 Action Items
1. Immediate: document that workflow `if` conditions for classification should use `starts_with` or `regex`, not `contains`
2. Proper: add `classify` workflow node type or `format` param to `deliberate`

### Bug 3 Action Items
1. ~~Verify: run `pipe(input_text="Hello", pipeline=[])` and check actual response~~ DONE — confirmed Pydantic drops empty list
2. Fix Pydantic schema: use `Optional[List[int]]` with `None` default, or `min_length=1`
3. Return friendly error message instead of raw Pydantic validation error
