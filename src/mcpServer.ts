import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import * as zlib from 'zlib';

// Tool category → tool name mapping (146 tools across 21 categories)
export const TOOL_CATEGORIES: Record<string, { setting: string; tools: string[] }> = {
    'Core Inference': {
        setting: 'coreInference',
        tools: ['forward', 'infer', 'embed_text', 'deliberate', 'imagine']
    },
    'Chat & Conversation': {
        setting: 'chat',
        tools: ['chat', 'chat_reset', 'chat_history']
    },
    'Batch Operations': {
        setting: 'batch',
        tools: ['batch_forward', 'batch_embed', 'pipe', 'compare', 'invoke_slot']
    },
    'Council/Slot Management': {
        setting: 'councilSlots',
        tools: ['plug_model', 'unplug_slot', 'list_slots', 'clone_slot', 'mutate_slot', 'rename_slot', 'swap_slots', 'slot_info', 'get_slot_params', 'hub_plug', 'cull_slot', 'load_manifest']
    },
    'Council Operations': {
        setting: 'council',
        tools: ['broadcast', 'council_broadcast', 'council_status', 'set_consensus', 'debate', 'chain', 'all_slots']
    },
    'FelixBag Memory': {
        setting: 'felixbag',
        tools: ['bag_get', 'bag_put', 'bag_search', 'bag_catalog', 'bag_induct', 'bag_forget', 'bag_export', 'pocket', 'summon', 'materialize', 'load_bag', 'save_bag']
    },
    'HuggingFace Hub': {
        setting: 'huggingface',
        tools: ['hub_search', 'hub_search_datasets', 'hub_top', 'hub_info', 'hub_download', 'hub_tasks', 'hub_count', 'capture_model']
    },
    'LLM Operations': {
        setting: 'llm',
        tools: ['generate', 'classify', 'rerank']
    },
    'Vast.AI GPU Rental': {
        setting: 'vastai',
        tools: ['vast_search', 'vast_details', 'vast_rent', 'vast_instances', 'vast_stop', 'vast_connect', 'vast_ready', 'vast_run', 'vast_load_model', 'vast_generate', 'vast_embed', 'vast_broadcast', 'vast_distribute']
    },
    'Snapshots & Variants': {
        setting: 'replication',
        tools: ['replicate', 'spawn_swarm', 'spawn_quine', 'export_quine', 'import_brain']
    },
    'Export & Documentation': {
        setting: 'export',
        tools: ['export_config', 'export_docs', 'export_interface', 'export_pt', 'export_onnx', 'get_readme', 'get_artifacts', 'save_state']
    },
    'Visualization': {
        setting: 'visualization',
        tools: ['start_rerun_viewer', 'log_to_rerun', 'rerun_log_inference', 'rerun_log_evolution', 'spawn_tui']
    },
    'Status & Introspection': {
        setting: 'status',
        tools: ['get_status', 'get_capabilities', 'get_identity', 'get_genesis', 'get_provenance', 'verify_integrity', 'verify_hash', 'tree', 'show_weights', 'show_dims', 'show_rssm', 'show_lora', 'demo', 'get_help', 'get_about', 'get_onboarding', 'get_quickstart', 'list_models', 'heartbeat', 'get_embedder_info']
    },
    'Diagnostics': {
        setting: 'diagnostics',
        tools: ['diagnose_file', 'diagnose_directory', 'symbiotic_interpret', 'trace_root_causes', 'forensics_analyze', 'metrics_analyze']
    },
    'API & Server': {
        setting: 'apiServer',
        tools: ['start_api_server', 'orchestra', 'relay_status', 'relay_send', 'spawn_tui', 'toggle_relay']
    },
    'HOLD Protocol': {
        setting: 'hold',
        tools: ['hold_yield', 'hold_resolve']
    },
    'Safety': {
        setting: 'security',
        tools: ['crystallize', 'resume_agent', 'is_frozen']
    },
    'Workflow Automation': {
        setting: 'workflows',
        tools: ['workflow_test', 'workflow_execute', 'workflow_list', 'workflow_create', 'workflow_get', 'workflow_update', 'workflow_delete', 'workflow_history', 'workflow_status']
    },
    'Advanced': {
        setting: 'advanced',
        tools: ['call', 'observe', 'feed', 'grab_slot', 'restore_slot']
    },
    'Cache Management': {
        setting: 'cache',
        tools: ['get_cached', 'clear_cache']
    },
    'CASCADE Observability': {
        setting: 'cascade',
        tools: ['cascade_graph', 'cascade_chain', 'cascade_data', 'cascade_system', 'cascade_instrument', 'cascade_record', 'cascade_proxy']
    }
};

export interface ToolCallEvent {
    timestamp: number;
    tool: string;
    category: string;
    args: Record<string, any>;
    result?: any;
    error?: string;
    durationMs?: number;
    source?: 'extension' | 'external' | 'internal';
}

type ServerStatus = 'starting' | 'running' | 'stopped' | 'error';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface CallToolOptions {
    suppressActivity?: boolean;
    source?: 'extension' | 'internal';
}

/**
 * MCP Server Manager
 * Spawns champion_gen8.py in HTTP/SSE mode and communicates via persistent SSE stream.
 *
 * FastMCP SSE protocol:
 * 1. Client opens GET /sse (persistent connection, stays open)
 * 2. Server sends: event: endpoint\ndata: /messages/?session_id=xxx\n\n
 * 3. Client POSTs JSON-RPC to /messages/?session_id=xxx -> gets 202 Accepted
 * 4. Server sends JSON-RPC response back through the SSE stream
 * 5. Client matches response to request by JSON-RPC id
 */
export class MCPServerManager {
    private pythonProcess: child_process.ChildProcess | null = null;
    private _status: ServerStatus = 'stopped';
    private statusListeners: ((status: ServerStatus) => void)[] = [];
    private activityListeners: ((event: ToolCallEvent) => void)[] = [];
    private _startTime: number = 0;
    private _port: number = 8765;
    private _messagesEndpoint: string = '';
    private _sseResponse: http.IncomingMessage | null = null;
    private _sseRequest: http.ClientRequest | null = null;
    private _pendingRequests: Map<number, PendingRequest> = new Map();
    private _nextId: number = 1;
    private _sseBuf: string = '';
    private _capsulePath: string = '';
    private _mcpLogPath: string = '';
    private _mcpLogOffset: number = 0;
    private _mcpLogRemainder: string = '';
    private _mcpLogPollTimer: ReturnType<typeof setInterval> | null = null;
    private _recentLocalToolCalls: Array<{ tool: string; timestamp: number; dedupeWindowMs: number }> = [];
    // Marathon-session hardening: SSE heartbeat, auto-restart, periodic cache cleanup
    private _lastSseDataTime: number = 0;
    private _sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private _hasAttemptedRestart: boolean = false;
    private _cacheCleanupTimer: ReturnType<typeof setInterval> | null = null;
    private static readonly SSE_HEARTBEAT_TIMEOUT_MS = 60000; // 60s no data = dead
    private static readonly CACHE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 min
    private static readonly LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB
    private static readonly LOG_KEEP_SIZE = 1 * 1024 * 1024; // keep last 1MB

    constructor(private context: vscode.ExtensionContext) {}

    get status(): ServerStatus { return this._status; }
    get port(): number { return this._port; }
    get uptime(): number { return this._startTime ? Date.now() - this._startTime : 0; }

    onStatusChange(listener: (status: ServerStatus) => void) {
        this.statusListeners.push(listener);
        listener(this._status);
    }

    onActivity(listener: (event: ToolCallEvent) => void) {
        this.activityListeners.push(listener);
    }

    private setStatus(status: ServerStatus) {
        this._status = status;
        this.statusListeners.forEach(l => l(status));
    }

    private emitActivity(event: ToolCallEvent) {
        this.activityListeners.forEach(l => l(event));
    }

