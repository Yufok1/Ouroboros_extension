# Dreamer Extension Display — UI Implementation Spec (v2)

*Extension-side changes for Track E. **ZERO new MCP tools.** Config UI for all parameters. Live telemetry from enriched existing tool responses.*

---

## 1. OVERVIEW

Three display locations:
1. **Sidebar bottom half** — Dreamer Pulse widget (always visible, at-a-glance via enriched `get_status`)
2. **Diagnostics tab** — Enhanced RSSM/IMAGINATION buttons (existing tools, richer output)
3. **Dreamer Config section** — All tunable parameters exposed as form inputs (writes `dreamer_config.json`)

No new MCP tools. Sidebar polls `get_status` (enriched). Diagnostics uses `show_rssm` (enriched) and `imagine` (enriched). Config changes write a JSON file that the brain reads.

---

## 2. SIDEBAR: DREAMER PULSE WIDGET

### 2.1 Visual Design

```
├────────────────────────┤
│ DREAMER ◉              │
├────────────────────────┤
│ Value   0.73 ▲ ████░░  │
│ Fitness 0.68   ███░░░  │
│ Buffer  847 / 234      │
│ Rewards +42 (3/min)    │
├────────────────────────┤
│ IMAGINATION             │
│ ► 0: ████████░░ 0.82   │
│   1: ██████░░░░ 0.61   │
│   2: ████░░░░░░ 0.44   │
│   3: ███░░░░░░░ 0.29   │
│   ···                   │
├────────────────────────┤
│ Training: 12 cycles     │
│ Last: accepted ✓        │
├────────────────────────┤
│ [Imagine] [Train]       │
└────────────────────────┘
```

### 2.2 Implementation in extension.ts

The sidebar view is built in the `resolveWebviewView` method. Add after the existing MCP status section (which has port, tools count, categories, nostr relays):

```typescript
const dreamerSection = `
<div id="dreamer-section" style="border-top: 1px solid var(--vscode-panel-border); margin-top: 12px; padding-top: 8px;">
  <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
    <span style="font-weight: bold; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Dreamer</span>
    <span id="dreamer-dot" style="width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); display: inline-block;"></span>
  </div>

  <div style="font-size: 11px; line-height: 1.6; font-family: var(--vscode-editor-font-family);">
    <div style="display: flex; justify-content: space-between;">
      <span style="opacity: 0.7;">Value</span>
      <span id="dreamer-value" style="font-variant-numeric: tabular-nums;">—</span>
    </div>
    <div id="dreamer-value-bar" style="height: 3px; background: var(--vscode-progressBar-background); border-radius: 2px; margin: 2px 0 4px;">
      <div id="dreamer-value-fill" style="height: 100%; width: 0%; background: var(--vscode-charts-blue); border-radius: 2px; transition: width 0.3s;"></div>
    </div>

    <div style="display: flex; justify-content: space-between;">
      <span style="opacity: 0.7;">Fitness</span>
      <span id="dreamer-fitness">—</span>
    </div>
    <div style="display: flex; justify-content: space-between;">
      <span style="opacity: 0.7;">Buffer</span>
      <span id="dreamer-buffer">—</span>
    </div>
    <div style="display: flex; justify-content: space-between;">
      <span style="opacity: 0.7;">Rewards</span>
      <span id="dreamer-rewards">—</span>
    </div>
  </div>

  <div id="dreamer-imagination" style="margin-top: 8px; display: none;">
    <div style="font-size: 10px; opacity: 0.7; text-transform: uppercase; margin-bottom: 4px;">Imagination</div>
    <div id="dreamer-action-bars" style="font-size: 10px; font-family: var(--vscode-editor-font-family); line-height: 1.5;"></div>
  </div>

  <div style="margin-top: 8px; font-size: 10px;">
    <div style="display: flex; justify-content: space-between; opacity: 0.7;">
      <span>Training: <span id="dreamer-train-count">0</span> cycles</span>
      <span id="dreamer-train-status"></span>
    </div>
  </div>

  <div style="margin-top: 8px; display: flex; gap: 4px;">
    <button id="btn-imagine" style="flex: 1; padding: 3px 8px; font-size: 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; border-radius: 2px;">Imagine</button>
    <button id="btn-train" style="flex: 1; padding: 3px 8px; font-size: 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; border-radius: 2px;">Train</button>
  </div>
</div>
`;
```

### 2.3 Sidebar JavaScript (Update Logic)

Add to the sidebar's `<script>` section:

```javascript
// Dreamer state polling — uses EXISTING get_status tool (enriched with dreamer section)
let dreamerPollInterval = null;

function startDreamerPoll() {
  dreamerPollInterval = setInterval(() => {
    vscode.postMessage({ command: 'dreamerStatus' });
  }, 5000);
}

function updateDreamerDisplay(data) {
  // data = the "dreamer" section from get_status response
  if (!data || data.error) {
    document.getElementById('dreamer-dot').style.background = 'var(--vscode-charts-red)';
    return;
  }

  document.getElementById('dreamer-dot').style.background =
    data.active ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-yellow)';

  // Value
  const value = data.critic_value ?? 0;
  document.getElementById('dreamer-value').textContent =
    value.toFixed(3) + (value > 0 ? ' ▲' : value < 0 ? ' ▼' : '');
  const valuePct = Math.max(0, Math.min(100, (value + 1) * 50)); // map [-1,1] to [0,100]
  document.getElementById('dreamer-value-fill').style.width = valuePct + '%';

  // Fitness
  document.getElementById('dreamer-fitness').textContent =
    (data.fitness ?? 0).toFixed(3);

  // Buffer (obs / rewards)
  document.getElementById('dreamer-buffer').textContent =
    `${data.obs_buffer_size ?? 0} / ${data.reward_buffer_size ?? 0}`;

  // Rewards
  const rr = data.reward_rate ?? 0;
  document.getElementById('dreamer-rewards').textContent =
    `+${data.reward_count ?? 0} (${rr}/min)`;

  // Imagination bars
  const imgData = data.last_imagination;
  if (imgData && imgData.action_values && imgData.action_values.length > 0) {
    document.getElementById('dreamer-imagination').style.display = 'block';
    const barsEl = document.getElementById('dreamer-action-bars');
    const maxVal = Math.max(...imgData.action_values.map(Math.abs), 0.01);
    let html = '';
    imgData.action_values.forEach((v, i) => {
      const pct = Math.max(0, Math.min(100, (v / maxVal) * 100));
      const isBest = i === imgData.best_action;
      const color = isBest ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-blue)';
      html += `<div style="display:flex;align-items:center;gap:4px;">`;
      html += `<span style="width:12px;${isBest ? 'color:var(--vscode-charts-green);' : 'opacity:0.5;'}">${isBest ? '►' : ' '}${i}</span>`;
      html += `<div style="flex:1;height:6px;background:var(--vscode-progressBar-background);border-radius:2px;">`;
      html += `<div style="width:${pct}%;height:100%;background:${color};border-radius:2px;transition:width 0.3s;"></div>`;
      html += `</div>`;
      html += `<span style="width:36px;text-align:right;">${v.toFixed(2)}</span>`;
      html += `</div>`;
    });
    barsEl.innerHTML = html;
  } else {
    document.getElementById('dreamer-imagination').style.display = 'none';
  }

  // Training
  document.getElementById('dreamer-train-count').textContent = data.training_cycles ?? 0;
  const lastTrain = data.last_train;
  if (lastTrain && lastTrain.accepted !== undefined) {
    document.getElementById('dreamer-train-status').textContent =
      lastTrain.accepted ? '✓' : '✗';
    document.getElementById('dreamer-train-status').style.color =
      lastTrain.accepted ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)';
  }
}

// Button handlers — use EXISTING tools
document.getElementById('btn-imagine')?.addEventListener('click', () => {
  vscode.postMessage({ command: 'callTool', tool: 'imagine', args: { scenario: 'current state projection', steps: 15 } });
});

document.getElementById('btn-train')?.addEventListener('click', () => {
  // No dreamer_train tool exists — training runs automatically.
  // This button calls show_rssm which triggers config re-read and returns training stats.
  // The result will show in the diagnostics output if the control panel is open.
  vscode.postMessage({ command: 'callTool', tool: 'show_rssm', args: {} });
});

startDreamerPoll();
```

### 2.4 Extension Message Handler (extension.ts)

The message handler for `dreamerStatus` calls `get_status` (existing tool) and extracts the `dreamer` section:

```typescript
case 'dreamerStatus':
  // Call EXISTING get_status tool, extract enriched dreamer section
  if (mcpManager && mcpManager.isConnected()) {
    try {
      const result = await mcpManager.callTool('get_status', {});
      const parsed = JSON.parse(result?.content?.[0]?.text || '{}');
      webviewView.webview.postMessage({
        type: 'dreamerStatus',
        data: parsed.dreamer || { active: false }
      });
    } catch {
      webviewView.webview.postMessage({
        type: 'dreamerStatus',
        data: { error: 'not available' }
      });
    }
  }
  break;
```

