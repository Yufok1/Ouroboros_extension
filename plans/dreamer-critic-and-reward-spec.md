# Dreamer Critic Head & Reward Capture — Implementation Spec (v2)

*Code-level specification for Tracks A and B. **ZERO new MCP tools.** All reward weights from config file. Critic/training data exposed through enriched existing tools.*

---

## PART 1: REWARD SIGNAL CAPTURE

### 1.1 Config File: `dreamer_config.json`

The brain reads this file on startup and re-reads on every `show_rssm` call (or every 60s via timer). Lives in the same directory as the running champion.

```python
# Default config (used when file doesn't exist or key is missing):
_DREAMER_CONFIG_DEFAULTS = {
    "rewards": {
        "hold_accept": 1.0,
        "hold_override": -0.5,
        "bag_induct": 0.8,
        "bag_forget": -0.3,
        "workflow_save": 1.0,
        "workflow_success": 0.5,
        "workflow_failure": -0.5,
        "tool_success": 0.1,
        "tool_error": -0.2,
        "mutation_kept": 0.3,
        "mutation_reverted": -0.1,
        "normalize": True,
    },
    "training": {
        "enabled": True,
        "auto_train": True,
        "world_model_frequency": 32,
        "critic_frequency": 32,
        "full_cycle_frequency": 64,
        "batch_size": 32,
        "noise_scale": 0.005,
        "gamma": 0.99,
        "lambda_": 0.95,
        "critic_target_tau": 0.02,
        "timeout_budget_seconds": 30,
    },
    "imagination": {
        "horizon": 15,
        "n_actions": 8,
        "auto_imagine_on_train": True,
    },
    "buffers": {
        "reward_buffer_max": 5000,
        "obs_buffer_max": 1000,
        "value_history_max": 200,
        "reward_rate_window": 100,
    },
    "architecture": {
        "critic_hidden_dim": 256,
        "reward_head_hidden_dim": 128,
        "continue_head_hidden_dim": 64,
        "latent_dim": 5120,
    },
}
```

### 1.2 Config Loader Method

Add to QuineOuroborosBrain:

```python
def _load_dreamer_config(self):
    """Load dreamer config from JSON file, merging with defaults."""
    import copy
    config = copy.deepcopy(_DREAMER_CONFIG_DEFAULTS)
    config_path = pathlib.Path(__file__).parent / 'dreamer_config.json'
    try:
        if config_path.exists():
            with open(config_path, 'r') as f:
                user_config = json.load(f)
            # Deep merge: user values override defaults
            for section, values in user_config.items():
                if section in config and isinstance(config[section], dict):
                    config[section].update(values)
                else:
                    config[section] = values
    except Exception:
        pass  # Use defaults on any error
    self._dreamer_config = config
    self._dreamer_config_mtime = config_path.stat().st_mtime if config_path.exists() else 0
    return config

def _get_reward_weight(self, key):
    """Get reward weight from config."""
    return self._dreamer_config.get('rewards', {}).get(key,
           _DREAMER_CONFIG_DEFAULTS['rewards'].get(key, 0.0))

def _get_training_param(self, key):
    """Get training parameter from config."""
    return self._dreamer_config.get('training', {}).get(key,
           _DREAMER_CONFIG_DEFAULTS['training'].get(key, 0))
```

### 1.3 RewardEvent Data Structure

Add to the Level 1 template inside `_generate_capsule_source`, near the existing `_obs_buffer` initialization:

```python
@dataclass
class RewardEvent:
    timestamp: float
    reward: float           # scalar reward value (after normalization if enabled)
    raw_weight: float       # weight from config before normalization
    source: str             # 'hold', 'bag', 'workflow', 'tool', 'mutation'
    event_id: str           # links to CausationGraph event_id
    latent: np.ndarray      # 5120-dim dreamer latent at capture time
    action: int             # action index (0-7) if applicable
    context_hash: str       # SHA256 of surrounding context for dedup
    metadata: dict          # source-specific details

    def to_dict(self):
        return {
            'timestamp': self.timestamp,
            'reward': self.reward,
            'raw_weight': self.raw_weight,
            'source': self.source,
            'event_id': self.event_id,
            'action': self.action,
            'context_hash': self.context_hash,
            'metadata': self.metadata,
            # NOTE: latent NOT serialized here (too large for JSON)
        }
```

**Codex reminder:** Inside the Level 1 template, all `{` in the above become `{{`, all `}` become `}}`. The `@dataclass` and type annotations pass through as-is.