    /** Resolve the category name for a given tool */
    getCategoryForTool(toolName: string): string {
        for (const [category, info] of Object.entries(TOOL_CATEGORIES)) {
            if (info.tools.includes(toolName)) {
                return category;
            }
        }
        return 'Unknown';
    }

    /** Get enabled categories from settings */
    getEnabledCategories(): Record<string, boolean> {
        const config = vscode.workspace.getConfiguration('champion.tools');
        const result: Record<string, boolean> = {};
        for (const [category, info] of Object.entries(TOOL_CATEGORIES)) {
            result[category] = config.get(info.setting, true);
        }
        return result;
    }

    /** Get total tool count (enabled / total) */
    getToolCounts(): { enabled: number; total: number } {
        const enabled = this.getEnabledCategories();
        let enabledCount = 0;
        let totalCount = 0;
        for (const [category, info] of Object.entries(TOOL_CATEGORIES)) {
            totalCount += info.tools.length;
            if (enabled[category]) {
                enabledCount += info.tools.length;
            }
        }
        return { enabled: enabledCount, total: totalCount };
    }

    private _attachedToExisting = false;

    async start(): Promise<void> {
        if (this.pythonProcess || this._attachedToExisting) {
            return;
        }

        this.setStatus('starting');
        this._messagesEndpoint = '';
        this._sseBuf = '';

        const config = vscode.workspace.getConfiguration('champion');
        const pythonPath = config.get('pythonPath', 'python');
        this._port = config.get('mcpPort', 8765);
        let scriptPathForLogs = '';

        // Phase 0: Check if an MCP server is already running on this port
        // (e.g. TUI started "mcp remote"). If so, attach — don't spawn.
        const alreadyRunning = await this.isPortReachable(this._port);

        if (alreadyRunning) {
            console.log(`[MCP] Server already running on port ${this._port} — attaching (no spawn)`);
            this._attachedToExisting = true;
            try {
                scriptPathForLogs = this.resolveCapsulePath();
                this._capsulePath = scriptPathForLogs;
            } catch {
                // Attached mode may not expose capsule path. We'll fall back to known log candidates.
            }
        } else {
            // Clean up any orphaned rerun viewers from previous sessions
            this.killOrphanRerun();
            // Resolve capsule path (user setting > extracted .gz > raw file)
            const scriptPath = this.resolveCapsulePath();
            this._capsulePath = scriptPath;
            scriptPathForLogs = scriptPath;
            const args = [scriptPath, '--mcp-remote', `--port=${this._port}`];

            this.pythonProcess = child_process.spawn(pythonPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: path.dirname(scriptPath),
                env: { ...process.env }
            });

            this.pythonProcess.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log('[MCP]', msg.trim());
                this.parseStderrForProgress(msg);
            });

            this.pythonProcess.stdout?.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log('[MCP stdout]', msg.trim());
                this.parseStderrForProgress(msg);
            });

            this.pythonProcess.on('exit', (code) => {
                console.log(`MCP server exited (code ${code})`);
                this.pythonProcess = null;
                this.closeSseConnection();
                this.setStatus('stopped');
            });

            this.pythonProcess.on('error', (err) => {
                this.setStatus('error');
                vscode.window.showErrorMessage(`Champion MCP: ${err.message}`);
            });
        }

        try {
            // Phase 1: Wait for HTTP server to be reachable
            await this.waitForHttpReady(60000);
            console.log('[MCP] HTTP server is reachable');

            // Phase 2: Open persistent SSE connection and get session endpoint
            await this.openSseConnection(15000);
            console.log('[MCP] SSE connected, endpoint:', this._messagesEndpoint);

            // Phase 3: MCP protocol initialization handshake
            await this.initializeMcp();
            console.log('[MCP] MCP protocol initialized');

            this._startTime = Date.now();
            this._hasAttemptedRestart = false;
            this.setStatus('running');
            this.startMcpLogPolling(scriptPathForLogs);
            this.startSseHeartbeat();
            this.startPeriodicCacheCleanup();

            // Initialize Rerun bridge (non-blocking).
            // start_rerun_viewer reuses existing recording if TUI already
            // started one — no parallel recordings.
            this.initRerunBridge().catch(() => {});

        } catch (error: any) {
            this.setStatus('error');
            throw error;
        }
    }

    /**
     * Resolve the path to champion_gen8.py.
     * Priority: user setting > extracted from bundled .gz > raw file in extension dir
     */
    private resolveCapsulePath(): string {
        const config = vscode.workspace.getConfiguration('champion');
        const customPath = config.get<string>('capsulePath', '');
        if (customPath && fs.existsSync(customPath)) {
            return customPath;
        }

        // Check raw .py in extension dir (dev mode)
        const rawPath = path.join(this.context.extensionPath, 'champion_gen8.py');
        if (fs.existsSync(rawPath)) {
            return rawPath;
        }

        // Extract from bundled .gz (marketplace install)
        const gzPath = path.join(this.context.extensionPath, 'resources', 'capsule.gz');
        if (fs.existsSync(gzPath)) {
            const extractDir = this.context.globalStorageUri.fsPath;
            const extractedPath = path.join(extractDir, 'champion_gen8.py');
            // Re-extract if .gz is newer than the extracted copy (handles version upgrades)
            let needsExtract = !fs.existsSync(extractedPath);
            if (!needsExtract) {
                const gzMtime = fs.statSync(gzPath).mtimeMs;
                const exMtime = fs.statSync(extractedPath).mtimeMs;
                if (gzMtime > exMtime) {
                    needsExtract = true;
                    console.log('[MCP] Capsule .gz is newer — re-extracting');
                }
            }
            if (needsExtract) {
                if (!fs.existsSync(extractDir)) {
                    fs.mkdirSync(extractDir, { recursive: true });
                }
                const compressed = fs.readFileSync(gzPath);
                const decompressed = zlib.gunzipSync(compressed);
                fs.writeFileSync(extractedPath, decompressed);
                console.log('[MCP] Extracted capsule to:', extractedPath);
            }
            return extractedPath;
        }

        throw new Error(
            'Champion capsule not found. Either:\n' +
            '1. Set "champion.capsulePath" in settings to your champion_gen8.py path\n' +
            '2. Start the TUI with "mcp remote" first (extension will auto-attach)'
        );
    }

    /** Quick TCP probe to check if a port is already listening */
    private isPortReachable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
                res.resume();
                resolve(true);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    async stop(): Promise<void> {
        this.stopSseHeartbeat();
        this.stopPeriodicCacheCleanup();
        this.closeSseConnection();
        this.stopMcpLogPolling();
        this._rerunReady = false;
        this._rerunSeeded = false;
        if (this._attachedToExisting) {
            // We didn't spawn it — just disconnect, but still clean up orphan rerun
            this._attachedToExisting = false;
            this._startTime = 0;
            this.killOrphanRerun();
            this.setStatus('stopped');
            return;
        }
        if (!this.pythonProcess) { return; }
        this.killProcessTree(this.pythonProcess);
        this.pythonProcess = null;
        this._startTime = 0;
        this.setStatus('stopped');
    }

    /** Kill a process and all its children (including Rerun viewer) */
    private killProcessTree(proc: child_process.ChildProcess) {
        const pid = proc.pid;
        if (!pid) { proc.kill(); return; }
        try {
            // On Windows, taskkill /T kills the entire process tree
            if (process.platform === 'win32') {
                child_process.execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
            } else {
                // On Unix, kill the process group
                process.kill(-pid, 'SIGTERM');
            }
        } catch {
            // Fallback: simple kill
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
    }

    /** Kill any orphaned rerun processes that survived a previous shutdown */
    private killOrphanRerun() {
        try {
            if (process.platform === 'win32') {
                child_process.exec('taskkill /F /IM rerun.exe 2>nul', { stdio: 'ignore' } as any);
            } else {
                child_process.exec('pkill -f rerun 2>/dev/null', { stdio: 'ignore' } as any);
            }
        } catch { /* no rerun running — that's fine */ }
    }

    async restart(): Promise<void> {
        await this.stop();
        await new Promise(r => setTimeout(r, 1000));
        await this.start();
    }

    /** Close SSE connection and reject all pending requests */
    private closeSseConnection() {
        if (this._sseResponse) {
            this._sseResponse.destroy();
            this._sseResponse = null;
        }
        if (this._sseRequest) {
            this._sseRequest.destroy();
            this._sseRequest = null;
        }
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('SSE connection closed'));
        }
        this._pendingRequests.clear();
        this._messagesEndpoint = '';
        this._sseBuf = '';
    }

    // ── MARATHON SESSION HARDENING ──────────────────────────────

    /** SSE heartbeat: detect silent connection death */
    private startSseHeartbeat() {
        this.stopSseHeartbeat();
        this._lastSseDataTime = Date.now();
        this._sseHeartbeatTimer = setInterval(() => {
            if (this._status !== 'running') { return; }
            const elapsed = Date.now() - this._lastSseDataTime;
            if (elapsed > MCPServerManager.SSE_HEARTBEAT_TIMEOUT_MS) {
                console.warn(`[MCP] SSE heartbeat timeout (${Math.round(elapsed / 1000)}s no data) — triggering reconnect`);
                this._lastSseDataTime = Date.now(); // prevent re-trigger
                if (this._sseResponse) {
                    this._sseResponse.destroy();
                    this._sseResponse = null;
                }
                this.reconnectSse();
            }
        }, 15000); // check every 15s
    }

    private stopSseHeartbeat() {
        if (this._sseHeartbeatTimer) {
            clearInterval(this._sseHeartbeatTimer);
            this._sseHeartbeatTimer = null;
        }
    }

    /** Periodic Python-side cache cleanup (every 30 min) */
    private startPeriodicCacheCleanup() {
        this.stopPeriodicCacheCleanup();
        this._cacheCleanupTimer = setInterval(() => {
            if (this._status !== 'running') { return; }
            console.log('[MCP] Periodic cache cleanup...');
            this.callTool('clear_cache', {}, { suppressActivity: true, source: 'internal' }).catch(() => {});
        }, MCPServerManager.CACHE_CLEANUP_INTERVAL_MS);
    }

    private stopPeriodicCacheCleanup() {
        if (this._cacheCleanupTimer) {
            clearInterval(this._cacheCleanupTimer);
            this._cacheCleanupTimer = null;
        }
    }

    /** Log rotation: truncate .mcp_server.log if it exceeds 5MB */
    private async rotateLogIfNeeded(): Promise<void> {
        if (!this._mcpLogPath) { return; }
        try {
            const stat = await fs.promises.stat(this._mcpLogPath);
            if (stat.size > MCPServerManager.LOG_MAX_SIZE) {
                const fh = await fs.promises.open(this._mcpLogPath, 'r');
                try {
                    const keepOffset = stat.size - MCPServerManager.LOG_KEEP_SIZE;
                    const buf = Buffer.alloc(MCPServerManager.LOG_KEEP_SIZE);
                    await fh.read(buf, 0, MCPServerManager.LOG_KEEP_SIZE, keepOffset);
                    await fh.close();
                    await fs.promises.writeFile(this._mcpLogPath, buf);
                    this._mcpLogOffset = MCPServerManager.LOG_KEEP_SIZE;
                    this._mcpLogRemainder = '';
                    console.log(`[MCP] Log rotated: ${Math.round(stat.size / 1024)}KB → ${Math.round(MCPServerManager.LOG_KEEP_SIZE / 1024)}KB`);
                } catch {
                    await fh.close();
                }
            }
        } catch { /* file may not exist yet */ }
    }

    private rememberLocalToolCall(toolName: string, options: CallToolOptions = {}) {
        const now = Date.now();
        const suppressEcho = options.suppressActivity === true || options.source === 'internal';
        const dedupeWindowMs = suppressEcho ? 120000 : 10000;
        const maxWindowMs = 180000;

        this._recentLocalToolCalls.push({ tool: toolName, timestamp: now, dedupeWindowMs });
        this._recentLocalToolCalls = this._recentLocalToolCalls.filter((e) => now - e.timestamp < maxWindowMs);
    }

    private isLikelyLocalEcho(toolName: string, eventTimestamp: number): boolean {
        const now = Date.now();
        const maxWindowMs = 180000;
        this._recentLocalToolCalls = this._recentLocalToolCalls.filter((e) => now - e.timestamp < maxWindowMs);

        let bestMatchIndex = -1;
        let bestDelta = Number.MAX_SAFE_INTEGER;

        for (let i = 0; i < this._recentLocalToolCalls.length; i++) {
            const candidate = this._recentLocalToolCalls[i];
            if (candidate.tool !== toolName) { continue; }

            const delta = Math.abs(eventTimestamp - candidate.timestamp);
            if (delta <= candidate.dedupeWindowMs && delta < bestDelta) {
                bestDelta = delta;
                bestMatchIndex = i;
            }
        }

        if (bestMatchIndex >= 0) {
            // Consume the matched local call so one local invocation only suppresses one log echo.
            this._recentLocalToolCalls.splice(bestMatchIndex, 1);
            return true;
        }

        return false;
    }

    private resolveMcpLogPath(capsulePathHint?: string): string {
        const candidates: string[] = [];
        if (capsulePathHint) {
            candidates.push(path.join(path.dirname(capsulePathHint), '.mcp_server.log'));
        }
        if (this._capsulePath) {
            candidates.push(path.join(path.dirname(this._capsulePath), '.mcp_server.log'));
        }
        candidates.push(path.join(this.context.extensionPath, '.mcp_server.log'));
        candidates.push(path.join(this.context.globalStorageUri.fsPath, '.mcp_server.log'));

        // Check sibling IDE globalStorage paths (Windsurf, Cursor, etc.)
        // The MCP server may have been spawned by another IDE using the same capsule
        const gsParent = path.dirname(this.context.globalStorageUri.fsPath);
        const extId = 'ouroboros.champion-council';
        try {
            const homeDir = process.env.APPDATA || process.env.HOME || '';
            const ideStoragePaths = [
                path.join(homeDir, 'Windsurf', 'User', 'globalStorage', extId),
                path.join(homeDir, 'Cursor', 'User', 'globalStorage', extId),
                path.join(homeDir, 'Code', 'User', 'globalStorage', extId),
                path.join(homeDir, 'Code - Insiders', 'User', 'globalStorage', extId),
                path.join(homeDir, 'Kiro', 'User', 'globalStorage', extId),
                path.join(homeDir, 'Antigravity', 'User', 'globalStorage', extId),
            ];
            for (const p of ideStoragePaths) {
                candidates.push(path.join(p, '.mcp_server.log'));
            }
        } catch { /* ignore */ }

        // Pick the most recently modified log file
        let bestPath = '';
        let bestMtime = 0;
        for (const candidate of candidates) {
            try {
                if (candidate && fs.existsSync(candidate)) {
                    const mtime = fs.statSync(candidate).mtimeMs;
                    if (mtime > bestMtime) {
                        bestMtime = mtime;
                        bestPath = candidate;
                    }
                }
            } catch { /* skip */ }
        }
        if (bestPath) {
            console.log('[MCP] Resolved log path:', bestPath);
            return bestPath;
        }

        return candidates[0] || path.join(this.context.extensionPath, '.mcp_server.log');
    }

    private startMcpLogPolling(capsulePathHint?: string) {
        this.stopMcpLogPolling();
        this._mcpLogPath = this.resolveMcpLogPath(capsulePathHint);
        this._mcpLogRemainder = '';

        try {
            const stat = fs.statSync(this._mcpLogPath);
            // Start at EOF so we only emit fresh activity for this session.
            this._mcpLogOffset = stat.size;
            console.log(`[MCP] Log polling started: ${this._mcpLogPath} (offset=${stat.size})`);
        } catch {
            this._mcpLogOffset = 0;
            console.log(`[MCP] Log polling started: ${this._mcpLogPath} (file not found, offset=0)`);
        }

        this._mcpLogPollTimer = setInterval(() => {
            this.pollMcpLogForActivity().catch((err) => {
                console.error('[MCP] Log poll error:', err?.message || err);
            });
            this.rotateLogIfNeeded().catch(() => {});
        }, 750);
    }

    private stopMcpLogPolling() {
        if (this._mcpLogPollTimer) {
            clearInterval(this._mcpLogPollTimer);
            this._mcpLogPollTimer = null;
        }
        this._mcpLogRemainder = '';
        this._mcpLogOffset = 0;
    }

    private parseLogTimestamp(hours: number, minutes: number, seconds: number): number {
        const now = new Date();
        const ts = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            hours,
            minutes,
            seconds,
            0
        ).getTime();

        // Handle midnight crossover safely.
        const diff = ts - Date.now();
        if (diff > 6 * 60 * 60 * 1000) {
            return ts - 24 * 60 * 60 * 1000;
        }
        if (diff < -18 * 60 * 60 * 1000) {
            return ts + 24 * 60 * 60 * 1000;
        }
        return ts;
    }

    private parseToolLine(line: string): { timestamp: number; tool: string; argsSummary: string } | null {
        const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+🔧\s+([a-zA-Z0-9_]+)\((.*)\)\s*$/);
        if (!match) { return null; }
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);
        const tool = match[4];
        const argsSummary = (match[5] || '').trim();
        return {
            timestamp: this.parseLogTimestamp(hours, minutes, seconds),
            tool,
            argsSummary
        };
    }

    private async pollMcpLogForActivity(): Promise<void> {
        if (!this._mcpLogPath || this._status !== 'running') { return; }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(this._mcpLogPath);
        } catch {
            return;
        }

        if (stat.size < this._mcpLogOffset) {
            this._mcpLogOffset = 0;
            this._mcpLogRemainder = '';
        }

        if (stat.size === this._mcpLogOffset) {
            return;
        }

        const bytesToRead = stat.size - this._mcpLogOffset;
        if (bytesToRead <= 0) { return; }

        const MAX_TAIL_BYTES = 512 * 1024;
        if (bytesToRead > MAX_TAIL_BYTES) {
            this._mcpLogOffset = stat.size - MAX_TAIL_BYTES;
            this._mcpLogRemainder = '';
        }

        const readBytes = stat.size - this._mcpLogOffset;
        if (readBytes <= 0) { return; }

        // Use readFileSync + slice instead of open()+read() — Windows file
        // sharing semantics cause open('r') to fail with EBUSY/EACCES when
        // the Python MCP server has the log open for append.
        let chunk: string;
        try {
            const fullBuf = fs.readFileSync(this._mcpLogPath);
            chunk = fullBuf.subarray(this._mcpLogOffset, this._mcpLogOffset + readBytes).toString('utf8');
            this._mcpLogOffset = stat.size;
        } catch {
            return;
        }

        const text = this._mcpLogRemainder + chunk;
        const lines = text.split(/\r?\n/);
        this._mcpLogRemainder = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) { continue; }
            const parsed = this.parseToolLine(line);
            if (!parsed) { continue; }
            if (this.isLikelyLocalEcho(parsed.tool, parsed.timestamp)) {
                continue;
            }

            this.emitActivity({
                timestamp: parsed.timestamp,
                tool: parsed.tool,
                category: this.getCategoryForTool(parsed.tool),
                args: parsed.argsSummary ? { summary: parsed.argsSummary } : {},
                result: parsed.argsSummary ? `[external] ${parsed.argsSummary}` : '[external call]',
                durationMs: 0,
                source: 'external'
            });

            if (parsed.tool === 'workflow_execute' || parsed.tool === 'workflow_status') {
                this.fetchExternalWorkflowResult(parsed).catch(() => {});
            }
        }
    }

    // ── EXTERNAL WORKFLOW EXECUTION DETECTION ──
    // Mirrors the model-plugging approach: when an external client runs a workflow,
    // fetch the real execution result and re-emit it so the webview can render animations.
    private async fetchExternalWorkflowResult(parsed: { timestamp: number; tool: string; argsSummary: string }): Promise<void> {
        // Extract workflow_id from argsSummary like "workflow_id=inference_pipeline, input_data=..."
        const wfIdMatch = parsed.argsSummary.match(/workflow_id\s*=\s*([^,\s)]+)/);
        const execIdMatch = parsed.argsSummary.match(/execution_id\s*=\s*([^,\s)]+)/);

        if (parsed.tool === 'workflow_status' && execIdMatch) {
            // Direct status fetch
            try {
                const result = await this.callToolParsed('workflow_status', { execution_id: execIdMatch[1] }, { suppressActivity: true, source: 'internal' });
                if (result && typeof result === 'object' && result.node_states) {
                    this.emitActivity({
                        timestamp: Date.now(),
                        tool: 'workflow_status',
                        category: this.getCategoryForTool('workflow_status'),
                        args: { execution_id: execIdMatch[1] },
                        result: JSON.stringify(result),
                        durationMs: 0,
                        source: 'external'
                    });
                }
            } catch { /* ignore */ }
            return;
        }

        if (parsed.tool === 'workflow_execute' && wfIdMatch) {
            const workflowId = wfIdMatch[1];
            // Fetch latest execution history to get the execution result with node_states
            try {
                const history = await this.callToolParsed('workflow_history', { workflow_id: workflowId, limit: '1' }, { suppressActivity: true, source: 'internal' });
                const executions = history?.executions || history?.history || (Array.isArray(history) ? history : []);
                const latest = executions[0];
                if (latest && typeof latest === 'object') {
                    // Ensure workflow_id is set
                    if (!latest.workflow_id) { latest.workflow_id = workflowId; }
                    this.emitActivity({
                        timestamp: Date.now(),
                        tool: 'workflow_execute',
                        category: this.getCategoryForTool('workflow_execute'),
                        args: { workflow_id: workflowId },
                        result: JSON.stringify(latest),
                        durationMs: 0,
                        source: 'external'
                    });
                }
            } catch { /* ignore */ }
        }
    }

    // ── REAL-TIME MODEL LOADING DETECTION ──
    private _plugProgressState: { modelId: string; phase: string; startTime: number } | null = null;
    private _lastProgressEmit: number = 0;

    private cleanProgressText(raw: string): string {
        // Strip ANSI escape codes
        let clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        // Strip tqdm bar characters (Unicode blocks, pipes, brackets)
        clean = clean.replace(/[░▒▓█▏▎▍▌▋▊▉\|│┃■□●○◉◎⣿⣷⣶⣦⣤⣄⡄⡀]/g, '');
        // Strip carriage returns and excessive whitespace
        clean = clean.replace(/\r/g, '').replace(/\s{2,}/g, ' ').trim();
        // Remove null bytes
        clean = clean.replace(/\0/g, '');
        return clean;
    }

    private extractProgressInfo(line: string): string | null {
        // tqdm: "  42%|████      | 1.2G/2.8G [00:05<00:08, 200MB/s]"
        const tqdmMatch = line.match(/(\d+)%.*?(\d+(?:\.\d+)?[KMGT]?i?B?)\/(\d+(?:\.\d+)?[KMGT]?i?B)/i);
        if (tqdmMatch) {
            return `${tqdmMatch[1]}% — ${tqdmMatch[2]} / ${tqdmMatch[3]}`;
        }

        // Percentage only: "  42%"
        const pctMatch = line.match(/(\d+)%/);

        // Shard loading: "Loading checkpoint shards: 2/4"
        const shardMatch = line.match(/Loading checkpoint shards.*?(\d+)\s*\/\s*(\d+)/i);
        if (shardMatch) {
            return `Loading shards ${shardMatch[1]}/${shardMatch[2]}`;
        }

        // Download with size: "Downloading model.safetensors: 2.1GB"
        const dlMatch = line.match(/Downloading\s+(\S+).*?(\d+(?:\.\d+)?\s*[KMGT]?i?B)/i);
        if (dlMatch) {
            const file = dlMatch[1].length > 30 ? dlMatch[1].substring(0, 27) + '...' : dlMatch[1];
            return `Downloading ${file} (${dlMatch[2]})`;
        }

        // Generic download
        const dlGeneric = line.match(/Downloading\s+(\S+)/i);
        if (dlGeneric) {
            const file = dlGeneric[1].length > 40 ? dlGeneric[1].substring(0, 37) + '...' : dlGeneric[1];
            return `Downloading ${file}` + (pctMatch ? ` ${pctMatch[1]}%` : '');
        }

        // Fetching
        const fetchMatch = line.match(/Fetching\s+\d+\s+files/i);
        if (fetchMatch) {
            return fetchMatch[0];
        }

        // config.json, tokenizer, etc.
        const configMatch = line.match(/(config\.json|tokenizer|model\.safetensors|pytorch_model|vocab|special_tokens)/i);
        if (configMatch && pctMatch) {
            return `Downloading ${configMatch[1]} ${pctMatch[1]}%`;
        }

        // If we just have a percentage
        if (pctMatch) {
            return `Loading ${pctMatch[1]}%`;
        }

        return null;
    }

    // ── LIVE WORKFLOW EXECUTION TRACKING ──
    private _wfExecState: {
        workflowId: string;
        activeNode: string;
        nodeStates: Record<string, { status: string; tool?: string; startTime?: number }>;
        startTime: number;
    } | null = null;

    private parseStderrForWorkflow(line: string) {
        // Detect workflow_execute start: [HH:MM:SS] 🔧 workflow_execute(workflow_id=foo, ...)
        const wfStartMatch = line.match(/🔧\s*workflow_execute\((?:.*?workflow_id\s*=\s*)?([^,)\s]+)/);
        if (wfStartMatch) {
            this._wfExecState = {
                workflowId: wfStartMatch[1],
                activeNode: '',
                nodeStates: {},
                startTime: Date.now()
            };
            this.emitActivity({
                timestamp: Date.now(),
                tool: 'workflow_execute',
                category: 'Workflow',
                args: { workflow_id: this._wfExecState.workflowId },
                result: JSON.stringify({
                    workflow_id: this._wfExecState.workflowId,
                    status: 'running',
                    node_states: {}
                }),
                source: 'external',
                durationMs: -1
            });
            return;
        }

        if (!this._wfExecState) { return; }

        // Detect node start: [HH:MM:SS]   ▶ node_id (tool_name)  OR  🔧 tool_name(...)
        // The Python workflow engine logs node execution - match common patterns
        const nodeStartMatch = line.match(/(?:▶|►|→|Running node)\s+['"]?(\w+)['"]?/) ||
                               line.match(/Node\s+['"]?(\w+)['"]?\s+(?:starting|running|executing)/i);
        if (nodeStartMatch) {
            const nodeId = nodeStartMatch[1];
            this._wfExecState.activeNode = nodeId;
            this._wfExecState.nodeStates[nodeId] = { status: 'running', startTime: Date.now() };
            // Emit updated state
            const ns: Record<string, any> = {};
            for (const [k, v] of Object.entries(this._wfExecState.nodeStates)) {
                ns[k] = { status: v.status };
            }
            this.emitActivity({
                timestamp: Date.now(),
                tool: 'workflow_execute',
                category: 'Workflow',
                args: { workflow_id: this._wfExecState.workflowId },
                result: JSON.stringify({
                    workflow_id: this._wfExecState.workflowId,
                    status: 'running',
                    node_states: ns
                }),
                source: 'external',
                durationMs: -2
            });
            return;
        }

        // Detect node complete: ✅ tool_name complete  OR  Node 'x' completed
        const nodeCompleteMatch = line.match(/(?:✅|✓|completed)\s+(\w+)\s+complete/i) ||
                                  line.match(/Node\s+['"]?(\w+)['"]?\s+completed/i);
        if (nodeCompleteMatch && this._wfExecState.activeNode) {
            const nodeId = this._wfExecState.activeNode;
            const nodeState = this._wfExecState.nodeStates[nodeId];
            if (nodeState) {
                nodeState.status = 'completed';
            }
            const ns: Record<string, any> = {};
            for (const [k, v] of Object.entries(this._wfExecState.nodeStates)) {
                ns[k] = { status: v.status, elapsed_ms: v.startTime ? Date.now() - v.startTime : 0 };
            }
            this.emitActivity({
                timestamp: Date.now(),
                tool: 'workflow_execute',
                category: 'Workflow',
                args: { workflow_id: this._wfExecState.workflowId },
                result: JSON.stringify({
                    workflow_id: this._wfExecState.workflowId,
                    status: 'running',
                    node_states: ns
                }),
                source: 'external',
                durationMs: -2
            });
            return;
        }

        // Detect node failure
        const nodeFailMatch = line.match(/(?:❌|failed|error).*?Node\s+['"]?(\w+)['"]?/i) ||
                              line.match(/Node\s+['"]?(\w+)['"]?\s+failed/i);
        if (nodeFailMatch) {
            const nodeId = nodeFailMatch[1];
            if (this._wfExecState.nodeStates[nodeId]) {
                this._wfExecState.nodeStates[nodeId].status = 'failed';
            }
        }

        // Detect workflow complete: ✅ workflow_execute complete
        const wfComplete = line.match(/✅\s*workflow_execute\s+complete/);
        if (wfComplete) {
            // Final state — fetch the real result with all node_states
            const wfId = this._wfExecState.workflowId;
            this._wfExecState = null;
            // Async fetch the full result
            this.callToolParsed('workflow_history', { workflow_id: wfId, limit: '1' }, { suppressActivity: true, source: 'internal' })
                .then((history: any) => {
                    const executions = history?.executions || history?.history || (Array.isArray(history) ? history : []);
                    const latest = executions[0];
                    if (latest && typeof latest === 'object') {
                        if (!latest.workflow_id) { latest.workflow_id = wfId; }
                        this.emitActivity({
                            timestamp: Date.now(),
                            tool: 'workflow_execute',
                            category: 'Workflow',
                            args: { workflow_id: wfId },
                            result: JSON.stringify(latest),
                            source: 'external',
                            durationMs: latest.elapsed_ms || 0
                        });
                    }
                })
                .catch(() => {});
            return;
        }
    }

    private parseStderrForProgress(text: string) {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.length < 3) { continue; }

            // Live workflow execution tracking
            this.parseStderrForWorkflow(trimmed);

            const cleaned = this.cleanProgressText(trimmed);
            if (!cleaned) { continue; }

            // Detect model loading start patterns from transformers/HuggingFace
            const isLoadStart = /loading.+model|Loading model|AutoModel|from_pretrained|Loading checkpoint|Fetching.*huggingface/i.test(cleaned);
            const isDownload = /Downloading\s+(model|shards?|weights|config|tokenizer|safetensors)/i.test(cleaned);

            // Extract model ID if present
            const modelMatch = cleaned.match(/(?:Loading|Downloading|Fetching)\s+(?:model\s+)?['"]?([a-zA-Z0-9_\-\/\.]+)/i) ||
                               cleaned.match(/from_pretrained\(['"]([a-zA-Z0-9_\-\/\.]+)['"]/);

            if ((isLoadStart || isDownload) && !this._plugProgressState) {
                const modelId = modelMatch ? modelMatch[1] : 'model';
                this._plugProgressState = { modelId, phase: 'Initializing...', startTime: Date.now() };
                this.emitActivity({
                    timestamp: Date.now(),
                    tool: 'plug_model',
                    category: 'Council\\Slot Management',
                    args: { model_id: modelId, _phase: 'loading' },
                    source: 'external',
                    durationMs: -1  // sentinel: in progress
                });
            }

            // Extract clean progress info and emit updates (throttled to 1/sec)
            if (this._plugProgressState) {
                const progressText = this.extractProgressInfo(cleaned);
                if (progressText) {
                    const now = Date.now();
                    if (now - this._lastProgressEmit > 500) {
                        this._lastProgressEmit = now;
                        this._plugProgressState.phase = progressText;
                        this.emitActivity({
                            timestamp: now,
                            tool: '_plug_progress',
                            category: 'Council\\Slot Management',
                            args: {
                                model_id: this._plugProgressState.modelId,
                                progress: progressText
                            },
                            source: 'external',
                            durationMs: -2  // sentinel: progress update
                        });
                    }
                }

                // Detect loading complete
                if (/(?:Model loaded|Successfully loaded|loaded in \d|plug.*ok|type.*(?:LLM|EMBEDDING|CLASSIFIER))/i.test(cleaned)) {
                    this._plugProgressState = null;
                }
            }
        }
    }

    /**
     * Phase 1: Poll until the HTTP server is reachable.
     * Just checks that a TCP connection to the port succeeds.
     * This handles the DreamerV3 extraction delay without creating SSE sessions.
     */
    private waitForHttpReady(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;

            const poll = () => {
                if (Date.now() > deadline) {
                    reject(new Error('MCP server startup timeout - HTTP not reachable'));
                    return;
                }

                console.log('[MCP] Polling HTTP server...');

                const req = http.get(`http://127.0.0.1:${this._port}/sse`, (res) => {
                    // Server is up! Destroy this probe connection immediately.
                    res.destroy();
                    resolve();
                });

                req.on('error', () => {
                    // Not ready yet, retry
                    setTimeout(poll, 1000);
                });

                // Don't wait forever for this single probe
                req.setTimeout(3000, () => {
                    req.destroy();
                    setTimeout(poll, 1000);
                });
            };

            // Give Python 2 seconds to start before first probe
            setTimeout(poll, 2000);
        });
    }

    /**
     * Phase 2: Open a single persistent SSE connection.
     * The server is already confirmed reachable, so this should connect immediately.
     * Waits for the session endpoint event, then keeps the stream alive for responses.
     */
    private openSseConnection(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('SSE session endpoint timeout - server connected but no endpoint received'));
                }
            }, timeoutMs);

            console.log('[MCP] Opening persistent SSE connection...');

            this._sseRequest = http.get(`http://127.0.0.1:${this._port}/sse`, (res) => {
                this._sseResponse = res;
                this._sseBuf = '';

                console.log('[MCP] SSE connection established, status:', res.statusCode);

                res.on('data', (chunk: Buffer) => {
                    const text = chunk.toString();
                    console.log('[MCP] SSE raw chunk:', JSON.stringify(text.substring(0, 200)));
                    this._sseBuf += text;
                    this._lastSseDataTime = Date.now();

                    // Try to extract complete SSE events from the buffer
                    this.drainSseBuffer();

                    // Check if we got the endpoint
                    if (this._messagesEndpoint && !settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve();
                    }
                });

                res.on('end', () => {
                    console.log('[MCP] SSE stream ended');
                    this._sseResponse = null;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error('SSE stream closed before endpoint received'));
                    } else if (this._status === 'running') {
                        // Unexpected disconnect while running - reconnect
                        console.log('[MCP] SSE unexpectedly closed, reconnecting...');
                        this.reconnectSse();
                    }
                });

                res.on('error', (err) => {
                    console.log('[MCP] SSE stream error:', err.message);
                    this._sseResponse = null;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error(`SSE stream error: ${err.message}`));
                    }
                });
            });

            this._sseRequest.on('error', (err) => {
                console.log('[MCP] SSE request error:', err.message);
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(`SSE connection failed: ${err.message}`));
                }
            });

            // No inactivity timeout on the SSE request - the stream is meant to be long-lived
        });
    }

    /**
     * Phase 3: MCP protocol initialization handshake.
     * Must send initialize request, wait for response, then send initialized notification.
     * No tool calls are allowed until this completes.
     */
    private async initializeMcp(): Promise<void> {
        console.log('[MCP] Sending initialize request...');

        // Step 1: Send initialize request
        const initResult = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'champion-council-vscode',
                version: '0.1.0'
            }
        });

        console.log('[MCP] Initialize response:', JSON.stringify(initResult).substring(0, 200));

        // Step 2: Send initialized notification (no response expected)
        this.sendNotification('notifications/initialized', {});
        console.log('[MCP] Sent initialized notification');

        // Brief pause to let server process the notification
        await new Promise(r => setTimeout(r, 100));
    }

    /**
     * Send a JSON-RPC notification (no id, no response expected).
     */
    private sendNotification(method: string, params: Record<string, any>) {
        if (!this._messagesEndpoint) {
            console.log('[MCP] Cannot send notification - no endpoint');
            return;
        }

        const body = JSON.stringify({
            jsonrpc: '2.0',
            method,
            params
        });

        const options: http.RequestOptions = {
            hostname: '127.0.0.1',
            port: this._port,
            path: this._messagesEndpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`[MCP] Notification ${method} -> HTTP ${res.statusCode}`);
            });
        });

        req.on('error', (err) => {
            console.log(`[MCP] Notification ${method} failed:`, err.message);
        });

        req.write(body);
        req.end();
    }

    /**
     * Parse complete SSE events from the buffer.
     * SSE format: "event: <type>\ndata: <payload>\n\n"
     * Events are separated by double newlines.
     * Handles both \n and \r\n line endings.
     */
    private drainSseBuffer() {
        // Normalize \r\n to \n for consistent parsing
        this._sseBuf = this._sseBuf.replace(/\r\n/g, '\n');

        // Split on double newline (event boundary)
        const parts = this._sseBuf.split('\n\n');

        // Last part may be incomplete - keep it in the buffer
        this._sseBuf = parts.pop() || '';

        for (const part of parts) {
            if (!part.trim()) { continue; }

            let eventType = 'message';
            let eventData = '';

            const lines = part.split('\n');
            for (const line of lines) {
                if (line.startsWith('event:')) {
                    eventType = line.substring(6).trim();
                } else if (line.startsWith('data:')) {
                    // Data can span multiple lines - append
                    if (eventData) {
                        eventData += '\n' + line.substring(5).trim();
                    } else {
                        eventData = line.substring(5).trim();
                    }
                }
            }

            console.log('[MCP] SSE event:', eventType, 'data:', eventData.substring(0, 100));

            if (eventType === 'endpoint' && eventData.includes('session_id')) {
                this._messagesEndpoint = eventData;
                console.log('[MCP] Got session endpoint:', this._messagesEndpoint);
            } else if (eventType === 'message' && eventData) {
                this.handleSseResponse(eventData);
            }
        }
    }

    /** Handle a JSON-RPC response received via SSE */
    private handleSseResponse(data: string) {
        try {
            const parsed = JSON.parse(data);
            console.log('[MCP] SSE response id:', parsed.id);

            const id = parsed.id;
            if (id != null && this._pendingRequests.has(id)) {
                const pending = this._pendingRequests.get(id)!;
                this._pendingRequests.delete(id);
                clearTimeout(pending.timer);

                if (parsed.error) {
                    const msg = parsed.error.message || '';
                    const errData = parsed.error.data;
                    const fullMsg = errData ? msg + '\n' + (typeof errData === 'string' ? errData : JSON.stringify(errData, null, 2)) : msg;
                    pending.reject(new Error(fullMsg || JSON.stringify(parsed.error)));
                } else {
                    pending.resolve(parsed.result ?? parsed);
                }
            } else {
                console.log('[MCP] Unmatched SSE message (no pending request for id):', id);
            }
        } catch (err) {
            console.log('[MCP] Failed to parse SSE response:', data.substring(0, 200));
        }
    }

    /** Reconnect SSE after unexpected disconnect (with backoff + max retries) */
    private _reconnectAttempts = 0;
    private static readonly MAX_RECONNECT_ATTEMPTS = 10;

    private reconnectSse() {
        // Reject all pending
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('SSE disconnected'));
        }
        this._pendingRequests.clear();
        this._messagesEndpoint = '';
        this._sseBuf = '';

        this._reconnectAttempts++;
        if (this._reconnectAttempts > MCPServerManager.MAX_RECONNECT_ATTEMPTS) {
            if (!this._hasAttemptedRestart) {
                this._hasAttemptedRestart = true;
                console.log('[MCP] Max reconnect attempts reached — attempting ONE full process restart...');
                this.restart().then(() => {
                    console.log('[MCP] Full restart succeeded');
                }).catch((err) => {
                    console.error('[MCP] Full restart failed:', err.message);
                    this.setStatus('error');
                });
            } else {
                console.error(`[MCP] Max reconnect attempts reached and restart already tried — giving up`);
                this.setStatus('error');
            }
            return;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000);
        console.log(`[MCP] Reconnecting SSE (attempt ${this._reconnectAttempts}, delay ${delay}ms)...`);

        setTimeout(() => {
            if (this._status !== 'running' && this._status !== 'starting') { return; }

            this._sseRequest = http.get(`http://127.0.0.1:${this._port}/sse`, (res) => {
                this._sseResponse = res;
                this._sseBuf = '';

                console.log('[MCP] SSE reconnected, status:', res.statusCode);

                res.on('data', (chunk: Buffer) => {
                    this._sseBuf += chunk.toString();
                    this._lastSseDataTime = Date.now();
                    this.drainSseBuffer();

                    // Once we get the endpoint, re-initialize MCP and reset backoff
                    if (this._messagesEndpoint && this._reconnectAttempts > 0) {
                        this._reconnectAttempts = 0;
                        this.initializeMcp().catch((err) => {
                            console.error('[MCP] Re-init after reconnect failed:', err.message);
                        });
                    }
                });

                res.on('end', () => {
                    console.log('[MCP] Reconnected SSE stream ended');
                    this._sseResponse = null;
                    if (this._status === 'running') {
                        this.reconnectSse();
                    }
                });

                res.on('error', (err) => {
                    console.log('[MCP] Reconnected SSE error:', err.message);
                    if (this._status === 'running') {
                        this.reconnectSse();
                    }
                });
            });

            this._sseRequest.on('error', (err) => {
                console.log('[MCP] SSE reconnect request error:', err.message);
                if (this._status === 'running') {
                    this.reconnectSse();
                }
            });
        }, delay);
    }

    /**
     * Send a JSON-RPC request via HTTP POST and wait for the response via SSE.
     * POST returns 202 Accepted. Actual result arrives through the SSE stream.
     */
    private sendRequest(method: string, params: Record<string, any>, timeoutMs: number = 120000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this._messagesEndpoint) {
                reject(new Error('No SSE session established'));
                return;
            }

            const id = this._nextId++;

            const timer = setTimeout(() => {
                this._pendingRequests.delete(id);
                reject(new Error(`Request timeout (${method} id=${id})`));
            }, timeoutMs);

            // Register pending request - resolved when SSE delivers the matching response
            this._pendingRequests.set(id, { resolve, reject, timer });

            const body = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params
            });

            const options: http.RequestOptions = {
                hostname: '127.0.0.1',
                port: this._port,
                path: this._messagesEndpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        this._pendingRequests.delete(id);
                        clearTimeout(timer);
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                    console.log(`[MCP] POST ${method} id=${id} -> HTTP ${res.statusCode}`);
                });
            });

            req.on('error', (err) => {
                this._pendingRequests.delete(id);
                clearTimeout(timer);
                reject(new Error(`HTTP POST failed: ${err.message}`));
            });

            req.write(body);
            req.end();
        });
    }

    /** Call an MCP tool */
    async callTool(toolName: string, args: Record<string, any>, options: CallToolOptions = {}): Promise<any> {
        if (this._status !== 'running') {
            throw new Error('MCP server not running');
        }

        const suppressActivity = options.suppressActivity === true;
        const source = options.source || 'extension';
        const startTime = Date.now();
        const category = this.getCategoryForTool(toolName);
        this.rememberLocalToolCall(toolName, options);

        // Emit a "started" event for long-running tools so UI can show progress
        const LONG_RUNNING_TOOLS = ['plug_model', 'hub_plug', 'hub_download'];
        if (!suppressActivity && LONG_RUNNING_TOOLS.includes(toolName)) {
            this.emitActivity({
                timestamp: Date.now(),
                tool: toolName,
                category,
                args,
                source,
                durationMs: -1  // sentinel: -1 means "in progress"
            });
        }

        try {
            const result = await this.sendRequest('tools/call', {
                name: toolName,
                arguments: args
            });
            const durationMs = Date.now() - startTime;

            if (!suppressActivity) {
                this.emitActivity({
                    timestamp: Date.now(),
                    tool: toolName,
                    category,
                    args,
                    result,
                    durationMs,
                    source
                });

                // Bridge MCP tool metrics to Rerun (non-blocking)
                this.logToolToRerun(toolName, durationMs, result).catch(() => {});
            }

            return result;

        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            if (!suppressActivity) {
                this.emitActivity({
                    timestamp: Date.now(),
                    tool: toolName,
                    category,
                    args,
                    error: error.message,
                    durationMs,
                    source
                });
            }
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // RERUN BRIDGE — Extension seeds and feeds Rerun entity paths
    // that the MCP server doesn't populate in --mcp-remote mode
    // ═══════════════════════════════════════════════════════════════

    private _rerunReady = false;
    private _rerunSeeded = false;
    private _rerunToolStep = 0;
    private _rerunCascadeStep = 0;

    private async initRerunBridge(): Promise<void> {
        try {
            // Start the Rerun viewer (applies Glass Box blueprint).
            // If TUI already has Rerun running, this REUSES that recording
            // instead of creating a duplicate — one recording, always.
            const result = await this.callTool('start_rerun_viewer', {}, { suppressActivity: true, source: 'internal' });
            let parsed: any = result;
            try {
                if (typeof result === 'string') {
                    parsed = JSON.parse(result);
                } else if (result?.content?.[0]?.text) {
                    parsed = JSON.parse(result.content[0].text);
                }
            } catch { /* use raw result */ }

            if (parsed?.error) {
                console.log('[Rerun] Not available:', parsed.error);
                return;
            }
            console.log('[Rerun] Viewer initialized:', parsed?.message || 'ok');

            // Seed all blueprint entity paths so tabs connect.
            // Guard: only seed once — restart reuses the same recording.
            if (!this._rerunSeeded) {
                await this.seedRerunEntities();
                this._rerunSeeded = true;
            }
            this._rerunReady = true;
            console.log('[Rerun] All entity paths seeded — single recording active');

            // Populate graphs with real capsule state immediately (non-blocking).
            // rerun_log_inference feeds Tab 1, 2, 3 (inference pipeline + state space).
            // rerun_log_evolution feeds Tab 3 (fitness time-series history).
            this.callTool('rerun_log_inference', {}, { suppressActivity: true, source: 'internal' }).catch(() => {});
            this.callTool('rerun_log_evolution', {}, { suppressActivity: true, source: 'internal' }).catch(() => {});
            // bag_catalog feeds Tab 4 (FelixBag).
            this.callToolParsed('bag_catalog', {}, { suppressActivity: true, source: 'internal' }).catch(() => {});
        } catch (err: any) {
            console.warn('[Rerun] Bridge init failed (rerun-sdk may not be installed):', err.message);
            this._rerunReady = false;
        }
    }

    private async seedRerunEntities(): Promise<void> {
        const log = (path: string, type: string, value: string) =>
            this.callTool(
                'log_to_rerun',
                { entity_path: path, data_type: type, value },
                { suppressActivity: true, source: 'internal' }
            ).catch(() => {});

        // Tab 1: CASCADE Events
        await log('event', 'log', 'Waiting for CASCADE events...');
        await log('provenance', 'log', 'Provenance chain ready');
        await log('computation/path', 'log', 'No computation yet');
        await log('computation/input', 'scalar', '0');
        await log('computation/output', 'scalar', '0');
        await log('computation/hidden/pre_activation', 'scalar', '0');
        await log('computation/hidden/post_activation', 'scalar', '0');
        await log('logs', 'log', 'CASCADE Events tab initialized');

        // Tab 2: MCP Tools
        await log('mcp/duration_ms', 'scalar', '0');
        await log('mcp/result_size', 'scalar', '0');
        await log('mcp/tool', 'log', 'Waiting for tool calls...');
        await log('mcp/args', 'log', '{}');
        await log('mcp/metrics', 'scalar', '0');

        // Tab 3: State Space (was entirely missing — all 5 entities causing "not found")
        await log('state/slots/activity', 'scalar', '0');
        await log('state/slots/count', 'scalar', '0');
        await log('state/embedding', 'scalar', '0');
        await log('state/traits', 'scalar', '0');
        await log('state/fitness', 'scalar', '0');

        // Tab 4: FelixBag
        await log('bag/ops', 'log', 'FelixBag ready');
        await log('bag/type_counts', 'scalar', '0');
        await log('bag/size', 'scalar', '0');
        await log('bag/items', 'log', 'No items yet');
        await log('bag/embeddings', 'scalar', '0');

        // Tab 5: Causation Graph
        await log('cascade/cid', 'log', 'Awaiting CASCADE events...');
        await log('cascade/event_type', 'log', 'none');
        await log('provenance/depth', 'scalar', '0');
        await log('provenance/event_count', 'scalar', '0');
        await log('cascade/merkle_root', 'log', 'pending');
    }

    private async logToolToRerun(toolName: string, durationMs: number, result: any): Promise<void> {
        if (!this._rerunReady) { return; }
        // Skip logging rerun tools to avoid recursion
        if (toolName.startsWith('log_to_rerun') || toolName.startsWith('start_rerun') || toolName.startsWith('rerun_log')) { return; }

        this._rerunToolStep++;
        const resultSize = typeof result === 'string' ? result.length :
            (result?.content?.[0]?.text?.length || 0);

        const log = (path: string, type: string, value: string) =>
            this.sendRequest('tools/call', { name: 'log_to_rerun', arguments: { entity_path: path, data_type: type, value } }).catch(() => {});

        await Promise.all([
            log('mcp/duration_ms', 'scalar', String(durationMs)),
            log('mcp/result_size', 'scalar', String(resultSize)),
            log('mcp/tool', 'log', `${toolName} (${durationMs.toFixed(0)}ms)`),
            log('mcp/args', 'log', toolName),
            log('mcp/metrics', 'scalar', String(this._rerunToolStep)),
        ]);

        // Bridge FelixBag operations
        if (toolName.startsWith('bag_') || toolName === 'pocket' || toolName === 'summon' || toolName === 'materialize') {
            await log('bag/ops', 'log', `${toolName} (${durationMs.toFixed(0)}ms)`);

            // If modification, fetch fresh state (fire and forget)
            if (['bag_put', 'bag_induct', 'bag_forget', 'pocket', 'load_bag'].includes(toolName)) {
                this.callToolParsed('bag_catalog', {}, { suppressActivity: true, source: 'internal' }).catch(() => {});
            }

            // If catalog result, update Rerun
            if (toolName === 'bag_catalog' && result) {
                try {
                    let items = result;
                    if (typeof result === 'string') {
                         try { items = JSON.parse(result); } catch (e) { items = {}; }
                    }
                    // Handle wrapped content
                    if (items.content && Array.isArray(items.content)) {
                        try { items = JSON.parse(items.content[0].text); } catch (e) { }
                    }

                    const count = Array.isArray(items) ? items.length : (typeof items === 'object' ? Object.keys(items).length : 0);
                    const summary = JSON.stringify(items, null, 2).substring(0, 2000); // Truncate for display

                    await Promise.all([
                        log('bag/items', 'text', summary),
                        log('bag/size', 'scalar', String(count)),
                        log('bag/type_counts', 'scalar', String(count))
                    ]);
                } catch (e) { console.warn('Failed to parse bag_catalog for Rerun:', e); }
            }
        }

        // Bridge get_status → State Space tab (Tab 3)
        if (toolName === 'get_status' && result) {
            try {
                let data: any = result;
                if (typeof result === 'string') { try { data = JSON.parse(result); } catch { /* raw */ } }
                if (data?.content?.[0]?.text) { try { data = JSON.parse(data.content[0].text); } catch { /* raw */ } }
                const slotCount = data.num_slots ?? data.slots ?? data.slot_count ?? 0;
                const fitness   = data.fitness   ?? data.evolution_fitness ?? 0;
                await Promise.all([
                    log('state/slots/count', 'scalar', String(slotCount)),
                    log('state/fitness',      'scalar', String(fitness)),
                ]);
            } catch { /* ignore */ }
        }

        // Bridge CASCADE operations
        if (toolName.startsWith('cascade_')) {
            this._rerunCascadeStep++;
            await Promise.all([
                log('cascade/cid', 'log', `${toolName} #${this._rerunCascadeStep}`),
                log('cascade/event_type', 'log', toolName),
                log('provenance/event_count', 'scalar', String(this._rerunCascadeStep)),
            ]);

            // Parse result for more info
            if (result) {
                try {
                    let data = result;
                    if (typeof result === 'string') {
                        try { data = JSON.parse(result); } catch (e) { }
                    }
                    
                    if (data.merkle_root) await log('cascade/merkle_root', 'log', data.merkle_root);
                    if (data.cid) await log('cascade/cid', 'log', data.cid);
                    if (data.event_type) await log('cascade/event_type', 'log', data.event_type);
                    if (data.provenance) await log('provenance', 'text', JSON.stringify(data.provenance, null, 2));
                    
                    // Log graph stats if available
                    if (data.events && data.links) {
                        await log('provenance/depth', 'scalar', String(data.events));
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }

    /** Parse a tool result, unwrapping MCP content format and JSON strings */
    parseToolPayload(result: any): any {
        if (typeof result === 'string') {
            try { return JSON.parse(result); } catch { return result; }
        }
        const textPayload = result?.content?.[0]?.text;
        if (typeof textPayload === 'string') {
            try { return JSON.parse(textPayload); } catch { return textPayload; }
        }
        return result;
    }

    /**
     * Call an MCP tool and auto-resolve cached responses.
     * When the server caches responses >2KB, this fetches the full data via get_cached.
     */
    async callToolParsed(toolName: string, args: Record<string, any>, options: CallToolOptions = {}): Promise<any> {
        const raw = await this.callTool(toolName, args, options);
        let parsed = this.parseToolPayload(raw);

        if (parsed && typeof parsed === 'object' && parsed._cached && toolName !== 'get_cached') {
            const cachedRaw = await this.callTool(
                'get_cached',
                { cache_id: parsed._cached },
                { suppressActivity: true, source: 'internal' }
            );
            parsed = this.parseToolPayload(cachedRaw);
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch { /* keep raw string */ }
            }
        }

        return parsed;
    }

    /** List all tools from the MCP server */
    async listTools(): Promise<any> {
        return this.sendRequest('tools/list', {});
    }

    /** Read an MCP resource */
    async readResource(uri: string): Promise<any> {
        return this.sendRequest('resources/read', { uri });
    }

    /** Generate .vscode/mcp.json for IDE agent discovery (SSE format) */
    async generateMCPConfig(workspaceFolder?: string): Promise<string> {
        const folder = workspaceFolder ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!folder) {
            throw new Error('No workspace folder open');
        }

        const mcpConfig = {
            servers: {
                'champion-ouroboros': {
                    url: `http://127.0.0.1:${this._port}/sse`
                }
            }
        };

        const vscodePath = path.join(folder, '.vscode');
        const configPath = path.join(vscodePath, 'mcp.json');

        const uri = vscode.Uri.file(vscodePath);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            await vscode.workspace.fs.createDirectory(uri);
        }

        const content = Buffer.from(JSON.stringify(mcpConfig, null, 2), 'utf-8');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(configPath), content);

        return configPath;
    }
}
