import * as vscode from 'vscode';
import { MCPServerManager, TOOL_CATEGORIES, ToolCallEvent } from '../mcpServer';

export class CouncilPanel {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private activityLog: ToolCallEvent[] = [];

    constructor(
        private extensionUri: vscode.Uri,
        private mcp: MCPServerManager,
        private context: vscode.ExtensionContext
    ) {
        // Capture activity events
        this.mcp.onActivity((event) => {
            this.activityLog.push(event);
            if (this.activityLog.length > 500) {
                this.activityLog = this.activityLog.slice(-500);
            }
            this.send({ type: 'activity', event });
        });

        // Update panel when server status changes - postMessage only, NEVER re-render
        this.mcp.onStatusChange((status) => {
            console.log('[Panel] Status changed to:', status);
            this.pushFullState();
        });
    }

    show() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js');

        this.panel = vscode.window.createWebviewPanel(
            'championCouncil', 'Champion Council', vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
            }
        );

        const scriptUri = this.panel.webview.asWebviewUri(mediaPath);
        this.panel.webview.html = this.buildHTML(scriptUri);

        this.panel.webview.onDidReceiveMessage(
            (msg) => {
                if (msg.command === 'ready') {
                    console.log('[Panel] Webview is ready');
                    this.pushFullState();
                    return;
                }
                this.handleMessage(msg);
            }, null, this.disposables
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
        }, null, this.disposables);

        // Periodic refresh - postMessage only
        const interval = setInterval(() => {
            if (!this.panel) { clearInterval(interval); return; }
            this.pushFullState();
        }, 5000);
        this.disposables.push({ dispose: () => clearInterval(interval) });
    }

    private send(msg: any) {
        console.log('[Panel] Sending message:', msg.type);
        if (this.panel && this.panel.webview) {
            this.panel.webview.postMessage(msg);
        }
    }

    private async pushFullState() {
        // Send server status
        const counts = this.mcp.getToolCounts();
        const categories = this.mcp.getEnabledCategories();
        this.send({
            type: 'state',
            serverStatus: this.mcp.status,
            uptime: this.mcp.uptime,
            port: this.mcp.port,
            toolCounts: counts,
            categories,
            activityLog: this.activityLog.slice(-50)
        });

        // If server is running, fetch live data
        if (this.mcp.status === 'running') {
            try {
                const status = await this.mcp.callTool('get_status', {});
                this.send({ type: 'capsuleStatus', data: status });
            } catch { /* server may be busy */ }

            try {
                const slots = await this.mcp.callTool('list_slots', {});
                this.send({ type: 'slots', data: slots });
            } catch { /* ignore */ }
        }
    }

    private async handleMessage(msg: any) {
        switch (msg.command) {
            case 'callTool': {
                try {
                    const result = await this.mcp.callTool(msg.tool, msg.args || {});
                    this.send({ type: 'toolResult', id: msg.id, data: result });
                } catch (err: any) {
                    this.send({ type: 'toolResult', id: msg.id, error: err.message });
                }
                break;
            }
            case 'refresh':
                await this.pushFullState();
                break;
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'champion');
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // HTML Generation - Operations Facility UI
    // ═══════════════════════════════════════════════════════════════

    private buildHTML(scriptUri: vscode.Uri): string {
        const toolRegistryJSON = JSON.stringify(TOOL_CATEGORIES);

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Champion Council</title>
<style>
:root {
    --accent: #00ff88;
    --accent-dim: #00ff8833;
    --surface: #1a1a2e;
    --surface2: #16213e;
    --border: #2a2a4a;
    --text: #e0e0e0;
    --text-dim: #888;
    --red: #ff4444;
    --amber: #ffaa00;
    --green: #00ff88;
    --blue: #4488ff;
    --mono: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--mono);
    background: var(--vscode-editor-background, #0a0a1a);
    color: var(--text);
    font-size: 12px;
    line-height: 1.5;
    overflow-x: hidden;
}

/* ── HEADER ── */
.header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.header-title {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 3px;
    font-weight: 600;
}
.header-title span { color: var(--accent); }
.header-status {
    display: flex;
    gap: 20px;
    font-size: 11px;
}
.header-status .stat { display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot.amber { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
.dot.red { background: var(--red); box-shadow: 0 0 6px var(--red); }
.dot.off { background: #444; }
.dot.pulse { animation: pulse 2s infinite; }
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

/* ── TABS ── */
.tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    padding: 0 20px;
    background: var(--vscode-editor-background, #0a0a1a);
}
.tab {
    padding: 10px 16px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-dim);
    border-bottom: 2px solid transparent;
    font-family: var(--mono);
    background: none;
    border-top: none; border-left: none; border-right: none;
}
.tab:hover { color: var(--text); }
.tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
}

/* ── CONTENT ── */
.content { padding: 20px; display: none; }
.content.active { display: block; }

/* ── OVERVIEW TAB ── */
.arch-flow {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 20px 0;
}
.arch-tier {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent-dim);
    background: var(--surface);
}
.arch-tier.active { border-left-color: var(--accent); }
.arch-tier .tier-num {
    font-size: 18px;
    font-weight: 700;
    color: var(--accent);
    opacity: 0.5;
    width: 24px;
}
.arch-tier.active .tier-num { opacity: 1; }
.arch-tier .tier-name {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    min-width: 180px;
}
.arch-tier .tier-desc { color: var(--text-dim); font-size: 10px; }
.arch-tier .tier-status { margin-left: auto; }
.arch-connector { text-align: center; color: var(--border); font-size: 10px; letter-spacing: 3px; padding: 0 0 0 20px; }

.meta-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-top: 20px;
}
.meta-card {
    padding: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
}
.meta-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    margin-bottom: 4px;
}
.meta-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--accent);
}
.meta-value.small { font-size: 12px; }