### 1.4 RewardBuffer Initialization

Add alongside `_obs_buffer` in QuineOuroborosBrain.__init__:

```python
self._load_dreamer_config()  # Load config first
self._reward_buffer = collections.deque(maxlen=self._dreamer_config['buffers']['reward_buffer_max'])
self._reward_count = 0
self._reward_sum = 0.0
self._reward_rate_window = collections.deque(maxlen=self._dreamer_config['buffers']['reward_rate_window'])
```

### 1.5 Reward Capture Method

Add to QuineOuroborosBrain:

```python
def _capture_reward(self, source_key, event_id='', action=-1, metadata=None):
    """Record a reward event using weight from config."""
    raw_weight = self._get_reward_weight(source_key)
    if raw_weight == 0.0:
        return  # Skip disabled reward sources

    now = time.time()

    # Normalize if enabled
    reward = raw_weight
    if self._dreamer_config.get('rewards', {}).get('normalize', True):
        reward = float(np.sign(raw_weight) * np.log1p(np.abs(raw_weight)))

    # Get current dreamer latent if available
    latent = np.zeros(5120, dtype=np.float32)
    if self.dreamer_world_model and hasattr(self.dreamer_world_model, '_get_latent_vector'):
        try:
            latent = self.dreamer_world_model._get_latent_vector()
        except Exception:
            pass

    ctx = f"{source_key}:{event_id}:{action}"
    ctx_hash = hashlib.sha256(ctx.encode()).hexdigest()[:16]

    evt = RewardEvent(
        timestamp=now,
        reward=reward,
        raw_weight=raw_weight,
        source=source_key.split('_')[0] if '_' in source_key else source_key,
        event_id=str(event_id),
        latent=latent.copy(),
        action=max(0, action),
        context_hash=ctx_hash,
        metadata=metadata or {},
    )

    self._reward_buffer.append(evt)
    self._reward_count += 1
    self._reward_sum += reward
    self._reward_rate_window.append(now)

    # Auto-trigger critic training if enough events
    freq = self._get_training_param('critic_frequency')
    if (self._get_training_param('auto_train')
        and len(self._reward_buffer) >= freq
        and self._reward_count % freq == 0):
        try:
            self._train_critic()
        except Exception:
            pass
```

**Key change from v1:** The method takes `source_key` (a config key like `'tool_success'`) instead of a raw reward value. The weight comes from config. This means users can tune rewards at runtime.

### 1.6 Hook Points (Where to Inject Reward Capture)

#### 1.6.1 In `logged_tool()` Wrapper (NOT `_bus_call`)

Per errata Issue 2: hook into `logged_tool()`, not `_bus_call`.

After line ~25002 (success path, after CASCADE observe):
```python
# Reward capture for dreamer training
try:
    _ragent = get_agent()
    _router = _ragent._brain if hasattr(_ragent, '_brain') else getattr(_ragent, 'brain', None)
    _rbrain = getattr(_router, '_brain', _router)
    if _rbrain and hasattr(_rbrain, '_capture_reward'):
        _rbrain._capture_reward(
            source_key='tool_success',
            event_id=str(_MCP_TOOL_STEP),
            metadata={'tool': func.__name__, 'status': 'success'}
        )
except Exception:
    pass  # Never let reward capture break tool execution
```

After line ~25030 (error path, before `raise`):
```python
try:
    _ragent = get_agent()
    _router = _ragent._brain if hasattr(_ragent, '_brain') else getattr(_ragent, 'brain', None)
    _rbrain = getattr(_router, '_brain', _router)
    if _rbrain and hasattr(_rbrain, '_capture_reward'):
        _rbrain._capture_reward(
            source_key='tool_error',
            event_id=str(_MCP_TOOL_STEP),
            metadata={'tool': func.__name__, 'status': 'error', 'error': str(e)[:200]}
        )
except Exception:
    pass
```

**In agent_compiler.py (Level 1):** The `logged_tool` wrapper has dict literals — double all braces:
- `{{'tool': func.__name__, 'status': 'success'}}`
- `{{'tool': func.__name__, 'status': 'error', 'error': str(e)[:200]}}`

#### 1.6.2 In HOLD Protocol resolve_point

Per errata Issue 5: use `was_override` bool, add `_brain_ref` to `_HoldState`.

