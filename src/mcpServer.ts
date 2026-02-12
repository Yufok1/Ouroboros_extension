import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as http from 'http';

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
    'Replication & Evolution': {
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
    'Security': {
        setting: 'security',
        tools: ['implode', 'defrost', 'is_frozen']
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
}

type ServerStatus = 'starting' | 'running' | 'stopped' | 'error';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
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

    async start(): Promise<void> {
        if (this.pythonProcess) {
            return;
        }

        this.setStatus('starting');
        this._messagesEndpoint = '';
        this._sseBuf = '';

        const config = vscode.workspace.getConfiguration('champion');
        const pythonPath = config.get('pythonPath', 'python');
        this._port = config.get('mcpPort', 8765);

        // Resolve capsule path
        const customPath = config.get<string>('capsulePath', '');
        const scriptPath = customPath || path.join(this.context.extensionPath, 'champion_gen8.py');

        const args = [scriptPath, '--mcp-remote', `--port=${this._port}`];

        try {
            this.pythonProcess = child_process.spawn(pythonPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: path.dirname(scriptPath),
                env: { ...process.env }
            });

            this.pythonProcess.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log('[MCP]', msg.trim());
            });

            this.pythonProcess.stdout?.on('data', (data: Buffer) => {
                console.log('[MCP stdout]', data.toString().trim());
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

            // Phase 1: Wait for HTTP server to be reachable (polls until connection succeeds)
            await this.waitForHttpReady(60000);
            console.log('[MCP] HTTP server is reachable');

            // Phase 2: Open persistent SSE connection and get session endpoint
            await this.openSseConnection(15000);
            console.log('[MCP] SSE connected, endpoint:', this._messagesEndpoint);

            // Phase 3: MCP protocol initialization handshake
            await this.initializeMcp();
            console.log('[MCP] MCP protocol initialized');

            this._startTime = Date.now();
            this.setStatus('running');

        } catch (error: any) {
            this.setStatus('error');
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.closeSseConnection();
        if (!this.pythonProcess) { return; }
        this.pythonProcess.kill();
        this.pythonProcess = null;
        this._startTime = 0;
        this.setStatus('stopped');
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
                    pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
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

    /** Reconnect SSE after unexpected disconnect */
    private reconnectSse() {
        // Reject all pending
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('SSE disconnected'));
        }
        this._pendingRequests.clear();
        this._messagesEndpoint = '';
        this._sseBuf = '';

        console.log('[MCP] Reconnecting SSE...');

        this._sseRequest = http.get(`http://127.0.0.1:${this._port}/sse`, (res) => {
            this._sseResponse = res;
            this._sseBuf = '';

            console.log('[MCP] SSE reconnected, status:', res.statusCode);

            res.on('data', (chunk: Buffer) => {
                this._sseBuf += chunk.toString();
                this.drainSseBuffer();
            });

            res.on('end', () => {
                console.log('[MCP] Reconnected SSE stream ended');
                this._sseResponse = null;
                if (this._status === 'running') {
                    setTimeout(() => this.reconnectSse(), 1000);
                }
            });

            res.on('error', (err) => {
                console.log('[MCP] Reconnected SSE error:', err.message);
                if (this._status === 'running') {
                    setTimeout(() => this.reconnectSse(), 1000);
                }
            });
        });

        this._sseRequest.on('error', (err) => {
            console.log('[MCP] SSE reconnect request error:', err.message);
            if (this._status === 'running') {
                setTimeout(() => this.reconnectSse(), 2000);
            }
        });
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
    async callTool(toolName: string, args: Record<string, any>): Promise<any> {
        if (this._status !== 'running') {
            throw new Error('MCP server not running');
        }

        const startTime = Date.now();
        const category = this.getCategoryForTool(toolName);

        try {
            const result = await this.sendRequest('tools/call', {
                name: toolName,
                arguments: args
            });
            const durationMs = Date.now() - startTime;

            this.emitActivity({
                timestamp: Date.now(),
                tool: toolName,
                category,
                args,
                result,
                durationMs
            });

            return result;

        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            this.emitActivity({
                timestamp: Date.now(),
                tool: toolName,
                category,
                args,
                error: error.message,
                durationMs
            });
            throw error;
        }
    }

    /** List all tools from the MCP server */
    async listTools(): Promise<any[]> {
        return this.sendRequest('tools/list', {});
    }

    /** Read an MCP resource */
    async readResource(uri: string): Promise<any> {
        return this.sendRequest('resources/read', { uri });
    }

    /** Generate .vscode/mcp.json for IDE agent discovery */
    async generateMCPConfig(workspaceFolder?: string): Promise<string> {
        const folder = workspaceFolder ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!folder) {
            throw new Error('No workspace folder open');
        }

        const config = vscode.workspace.getConfiguration('champion');
        const pythonPath = config.get('pythonPath', 'python');
        const customPath = config.get<string>('capsulePath', '');
        const scriptPath = customPath || path.join(this.context.extensionPath, 'champion_gen8.py');

        const mcpConfig = {
            servers: {
                'champion-council': {
                    command: pythonPath,
                    args: [scriptPath, '--mcp']
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