.cat-bars { margin-top: 20px; }
.cat-bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 10px;
}
.cat-bar-label {
    width: 200px;
    text-align: right;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cat-bar-track {
    flex: 1;
    height: 6px;
    background: var(--border);
    position: relative;
}
.cat-bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s;
}
.cat-bar-fill.disabled { background: #333; }
.cat-bar-count { width: 30px; color: var(--text-dim); }

/* ── COUNCIL TAB ── */
.slots-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
}
.slot-card {
    border: 1px solid var(--border);
    padding: 14px;
    background: var(--surface);
    position: relative;
    cursor: default;
}
.slot-card.occupied {
    border-color: var(--accent);
    border-left-width: 3px;
}
.slot-num {
    position: absolute;
    top: 8px;
    right: 10px;
    font-size: 24px;
    font-weight: 800;
    opacity: 0.12;
}
.slot-status-line {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
}
.slot-model-name {
    font-size: 11px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 4px;
}
.slot-detail { font-size: 10px; color: var(--text-dim); }
.slot-actions {
    margin-top: 10px;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.council-controls {
    margin-top: 16px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

/* ── MEMORY TAB ── */
.memory-stats {
    display: flex;
    gap: 20px;
    margin-bottom: 16px;
}
.memory-list {
    border: 1px solid var(--border);
    max-height: 400px;
    overflow-y: auto;
}
.memory-item {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    display: flex;
    justify-content: space-between;
}
.memory-item:hover { background: var(--surface2); }

/* ── ACTIVITY TAB ── */
.activity-feed {
    max-height: 500px;
    overflow-y: auto;
    border: 1px solid var(--border);
}
.activity-entry {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
}
.activity-entry:hover { background: var(--surface2); }
.activity-ts { color: var(--text-dim); font-size: 10px; }
.activity-tool { color: var(--accent); font-weight: 600; }
.activity-cat {
    font-size: 9px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-left: 6px;
}
.activity-duration { color: var(--text-dim); float: right; }
.activity-detail {
    margin-top: 4px;
    padding: 6px 8px;
    background: var(--surface);
    font-size: 10px;
    max-height: 100px;
    overflow: auto;
    display: none;
    white-space: pre-wrap;
    word-break: break-all;
}
.activity-entry.expanded .activity-detail { display: block; }
.activity-filter {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: center;
}

/* ── TOOLS TAB ── */
.tool-category {
    margin-bottom: 12px;
    border: 1px solid var(--border);
}
.tool-category-header {
    padding: 10px 14px;
    background: var(--surface);
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 600;
    font-family: var(--mono);
    border: none;
    color: var(--text);
    width: 100%;
    text-align: left;
}
.tool-category-header:hover { background: var(--surface2); }
.tool-category-header .cat-badge {
    font-size: 10px;
    color: var(--text-dim);
    font-weight: 400;
}
.tool-category-header.disabled { opacity: 0.4; }
.tool-category-body {
    display: none;
    padding: 8px 14px;
}
.tool-category.expanded .tool-category-body { display: block; }
.tool-row {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.tool-row:last-child { border-bottom: none; }
.tool-name { color: var(--accent); font-weight: 600; }
.tool-desc { color: var(--text-dim); font-size: 10px; }

/* ── DIAGNOSTICS TAB ── */
.diag-section {
    margin-bottom: 20px;
}
.diag-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    margin-bottom: 8px;
    font-weight: 600;
}
.diag-output {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 12px;
    font-size: 11px;
    max-height: 250px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
}

/* ── BUTTONS ── */
button, .btn {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 4px 10px;
    font-size: 10px;
    font-family: var(--mono);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 1px;
}
button:hover, .btn:hover {
    background: var(--accent);
    color: #000;
}
button.btn-dim {
    border-color: var(--border);
    color: var(--text-dim);
}
button.btn-dim:hover {
    background: var(--border);
    color: var(--text);
}

/* ── INPUT ── */
input, select {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 10px;
    font-size: 11px;
    font-family: var(--mono);
    width: 100%;
}
input:focus, select:focus { border-color: var(--accent); outline: none; }

/* ── MODAL ── */
.modal-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8);
    z-index: 100;
    align-items: center;
    justify-content: center;
}
.modal-overlay.active { display: flex; }
.modal {
    background: var(--vscode-editor-background, #0a0a1a);
    border: 1px solid var(--accent);
    padding: 20px;
    width: 500px;
    max-width: 90%;
}
.modal-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin-bottom: 16px;
    color: var(--accent);
}
.modal .field { margin-bottom: 12px; }
.modal .field label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    display: block;
    margin-bottom: 4px;
}
.modal-actions { display: flex; gap: 8px; margin-top: 16px; }

