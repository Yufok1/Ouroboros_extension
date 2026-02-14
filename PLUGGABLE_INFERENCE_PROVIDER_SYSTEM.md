# Pluggable Inference Provider System

## Label: PIPS — Champion Plug Slots

## For: Neural Network Coder

---

## Core Concept

The Champion Council already has **plug slots** — named positions where models are hot-swapped at runtime via `plug_model`, `unplug_slot`, `clone_slot`, `mutate_slot`, `swap_slots`. Currently these slots accept HuggingFace model IDs and load them locally or on Vast.ai GPUs.

**PIPS extends this to accept ANY inference provider as a plug.** A slot doesn't care if the inference comes from a local GGUF, an OpenAI API, a Bittensor subnet, an Akash deployment, or a self-hosted Ollama instance. The slot is a **universal socket**. The provider is a **cartridge**.

Think of it like a mixing board in a recording studio. Each channel (slot) has the same interface — input goes in, output comes out. But the source on each channel can be a microphone, a synthesizer, a turntable, or a satellite feed. The mixing board doesn't care. It mixes.

**Multiple providers running in concerto** = the council deliberates across heterogeneous inference sources simultaneously. A local embedding model on slot 0, GPT-4 on slot 1, a Bittensor text subnet on slot 2, a fine-tuned Llama on Akash on slot 3. All deliberating on the same prompt. The council's fusion layer combines their outputs.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                CHAMPION COUNCIL                  │
│                                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐│
│  │ SLOT 0  │ │ SLOT 1  │ │ SLOT 2  │ │ SLOT N ││
│  │         │ │         │ │         │ │        ││
│  │ ┌─────┐ │ │ ┌─────┐ │ │ ┌─────┐ │ │ ┌────┐ ││
│  │ │PLUG │ │ │ │PLUG │ │ │ │PLUG │ │ │ │PLUG│ ││
│  │ └──┬──┘ │ │ └──┬──┘ │ │ └──┬──┘ │ │ └──┬─┘ ││
│  └────┼────┘ └────┼────┘ └────┼────┘ └────┼───┘│
│       │           │           │            │    │
│  ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼───┐│
│  │PROVIDER │ │PROVIDER │ │PROVIDER │ │PROVIDER││
│  │ADAPTER  │ │ADAPTER  │ │ADAPTER  │ │ADAPTER ││
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬───┘│
└───────┼──────────┼──────────┼──────────┼──────┘
        │          │          │          │
   ┌────▼───┐ ┌───▼────┐ ┌──▼─────┐ ┌──▼─────┐
   │ LOCAL  │ │ OPENAI │ │BITTENSOR│ │ AKASH  │
   │ MODEL  │ │  API   │ │ SUBNET │ │  ML    │
   │(GGUF/  │ │(GPT-4/ │ │(TAO    │ │(Llama  │
   │ HF)    │ │ Claude)│ │ miners)│ │ 70B)   │
   └────────┘ └────────┘ └────────┘ └────────┘
```

---

## Provider Adapter Interface

Every provider implements the same interface. This is the contract.

```python
class InferenceProviderAdapter:
    """Universal adapter interface for any inference provider."""
    
    # ── IDENTITY ──
    provider_id: str          # e.g. "openai", "bittensor-sn1", "akash-ml", "local-gguf"
    provider_type: str        # "api", "decentralized", "local", "p2p"
    display_name: str         # Human-readable name for UI
    
    # ── CAPABILITIES ──
    supports_streaming: bool  # Can stream tokens
    supports_embeddings: bool # Can generate embeddings
    supports_images: bool     # Can generate/process images
    max_context: int          # Max tokens in context window
    
    # ── LIFECYCLE ──
    async def connect(self, config: dict) -> bool:
        """Initialize connection to the provider. Returns True if ready."""
        ...
    
    async def disconnect(self) -> None:
        """Clean shutdown."""
        ...
    
    def is_available(self) -> bool:
        """Health check. Is this provider currently reachable?"""
        ...
    
    # ── CORE INFERENCE ──
    async def forward(self, prompt: str, **kwargs) -> str:
        """Run inference. This is the universal entry point.
        
        kwargs may include:
            temperature: float
            max_tokens: int
            stop_sequences: list[str]
            system_prompt: str
            format: str  # "text", "json", "embedding"
        
        Returns: generated text (or JSON string for structured output)
        """
        ...
    
    async def embed(self, text: str) -> list[float]:
        """Generate embedding vector. Raises if not supported."""
        ...
    
    async def stream(self, prompt: str, **kwargs) -> AsyncIterator[str]:
        """Stream tokens. Raises if not supported."""
        ...
    
    # ── METADATA ──
    def get_metrics(self) -> dict:
        """Return current metrics: latency_ms, tokens_used, cost_estimate, etc."""
        ...
    
    def get_cost_estimate(self, prompt_tokens: int, completion_tokens: int) -> float:
        """Estimate cost in sats for this inference call."""
        ...