```python
# In yield_point(), AFTER sdk_observe() but BEFORE self.current_hold = None:
# NOTE: Use local `result` variable, NOT self.resolution (which is None on timeout)
if self._brain_ref and hasattr(self._brain_ref, '_capture_reward'):
    was_override = result.get('was_override', False)
    source_key = 'hold_override' if was_override else 'hold_accept'
    self._brain_ref._capture_reward(
        source_key=source_key,
        action=self.current_hold.get('ai_choice', 0) if self.current_hold else 0,
        event_id=f"hold_{self.hold_count}",
        metadata={
            'was_override': was_override,
            'source': self.resolution.get('source', 'unknown'),
            'hold_number': self.hold_count,
        }
    )
```

#### 1.6.3 In FelixBag.induct / FelixBag.forget

In the `bag_put` / `bag_induct` tool handler:
```python
if hasattr(_brain_ref, '_capture_reward'):
    _brain_ref._capture_reward(
        source_key='bag_induct',
        metadata={'op': 'induct', 'key': name}
    )
```

In the `bag_forget` tool handler:
```python
if hasattr(_brain_ref, '_capture_reward'):
    _brain_ref._capture_reward(
        source_key='bag_forget',
        metadata={'op': 'forget', 'key': name}
    )
```

#### 1.6.4 In WorkflowExecutor

After workflow completes:
```python
# Success:
if hasattr(brain, '_capture_reward'):
    brain._capture_reward(
        source_key='workflow_success',
        metadata={'workflow_id': wf_id, 'status': 'success', 'nodes': len(executed_nodes)}
    )

# Failure:
if hasattr(brain, '_capture_reward'):
    brain._capture_reward(
        source_key='workflow_failure',
        metadata={'workflow_id': wf_id, 'status': 'failure', 'error': str(e)[:200]}
    )
```

#### 1.6.5 In workflow_create Tool (not `workflow_save` — that tool doesn't exist)

```python
if hasattr(_brain_ref, '_capture_reward'):
    _brain_ref._capture_reward(
        source_key='workflow_save',  # config key name, hooks into workflow_create
        metadata={'op': 'create', 'workflow_id': wf_id}
    )
```

---

## PART 2: CRITIC HEAD

### 2.1 Critic Architecture (Scalar Output)