.section-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--text-dim);
    margin-bottom: 12px;
    font-weight: 600;
}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
    <div class="header-title"><span>CHAMPION</span> COUNCIL</div>
    <div class="header-status">
        <div class="stat"><span class="dot off" id="hd-dot"></span> <span id="hd-status">CONNECTING</span></div>
        <div class="stat" id="hd-uptime">--:--:--</div>
        <div class="stat" id="hd-tools">0 / 134 TOOLS</div>
        <div class="stat" id="hd-port">:----</div>
    </div>
</div>

<!-- TABS -->
<div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="council">Council</button>
    <button class="tab" data-tab="memory">Memory</button>
    <button class="tab" data-tab="activity">Activity</button>
    <button class="tab" data-tab="tools">Tools</button>
    <button class="tab" data-tab="diagnostics">Diagnostics</button>
</div>

<!-- ═══════════════ OVERVIEW TAB ═══════════════ -->
<div class="content active" id="tab-overview">
    <div class="section-head">OUROBOROS ARCHITECTURE</div>
    <div class="arch-flow">
        <div class="arch-tier active" id="tier-1">
            <div class="tier-num">1</div>
            <div class="tier-name">Embedding Foundation</div>
            <div class="tier-desc">384-dim semantic substrate (all-MiniLM-L6-v2)</div>
            <div class="tier-status"><span class="dot green pulse"></span></div>
        </div>
        <div class="arch-connector">|</div>
        <div class="arch-tier active" id="tier-2">
            <div class="tier-num">2</div>
            <div class="tier-name">Dreamer World Model</div>
            <div class="tier-desc">5120-dim RSSM latent space, 15-step horizon</div>
            <div class="tier-status"><span class="dot green pulse"></span></div>
        </div>
        <div class="arch-connector">|</div>
        <div class="arch-tier active" id="tier-3">
            <div class="tier-num">3</div>
            <div class="tier-name">Scarecrow Adapter</div>
            <div class="tier-desc">384-64-384 LoRA, null port design (~49K params)</div>
            <div class="tier-status"><span class="dot green pulse"></span></div>
        </div>
        <div class="arch-connector">|</div>
        <div class="arch-tier active" id="tier-4">
            <div class="tier-num">4</div>
            <div class="tier-name">Council Consensus</div>
            <div class="tier-desc">8-slot multi-agent deliberation + HOLD gate</div>
            <div class="tier-status"><span class="dot green pulse"></span></div>
        </div>
        <div class="arch-connector">|</div>
        <div class="arch-tier active" id="tier-5">
            <div class="tier-num">5</div>
            <div class="tier-name">Cascade-Lattice Provenance</div>
            <div class="tier-desc">Cryptographic audit trail, merkle-observed</div>
            <div class="tier-status"><span class="dot green pulse"></span></div>
        </div>
    </div>

    <div class="meta-grid">
        <div class="meta-card">
            <div class="meta-label">Generation</div>
            <div class="meta-value" id="ov-gen">8</div>
        </div>
        <div class="meta-card">
            <div class="meta-label">Fitness</div>
            <div class="meta-value" id="ov-fitness">0.636</div>
        </div>
        <div class="meta-card">
            <div class="meta-label">Brain Type</div>
            <div class="meta-value small" id="ov-brain">ouroboros</div>
        </div>
        <div class="meta-card">
            <div class="meta-label">Quine Hash</div>
            <div class="meta-value small" id="ov-hash" style="font-size:10px;word-break:break-all;">1f74574c...</div>
        </div>
    </div>

    <div class="section-head" style="margin-top:24px;">TOOL CATEGORIES</div>
    <div class="cat-bars" id="cat-bars"></div>