```

---

## Provider Registry

```python
class ProviderRegistry:
    """Manages available inference providers and their configurations."""
    
    providers: dict[str, type[InferenceProviderAdapter]]  # id -> adapter class
    configs: dict[str, dict]      # id -> saved configuration
    active: dict[int, str]        # slot_index -> provider_id
    
    def register(self, provider_id: str, adapter_class: type[InferenceProviderAdapter]):
        """Register a new provider type."""
        ...
    
    def list_providers(self) -> list[dict]:
        """List all registered providers with their capabilities."""
        ...
    
    async def plug(self, slot: int, provider_id: str, config: dict = None) -> bool:
        """Plug a provider into a council slot.
        
        This replaces the current plug_model for that slot.
        Config contains provider-specific settings (API keys, endpoints, etc.)
        """
        ...
    
    async def unplug(self, slot: int) -> bool:
        """Remove provider from slot."""
        ...
    
    def get_adapter(self, slot: int) -> InferenceProviderAdapter | None:
        """Get the active adapter for a slot."""
        ...
```

---

## Built-in Provider Adapters

### 1. LocalModelAdapter
```python
class LocalModelAdapter(InferenceProviderAdapter):
    """Local HuggingFace / GGUF models. Current behavior."""
    provider_id = "local"
    provider_type = "local"
    
    # Wraps existing plug_model / forward logic
    # Zero network dependency
    # Best for: embeddings, small models, offline use
```

### 2. OpenAICompatibleAdapter
```python
class OpenAICompatibleAdapter(InferenceProviderAdapter):
    """Any OpenAI-compatible API: OpenAI, Anthropic, Together, Groq, Ollama, LMStudio, vLLM."""
    provider_id = "openai-compat"
    provider_type = "api"
    
    # Config:
    #   base_url: str  (e.g. "https://api.openai.com/v1", "http://localhost:11434/v1")
    #   api_key: str
    #   model: str     (e.g. "gpt-4", "claude-3-opus", "llama-3.1-70b")
    #
    # This single adapter covers:
    #   - OpenAI (GPT-4, o1, etc.)
    #   - Anthropic (via proxy or native)
    #   - Together AI (open-source models)
    #   - Groq (ultra-fast inference)
    #   - Ollama (local, OpenAI-compat endpoint)
    #   - LM Studio (local, OpenAI-compat endpoint)
    #   - vLLM (self-hosted, OpenAI-compat endpoint)
    #   - Any LiteLLM-proxied endpoint
```

### 3. LiteLLMAdapter
```python
class LiteLLMAdapter(InferenceProviderAdapter):
    """LiteLLM proxy — routes to 100+ providers through a single interface."""
    provider_id = "litellm"
    provider_type = "api"
    
    # LiteLLM supports:
    #   OpenAI, Anthropic, Google (Gemini/PaLM), AWS Bedrock, Azure,
    #   Cohere, Replicate, Hugging Face Inference API, Together, Anyscale,
    #   Fireworks, Perplexity, Deepseek, Mistral, Groq, Cerebras, SAP...
    #
    # Config:
    #   model: str  (e.g. "anthropic/claude-3-opus", "together/meta-llama/Llama-3.1-70B")
    #   api_key: str (per-provider)
    #
    # This is the "I just want it to work" adapter.
    # LiteLLM handles routing, retries, fallbacks, cost tracking.
```

### 4. BittensorAdapter
```python
class BittensorAdapter(InferenceProviderAdapter):
    """Bittensor decentralized AI network — inference from competing miners."""
    provider_id = "bittensor"
    provider_type = "decentralized"
    
    # Config:
    #   subnet: int       (e.g. 1 for text generation, 4 for embeddings)
    #   wallet_name: str  (Bittensor coldkey)
    #   network: str      ("finney" for mainnet, "test" for testnet)
    #
    # How it works:
    #   1. Connect to Bittensor network via subtensor
    #   2. Query miners on the specified subnet
    #   3. Miners compete to provide best inference
    #   4. Validators score responses
    #   5. Best response returned
    #
    # Cost: TAO tokens (staked, not spent per query on most subnets)
    # Latency: Higher (network hop + miner competition)
    # Quality: Variable but improving (validator scoring)
    #
    # Best for: censorship-resistant inference, diverse model access
