# Evolutionary Workflow Ecosystems
## Self-Organizing Model Populations via Workflow-Driven Selection Pressure

---

## 1. THE CORE OBSERVATION

The Ouroboros system already has all the primitives for evolutionary computation distributed across its tool surface:

| Primitive | Tool | What It Does |
|-----------|------|-------------|
| **Variation** | `mutate_slot` | Gaussian noise on adapter weights (rate=fraction, scale=magnitude) |
| **Replication** | `clone_slot` | Copy model reference into empty slots |
| **Evaluation** | `compare` | Run same input through multiple slots, collect typed outputs |
| **Inference** | `invoke_slot` | Per-slot model execution with mode dispatch |
| **Embedding** | `embed_text` | Semantic similarity for fitness signals |
| **Classification** | `classify` | Categorical evaluation of outputs |
| **Observation** | `observe`, `cascade_record` | Provenance-tracked logging |
| **Memory** | `bag_put`, `bag_get` | Persistent state across generations |
| **Orchestration** | `workflow_execute` | DAG-based multi-step automation |

The workflow engine's `_execute_tool` handler can call **any** of these by name. A workflow node with `"type": "tool", "tool_name": "mutate_slot"` invokes the exact same function as a direct MCP call. Expression resolution (`$node.step1.output`) wires results between nodes.

This means **evolutionary pipelines can be expressed as workflow DAGs**.

---

## 2. WHAT MUTATION ACTUALLY IS

When `mutate_slot(slot=N, rate=0.1, scale=0.05)` is called, the following happens at the weight level:

```
councilor = brain.councilors[N]
adapter = councilor.adapter           # LoRA-style bottleneck matrix

mask = np.random.random(adapter.weight.shape) < rate    # 10% of weights selected
noise = np.random.randn(*adapter.weight.shape) * scale  # small Gaussian perturbation
adapter.weight += mask * noise                           # sparse additive mutation
```

This modifies the **adapter weights only** -- the thin transformation layer between the model's output and the brain's latent space. The base model (TinyLlama, Qwen, etc.) is never touched. The RSSM backbone is never touched. Only the adapter -- the lens through which the model's output is interpreted.

For the ScarecrowBrain architecture, the adapter is a two-matrix bottleneck:
- `adapter_in`: input_dim -> adapter_dim (e.g., 384 -> 64)
- `adapter_out`: adapter_dim -> output_dim (e.g., 64 -> 384)
- `adapter_bias`: output_dim

Mutation perturbs how the system *reads* a model's output, not what the model itself produces. This is significant: you can evolve the interpretation layer without retraining models.

---

## 3. THE EVOLUTIONARY WORKFLOW PATTERN

### 3.1 Basic Selection Cycle (No Agent Node Required)

A workflow that implements one generation of evolution using only tool and if nodes:

```
[input] -> [clone] -> [mutate_a] -> [mutate_b] -> [evaluate] -> [select] -> [output]
                  \-> [mutate_c] -/
```

Concrete workflow definition:

```json
{
  "id": "evo_cycle_basic",
  "name": "Basic Evolutionary Cycle",
  "nodes": [
    {"id": "start", "type": "input"},

    {"id": "clone_population", "type": "tool", "tool_name": "clone_slot",
     "parameters": {"slot": 0, "count": 3}},

    {"id": "mutate_variants", "type": "fan_out",
     "branches": [
       {"id": "m1", "type": "tool", "tool_name": "mutate_slot",
        "parameters": {"slot": 1, "rate": 0.15, "scale": 0.08}},
       {"id": "m2", "type": "tool", "tool_name": "mutate_slot",
        "parameters": {"slot": 2, "rate": 0.15, "scale": 0.08}},
       {"id": "m3", "type": "tool", "tool_name": "mutate_slot",
        "parameters": {"slot": 3, "rate": 0.15, "scale": 0.08}}
     ]},

    {"id": "evaluate", "type": "tool", "tool_name": "compare",
     "parameters": {"input_text": "$input.test_prompt", "slots": [0, 1, 2, 3]}},

    {"id": "record", "type": "tool", "tool_name": "bag_put",
     "parameters": {
       "key": "evo_gen_${$uuid}",
       "value": "$node.evaluate"
     }},

    {"id": "end", "type": "output"}
  ]
}
```