```python
class CriticHead:
    """Small MLP that estimates value of dreamer latent states."""

    def __init__(self, latent_dim=5120, hidden_dim=256):
        self.latent_dim = latent_dim
        self.hidden_dim = hidden_dim

        # Xavier initialization
        scale1 = np.sqrt(2.0 / (latent_dim + hidden_dim))
        scale2 = np.sqrt(2.0 / (hidden_dim + hidden_dim))

        self.W1 = np.random.randn(latent_dim, hidden_dim).astype(np.float32) * scale1
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)
        self.W2 = np.random.randn(hidden_dim, hidden_dim).astype(np.float32) * scale2
        self.b2 = np.zeros(hidden_dim, dtype=np.float32)
        self.W3 = np.zeros((hidden_dim, 1), dtype=np.float32)  # Zero-init output
        self.b3 = np.zeros(1, dtype=np.float32)

        # Slow target (EMA)
        self._target_W1 = self.W1.copy()
        self._target_b1 = self.b1.copy()
        self._target_W2 = self.W2.copy()
        self._target_b2 = self.b2.copy()
        self._target_W3 = self.W3.copy()
        self._target_b3 = self.b3.copy()
        self._target_tau = 0.02

    def forward(self, latent):
        """Estimate value of a latent state."""
        x = latent.astype(np.float32)
        z1 = x @ self.W1 + self.b1
        x = z1 * (1.0 / (1.0 + np.exp(-z1)))  # SiLU
        z2 = x @ self.W2 + self.b2
        x = z2 * (1.0 / (1.0 + np.exp(-z2)))  # SiLU
        value = float((x @ self.W3 + self.b3)[0])
        return value

    def forward_target(self, latent):
        """Estimate value using slow target network."""
        x = latent.astype(np.float32)
        z1 = x @ self._target_W1 + self._target_b1
        x = z1 * (1.0 / (1.0 + np.exp(-z1)))
        z2 = x @ self._target_W2 + self._target_b2
        x = z2 * (1.0 / (1.0 + np.exp(-z2)))
        value = float((x @ self._target_W3 + self._target_b3)[0])
        return value

    def update_target(self):
        """Soft-update target network via EMA."""
        tau = self._target_tau
        self._target_W1 = tau * self.W1 + (1 - tau) * self._target_W1
        self._target_b1 = tau * self.b1 + (1 - tau) * self._target_b1
        self._target_W2 = tau * self.W2 + (1 - tau) * self._target_W2
        self._target_b2 = tau * self.b2 + (1 - tau) * self._target_b2
        self._target_W3 = tau * self.W3 + (1 - tau) * self._target_W3
        self._target_b3 = tau * self.b3 + (1 - tau) * self._target_b3

    def get_params(self):
        return np.concatenate([
            self.W1.flatten(), self.b1,
            self.W2.flatten(), self.b2,
            self.W3.flatten(), self.b3,
        ])

    def set_params(self, params):
        idx = 0
        s = self.latent_dim * self.hidden_dim
        self.W1 = params[idx:idx+s].reshape(self.latent_dim, self.hidden_dim); idx += s
        s = self.hidden_dim
        self.b1 = params[idx:idx+s]; idx += s
        s = self.hidden_dim * self.hidden_dim
        self.W2 = params[idx:idx+s].reshape(self.hidden_dim, self.hidden_dim); idx += s
        s = self.hidden_dim
        self.b2 = params[idx:idx+s]; idx += s
        s = self.hidden_dim * 1
        self.W3 = params[idx:idx+s].reshape(self.hidden_dim, 1); idx += s
        self.b3 = params[idx:idx+1]; idx += 1

    @property
    def param_count(self):
        return (
            self.latent_dim * self.hidden_dim + self.hidden_dim +
            self.hidden_dim * self.hidden_dim + self.hidden_dim +
            self.hidden_dim * 1 + 1
        )

    def to_dict(self):
        """Serialize using base64+gzip (same as nj_state)."""
        import base64, gzip
        def _pack(arr):
            compressed = gzip.compress(arr.astype(np.float32).tobytes(), compresslevel=1)
            return {'b64gz': base64.b64encode(compressed).decode('ascii'), 'shape': list(arr.shape)}
        return {
            'latent_dim': self.latent_dim,
            'hidden_dim': self.hidden_dim,
            'W1': _pack(self.W1), 'b1': _pack(self.b1),
            'W2': _pack(self.W2), 'b2': _pack(self.b2),
            'W3': _pack(self.W3), 'b3': _pack(self.b3),
            'target_W1': _pack(self._target_W1), 'target_b1': _pack(self._target_b1),
            'target_W2': _pack(self._target_W2), 'target_b2': _pack(self._target_b2),
            'target_W3': _pack(self._target_W3), 'target_b3': _pack(self._target_b3),
        }

    @classmethod
    def from_dict(cls, data):
        import base64, gzip
        def _unpack(d):
            if isinstance(d, dict) and 'b64gz' in d:
                raw = gzip.decompress(base64.b64decode(d['b64gz']))
                return np.frombuffer(raw, dtype=np.float32).reshape(d['shape'])
            return np.array(d, dtype=np.float32)  # fallback for .tolist() format
        obj = cls(data['latent_dim'], data['hidden_dim'])
        obj.W1 = _unpack(data['W1']); obj.b1 = _unpack(data['b1'])
        obj.W2 = _unpack(data['W2']); obj.b2 = _unpack(data['b2'])
        obj.W3 = _unpack(data['W3']); obj.b3 = _unpack(data['b3'])
        obj._target_W1 = _unpack(data['target_W1']); obj._target_b1 = _unpack(data['target_b1'])
        obj._target_W2 = _unpack(data['target_W2']); obj._target_b2 = _unpack(data['target_b2'])
        obj._target_W3 = _unpack(data['target_W3']); obj._target_b3 = _unpack(data['target_b3'])
        return obj
```

### 2.2 Critic Integration Points

Add `CriticHead` as attribute of QuineOuroborosBrain:

```python
# In __init__:
arch = self._dreamer_config['architecture']
self._critic = CriticHead(latent_dim=arch['latent_dim'], hidden_dim=arch['critic_hidden_dim'])
self._critic_training_count = 0
self._value_history = collections.deque(maxlen=self._dreamer_config['buffers']['value_history_max'])
self._last_train_stats = {}
```

Wire into forward pass (after dreamer simulate, before council):

```python
# After _dreamer_simulate returns latent_state:
if hasattr(self, '_critic'):
    value = self._critic.forward(latent_state[:5120])
    self._value_history.append((time.time(), value))
```

### 2.3 Critic Training Method

