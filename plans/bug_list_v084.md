# Bug List — v0.8.4 Candidates

Discovered during Hydra Workflow Orchestration & Evolutionary Adapter testing session.
Date: 2026-02-23

---

## BUG 1: Workflow `if` Node Does Not Skip Unrouted Branches

**Severity**: HIGH (performance waste, correctness concern)
**Component**: Workflow Engine — `WorkflowExecutor._execute_node()` / DAG traversal
**File**: `agent_compiler.py` (WorkflowExecutor class)

**Description**:
When an `if` node routes to one branch (e.g., `architect_branch`), ALL other branches still execute to completion. The `merge` node at the end correctly picks the routed branch's output (`mode: "first"`, `selected: "architect_branch"`), but the engine wastes significant time running the unrouted branches.

**Evidence** (3 separate workflow executions):

| Run | Routed To | Unrouted Branches Executed | Wasted Time |
|-----|-----------|---------------------------|-------------|
| ARCHITECT intent | `architect_branch` (64.9s) | `scribe_branch` (66.7s), `scout_branch` (71.7s) | ~138s |
| SCRIBE intent | `architect_branch` (32.4s) | `scribe_branch` (26.7s), `scout_branch` (21.7s) | ~48s |
| Previous session ARCHITECT | `architect_branch` | `scribe_branch` + `scout_branch` | ~128s |

The `check_scribe` if-node correctly shows `status: "skipped"` when the first `route` if-node takes the `architect_branch` path. But the `scribe_branch` and `scout_branch` tool nodes downstream of `check_scribe` still execute with `status: "completed"`.

**Root Cause Hypothesis**:
The DAG executor likely traverses all nodes reachable via `connections` regardless of whether the `if` node's routing marked them as active. The `if` node sets `_branch` metadata but the executor doesn't consult it before running downstream tool nodes. Only the `merge` node respects the routing by picking `mode: "first"`.

**Expected Behavior**:
Nodes downstream of an `if` node's unchosen branch should be skipped (status: `"skipped"`, elapsed: 0ms). Only the chosen branch's nodes should execute.

**Impact**:
Every conditional workflow runs 2-3x slower than necessary. For LLM-heavy branches (30-70s each), this adds minutes of wasted GPU/CPU time per execution.

---

## BUG 2: `deliberate` Tool Returns Raw Embedding Vectors Instead of Text

**Severity**: CRITICAL (breaks all text-based workflow routing)
**Component**: Council consensus / `deliberate` MCP tool handler
**File**: `agent_compiler.py` (deliberate handler + council consensus logic)

**Description**:
The `deliberate` tool returns `consensus_output` as a raw 384-dimensional float array (repeated 12x = 4608 floats) instead of text deliberation. Each councilor's individual output in the `deliberation` dict is also a float array, not text. All councilors report identical `confidence: 0.3`.

**Evidence**:
Called `deliberate` with question: *"Classify this request into ARCHITECT/SCRIBE/SCOUT..."*

Response structure:
```json
{
  "consensus_output": [0.1529, -0.4196, -0.6705, ...],  // 4608 floats
  "councilor_votes": 4,
  "deliberation": {
    "llm-gemma": {"output": [0.1529, ...], "confidence": 0.3},
    "embed-bge": {"output": [0.1529, ...], "confidence": 0.3},
    "reranker-marco": {"output": [0.1529, ...], "confidence": 0.3},
    "classify-emotions": {"output": [0.1529, ...], "confidence": 0.3}
  }
}
```

All 4 councilors return the EXACT SAME float array with the EXACT SAME confidence (0.3). This means:
1. The deliberation is not actually invoking each model's generation/classification capability
2. It's returning the brain's latent state vector (384-dim, tiled to fill the output)
3. The bayesian consensus is operating on identical inputs, making voting meaningless

**Impact on Hydra Router**:
The `if` node condition `{{$node.classify_intent.result}} contains 'ARCHITECT'` evaluates against a stringified float array. Since no text keywords exist in the output, the condition matching falls through to a default, which explains why ALL three hydra-router test runs routed to `architect_branch` regardless of intent.

