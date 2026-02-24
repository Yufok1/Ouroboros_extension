# Bug List — v0.8.5 Candidates

Post-0.8.4 verification testing. Some bugs from v0.8.4 were fixed, some were not, and one new bug was introduced.
Date: 2026-02-23

---

## Status of v0.8.4 Fixes

| Bug | Status | Notes |
|-----|--------|-------|
| Bug 1 (if-node skip) | ✅ FIXED but introduced Bug A | Skip propagation works but is too aggressive — skips merge/output nodes |
| Bug 2 (deliberate text) | ✅ PARTIALLY FIXED | LLM returns text, but non-LLM models produce garbage text |
| Bug 3 (classify not found) | ❌ NOT FIXED | Still returns "No classification model found" — depends on Bug 4 |
| Bug 4 (smart loader) | ❌ NOT FIXED | All 4 models still load as `type: "LLM"` |
| Bug 5 (pipe type hints) | ❌ NOT FIXED | Depends on Bug 4 — no type hints set because loader doesn't detect types |
| Bug 6 (pipe fallback) | ❌ NOT FIXED | Pipe still appends slot 0 as fallback |
| Bug 7 (cull name reset) | ✅ FIXED | Slot name resets to `slot_N` after cull |
| Bug 8 (chain empty) | ❌ NOT FIXED | Still defaults to slot 0 on empty sequence |
| Bug 9 (rerank method) | ✅ PARTIALLY FIXED | `method` field added, but still uses cosine-similarity (depends on Bug 4) |

---

## BUG A (NEW): Workflow Skip Propagation Too Aggressive — Merge & Output Nodes Skipped

**Severity**: HIGH (workflow output is returned by accident, not by design)
**Component**: Workflow Engine — DAG traversal skip propagation
**File**: `agent_compiler.py` (WorkflowExecutor, ~line 17725-17745)

**Description**:
The v0.8.4 fix for Bug 1 added skip propagation: "if ANY upstream source node has status `skipped`, skip the current node." This correctly skips `scribe_branch` and `scout_branch` when the `if` node routes to `architect_branch`. However, it ALSO skips `merge_output` and `output` because they have connections from the skipped branches.

**Evidence** (hydra-router execution):
```
node_states:
  architect_branch: "completed" (55s)
  check_scribe:     "skipped"   ✅ correct
  scribe_branch:    "skipped"   ✅ correct
  scout_branch:     "skipped"   ✅ correct
  merge_output:     "skipped"   ❌ WRONG — should execute
  output:           "skipped"   ❌ WRONG — should execute
```

The workflow still returned a result because the executor apparently returns whatever data is available even when the output node is "skipped". But this is fragile — the merge node's `mode: "first"` selection logic never ran, so the output came from the raw `architect_branch` data rather than the merge node's processed output.

**Root Cause**:
The skip condition checks if ANY upstream source is skipped. For `merge_output`, its upstream sources include `architect_branch` (completed), `scribe_branch` (skipped), and `scout_branch` (skipped). Since 2 of 3 are skipped, the merge gets skipped.

**Fix Required**:
The skip condition for `merge` nodes (and `output` nodes) should be: skip only if ALL upstream sources are skipped. If ANY upstream source completed, the merge/output should execute. For regular tool/agent nodes in a branch, the current "skip if ANY upstream is skipped" logic is correct.

Alternative: Only propagate skips through nodes that have exactly ONE upstream connection. Nodes with multiple upstream connections (merge, output) should only skip if ALL upstreams are skipped.

---

## BUG B (PERSISTENT): Smart Loader Does Not Detect Model Types from Local Paths

**Severity**: CRITICAL (blocks Bugs 3, 5, 9 — cascade failure)
**Component**: `_load_model_smart` / `plug_model` handler
**File**: `agent_compiler.py` (~line 742-772)

**Description**:
The v0.8.4 fix claimed to add local `config.json` architecture detection, but all 4 models from local HF cache paths still load as `type: "LLM"`:

| Model | config.json `architectures` | Expected Type | Actual Type |
|-------|---------------------------|---------------|-------------|
| google/gemma-3-1b-it | `["Gemma3ForCausalLM"]` | LLM | LLM ✅ |
| BAAI/bge-small-en-v1.5 | `["BertModel"]` | EMBEDDING | LLM ❌ |
| cross-encoder/ms-marco-MiniLM-L-6-v2 | `["BertForSequenceClassification"]` | RERANKER | LLM ❌ |
| SamLowe/roberta-base-go_emotions | `["RobertaForSequenceClassification"]` | CLASSIFIER | LLM ❌ |

**Detection Signals Available** (verified by reading actual files):

For **bge-small** (EMBEDDING):
- `config.json`: `architectures: ["BertModel"]` — bare BertModel, no task-specific head
- Has `modules.json` file (sentence-transformers marker)
- Has `config_sentence_transformers.json` file
- Has `sentence_bert_config.json` file
- Has `1_Pooling/` directory
- Detection: Check for `modules.json` or `config_sentence_transformers.json` existence → EMBEDDING

For **roberta-go_emotions** (CLASSIFIER):
- `config.json`: `architectures: ["RobertaForSequenceClassification"]`
- `config.json`: `problem_type: "multi_label_classification"`
- `config.json`: `id2label` has 28 emotion labels (admiration, amusement, anger, etc.)
- No `modules.json`, no sentence-transformer markers
- Detection: `ForSequenceClassification` in architecture + `id2label` has >2 labels → CLASSIFIER

For **ms-marco-MiniLM** (RERANKER):
- `config.json`: `architectures: ["BertForSequenceClassification"]`
- `config.json`: `id2label` has only 1 label (`{"0": "LABEL_0"}`)
- `config.json`: has `sbert_ce_default_activation_function` key (cross-encoder marker)
- Path contains `cross-encoder` in the model name
- No `modules.json`, no sentence-transformer markers
- Detection: `ForSequenceClassification` + single label + `sbert_ce_default_activation_function` → RERANKER

**Proposed Detection Algorithm** (in priority order):
```python
# 1. Read config.json from model path
config = json.load(open(os.path.join(model_path, 'config.json')))
architectures = config.get('architectures', [])
arch_str = ' '.join(architectures).lower()

# 2. Check for sentence-transformer markers → EMBEDDING
if os.path.exists(os.path.join(model_path, 'modules.json')):
    return 'EMBEDDING'
if os.path.exists(os.path.join(model_path, 'config_sentence_transformers.json')):
    return 'EMBEDDING'

# 3. Check architecture string
if 'forsequenceclassification' in arch_str or 'fortokenclassification' in arch_str:
    # Distinguish classifier vs reranker
    id2label = config.get('id2label', {})
    if len(id2label) <= 2 or 'sbert_ce_default_activation_function' in config:
        return 'RERANKER'  # cross-encoder with 1-2 labels
    else:
        return 'CLASSIFIER'  # multi-class/multi-label classifier

if 'forcausallm' in arch_str or 'formaskedlm' in arch_str:
    return 'LLM'

if 'seq2seq' in arch_str or 'forconditionalgeneration' in arch_str:
    return 'SEQ2SEQ'

# 4. Bare model (BertModel, etc.) — check for pooling layer
if os.path.exists(os.path.join(model_path, '1_Pooling')):
    return 'EMBEDDING'

# 5. Default fallback
return 'LLM'
```

**Why the v0.8.4 fix likely failed**:
The fix was added to `_load_model_smart` but may be in a code path that's never reached for local paths. The `plug_model` handler might resolve the model path and call a different loading function that bypasses `_load_model_smart`. Or the config.json reading code has a path resolution bug (e.g., looking for config.json in the wrong directory). Need to verify the actual code path taken when plugging a local snapshot path.

---

## BUG C (PERSISTENT): `deliberate` Forces Text Generation on Non-LLM Models

**Severity**: MEDIUM
**Component**: `_council_deliberate` method
**File**: `agent_compiler.py` (~line 4431-4585)

**Description**:
The v0.8.4 fix correctly makes LLM councilors generate text responses. However, it also forces non-LLM models (embedders, rerankers, classifiers) to generate text, producing garbage:

| Slot | Model | text_output |
|------|-------|-------------|
| 0 (llm-gemma) | Gemma 3 1B IT | `"2 + 2 = 4"` ✅ |
| 1 (embed-bge) | BGE Small | `"hitch transcript britain articles progress..."` ❌ garbage |
| 2 (reranker-marco) | MS-MARCO MiniLM | `"alive alive alive alive..."` ❌ garbage |
| 3 (classify-emotions) | RoBERTa GoEmotions | `"reciprocal deleg deleg deleg..."` ❌ garbage |

All non-LLM models report `confidence: 0.7` (the new "successful generation" confidence), even though their output is meaningless.

**Root Cause**:
The deliberate fix calls `model.generate(text=question)` on ALL plugged councilors. Non-LLM models (loaded as LLMWrapper due to Bug B) have a `generate()` method that produces tokens, but since these models aren't trained for text generation, they output random vocabulary tokens.

**Fix Required**:
Even before Bug B is fixed, the deliberate method should check the model's actual capability:
1. If the model has a `_model_type_hint` of EMBEDDING/RERANKER/CLASSIFIER, skip text generation and only contribute embeddings
2. If the model produces garbage (e.g., high token repetition rate, very low perplexity), discard the text and fall back to embedding-only contribution
3. Only count LLM-type models for `consensus_output` text selection

After Bug B is fixed, the `_model_type_hint` check will naturally filter non-LLM models.

---

## BUG D (PERSISTENT): `pipe` Appends Unrequested Slot 0 as Fallback

**Severity**: MEDIUM
**Component**: `pipe` MCP tool handler
**File**: `agent_compiler.py` (pipe handler)

**Description**:
`pipe(input_text="...", pipeline=[1])` executes slot 1 AND slot 0. Slot 0 was not in the requested pipeline.

**Evidence**:
```json
{
  "trace": [
    {"slot": "input", "output": "What are the key innovations..."},
    {"slot": 1, "type": "generate", "output": "subjectsc đ primarily..."},  // garbage from embedder
    {"slot": 0, "type": "generate", "output": "llm-gemma\n"}  // unrequested
  ]
}
```

Pipeline was `[1]` but trace shows slots 1 AND 0. This was reported as Bug 6 in v0.8.4 and marked "not reproducible" but it IS reproducible.

**Root Cause Hypothesis**:
The pipe handler may have a fallback that appends slot 0 when the pipeline output is empty or when an error occurs. Or the pipeline parameter is being extended with a default slot.

---

## BUG E (PERSISTENT): `chain` Defaults to Slot 0 on Empty Sequence

**Severity**: LOW
**Component**: `chain` MCP tool handler
**File**: `agent_compiler.py` (chain handler)

**Description**:
`chain(slot_sequence=[], text="test passthrough")` executes slot 0 instead of returning an error or passthrough.

**Evidence**:
```json
{"chain": [0], "trace": [{"slot": "input"}, {"slot": 0, "name": "llm-gemma"}]}
```

Was reported as Bug 8 in v0.8.4 and marked "already fixed" but it is NOT fixed.

---

## Summary & Priority

| # | Bug | Severity | Status | Depends On |
|---|-----|----------|--------|------------|
| B | Smart loader doesn't detect model types | CRITICAL | Persistent from v0.8.4 | — |
| A | Skip propagation too aggressive (merge/output skipped) | HIGH | NEW in v0.8.4 | — |
| C | deliberate forces text gen on non-LLM models | MEDIUM | Persistent | Bug B |
| D | pipe appends unrequested slot 0 | MEDIUM | Persistent | — |
| E | chain defaults to slot 0 on empty | LOW | Persistent | — |

**Priority order**: Bug B → Bug A → Bug C → Bug D → Bug E

Bug B is the root cause for 4 other bugs (3, 5, 9, C). Fixing it will cascade-fix classify, pipe type routing, rerank cross-encoder scoring, and deliberate garbage filtering.

Bug A is a regression from the v0.8.4 if-node fix — the skip logic needs to distinguish between "all upstream skipped" (skip) and "some upstream skipped" (execute for merge/output nodes).