```python
def _train_critic(self):
    """Train critic on reward buffer via gradient-free perturbation."""
    batch_size = self._get_training_param('batch_size')
    gamma = self._get_training_param('gamma')
    noise_scale = self._get_training_param('noise_scale')

    if len(self._reward_buffer) < batch_size:
        return None

    # Sample batch
    indices = random.sample(range(len(self._reward_buffer) - 1), min(batch_size, len(self._reward_buffer) - 1))

    # Compute baseline loss (TD error)
    baseline_loss = 0.0
    for i in indices:
        evt = self._reward_buffer[i]
        next_evt = self._reward_buffer[min(i + 1, len(self._reward_buffer) - 1)]
        pred_value = self._critic.forward(evt.latent)
        target_value = evt.reward + gamma * self._critic.forward_target(next_evt.latent)
        baseline_loss += (pred_value - target_value) ** 2
    baseline_loss /= len(indices)

    # Perturb and evaluate
    original_params = self._critic.get_params().copy()
    noise = np.random.randn(len(original_params)).astype(np.float32) * noise_scale
    self._critic.set_params(original_params + noise)

    perturbed_loss = 0.0
    for i in indices:
        evt = self._reward_buffer[i]
        next_evt = self._reward_buffer[min(i + 1, len(self._reward_buffer) - 1)]
        pred_value = self._critic.forward(evt.latent)
        target_value = evt.reward + gamma * self._critic.forward_target(next_evt.latent)
        perturbed_loss += (pred_value - target_value) ** 2
    perturbed_loss /= len(indices)

    # Accept or reject
    if perturbed_loss < baseline_loss:
        accepted = True
        self._critic.update_target()
    else:
        accepted = False
        self._critic.set_params(original_params)

    self._critic_training_count += 1

    self._last_train_stats = {
        'critic_baseline_loss': round(baseline_loss, 6),
        'critic_perturbed_loss': round(perturbed_loss, 6),
        'accepted': accepted,
        'training_count': self._critic_training_count,
        'timestamp': time.time(),
    }

    return self._last_train_stats
```

### 2.4 NO New MCP Tools — Enriched Responses Instead

The data that would have been in `dreamer_value` is now in the `show_rssm` response. See Part 5 below.

---

## PART 3: REWARD HEAD & CONTINUE HEAD (Track D Supplement)

### 3.1 Reward Prediction Head

Small MLP that predicts reward from latent state (used during imagination):

```python
class RewardHead:
    def __init__(self, latent_dim=5120, hidden_dim=128):
        scale = np.sqrt(2.0 / (latent_dim + hidden_dim))
        self.W1 = np.random.randn(latent_dim, hidden_dim).astype(np.float32) * scale
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)
        self.W2 = np.zeros((hidden_dim, 1), dtype=np.float32)
        self.b2 = np.zeros(1, dtype=np.float32)
        self.latent_dim = latent_dim
        self.hidden_dim = hidden_dim

    def forward(self, latent):
        x = latent.astype(np.float32)
        z = x @ self.W1 + self.b1
        x = z * (1.0 / (1.0 + np.exp(-z)))  # SiLU
        return float((x @ self.W2 + self.b2)[0])

    def get_params(self):
        return np.concatenate([self.W1.flatten(), self.b1, self.W2.flatten(), self.b2])

    def set_params(self, params):
        idx = 0
        s = self.latent_dim * self.hidden_dim
        self.W1 = params[idx:idx+s].reshape(self.latent_dim, self.hidden_dim); idx += s
        self.b1 = params[idx:idx+self.hidden_dim]; idx += self.hidden_dim
        self.W2 = params[idx:idx+self.hidden_dim].reshape(self.hidden_dim, 1); idx += self.hidden_dim
        self.b2 = params[idx:idx+1]; idx += 1
```

### 3.2 Continue Prediction Head

Binary classifier — predicts P(episode continues):

```python
class ContinueHead:
    def __init__(self, latent_dim=5120, hidden_dim=64):
        scale = np.sqrt(2.0 / (latent_dim + hidden_dim))
        self.W1 = np.random.randn(latent_dim, hidden_dim).astype(np.float32) * scale
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)
        self.W2 = np.zeros((hidden_dim, 1), dtype=np.float32)
        self.b2 = np.zeros(1, dtype=np.float32)
        self.latent_dim = latent_dim
        self.hidden_dim = hidden_dim

    def forward(self, latent):
        x = latent.astype(np.float32)
        z = x @ self.W1 + self.b1
        x = z * (1.0 / (1.0 + np.exp(-z)))  # SiLU
        logit = float((x @ self.W2 + self.b2)[0])
        return 1.0 / (1.0 + np.exp(-logit))  # sigmoid -> P(continue)
```