</div>

<!-- ═══════════════ COUNCIL TAB ═══════════════ -->
<div class="content" id="tab-council">
    <div class="section-head">8-SLOT COUNCIL GRID</div>
    <div class="slots-grid" id="slots-grid"></div>
    <div class="council-controls">
        <button onclick="openPlugModal()">PLUG MODEL</button>
        <button onclick="callTool('list_slots',{})">REFRESH SLOTS</button>
        <button onclick="callTool('council_status',{})">CONSENSUS STATUS</button>
        <button class="btn-dim" onclick="callTool('all_slots',{})">INVOKE ALL</button>
    </div>
    <div class="diag-section" style="margin-top:16px;">
        <div class="diag-title">COUNCIL OUTPUT</div>
        <div class="diag-output" id="council-output" style="min-height:60px;">Run a council command above.</div>
    </div>
</div>

<!-- ═══════════════ MEMORY TAB ═══════════════ -->
<div class="content" id="tab-memory">
    <div class="section-head">FELIXBAG SEMANTIC MEMORY</div>
    <div class="memory-stats" id="mem-stats"></div>
    <div style="margin-bottom:12px;">
        <input id="mem-search" placeholder="Semantic search..." onkeyup="if(event.key==='Enter')memSearch()" />
    </div>
    <div class="memory-list" id="mem-list">
        <div class="memory-item" style="color:var(--text-dim);">Loading...</div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;">
        <button onclick="callTool('bag_catalog',{})">CATALOG</button>
        <button onclick="callTool('bag_export',{})">EXPORT</button>
        <button class="btn-dim" onclick="openInductModal()">INDUCT ITEM</button>
    </div>
</div>

<!-- ═══════════════ ACTIVITY TAB ═══════════════ -->
<div class="content" id="tab-activity">
    <div class="section-head">LIVE ACTIVITY FEED</div>
    <div class="activity-filter">
        <input id="activity-filter" placeholder="Filter by tool name..." style="width:300px;" />
        <button class="btn-dim" onclick="clearActivity()">CLEAR</button>
    </div>
    <div class="activity-feed" id="activity-feed">
        <div class="activity-entry" style="color:var(--text-dim);padding:20px;text-align:center;">
            Waiting for tool calls...
        </div>
    </div>
</div>