And in the webview script:

```javascript
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'dreamerStatus') {
    updateDreamerDisplay(msg.data);
  }
});
```

---

## 3. DIAGNOSTICS TAB ENHANCEMENTS

### 3.1 Buttons

The diagnostics tab already has RSSM, DIMS, LORA, INTEGRITY buttons. Add IMAGINATION button and a DREAMER WORLD MODEL section header:

```html
<div class="section-head" style="margin-top:20px;">DREAMER WORLD MODEL</div>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    <button onclick="runDiagnostic('show_rssm')">RSSM + DREAMER</button>
    <button onclick="runImagination()">IMAGINATION</button>
</div>
```

The RSSM button already exists — the enriched `show_rssm` response now includes critic, rewards, training, and config data. The diagnostics output panel will show all of it.

No separate CRITIC, REWARDS, TRAINING, STATUS buttons needed — `show_rssm` (enriched) returns everything.

### 3.2 Imagination Display Handler (main.js)

```javascript
async function runImagination() {
  const resultEl = document.getElementById('diag-result');
  resultEl.innerHTML = '<div style="opacity:0.5;">Imagining...</div>';

  vscode.postMessage({
    command: 'callTool',
    tool: 'imagine',
    args: { scenario: 'current state', steps: 15 }
  });
}

function renderImaginationResult(data) {
  if (!data.trajectories && !Array.isArray(data)) return JSON.stringify(data, null, 2);

  const trajectories = data.trajectories || data;
  const numTrajs = trajectories.length;
  const horizon = trajectories[0]?.length || 0;

  let html = '<div style="font-family: var(--vscode-editor-font-family);">';
  html += `<h3 style="margin: 0 0 8px;">IMAGINATION — ${numTrajs} branches × ${horizon} steps</h3>`;

  // Compute per-branch total values
  const branchValues = trajectories.map((traj, i) => {
    const totalValue = traj.reduce((sum, step) => sum + (step.critic_value || 0), 0);
    return { action: i, value: totalValue, traj };
  });
  branchValues.sort((a, b) => b.value - a.value);

  const bestAction = branchValues[0]?.action ?? 0;
  const worstAction = branchValues[branchValues.length - 1]?.action ?? 0;

  html += `<div style="margin-bottom: 12px;">`;
  html += `<div>Best action: <strong>${bestAction}</strong> (value: ${branchValues[0]?.value?.toFixed(3)})</div>`;
  html += `<div>Worst action: ${worstAction} (value: ${branchValues[branchValues.length - 1]?.value?.toFixed(3)})</div>`;
  html += `</div>`;

  // Trajectory table
  html += '<table style="width:100%; border-collapse: collapse; font-size: 11px;">';
  html += '<tr style="border-bottom: 1px solid var(--vscode-panel-border);">';
  html += '<th style="text-align:left; padding:4px;">Action</th>';
  html += '<th style="text-align:left; padding:4px;">Value</th>';
  html += '<th style="text-align:left; padding:4px;">Bar</th>';
  html += '<th style="text-align:left; padding:4px;">Trajectory</th>';
  html += '</tr>';

  const maxVal = Math.max(...branchValues.map(b => Math.abs(b.value)), 0.01);

  branchValues.forEach((branch, rank) => {
    const pct = Math.max(0, (branch.value / maxVal) * 100);
    const isBest = rank === 0;
    const color = isBest ? '#4CAF50' : '#2196F3';

    html += `<tr style="border-bottom: 1px solid var(--vscode-panel-border); opacity: ${1 - rank * 0.08};">`;
    html += `<td style="padding:4px;">${isBest ? '► ' : '  '}${branch.action}</td>`;
    html += `<td style="padding:4px; font-variant-numeric: tabular-nums;">${branch.value.toFixed(3)}</td>`;
    html += `<td style="padding:4px; width: 40%;"><div style="height:8px; background: var(--vscode-progressBar-background); border-radius:3px;">`;
    html += `<div style="width:${pct}%; height:100%; background:${color}; border-radius:3px;"></div></div></td>`;

    // Sparkline
    const norms = branch.traj.map(s => s.latent_norm || 0);
    const maxNorm = Math.max(...norms, 0.01);
    const sparkline = norms.map(n => {
      const h = Math.round((n / maxNorm) * 8);
      return ['▁','▂','▃','▄','▅','▆','▇','█'][Math.min(h, 7)];
    }).join('');
    html += `<td style="padding:4px; font-size:10px; letter-spacing: -1px;">${sparkline}</td>`;
    html += '</tr>';
  });

  html += '</table></div>';
  return html;
}
```