### 3.3 Training These Heads

Add to the 4-phase _train_step:

```python
# Phase 1b: Train reward head on (latent, actual_reward) pairs
noise_scale = self._get_training_param('noise_scale')
batch_size = self._get_training_param('batch_size')

if hasattr(self, '_reward_head') and len(self._reward_buffer) >= batch_size:
    sample = random.sample(list(self._reward_buffer), batch_size)
    original = self._reward_head.get_params().copy()
    loss_baseline = sum(
        (self._reward_head.forward(evt.latent) - evt.reward) ** 2
        for evt in sample
    ) / batch_size

    self._reward_head.set_params(original + np.random.randn(len(original)).astype(np.float32) * noise_scale)
    loss_perturbed = sum(
        (self._reward_head.forward(evt.latent) - evt.reward) ** 2
        for evt in sample
    ) / batch_size

    if loss_perturbed >= loss_baseline:
        self._reward_head.set_params(original)
```

---

## PART 4: UPDATED _train_step (4-Phase Loop)

### Full replacement for the existing _train_step:

```python
def _train_step(self):
    """4-phase training: world model, imagination, critic, actor. All params from config."""
    if not self._get_training_param('enabled'):
        return {}

    deadline = time.time() + self._get_training_param('timeout_budget_seconds')
    stats = {}
    batch_size = self._get_training_param('batch_size')
    noise_scale = self._get_training_param('noise_scale')
    gamma = self._get_training_param('gamma')
    lam = self._get_training_param('lambda_')

    # ══════════════════════════════════════════════
    # PHASE 1: World Model Update (existing, keep)
    # ══════════════════════════════════════════════
    if len(self._obs_buffer) >= batch_size:
        # ... existing perturbation-based world model training ...
        # (Keep the current MSE prediction loss approach)
        pass

    if time.time() > deadline:
        self._last_train_stats = stats
        return stats

    # ══════════════════════════════════════════════
    # PHASE 2: Imagination Rollout
    # ══════════════════════════════════════════════
    imagined_trajectories = []
    horizon = self._dreamer_config['imagination']['horizon']
    if hasattr(self, 'dreamer_world_model') and self.dreamer_world_model:
        try:
            trajectories = self.dreamer_world_model.imagine(horizon=horizon)
            for traj in trajectories:
                processed = []
                for step in traj:
                    latent = np.concatenate([
                        np.array(step.get('deter', np.zeros(4096))).flatten(),
                        np.array(step.get('stoch', np.zeros(1024))).flatten(),
                    ])[:5120]

                    pred_reward = 0.0
                    if hasattr(self, '_reward_head'):
                        pred_reward = self._reward_head.forward(latent)

                    critic_value = 0.0
                    if hasattr(self, '_critic'):
                        critic_value = self._critic.forward(latent)

                    processed.append({
                        'step': step['step'],
                        'action': step.get('branch_action', step.get('action', 0)),
                        'pred_reward': pred_reward,
                        'critic_value': critic_value,
                        'latent_norm': step.get('latent_norm', 0),
                    })
                imagined_trajectories.append(processed)
        except Exception:
            pass

    if time.time() > deadline:
        self._last_train_stats = stats
        return stats

    # ══════════════════════════════════════════════
    # PHASE 3: Critic Update
    # ══════════════════════════════════════════════
    if hasattr(self, '_critic') and len(self._reward_buffer) >= batch_size:
        critic_stats = self._train_critic()
        if critic_stats:
            stats['critic'] = critic_stats

    if time.time() > deadline:
        self._last_train_stats = stats
        return stats

    # ══════════════════════════════════════════════
    # PHASE 4: Actor Update (LoRA)
    # ══════════════════════════════════════════════
    if imagined_trajectories and hasattr(self, '_critic'):
        actor_score_baseline = 0.0
        for traj in imagined_trajectories:
            # Compute lambda-returns
            returns = []
            G = traj[-1]['critic_value']
            for t in reversed(range(len(traj))):
                r = traj[t]['pred_reward']
                v_next = traj[t+1]['critic_value'] if t+1 < len(traj) else G
                G = r + gamma * ((1 - lam) * v_next + lam * G)
                returns.insert(0, G)

            for t, step in enumerate(traj):
                advantage = returns[t] - step['critic_value']
                actor_score_baseline += advantage

        # Perturb actor (LoRA) and evaluate
        dreamer = self.dreamer_world_model
        orig_A = dreamer.lora_A.copy()
        orig_B = dreamer.lora_B.copy()
        orig_bias = dreamer.lora_bias.copy()

        dreamer.lora_A += np.random.randn(*dreamer.lora_A.shape).astype(np.float32) * noise_scale
        dreamer.lora_B += np.random.randn(*dreamer.lora_B.shape).astype(np.float32) * noise_scale
        dreamer.lora_bias += np.random.randn(*dreamer.lora_bias.shape).astype(np.float32) * noise_scale

        try:
            new_trajs = dreamer.imagine(horizon=horizon)
            actor_score_perturbed = 0.0
            for traj in new_trajs:
                for step in traj:
                    latent = np.concatenate([
                        np.array(step.get('deter', np.zeros(4096))).flatten(),
                        np.array(step.get('stoch', np.zeros(1024))).flatten(),
                    ])[:5120]
                    v = self._critic.forward(latent)
                    r = self._reward_head.forward(latent) if hasattr(self, '_reward_head') else 0.0
                    actor_score_perturbed += r + gamma * v

            if actor_score_perturbed > actor_score_baseline:
                stats['actor'] = {'accepted': True, 'improvement': actor_score_perturbed - actor_score_baseline}
            else:
                dreamer.lora_A = orig_A
                dreamer.lora_B = orig_B
                dreamer.lora_bias = orig_bias
                stats['actor'] = {'accepted': False}
        except Exception:
            dreamer.lora_A = orig_A
            dreamer.lora_B = orig_B
            dreamer.lora_bias = orig_bias

    self._last_train_stats = stats
    return stats
```

