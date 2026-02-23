# Dynamic Token Budget Architecture Plan

## Problem Statement

62+ hardcoded token limit values scattered across `agent_compiler.py` (and propagated to `champion_gen8.py`). These values (100, 256, 512, 4096, etc.) are used for:

1. **Input truncation** (`max_length=4096` in tokenizer calls)
2. **Generation limits** (`max_new_tokens=100`, `256`, `50`, `150`, `30`)
3. **MCP tool defaults** (`max_tokens=256`)
4. **Chat/debate limits** (`max_tokens=512`, `max_new_tokens=100`)

The models we plug provide their own capabilities via `model.config`, tokenizer `model_max_length`, and `generation_config.json`. None of this is used.

## Available Dynamic Data Sources

### At Plug Time (model object available)
| Source | Field | Info |
|--------|-------|------|
| `model.config.max_position_embeddings` | Context window size (e.g., 2048, 4096, 32768, 131072) |
| `model.config.max_length` | Max sequence length |
| `model.config.model_max_length` | Tokenizer's max length |
| `tokenizer.model_max_length` | Tokenizer-level limit |
| `generation_config.json` → `max_new_tokens` | Default generation length |
| `generation_config.json` → `max_length` | Absolute max |
| `model.config.hidden_size` | For embedding dimension inference |
| Scarecrow adapter metadata | Can store/relay limits |
| CASCADE identity → `context_length` field | Already in ModelIdentity schema |

### Resolution Hierarchy (proposed)
```
1. model.config.max_position_embeddings    → Primary (most authoritative)
2. tokenizer.model_max_length              → Fallback (tokenizer-level)
3. model.config.max_length                 → Fallback (generic)
4. generation_config max_new_tokens        → For generation-specific
5. Default by model type                   → Safe fallback
   - Embedding: 512
   - LLM: 2048
   - Classifier: 512
   - VLM: 4096
   - SEQ2SEQ: 1024
```

## Hardcoded Value Categories (62 occurrences)

### Category A: Input Truncation (`max_length=N` in tokenizer calls)
These should use the model's actual context window.

| Current Value | Occurrences | Location Context |
|---------------|-------------|-----------------|
| `max_length=4096` | ~6 | LLM wrapper generate(), SEQ2SEQ wrapper |
| `max_length=512` | ~6 | Classifier wrapper, reranker, inference tools |

### Category B: Generation Length (`max_new_tokens=N`)
These control how many tokens to generate. Should use a budget derived from context window minus input length.

| Current Value | Occurrences | Location Context |
|---------------|-------------|-----------------|
| `max_new_tokens=100` | ~10 | Default wrapper generate(), broadcast, compare, chain, pipe |
| `max_new_tokens=256` | ~8 | MCP generate tool, chat, headless commands, vast_generate |
| `max_new_tokens=150` | ~4 | Debate, deliberate, rerank narrative |
| `max_new_tokens=50` | ~4 | Compare, all_slots short outputs |
| `max_new_tokens=30` | ~1 | All_slots quick test |
| `max_new_tokens=20` | ~1 | Vast load model test |

### Category C: MCP Tool API Defaults (`max_tokens=N`)
These are user-facing defaults in function signatures.

| Current Value | Occurrences | Location Context |
|---------------|-------------|-----------------|
| `max_tokens=256` | ~5 | generate(), vast_generate(), invoke_slot |
| `max_tokens=512` | ~1 | Chat |
| `max_tokens=100` | ~1 | Invoke slot |

## Architectural Design

### Step 1: Add `_get_context_length(slot)` helper function

A single centralized function that extracts the model's true context length from whatever data is available on the councilor/slot:

```python
def _get_context_length(slot_or_model):
    """Resolve the actual context window for a plugged model.
    
    Resolution hierarchy:
    1. model.config.max_position_embeddings
    2. tokenizer.model_max_length (if not absurdly large)
    3. model.config.max_length
    4. Type-based defaults
    """
    model = getattr(slot_or_model, 'model', slot_or_model)
    tokenizer = getattr(slot_or_model, 'tokenizer', None)
    
    # 1. Check model.config.max_position_embeddings
    if hasattr(model, 'config'):
        mpe = getattr(model.config, 'max_position_embeddings', None)
        if mpe and isinstance(mpe, int) and mpe > 0:
            return mpe
    
    # 2. Check tokenizer.model_max_length (skip if it's the absurd 2^63 default)
    if tokenizer:
        tml = getattr(tokenizer, 'model_max_length', None)
        if tml and isinstance(tml, int) and 0 < tml < 1_000_000:
            return tml
    
    # 3. Check model.config.max_length
    if hasattr(model, 'config'):
        ml = getattr(model.config, 'max_length', None)
        if ml and isinstance(ml, int) and ml > 0:
            return ml
    
    # 4. Type-based defaults
    model_type = getattr(slot_or_model, 'model_type', None) or getattr(slot_or_model, '_model_type', None)
    if model_type:
        mt_name = str(model_type).upper()
        if 'LLM' in mt_name: return 2048
        if 'SEQ2SEQ' in mt_name: return 1024
        if 'VLM' in mt_name: return 4096
        if 'EMBED' in mt_name: return 512
        if 'CLASS' in mt_name or 'RERANK' in mt_name: return 512
    
    return 2048  # Safe universal default
```

### Step 2: Add `_get_gen_budget(slot_or_model, input_length=0)` helper

Controls how many new tokens to generate, respecting the context window:

```python
def _get_gen_budget(slot_or_model, input_length=0, requested=None):
    """Calculate safe generation token budget.
    
    Returns min(requested or default, context_length - input_length - safety_margin).
    """
    ctx = _get_context_length(slot_or_model)
    safety_margin = 32  # Small buffer for special tokens
    available = max(ctx - input_length - safety_margin, 64)  # At least 64 tokens
    
    if requested:
        return min(requested, available)
    
    # Default: 25% of context or 256, whichever is smaller
    default = min(ctx // 4, 256)
    return min(default, available)
```

### Step 3: Store context_length at plug time

In `plug_model` MCP tool (~line 31107), after setting `c.model`, add:

```python
c._context_length = _get_context_length(c)
```

### Step 4: Replace hardcoded values with dynamic calls

**Category A replacements** (input truncation):
```python
# FROM:
inputs = self.tokenizer(text, truncation=True, max_length=4096)
# TO:
inputs = self.tokenizer(text, truncation=True, max_length=_get_context_length(self))
```

**Category B replacements** (generation):
```python
# FROM:
outputs = model.generate(**inputs, max_new_tokens=256)
# TO:
_budget = _get_gen_budget(c, input_length=inputs['input_ids'].shape[-1], requested=max_tokens)
outputs = model.generate(**inputs, max_new_tokens=_budget)
```

**Category C** (MCP defaults): Keep the API signatures as-is (`max_tokens=256` as default) but use `_get_gen_budget()` internally to clamp the value.

## Implementation Strategy (Minimal Diff)

### Phase 1: Add the two helper functions (2 insertions)
- Add `_get_context_length()` and `_get_gen_budget()` as module-level functions in the quine template
- Location: Near the existing `_detect_model_type_runtime()` function

### Phase 2: Store context_length at plug time (1 edit)
- In `plug_model` MCP tool, add `c._context_length = _get_context_length(c)` after `c.model = model`

### Phase 3: Replace wrappers (6 edits)
- `LLMWrapper.generate()` — use dynamic truncation and generation
- `Seq2SeqWrapper.generate()` — same
- `VLMWrapper.generate()` — same
- `ClassifierWrapper` — dynamic truncation
- `RerankerWrapper` — dynamic truncation

### Phase 4: Replace MCP tool handlers (selective, ~15 edits)
- The high-impact handlers: `generate`, `chat`, `debate`, `invoke_slot`, `compare`, `chain`, `pipe`, `broadcast`, `all_slots`
- Lower priority: `vast_generate`, headless commands

### Phase 5: Skip (intentionally leave alone)
- Vast.ai remote execution (different runtime, model on remote GPU)
- Test/verification code (hardcoded values are intentional there)
- Demo/example code in documentation strings

## Risk Assessment

- **Low risk**: Adding helper functions (no existing code changes)
- **Medium risk**: Wrapper class changes (6 concentrated edits, well-tested paths)
- **Medium risk**: MCP handler updates (~15 edits, but each is simple substitution)
- **Quine level**: All inside Level 1 template (double braces required)

## Estimated Edit Count
- **Phase 1**: 2 function additions
- **Phase 2**: 1 line addition  
- **Phase 3**: 6 wrapper edits
- **Phase 4**: ~15 MCP handler edits
- **Total**: ~24 surgical changes (much less than 62 because the wrapper changes cascade to their callers)