In the tool result handler, route `imagine` results:

```javascript
// In handleToolResult(), detect imagination results:
if (toolName === 'imagine' || pendingKey === '_imagination') {
  const diagOutput = document.getElementById('diag-result');
  if (diagOutput) {
    diagOutput.innerHTML = renderImaginationResult(resultData);
    return;
  }
}
```

---

## 4. DREAMER CONFIG UI (Control Panel)

### 4.1 Config Section in Diagnostics Area

Add a collapsible config editor section. The config values are loaded from the `dreamer` section of the `show_rssm` enriched response (which includes the full config dump).

```html
<div class="section-head" style="margin-top:20px; cursor: pointer;" onclick="toggleDreamerConfig()">
  DREAMER CONFIG ▼
</div>
<div id="dreamer-config-panel" style="display:none; padding: 8px; font-size: 11px;">

  <div style="margin-bottom: 12px;">
    <div style="font-weight: bold; margin-bottom: 4px; opacity: 0.7;">REWARD WEIGHTS</div>
    <div id="reward-config-fields"></div>
  </div>

  <div style="margin-bottom: 12px;">
    <div style="font-weight: bold; margin-bottom: 4px; opacity: 0.7;">TRAINING</div>
    <div id="training-config-fields"></div>
  </div>

  <div style="margin-bottom: 12px;">
    <div style="font-weight: bold; margin-bottom: 4px; opacity: 0.7;">IMAGINATION</div>
    <div id="imagination-config-fields"></div>
  </div>

  <div style="margin-bottom: 12px;">
    <div style="font-weight: bold; margin-bottom: 4px; opacity: 0.7;">BUFFERS</div>
    <div id="buffer-config-fields"></div>
  </div>

  <div style="margin-bottom: 12px;">
    <div style="font-weight: bold; margin-bottom: 4px; opacity: 0.7;">ARCHITECTURE (read-only)</div>
    <div id="arch-config-fields"></div>
  </div>

  <div style="display: flex; gap: 8px; margin-top: 12px;">
    <button onclick="saveDreamerConfig()" style="flex:1;">Save Config</button>
    <button onclick="resetDreamerConfig()" style="flex:1; opacity: 0.7;">Reset Defaults</button>
  </div>
  <div id="config-save-status" style="font-size: 10px; opacity: 0.7; margin-top: 4px;"></div>
</div>
```

### 4.2 Config UI JavaScript (main.js)