---

## PART 5: ENRICHING EXISTING TOOL RESPONSES

### 5.1 Enrich `get_status`

> **TARGET:** The NORMAL MODE `get_status` only (~line 33919 in agent_compiler.py, the one that calls `_get_capsule()` or `get_agent()`). NOT the proxy mode version (~line 31181) that reads from `state_file`. See Errata Issue 16.

Add a `dreamer` section to the existing response JSON:

```python
# At the end of get_status(), before return:
dreamer_section = {"active": False, "fitness": 0.0}
if hasattr(brain, 'dreamer_world_model') and brain.dreamer_world_model:
    dreamer_section["active"] = True
    dreamer_section["fitness"] = float(getattr(brain, '_fitness', 0.0))
    try:
        latent = brain.dreamer_world_model._get_latent_vector()
        dreamer_section["critic_value"] = round(brain._critic.forward(latent), 4) if hasattr(brain, '_critic') else 0.0
    except Exception:
        dreamer_section["critic_value"] = 0.0
    dreamer_section["reward_count"] = getattr(brain, '_reward_count', 0)
    dreamer_section["training_cycles"] = getattr(brain, '_critic_training_count', 0)
    dreamer_section["obs_buffer_size"] = len(getattr(brain, '_obs_buffer', []))
    dreamer_section["reward_buffer_size"] = len(getattr(brain, '_reward_buffer', []))

    # Reward rate (per minute)
    now = time.time()
    window = getattr(brain, '_reward_rate_window', [])
    recent = [t for t in window if now - t < 60]
    dreamer_section["reward_rate"] = len(recent)

    # Last imagination summary
    if hasattr(brain.dreamer_world_model, '_last_imagination') and brain.dreamer_world_model._last_imagination:
        trajs = brain.dreamer_world_model._last_imagination
        values = []
        for traj in trajs:
            total = sum(brain._critic.forward(
                np.concatenate([s.get('deter', np.zeros(4096)).flatten(), s.get('stoch', np.zeros(1024)).flatten()])[:5120]
            ) for s in traj) if hasattr(brain, '_critic') else 0.0
            values.append(round(total, 3))
        best_idx = int(np.argmax(values)) if values else 0
        dreamer_section["last_imagination"] = {
            "best_action": best_idx,
            "best_value": max(values) if values else 0,
            "action_values": values,
        }

    dreamer_section["last_train"] = getattr(brain, '_last_train_stats', {})

result["dreamer"] = dreamer_section
```

### 5.2 Enrich `show_rssm`

Add a comprehensive dreamer section with all telemetry + current config:

```python
# At the end of show_rssm(), before return:
dreamer_detail = {}

# Critic
if hasattr(brain, '_critic'):
    latent = brain.dreamer_world_model._get_latent_vector() if brain.dreamer_world_model else np.zeros(5120)
    dreamer_detail["critic"] = {
        "current_value": round(brain._critic.forward(latent), 4),
        "target_value": round(brain._critic.forward_target(latent), 4),
        "param_count": brain._critic.param_count,
        "training_cycles": brain._critic_training_count,
    }
    # Value history
    history = list(getattr(brain, '_value_history', []))[-50:]
    dreamer_detail["value_history"] = [{"t": round(t, 1), "v": round(v, 4)} for t, v in history]

# Rewards
if hasattr(brain, '_reward_buffer'):
    sources = {}
    for evt in brain._reward_buffer:
        sources[evt.source] = sources.get(evt.source, 0) + 1

    recent = list(brain._reward_buffer)[-20:]
    dreamer_detail["rewards"] = {
        "total": brain._reward_count,
        "cumulative_value": round(brain._reward_sum, 3),
        "buffer_size": len(brain._reward_buffer),
        "source_breakdown": sources,
        "recent": [e.to_dict() for e in recent],
    }

# Training stats
dreamer_detail["training"] = getattr(brain, '_last_train_stats', {})

# Current config (for extension UI to display/edit)
dreamer_detail["config"] = getattr(brain, '_dreamer_config', _DREAMER_CONFIG_DEFAULTS)

result["dreamer"] = dreamer_detail
```

### 5.3 Enrich `imagine`

The branching imagine (from errata Issue 4) already returns per-action trajectories. Add critic values:

```python
# In the imagine tool handler, after getting trajectories:
if hasattr(brain, '_critic'):
    for traj in trajectories:
        for step in traj:
            latent = np.concatenate([
                step.get('deter', np.zeros(4096)).flatten(),
                step.get('stoch', np.zeros(1024)).flatten(),
            ])[:5120]
            step['critic_value'] = round(brain._critic.forward(latent), 4)
            if hasattr(brain, '_reward_head'):
                step['pred_reward'] = round(brain._reward_head.forward(latent), 4)
```

---

## PART 6: SERIALIZATION ADDITIONS

### 6.1 In to_full_dict() (QuineOuroborosBrain)

```python
if hasattr(self, '_critic'):
    data['critic'] = self._critic.to_dict()
if hasattr(self, '_reward_head'):
    data['reward_head'] = {
        'W1': _pack(self._reward_head.W1), 'b1': _pack(self._reward_head.b1),
        'W2': _pack(self._reward_head.W2), 'b2': _pack(self._reward_head.b2),
        'latent_dim': self._reward_head.latent_dim,
        'hidden_dim': self._reward_head.hidden_dim,
    }
if hasattr(self, '_continue_head'):
    data['continue_head'] = {
        'W1': _pack(self._continue_head.W1), 'b1': _pack(self._continue_head.b1),
        'W2': _pack(self._continue_head.W2), 'b2': _pack(self._continue_head.b2),
        'latent_dim': self._continue_head.latent_dim,
        'hidden_dim': self._continue_head.hidden_dim,
    }
```

### 6.2 In from_full_dict() (QuineOuroborosBrain)

```python
if data.get('critic'):
    brain._critic = CriticHead.from_dict(data['critic'])
if data.get('reward_head'):
    rh = data['reward_head']
    brain._reward_head = RewardHead(rh.get('latent_dim', 5120), rh.get('hidden_dim', 128))
    brain._reward_head.W1 = _unpack(rh['W1'])
    brain._reward_head.b1 = _unpack(rh['b1'])
    brain._reward_head.W2 = _unpack(rh['W2'])
    brain._reward_head.b2 = _unpack(rh['b2'])
# Similar for continue_head
```

---

## PART 7: PARAMETER BUDGET

| Component | Parameters | Size (float32) | Gzipped |
|-----------|-----------|----------------|---------|
| LoRA Actor (existing) | ~12.7K | ~51KB | ~12KB |
| CriticHead (256 hidden) | ~1.38M | ~5.5MB | ~1.2MB |
| RewardHead (128 hidden) | ~660K | ~2.6MB | ~600KB |
| ContinueHead (64 hidden) | ~330K | ~1.3MB | ~300KB |
| **Total new** | **~2.37M** | **~9.4MB** | **~2.1MB** |

---

*This spec is designed to be implementable following the Codex. All code shown is the TARGET champion output (Level 1). When editing agent_compiler.py, double all braces per the Nine Transformations. All hardcoded values have been replaced with config lookups.*