```

### 5. AkashMLAdapter
```python
class AkashMLAdapter(InferenceProviderAdapter):
    """Akash Network managed AI inference — decentralized cloud GPU."""
    provider_id = "akash-ml"
    provider_type = "decentralized"
    
    # Config:
    #   endpoint: str     (AkashML API endpoint)
    #   api_key: str      (AkashML API key)
    #   model: str        (e.g. "meta-llama/Llama-3.1-70B")
    #
    # Pricing: $0.0001/token for 70B models (vs $0.01+ on centralized)
    # Latency: Comparable to centralized (dedicated GPU)
    # 
    # Best for: cost-efficient large model inference
```

### 6. VastAIAdapter
```python
class VastAIAdapter(InferenceProviderAdapter):
    """Vast.ai GPU marketplace — existing integration, now as adapter."""
    provider_id = "vast"
    provider_type = "p2p"
    
    # Wraps existing vast_search/vast_rent/vast_connect logic
    # Into the universal adapter interface
    # Best for: custom deployments, fine-tuned models, training
```

### 7. RitualAdapter (Verifiable)
```python
class RitualAdapter(InferenceProviderAdapter):
    """Ritual Network — verifiable AI inference with ZK-proofs."""
    provider_id = "ritual"
    provider_type = "decentralized"
    
    # Returns inference result + cryptographic proof
    # Proof can be verified on-chain
    # 
    # Extra method:
    async def forward_verified(self, prompt: str, **kwargs) -> tuple[str, bytes]:
        """Returns (result, zk_proof)"""
        ...
    
    # Best for: high-trust inference where you need to PROVE the result
    # Use case: marketplace listings that claim "generated by GPT-4" — prove it
```

---

## Orchestration Layer — The Concerto

The magic happens when multiple providers run simultaneously.

```python
class InferenceConcerto:
    """Orchestrates multiple inference providers across council slots."""
    
    async def deliberate(self, prompt: str, slots: list[int] = None) -> dict:
        """Send prompt to multiple slots simultaneously, fuse results.
        
        Returns:
            {
                "fused": str,           # Combined/best result
                "individual": [         # Per-slot results
                    {"slot": 0, "provider": "local", "result": "...", "latency_ms": 45},
                    {"slot": 1, "provider": "openai-compat", "result": "...", "latency_ms": 320},
                    {"slot": 2, "provider": "bittensor", "result": "...", "latency_ms": 1200},
                ],
                "fusion_method": str,   # "majority_vote", "quality_weighted", "concatenate"
                "cost_sats": int,       # Total cost across all providers
                "verified": bool,       # True if any slot used Ritual verification
            }
        """
        ...
    
    async def cascade_inference(self, prompt: str, quality_threshold: float = 0.8) -> str:
        """Cascading inference: try cheapest provider first, escalate if quality is low.
        
        Strategy:
            1. Try local model (free)
            2. If confidence < threshold, try Akash/Bittensor (cheap)  
            3. If still low, try OpenAI/Anthropic (expensive but reliable)
            4. Return best result with cost tracking
        """
        ...
    
    async def ensemble(self, prompt: str, method: str = "quality_weighted") -> str:
        """Ensemble inference across all active slots.
        
        Methods:
            - "majority_vote": Most common answer wins
            - "quality_weighted": Weight by provider's historical quality score
            - "cost_weighted": Prefer cheaper providers unless quality drops
            - "latency_first": Return fastest response above quality threshold
            - "best_of_n": Generate N responses, score all, return best
        """
        ...
```

---

## MCP Tool Interface

New tools exposed via MCP for the VS Code extension and IDE agents:

```python
@tool
def plug_provider(slot: int, provider_id: str, config: str = "{}") -> str:
    """Plug an inference provider into a council slot.
    
    Args:
        slot: Slot index (0-based)
        provider_id: Provider type ("local", "openai-compat", "litellm", 
                     "bittensor", "akash-ml", "vast", "ritual")
        config: JSON config string. Provider-specific. Examples:
            local: '{"model_id": "BAAI/bge-small-en"}'
            openai-compat: '{"base_url": "https://api.openai.com/v1", "api_key": "sk-...", "model": "gpt-4"}'
            litellm: '{"model": "anthropic/claude-3-opus", "api_key": "sk-ant-..."}'
            bittensor: '{"subnet": 1, "network": "finney"}'
            akash-ml: '{"model": "meta-llama/Llama-3.1-70B", "api_key": "..."}'
    """
    ...

@tool
def list_providers() -> str:
    """List all registered inference providers and their capabilities."""
    ...

@tool
def provider_status() -> str:
    """Get status of all active providers: latency, cost, tokens used, health."""
    ...