```javascript
let _dreamerConfig = null;

function toggleDreamerConfig() {
  const panel = document.getElementById('dreamer-config-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block' && !_dreamerConfig) {
    loadDreamerConfig();
  }
}

function loadDreamerConfig() {
  // Request config from show_rssm enriched response
  vscode.postMessage({ command: 'callTool', tool: 'show_rssm', args: {} });
  // The result handler will call renderDreamerConfig when it sees dreamer.config
}

function renderDreamerConfig(config) {
  _dreamerConfig = config;

  // Render reward weight fields
  const rewardFields = document.getElementById('reward-config-fields');
  rewardFields.innerHTML = renderConfigSection(config.rewards, 'rewards', {
    hold_accept: { label: 'HOLD Accept', min: -5, max: 5, step: 0.1 },
    hold_override: { label: 'HOLD Override', min: -5, max: 5, step: 0.1 },
    bag_induct: { label: 'Bag Induct', min: -5, max: 5, step: 0.1 },
    bag_forget: { label: 'Bag Forget', min: -5, max: 5, step: 0.1 },
    workflow_save: { label: 'Workflow Save', min: -5, max: 5, step: 0.1 },
    workflow_success: { label: 'Workflow Success', min: -5, max: 5, step: 0.1 },
    workflow_failure: { label: 'Workflow Failure', min: -5, max: 5, step: 0.1 },
    tool_success: { label: 'Tool Success', min: -5, max: 5, step: 0.01 },
    tool_error: { label: 'Tool Error', min: -5, max: 5, step: 0.01 },
    mutation_kept: { label: 'Mutation Kept', min: -5, max: 5, step: 0.1 },
    mutation_reverted: { label: 'Mutation Reverted', min: -5, max: 5, step: 0.1 },
    normalize: { label: 'Symlog Normalize', type: 'checkbox' },
  });

  // Training fields
  const trainingFields = document.getElementById('training-config-fields');
  trainingFields.innerHTML = renderConfigSection(config.training, 'training', {
    enabled: { label: 'Enabled', type: 'checkbox' },
    auto_train: { label: 'Auto-Train', type: 'checkbox' },
    world_model_frequency: { label: 'World Model Freq', min: 8, max: 256, step: 8 },
    critic_frequency: { label: 'Critic Freq', min: 8, max: 256, step: 8 },
    full_cycle_frequency: { label: 'Full Cycle Freq', min: 16, max: 512, step: 16 },
    batch_size: { label: 'Batch Size', min: 8, max: 128, step: 8 },
    noise_scale: { label: 'Noise Scale', min: 0.001, max: 0.1, step: 0.001 },
    gamma: { label: 'Gamma (discount)', min: 0.9, max: 0.999, step: 0.001 },
    lambda_: { label: 'Lambda (GAE)', min: 0.8, max: 0.99, step: 0.01 },
    critic_target_tau: { label: 'Target EMA Tau', min: 0.001, max: 0.1, step: 0.001 },
    timeout_budget_seconds: { label: 'Timeout Budget (s)', min: 5, max: 55, step: 5 },
  });

  // Imagination fields
  const imgFields = document.getElementById('imagination-config-fields');
  imgFields.innerHTML = renderConfigSection(config.imagination, 'imagination', {
    horizon: { label: 'Horizon', min: 5, max: 50, step: 5 },
    n_actions: { label: 'Action Branches', min: 2, max: 16, step: 1 },
    auto_imagine_on_train: { label: 'Auto-Imagine on Train', type: 'checkbox' },
  });

  // Buffer fields
  const bufferFields = document.getElementById('buffer-config-fields');
  bufferFields.innerHTML = renderConfigSection(config.buffers, 'buffers', {
    reward_buffer_max: { label: 'Reward Buffer Max', min: 100, max: 50000, step: 100 },
    obs_buffer_max: { label: 'Obs Buffer Max', min: 100, max: 10000, step: 100 },
    value_history_max: { label: 'Value History Max', min: 50, max: 1000, step: 50 },
    reward_rate_window: { label: 'Rate Window', min: 10, max: 500, step: 10 },
  });

  // Architecture (read-only)
  const archFields = document.getElementById('arch-config-fields');
  archFields.innerHTML = Object.entries(config.architecture || {}).map(([k, v]) =>
    `<div style="display:flex;justify-content:space-between;padding:2px 0;">
      <span style="opacity:0.7;">${k}</span>
      <span style="font-variant-numeric:tabular-nums;">${v}</span>
    </div>`
  ).join('');
}

function renderConfigSection(values, section, schema) {
  return Object.entries(schema).map(([key, opts]) => {
    const val = values?.[key] ?? '';
    if (opts.type === 'checkbox') {
      return `<div style="display:flex;justify-content:space-between;padding:2px 0;">
        <label style="opacity:0.7;">${opts.label}</label>
        <input type="checkbox" ${val ? 'checked' : ''} data-section="${section}" data-key="${key}"
               onchange="updateConfigField('${section}', '${key}', this.checked)">
      </div>`;
    }
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">
      <label style="opacity:0.7;flex:1;">${opts.label}</label>
      <input type="number" value="${val}" min="${opts.min}" max="${opts.max}" step="${opts.step}"
             style="width:70px;text-align:right;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:2px 4px;font-size:11px;"
             data-section="${section}" data-key="${key}"
             onchange="updateConfigField('${section}', '${key}', parseFloat(this.value))">
    </div>`;
  }).join('');
}

function updateConfigField(section, key, value) {
  if (!_dreamerConfig) return;
  if (!_dreamerConfig[section]) _dreamerConfig[section] = {};
  _dreamerConfig[section][key] = value;
}

function saveDreamerConfig() {
  vscode.postMessage({
    command: 'saveDreamerConfig',
    config: _dreamerConfig
  });
  document.getElementById('config-save-status').textContent = 'Saved ✓';
  setTimeout(() => {
    document.getElementById('config-save-status').textContent = '';
  }, 2000);
}