**Expected Behavior**:
`deliberate` should invoke the LLM slot(s) with the question text and return the generated text response as `consensus_output`. Non-LLM slots (embedder, reranker, classifier) should either be skipped for deliberation or contribute embeddings that get decoded back to text.

---

## BUG 3: `classify` Tool Cannot Find Classification Model

**Severity**: MEDIUM
**Component**: `classify` MCP tool handler
**File**: `agent_compiler.py` (classify handler)

**Description**:
Calling `classify(text="I am so excited...")` returns `{"error": "No classification model found in slots"}` despite slot 3 having `classify-emotions` (SamLowe/roberta-base-go_emotions) plugged and visible in the UI.

**Root Cause**:
The `classify` handler scans slots looking for a `ClassifierWrapper` model type, but the model was loaded as `LLMWrapper` (confirmed by `slot_info` returning `model_class: "LLMWrapper"`). The smart loader in `plug_model` didn't detect roberta-base-go_emotions as a sequence classification model.

**Related**: See Bug 4 — direct `invoke_slot` with `mode: "classify"` on slot 3 also fails.

---

## BUG 4: Classifier Model Loaded as LLMWrapper

**Severity**: HIGH (blocks all classification functionality)
**Component**: `plug_model` smart loader / model type detection
**File**: `agent_compiler.py` (plug_model handler, smart loader logic)

**Description**:
`invoke_slot(slot=3, mode="classify", text="...")` fails with `'LLMWrapper' object has no attribute 'predict'`. The model `SamLowe/roberta-base-go_emotions` is a `RobertaForSequenceClassification` model but was wrapped in `LLMWrapper` instead of `ClassifierWrapper`.

**Evidence**:
```json
// slot_info response
{"slot": 3, "name": "classify-emotions", "model_class": "LLMWrapper"}

// invoke_slot response  
{"slot": 3, "status": "error", "error": "'LLMWrapper' object has no attribute 'predict'"}
```

**Root Cause Hypothesis**:
The smart loader's model type detection likely checks `AutoModelForCausalLM` first and succeeds (RoBERTa can be loaded as a generic model), before checking `AutoModelForSequenceClassification`. Or the detection heuristic doesn't check the model's `config.architectures` field which would contain `"RobertaForSequenceClassification"`.

**Expected Behavior**:
Models with `ForSequenceClassification` in their architecture should be loaded as `ClassifierWrapper` with a `predict()` method that returns label/score pairs.

---

## BUG 5: `pipe` Uses Wrong Mode for Non-LLM Slots

**Severity**: MEDIUM
**Component**: `pipe` MCP tool handler
**File**: `agent_compiler.py` (pipe handler)

**Description**:
`pipe(input_text="...", pipeline=[1, 2])` invokes slot 1 (embed-bge, an embedding model) in `generate` mode, producing garbage text output: *"nest count strength pitcher separated nrl nhl vii speedway marijuana twenty20 dt loggednp bjp glory songs nhl willie songs nhl willie..."*

The garbage output is then fed to slot 2 (reranker-marco, a cross-encoder) which crashes with `"index out of range in self"`.

**Evidence**:
```json
{
  "trace": [
    {"slot": 1, "type": "generate", "output": "nest count strength pitcher..."},
    {"slot": 2, "status": "error", "error": "index out of range in self"},
    {"slot": 0, "type": "generate", "output": "llm-gemma\n"}
  ]
}
```

**Root Cause**:
The `pipe` handler doesn't check the model type/wrapper class of each slot in the pipeline. It defaults to `generate` mode for all slots. Embedding models forced into generate mode produce random token sequences from their vocabulary.

**Expected Behavior**:
`pipe` should auto-detect model type per slot: use `embed` mode for embedding models, `rerank` mode for cross-encoders (with appropriate input formatting), `classify` for classifiers, and `generate` only for LLMs.

---

## BUG 6: `pipe` Appends Unrequested Fallback Slot

**Severity**: LOW
**Component**: `pipe` MCP tool handler
**File**: `agent_compiler.py` (pipe handler)

**Description**:
`pipe(input_text="...", pipeline=[1, 2])` executed 3 slots: 1, 2, AND 0. Slot 0 was not in the requested pipeline but appeared in the trace as a fallback after slot 2 errored.