@tool  
def concerto_deliberate(prompt: str, slots: str = "all") -> str:
    """Run inference across multiple providers simultaneously and fuse results.
    
    Args:
        prompt: The inference prompt
        slots: Comma-separated slot indices, or "all" for all active slots
    """
    ...

@tool
def concerto_cascade(prompt: str, quality_threshold: float = 0.8) -> str:
    """Cascading inference: try cheap first, escalate if quality is low."""
    ...

@tool
def estimate_cost(prompt: str, provider_id: str = "all") -> str:
    """Estimate cost in sats for running this prompt on specified provider(s)."""
    ...
```

---

## Configuration Persistence

Provider configs are stored securely:
- **API keys**: VS Code SecretStorage (encrypted, per-workspace)
- **Provider preferences**: globalState (which providers on which slots)
- **Cost budgets**: globalState (max sats per inference, per session)
- **Quality history**: globalState (per-provider quality scores over time)

```json
{
    "pips.slots": {
        "0": { "provider": "local", "config": { "model_id": "BAAI/bge-small-en" } },
        "1": { "provider": "openai-compat", "config": { "model": "gpt-4o" } },
        "2": { "provider": "bittensor", "config": { "subnet": 1 } },
        "3": { "provider": "akash-ml", "config": { "model": "meta-llama/Llama-3.1-70B" } }
    },
    "pips.budget": {
        "max_sats_per_call": 100,
        "max_sats_per_session": 10000,
        "prefer_free_first": true
    },
    "pips.fusion": {
        "default_method": "quality_weighted",
        "quality_threshold": 0.8,
        "cascade_enabled": true
    }
}
```

---

## VS Code Extension UI

The Marketplace tab gets a new section: **INFERENCE PROVIDERS**

```
┌─ INFERENCE PROVIDERS ──────────────────────────┐
│                                                 │
│  SLOT 0  ● LOCAL          BAAI/bge-small-en    │
│          Embeddings | 0ms avg | FREE            │
│                                                 │
│  SLOT 1  ● OPENAI         gpt-4o               │
│          Text+Stream | 320ms avg | ~2 sat/call  │
│                                                 │
│  SLOT 2  ○ BITTENSOR      Subnet 1 (Text Gen)  │
│          Text | 1.2s avg | ~0.5 sat/call        │
│                                                 │
│  SLOT 3  ● AKASH ML       Llama-3.1-70B        │
│          Text+Stream | 180ms avg | ~0.1 sat/call│
│                                                 │
│  [+ ADD PROVIDER]  [DELIBERATE ALL]  [CASCADE]  │
│                                                 │
│  Budget: 847/10000 sats this session            │
│  Last deliberation: 4 slots, 890ms, 3.2 sats   │
└─────────────────────────────────────────────────┘
```

---

## Payment Integration

Every provider adapter reports cost. The system tracks:
- **Per-call cost** in sats (or fractions)
- **Per-session budget** with hard cap
- **Cost comparison** across providers for the same prompt
- **Auto-routing** to cheapest provider above quality threshold

For decentralized providers (Bittensor, Akash), payments happen in native tokens. The PIPS layer handles conversion:
- Lightning sats → TAO (Bittensor) via DEX API
- Lightning sats → AKT (Akash) via DEX API  
- Or: user pre-funds provider accounts directly

---

## Implementation Priority

### Phase 1: Adapter Interface + OpenAI-Compatible
- Define the `InferenceProviderAdapter` base class
- Implement `OpenAICompatibleAdapter` (covers OpenAI, Ollama, LM Studio, vLLM, Together, Groq)
- Implement `LiteLLMAdapter` (covers 100+ providers instantly)
- Refactor existing `plug_model` to use `LocalModelAdapter`
- New MCP tools: `plug_provider`, `list_providers`, `provider_status`

### Phase 2: Concerto Orchestration
- Implement `InferenceConcerto` with deliberate/cascade/ensemble
- New MCP tools: `concerto_deliberate`, `concerto_cascade`
- Cost tracking and budget system
- VS Code UI for provider management

### Phase 3: Decentralized Providers
- Implement `BittensorAdapter`
- Implement `AkashMLAdapter`
- Implement `RitualAdapter` (verifiable inference)
- Cross-provider payment routing

### Phase 4: Marketplace Integration
- Publish provider configurations as marketplace "recipes"
- Share slot configurations: "My GPT-4 + Bittensor + Local setup"
- Rate and review provider performance in marketplace
- Zap providers whose configurations you benefit from

---

*Document: Pluggable Inference Provider System (PIPS)*  
*Label: Champion Plug Slots*
*For: Neural Network Coder*  
*Generated: Feb 13, 2026*