<!-- ═══════════════ TOOLS TAB ═══════════════ -->
<div class="content" id="tab-tools">
    <div class="section-head">TOOL REGISTRY (146 TOOLS / 21 CATEGORIES)</div>
    <div style="margin-bottom:12px;display:flex;gap:8px;">
        <button onclick="vscode.postMessage({command:'openSettings'})">OPEN SETTINGS</button>
        <button class="btn-dim" onclick="callTool('get_capabilities',{})">QUERY CAPABILITIES</button>
    </div>
    <div id="tools-registry"></div>
</div>

<!-- ═══════════════ DIAGNOSTICS TAB ═══════════════ -->
<div class="content" id="tab-diagnostics">
    <div class="section-head">SYSTEM DIAGNOSTICS</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button onclick="callTool('verify_integrity',{})">VERIFY INTEGRITY</button>
        <button onclick="callTool('verify_hash',{})">VERIFY HASH</button>
        <button onclick="callTool('get_provenance',{})">PROVENANCE CHAIN</button>
        <button onclick="callTool('tree',{})">STRUCTURE TREE</button>
        <button onclick="callTool('show_weights',{})">WEIGHTS</button>
        <button onclick="callTool('show_dims',{})">DIMENSIONS</button>
        <button onclick="callTool('show_rssm',{})">RSSM</button>
        <button onclick="callTool('show_lora',{})">LORA</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button class="btn-dim" onclick="callTool('export_pt',{})">EXPORT .PT</button>
        <button class="btn-dim" onclick="callTool('export_onnx',{})">EXPORT .ONNX</button>
        <button class="btn-dim" onclick="callTool('export_docs',{})">EXPORT DOCS</button>
        <button class="btn-dim" onclick="callTool('save_state',{})">SAVE STATE</button>
        <button class="btn-dim" onclick="callTool('demo',{})">RUN DEMO</button>
    </div>
    <div class="section-head" style="margin-top:20px;">CASCADE LATTICE</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button onclick="callTool('cascade_graph',{operation:'stats'})">GRAPH STATS</button>
        <button onclick="callTool('cascade_chain',{operation:'genesis'})">GENESIS</button>
        <button onclick="callTool('cascade_chain',{operation:'identity'})">IDENTITY</button>
        <button onclick="callTool('cascade_record',{operation:'session_stats'})">SESSION STATS</button>
        <button class="btn-dim" onclick="callTool('cascade_proxy',{operation:'status'})">PROXY STATUS</button>
        <button class="btn-dim" onclick="callTool('heartbeat',{})">HEARTBEAT</button>
        <button class="btn-dim" onclick="callTool('get_about',{})">ABOUT</button>
    </div>
    <div class="diag-section">
        <div class="diag-title">OUTPUT</div>
        <div class="diag-output" id="diag-output">Run a diagnostic command above.</div>
    </div>
</div>

<!-- ═══════════════ PLUG MODEL MODAL ═══════════════ -->
<div class="modal-overlay" id="plug-modal">
    <div class="modal">
        <div class="modal-title">PLUG MODEL INTO SLOT</div>
        <div class="field">
            <label>HuggingFace Model ID</label>
            <input id="plug-model-id" placeholder="BAAI/bge-small-en" />
        </div>
        <div class="field">
            <label>Slot Name (optional)</label>
            <input id="plug-slot-name" placeholder="my-embedder" />
        </div>
        <div class="modal-actions">
            <button onclick="doPlug()">PLUG</button>
            <button class="btn-dim" onclick="closeModals()">CANCEL</button>
        </div>
    </div>
</div>

<!-- ═══════════════ INDUCT MODAL ═══════════════ -->
<div class="modal-overlay" id="induct-modal">
    <div class="modal">
        <div class="modal-title">INDUCT INTO FELIXBAG</div>
        <div class="field">
            <label>Key</label>
            <input id="induct-key" placeholder="my-document" />
        </div>
        <div class="field">
            <label>Content</label>
            <input id="induct-value" placeholder="The content to store..." />
        </div>
        <div class="modal-actions">
            <button onclick="doInduct()">INDUCT</button>
            <button class="btn-dim" onclick="closeModals()">CANCEL</button>
        </div>
    </div>
</div>

<script>window.__CATEGORIES__ = ${toolRegistryJSON};</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