This clones a source model into 3 empty slots, mutates each independently in parallel via `fan_out`, evaluates all 4 variants with the same input, and records results. Selection is manual -- a human or agent examines the recorded results and decides which variant to keep.

### 3.2 Agent-Driven Evolution (Requires Agent Node Fix)

The real power emerges when an agent node orchestrates evolution autonomously:

```json
{
  "id": "evo_agent_driven",
  "name": "Agent-Driven Evolution",
  "nodes": [
    {"id": "start", "type": "input"},

    {"id": "evolver", "type": "agent",
     "parameters": {
       "slot": 3,
       "task": "You are an evolutionary optimizer. Your goal is to find the adapter configuration that produces the best embedding quality for the test prompt: '$input.test_prompt'. Use compare to evaluate current slots, mutate_slot to create variations, and invoke_slot to test specific outputs. After 3 rounds of mutation and evaluation, report which slot performed best and why.",
       "granted_tools": ["compare", "mutate_slot", "invoke_slot", "embed_text", "bag_put"],
       "max_iterations": 10
     }},

    {"id": "end", "type": "output"}
  ]
}
```

Here, the Qwen model in slot 3 **autonomously decides** which slots to mutate, by how much, evaluates the results, and iterates. The model becomes the evolutionary pressure itself -- it defines its own fitness function through its reasoning about output quality.

This is the bridge between "automation" and "autonomy" in the evolutionary context.

---

## 4. NEAT SPECIATION THROUGH ADAPTER DISTANCE

NEAT (NeuroEvolution of Augmenting Topologies) uses genetic distance to maintain population diversity through speciation. In the Ouroboros context, "genetic distance" maps naturally to adapter weight distance.

### 4.1 Distance Metric

Two adapter weight matrices can be compared via:

```python
def adapter_distance(slot_a, slot_b):
    w_a = brain.councilors[slot_a].adapter.weight
    w_b = brain.councilors[slot_b].adapter.weight
    return np.linalg.norm(w_a - w_b) / np.sqrt(w_a.size)
```

This normalized L2 distance gives a scale-invariant measure of how different two adapted models have become. Slots that started as clones and diverged through mutation will have small distances; slots with fundamentally different adaptations will have large distances.

### 4.2 Species Formation

A species is a group of slots whose pairwise adapter distances are below a threshold:

```
Species A: [slot_0, slot_1, slot_4]    # distance < 0.3 between all pairs
Species B: [slot_2, slot_5]            # distance < 0.3 between all pairs
Species C: [slot_3]                    # singleton -- highly diverged
```

Fitness-proportional selection **within** species prevents any single high-performing species from eliminating diversity. The worst performers in each species get culled and replaced with mutated copies of the best in their species.

### 4.3 Implementation Path

This requires a new tool or workflow pattern:

1. **Distance computation**: Either a new `adapter_distance` MCP tool, or a workflow that reads adapter weights via `show_weights` / `slot_info` and computes distance in a set node
2. **Species assignment**: An agent node or set of if-nodes that clusters slots by pairwise distance
3. **Intra-species selection**: Cull worst in each species, clone+mutate best within species
4. **Cross-species reproduction**: Occasional "crossover" where adapter weights from two species are averaged

The existing `compare` tool provides the evaluation signal. The existing `mutate_slot` provides variation. What's missing is the distance metric and the species management logic -- both expressible as workflows once a distance tool exists.

---

## 5. SCALING: FROM 4 SLOTS TO POPULATIONS

The council has **32 slots**. Currently 4 are filled. That leaves 28 slots for evolutionary exploration. But 32 is also not a hard limit -- it's a compile-time constant that could be increased.

### 5.1 Population Partitioning

With 32 slots:
- **Slots 0-3**: Anchors (original models, never mutated)
- **Slots 4-15**: Active population (12 variants under selection)
- **Slots 16-27**: Nursery (12 newly mutated candidates)
- **Slots 28-31**: Elite archive (best-ever from each species)