**Expected Behavior**:
If a slot in the pipeline errors, the pipe should either stop with the error or skip that slot — not silently append slot 0 as a fallback. The pipeline should execute exactly the slots specified.

---

## BUG 7: `cull_slot` Doesn't Reset Slot Name After Unplug

**Severity**: LOW (cosmetic, but confusing)
**Component**: `cull_slot` MCP tool handler
**File**: `agent_compiler.py` (cull_slot handler)

**Description**:
After `cull_slot(slot=4)` unplugs the clone, the slot retains the name `llm-gemma_clone_0` instead of resetting to `slot_4`. The UI shows slot 5 (1-indexed) as `EMPTY` but with name `llm-gemma_clone_0`.

**Evidence**:
- `list_slots` shows `all_ids[4] = "llm-gemma_clone_0"` with `plugged: false`
- UI shows the slot as EMPTY but with the stale clone name

**Expected Behavior**:
When a slot is unplugged (via cull or unplug), the slot name should reset to the default `slot_N` format.

---

## BUG 8: `chain` Executes Slot 0 When Given Empty Sequence

**Severity**: LOW
**Component**: `chain` MCP tool handler  
**File**: `agent_compiler.py` (chain handler)

**Description**:
`chain(slot_sequence=[], text="...")` should either return an error ("no slots specified") or return the input text unchanged. Instead it silently defaults to executing slot 0.

**Evidence**:
```json
{
  "chain": [0],
  "trace": [
    {"slot": "input", "value": "List three benefits..."},
    {"slot": 0, "name": "llm-gemma", "type": "generate", "output": "..."}
  ]
}
```

**Expected Behavior**:
Empty `slot_sequence` should return an error or pass-through, not silently invoke slot 0.

---

## BUG 9: Reranker Scoring Appears Inaccurate

**Severity**: MEDIUM (may be model limitation, not code bug)
**Component**: `rerank` MCP tool handler / cross-encoder invocation
**File**: `agent_compiler.py` (rerank handler)

**Description**:
Reranking 5 documents for query "efficient transformer inference optimization" produced questionable rankings:

| Rank | Score | Document | Expected Relevance |
|------|-------|----------|-------------------|
| 1 | 0.748 | Speculative decoding... | ✅ HIGH |
| 2 | 0.683 | Data augmentation... | ❌ LOW |
| 3 | 0.673 | Batch normalization... | ❌ LOW |
| 4 | 0.671 | KV-cache compression... | Should be #2 |
| 5 | 0.640 | Flash attention O(n²)→O(n)... | Should be #2-3 |

The scores are suspiciously compressed (0.64-0.75 range) and the irrelevant documents (data augmentation, batch norm) score higher than highly relevant ones (KV-cache, flash attention).

**Root Cause Hypothesis**:
The cross-encoder may not be receiving properly formatted `[query, document]` pairs. If the rerank handler is passing concatenated strings instead of sentence pairs, the cross-encoder falls back to generic similarity scoring. Alternatively, the model may be loaded as `LLMWrapper` (same as Bug 4) and not using the cross-encoder's `predict()` method.

**Note**: This could also be a limitation of the ms-marco-MiniLM-L-6-v2 model on this specific query. Would need to test with known-good query/doc pairs to confirm.

---

## Summary

| # | Bug | Severity | Component |
|---|-----|----------|-----------|
| 1 | if-node doesn't skip unrouted branches | HIGH | Workflow Engine |
| 2 | deliberate returns float arrays not text | CRITICAL | Council/Deliberate |
| 3 | classify can't find classifier model | MEDIUM | Classify handler |
| 4 | Classifier loaded as LLMWrapper | HIGH | Smart Loader |
| 5 | pipe uses wrong mode for non-LLM slots | MEDIUM | Pipe handler |
| 6 | pipe appends unrequested fallback slot | LOW | Pipe handler |
| 7 | cull_slot doesn't reset slot name | LOW | Cull handler |
| 8 | chain defaults to slot 0 on empty sequence | LOW | Chain handler |
| 9 | Reranker scoring inaccurate | MEDIUM | Rerank handler |

**Priority order for fixes**: Bug 2 → Bug 1 → Bug 4 → Bug 5 → Bug 3 → Bug 9 → Bug 7 → Bug 8 → Bug 6