function resetDreamerConfig() {
  vscode.postMessage({ command: 'resetDreamerConfig' });
  document.getElementById('config-save-status').textContent = 'Reset to defaults ✓';
  setTimeout(() => {
    document.getElementById('config-save-status').textContent = '';
    loadDreamerConfig();
  }, 1000);
}
```

### 4.3 Extension-Side Config File Handlers (extension.ts or mcpServer.ts)

```typescript
case 'saveDreamerConfig':
  // Write config to dreamer_config.json alongside the champion
  const configPath = path.join(championDir, 'dreamer_config.json');
  fs.writeFileSync(configPath, JSON.stringify(message.config, null, 2));
  break;

case 'resetDreamerConfig':
  // Delete the config file — brain will use defaults
  const resetPath = path.join(championDir, 'dreamer_config.json');
  if (fs.existsSync(resetPath)) fs.unlinkSync(resetPath);
  break;
```

The `championDir` should be resolved from the MCP connection info or hardcoded to the extension's working directory.

---

## 5. HOW DATA FLOWS (No New Tools)

> **NOTE:** There are TWO `get_status` implementations in agent_compiler.py: proxy mode (reads state file) and normal mode (live brain access). Only normal mode is enriched. The extension uses normal mode (direct MCP via SSE). See Errata Issue 16.

### 5.1 Sidebar Polling

```
Every 5s: Extension calls get_status (existing)
          → Brain returns JSON with new "dreamer" section
          → Extension extracts dreamer section
          → Posts to sidebar webview
          → updateDreamerDisplay() renders it
```

### 5.2 Diagnostics Deep Inspection

```
User clicks RSSM+DREAMER button
  → Calls show_rssm (existing)
  → Brain returns enriched JSON with critic, rewards, training, config
  → Diagnostics output renders full dump

User clicks IMAGINATION button
  → Calls imagine (existing)
  → Brain returns per-action branching trajectories with critic values
  → renderImaginationResult() renders trajectory table with sparklines
```

### 5.3 Config Changes

```
User changes a value in config form
  → updateConfigField() updates in-memory config
  → User clicks "Save Config"
  → saveDreamerConfig() sends config to extension
  → Extension writes dreamer_config.json
  → Brain re-reads config on next show_rssm call (or periodic timer)
  → New values take effect immediately for next reward/training cycle
```

---

## 6. FILE EDIT SUMMARY

### Extension-Side (TypeScript/HTML/JS)

| File | Edit | Description |
|------|------|-------------|
| `src/extension.ts` | Add dreamer HTML section | Sidebar bottom half widget |
| `src/extension.ts` | Modify `dreamerStatus` handler | Calls `get_status`, extracts `dreamer` section |
| `src/extension.ts` | Add dreamer polling interval | 5s update loop using existing tool |
| `src/extension.ts` | Add `saveDreamerConfig` handler | Writes JSON file |
| `src/extension.ts` | Add `resetDreamerConfig` handler | Deletes JSON file |
| `src/webview/panel.ts` | Add IMAGINATION button | In diagnostics section |
| `src/webview/panel.ts` | Add Dreamer Config section | Collapsible config editor |
| `media/main.js` | Add `runImagination()` function | Imagination trigger |
| `media/main.js` | Add `renderImaginationResult()` | Trajectory table with sparklines |
| `media/main.js` | Add config UI functions | `renderDreamerConfig`, `saveDreamerConfig`, etc. |
| `media/main.js` | Add imagination result routing | In `handleToolResult()` |

### Backend (agent_compiler.py Level 1) — NO NEW TOOLS

| Edit | Description |
|------|-------------|
| Enrich `get_status` response | Add `dreamer` section with summary data |
| Enrich `show_rssm` response | Add critic, rewards, training, config sections |
| Enrich `imagine` response | Add critic values + reward predictions per branch |

---

## 7. STYLING NOTES

- All colors use VSCode CSS variables (`var(--vscode-*)`) for theme compatibility
- Font sizes: 10-11px for the sidebar (compact), 11-12px for diagnostics/config
- Bar charts use `var(--vscode-charts-blue)` and `var(--vscode-charts-green)`
- Sparklines use Unicode block elements (`▁▂▃▄▅▆▇█`)
- Transitions on width changes (0.3s) for smooth bar animations
- `font-variant-numeric: tabular-nums` for value columns to prevent layout shift
- Config inputs use VSCode input variables for theme consistency

---

*This spec can be implemented before the backend changes. The sidebar will show placeholder/empty data until `get_status` is enriched. The config UI can be built and tested independently — it just reads/writes a JSON file.*