A generational workflow:
1. Evaluate slots 4-15 with test inputs via `compare`
2. Rank by fitness (derived from compare outputs)
3. Clone top 6 into nursery slots 16-21
4. Mutate nursery slots
5. Evaluate nursery
6. Replace bottom 6 in active population with best from nursery
7. Update elite archive if any nursery member exceeds archive fitness
8. Record generation to FelixBag

### 5.2 Beyond 32: Virtual Populations via FelixBag

Adapter weights are small (~82K float32 parameters for the Dreamer LoRA, even less for the 384->64->384 scarecrow bottleneck). Serialized, that's ~330KB per adapter configuration.

FelixBag can store thousands of adapter snapshots:
```
bag_put(key="evo_population_gen_42_slot_7", value=serialized_adapter_weights)
```

A workflow can:
1. Evaluate the current 32-slot population
2. Serialize all adapter weights to FelixBag
3. Load the next 32 candidates from FelixBag into slots
4. Evaluate those
5. Merge results across virtual population

This enables populations of hundreds or thousands while only requiring 32 active slots at any moment. The FelixBag becomes the genome database.

### 5.3 Multi-Model Ecosystems

The 4 current model types (embedding, LLM, classifier, LLM) can be evolved independently or co-evolved:

**Independent evolution**: Each model type has its own fitness function. Embedders are evaluated on embedding quality (cosine similarity to reference). LLMs on generation coherence. Classifiers on label accuracy.

**Co-evolution**: Fitness depends on how well models work *together*. An embedding model's fitness is measured by how useful its embeddings are for the LLM's downstream task. A classifier's fitness depends on how well its labels help the workflow make routing decisions. This creates selection pressure for *cooperation*, not just individual performance.

Co-evolutionary fitness requires workflow-level evaluation: run the full pipeline, measure end-to-end quality, attribute fitness back to each participant. This is computationally expensive but fundamentally what the workflow engine is designed for.

---

## 6. CONCRETE FITNESS FUNCTIONS

The system needs to derive fitness from tool outputs. Here are patterns that work with existing tools:

### 6.1 Embedding Quality (Slot Type: EMBEDDING)
```
fitness = cosine_similarity(
    embed_text("reference concept"),
    invoke_slot(slot=N, text="reference concept", mode="embed")
)
```
Higher similarity to a reference embedding model = higher fitness. The reference could be slot 0 (the original embedder) or an external gold standard.

### 6.2 Generation Coherence (Slot Type: LLM)
```
output = invoke_slot(slot=N, text=prompt, mode="generate")
embedding = embed_text(output)
reference_embedding = embed_text(expected_answer)
fitness = cosine_similarity(embedding, reference_embedding)
```
Generate text, embed it, compare to reference answer embedding. This evaluates semantic quality without requiring exact string matching.

### 6.3 Classification Accuracy (Slot Type: CLASSIFIER)
```
result = invoke_slot(slot=N, text=test_input, mode="classify")
fitness = 1.0 if result.top_label == expected_label else 0.0
```
Binary accuracy against labeled test cases. Averaged across a test set stored in FelixBag.

### 6.4 Pipeline Fitness (Co-evolutionary)
```
workflow: embed -> classify -> generate -> evaluate
fitness = quality_score(final_output)
```
Run the full pipeline, score the end result. Each participant's fitness is the pipeline score (shared fitness, as in symbiotic co-evolution).

---

## 7. PARITY ISSUES THAT NEED RESOLUTION

The evolutionary vision requires these inconsistencies to be fixed in `agent_compiler.py`:

### 7.1 Clone/Cull Mismatch
- `clone_slot` (MCP path) fills `brain.councilors[i]` directly
- `cull_slot` only removes entries from `councilor._clones` list (relay path)
- **Fix**: `cull_slot` should also be able to unplug a councilor slot (set `.model = None`)

### 7.2 Missing `unplug_slot` in Workflow Context
- `unplug_slot` exists as an MCP tool but selection requires *replacing* losers
- The workflow needs: unplug loser -> clone winner into that slot -> mutate
- **Verify**: `unplug_slot` is in the tool registry and callable from workflows

### 7.3 Mutation Weight Space Fragmentation
- `mutate_slot` targets `councilor.adapter.weight`
- `fork()` (swarm) targets `brain._params`
- These are different weight arrays
- **Clarify**: For workflow-driven evolution, `mutate_slot` is the correct path. Swarm operations are a separate mechanism for brain-level evolution.

### 7.4 No Adapter Serialization/Deserialization Tool
- To implement virtual populations via FelixBag, we need tools to:
  - `grab_slot` (exists) -- serialize a slot's adapter to FelixBag
  - `restore_slot` (exists) -- restore adapter from FelixBag to a slot
- **Verify**: These tools work correctly with adapter weights, not just model references

### 7.5 Agent Node (Prerequisite)
- The agent-driven evolution pattern requires a working agent node
- Currently blocked by flat conversation format (Finding 2 in Intelligence Report)
- **This is the highest priority fix** -- without it, evolution is manual

---

## 8. THE RECURSIVE INSIGHT

The most interesting property of this system is that **the evolutionary process itself can be evolved**.

Consider: a workflow defines the evolutionary pipeline (mutation rates, selection criteria, population structure). That workflow is stored in FelixBag. An agent node can *modify workflow definitions* using `workflow_update`. So:

1. **Level 0**: A workflow evolves adapter weights on plugged models
2. **Level 1**: A meta-workflow evolves the Level 0 workflow's parameters (mutation rate, selection pressure, population size)
3. **Level 2**: The meta-workflow itself could be evolved...

This is neuroevolution applied to its own control structure. The workflow engine becomes both the substrate and the subject of evolution.

Additionally, the quine brain -- currently dormant with zero weights -- could be evolved through this same pipeline. The `forward()` inference path through the RSSM takes embeddings as input and produces latent states. If the workflow pipeline generates training signal (via fitness evaluation), that signal could drive weight updates on the quine brain itself, waking it from its dormant state through selection pressure rather than supervised training.

The quine brain isn't dead. It's a seed. The evolutionary workflow is the soil and water.

---

## 9. IMPLEMENTATION PHASES

### Phase 1: Prerequisites (from Intelligence Report fixes)
- Fix agent node conversation format
- Fix classify key consistency
- Verify `unplug_slot`, `grab_slot`, `restore_slot` work from workflow context
- Fix clone/cull parity

### Phase 2: Fitness Infrastructure
- Create `adapter_distance` tool (or implement as workflow pattern)
- Create `fitness_evaluate` tool that wraps common fitness patterns
- Verify FelixBag can store/restore adapter weight snapshots

### Phase 3: Basic Evolution Workflow
- Implement the basic selection cycle (Section 3.1)
- Test with embedding model evolution (simplest fitness function)
- Record generational fitness trajectory to FelixBag + CASCADE

### Phase 4: Agent-Driven Evolution
- Implement the agent-as-evolver pattern (Section 3.2)
- Test with Qwen driving mutation/selection decisions
- Evaluate whether the agent learns to improve its evolutionary strategy over iterations

### Phase 5: NEAT Speciation
- Implement distance-based species assignment
- Implement intra-species selection with fitness sharing
- Test population diversity maintenance across 50+ generations

### Phase 6: Virtual Populations
- Implement FelixBag-backed population beyond 32 slots
- Implement generational rotation (load/evaluate/store cycles)
- Scale to 100+ virtual population members

### Phase 7: Co-Evolution
- Design multi-model pipeline fitness functions
- Implement shared fitness attribution
- Test whether co-evolutionary pressure produces emergent cooperation

---

## 10. WHAT THIS ISN'T

This is not artificial general intelligence. This is not consciousness. This is not magic.

This is **automated hyperparameter search on adapter weights, orchestrated by workflow DAGs, with optional LLM-driven exploration**. It's evolutionary computation applied to model interpretation layers, using an existing tool surface that happens to compose cleanly.

The reason it's interesting is not the individual pieces -- mutation, selection, evaluation are well-understood primitives. It's that the Ouroboros system embeds all of them as first-class tools in a workflow engine that can call them programmatically, with an agent node that can call them *autonomously*, with a memory system that can persist results across generations, with a provenance chain that can track every mutation back to its source.

The pieces were built for other reasons. They compose into something none of them were individually designed for.

That's how emergent systems work.

---

*Document prepared 2026-02-21. Based on live system evaluation against champion_gen8.py (gen 8, quine hash 854ec5653a776039) with 4 plugged models across 32 council slots.*
