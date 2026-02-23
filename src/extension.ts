import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { MCPServerManager, TOOL_CATEGORIES } from './mcpServer';
import { CouncilPanel } from './webview/panel';
import { GitHubService } from './githubService';
import { ModelEvaluator } from './evaluation';
import { ReputationChain } from './reputationChain';
import { MarketplaceIndex } from './marketplaceSearch';
import { IPFSPinningService } from './ipfsPinning';
// Lazy import — if Nostr deps fail, extension still activates
let NostrServiceClass: any = null;
try {
    NostrServiceClass = require('./nostrService').NostrService;
    console.log('[Nostr] Module loaded successfully');
} catch (e: any) {
    console.warn('[Nostr] Failed to load module:', e.message || e);
}

let mcpManager: MCPServerManager;
let councilPanel: CouncilPanel | undefined;
let nostrService: any;
let githubService: GitHubService;
let modelEvaluator: ModelEvaluator;
let marketplaceIndex: MarketplaceIndex;
let ipfsPinning: IPFSPinningService;
let bagSnapshotPath: string = '';
// ── FFMPEG NATIVE MIC CAPTURE ──
let _ffmpegProc: ChildProcess | null = null;
let _micLevelCallback: ((level: number) => void) | null = null;
let _micSensitivity = 1.0;
let _micNoiseGate = 5;

// ── WEBSOCKET AUDIO BRIDGE ──
// Streams raw PCM from ffmpeg to the webview for WebRTC peer audio
let _audioWss: InstanceType<typeof WebSocketServer> | null = null;
let _audioWsPort: number = 0;
let _audioWsClients: Set<WsWebSocket> = new Set();

/** Start WebSocket server for streaming PCM audio to webview */
export function startAudioWsServer(): Promise<number> {
    if (_audioWss && _audioWsPort > 0) { return Promise.resolve(_audioWsPort); }
    return new Promise((resolve, reject) => {
        _audioWss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        _audioWss.on('listening', () => {
            const addr = _audioWss!.address();
            if (typeof addr === 'object' && addr) {
                _audioWsPort = addr.port;
                console.log(`[AudioWS] Listening on ws://127.0.0.1:${_audioWsPort}`);
                resolve(_audioWsPort);
            } else {
                reject(new Error('Failed to get AudioWS port'));
            }
        });
        _audioWss.on('connection', (ws) => {
            _audioWsClients.add(ws);
            ws.on('close', () => _audioWsClients.delete(ws));
            ws.on('error', () => _audioWsClients.delete(ws));
        });
        _audioWss.on('error', reject);
    });
}

/** Stop WebSocket audio server */
export function stopAudioWsServer(): void {
    _audioWsClients.forEach(c => { try { c.close(); } catch { } });
    _audioWsClients.clear();
    if (_audioWss) { try { _audioWss.close(); } catch { } _audioWss = null; }
    _audioWsPort = 0;
}

/** Broadcast raw PCM binary to all connected webview clients */
function broadcastAudioChunk(chunk: Buffer): void {
    for (const client of _audioWsClients) {
        if (client.readyState === WsWebSocket.OPEN) {
            client.send(chunk);
        }
    }
}

/** Get the WebSocket audio server port (0 if not started) */
export function getAudioWsPort(): number { return _audioWsPort; }

/** List available audio input devices via ffmpeg */
export async function listAudioDevices(): Promise<string[]> {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            const devices: string[] = [];
            const lines = stderr.split('\n');
            let inAudio = false;
            for (const line of lines) {
                if (line.includes('DirectShow audio devices')) { inAudio = true; continue; }
                if (line.includes('DirectShow video devices')) { inAudio = false; continue; }
                if (inAudio) {
                    const match = line.match(/"([^"]+)"/);
                    if (match && !line.includes('Alternative name')) { devices.push(match[1]); }
                }
            }
            resolve(devices);
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { try { proc.kill(); } catch { } }, 5000);
    });
}

/** Start capturing audio from the default mic via ffmpeg. Calls onLevel with 0-100 level values. */
export async function startMicCapture(onLevel: (level: number) => void, deviceName?: string): Promise<{ success: boolean; error?: string; device?: string }> {
    if (_ffmpegProc) { return { success: true, device: deviceName || 'already running' }; }

    // Find a device if none specified
    if (!deviceName) {
        const devices = await listAudioDevices();
        if (devices.length === 0) {
            return { success: false, error: 'No audio input devices found. Is a microphone connected?' };
        }
        deviceName = devices[0];
    }

    _micLevelCallback = onLevel;

    return new Promise((resolve) => {
        try {
            // Capture raw 16-bit PCM at 16kHz mono from the mic
            _ffmpegProc = spawn('ffmpeg', [
                '-f', 'dshow',
                '-i', `audio=${deviceName}`,
                '-f', 's16le',
                '-ar', '16000',
                '-ac', '1',
                '-loglevel', 'error',
                'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] });

            let started = false;

            _ffmpegProc.stdout?.on('data', (chunk: Buffer) => {
                if (!started) {
                    started = true;
                    console.log(`[Mic] ffmpeg capturing from: ${deviceName}`);
                    resolve({ success: true, device: deviceName });
                }

                // Create view on the buffer to access 16-bit samples
                // Note: Modifying 'samples' modifies the underlying 'chunk' Buffer in-place
                const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2));

                // 1. Calculate RMS of the raw signal
                let sumSq = 0;
                for (let i = 0; i < samples.length; i++) {
                    const normalized = samples[i] / 32768;
                    sumSq += normalized * normalized;
                }
                const rms = Math.sqrt(sumSq / samples.length);

                // 2. Calculate display level (0-100) based on sensitivity
                // This simulates "post-gain" level for the gate check
                let level = Math.min(100, rms * 300 * _micSensitivity);

                // 3. Apply Gate & Gain
                if (level < _micNoiseGate) {
                    // Gate closed: Mute everything
                    level = 0;
                    chunk.fill(0);
                } else {
                    // Gate open: Apply gain to the actual samples
                    if (_micSensitivity !== 1.0) {
                        for (let i = 0; i < samples.length; i++) {
                            let val = samples[i] * _micSensitivity;
                            // Hard clip to 16-bit signed range
                            if (val > 32767) val = 32767;
                            else if (val < -32768) val = -32768;
                            samples[i] = val;
                        }
                    }
                }

                if (_micLevelCallback) _micLevelCallback(level);

                // Stream processed PCM (muted or gained) to webview
                broadcastAudioChunk(chunk);
            });

            _ffmpegProc.stderr?.on('data', (d: Buffer) => {
                const msg = d.toString().trim();
                if (msg && !started) {
                    console.error('[Mic] ffmpeg error:', msg);
                }
            });

            _ffmpegProc.on('error', (err) => {
                console.error('[Mic] ffmpeg spawn error:', err.message);
                if (!started) {
                    resolve({ success: false, error: `ffmpeg not found or failed: ${err.message}. Install ffmpeg and ensure it's on PATH.` });
                }
                _ffmpegProc = null;
            });

            _ffmpegProc.on('close', (code) => {
                console.log(`[Mic] ffmpeg exited with code ${code}`);
                if (!started) {
                    resolve({ success: false, error: `ffmpeg exited with code ${code}` });
                }
                _ffmpegProc = null;
                if (_micLevelCallback) _micLevelCallback(0);
            });

            // Timeout if ffmpeg doesn't start producing data
            setTimeout(() => {
                if (!started) {
                    resolve({ success: false, error: 'ffmpeg timed out — no audio data received. Check your microphone.' });
                    stopMicCapture();
                }
            }, 5000);
        } catch (err: any) {
            resolve({ success: false, error: err.message });
        }
    });
}

/** Stop mic capture */
export function stopMicCapture(): void {
    if (_ffmpegProc) {
        try { _ffmpegProc.kill('SIGTERM'); } catch { }
        _ffmpegProc = null;
    }
    _micLevelCallback = null;
}

/** Update mic sensitivity */
export function setMicSensitivity(val: number): void { _micSensitivity = val; }

/** Update mic noise gate */
export function setMicNoiseGate(val: number): void { _micNoiseGate = val; }

/** Check if mic is currently capturing */
export function isMicCapturing(): boolean { return _ffmpegProc !== null; }

export function activate(context: vscode.ExtensionContext) {
    mcpManager = new MCPServerManager(context);
    let sidebarView: vscode.WebviewView | undefined;
    bagSnapshotPath = path.join(context.globalStorageUri.fsPath, 'felixbag_snapshot.json');

    // ── New services (v0.5.0) ─────────────────────────────────
    modelEvaluator = new ModelEvaluator(context);
    ipfsPinning = new IPFSPinningService(context);

    // Audio WebSocket server cleanup on deactivate
    context.subscriptions.push({ dispose: () => stopAudioWsServer() });

    // MarketplaceIndex needs MCP for embeddings — initialized with
    // a reputation lookup that bridges to nostrService when available
    const reputationLookup = (pubkey: string): number => {
        if (nostrService && typeof nostrService.getReputation === 'function') {
            const rep = nostrService.getReputation(pubkey);
            return rep?.points || 0;
        }
        return 0;
    };
    marketplaceIndex = new MarketplaceIndex(mcpManager, context, reputationLookup);

    // Wire evaluation auto-recording into MCP tool calls
    mcpManager.onActivity((event) => {
        if (modelEvaluator.isTrackedTool(event.tool) && event.durationMs !== undefined) {
            const input = JSON.stringify(event.args || {});
            const output = event.error || JSON.stringify(event.result || {});
            const slotId = event.args?.slot ?? 0;
            modelEvaluator.record(
                slotId, event.tool, input, output,
                event.durationMs, !event.error, event.error
            );
        }
    });

    // Nostr — optional, never blocks activation
    if (NostrServiceClass) {
        try {
            nostrService = new NostrServiceClass(context);
            const nostrConfig = vscode.workspace.getConfiguration('champion');
            const defaultRelays = [
                'wss://relay.damus.io',
                'wss://nos.lol',
                'wss://relay.nostr.band'
            ];
            let relayUrls: string[] = nostrConfig.get('nostrRelays', defaultRelays);
            if (relayUrls.length === 0) {
                relayUrls = defaultRelays;
            }
            console.log('[Nostr] Using relays:', relayUrls);
            if (nostrConfig.get('nostrEnabled', true)) {
                nostrService.init().then((pubkey: string) => {
                    console.log('[Nostr] Identity:', pubkey.slice(0, 16) + '...');
                    nostrService.connectToRelays(relayUrls).catch((err: any) => {
                        console.error('[Nostr] Relay connection failed:', err);
                    });
                }).catch((err: any) => {
                    console.warn('[Nostr] Init failed:', err.message);
                });
            }
        } catch (err: any) {
            console.warn('[Nostr] Setup failed:', err.message);
            nostrService = undefined;
        }
    }

    // GitHub — always available, auth is lazy
    githubService = new GitHubService();
    githubService.authenticate(true).catch(() => { });

    // Auto-start MCP server
    const config = vscode.workspace.getConfiguration('champion');
    if (config.get('autoStartMCP', true)) {
        mcpManager.start().then(async () => {
            // Ensure storage dir exists
            try { await vscode.workspace.fs.createDirectory(context.globalStorageUri); } catch { }
            // Auto-restore FelixBag from last saved snapshot
            try {
                await mcpManager.callTool('load_bag', { file_path: bagSnapshotPath }, { suppressActivity: true, source: 'internal' });
                console.log('[FelixBag] Auto-restored from', bagSnapshotPath);
            } catch {
                // No snapshot yet or load failed — that's fine
            }
            // Periodic auto-save every 5 minutes
            const bagAutoSave = setInterval(async () => {
                if (mcpManager.status !== 'running') { return; }
                try {
                    await mcpManager.callTool('save_bag', { file_path: bagSnapshotPath }, { suppressActivity: true, source: 'internal' });
                } catch { }
            }, 5 * 60 * 1000);
            context.subscriptions.push({ dispose: () => clearInterval(bagAutoSave) });

            // Marathon session housekeeping: log stats every 30 min
            const housekeepingInterval = setInterval(() => {
                if (mcpManager.status !== 'running') { return; }
                console.log(`[Housekeeping] Uptime: ${Math.round(mcpManager.uptime / 60000)}min`);
            }, 30 * 60 * 1000);
            context.subscriptions.push({ dispose: () => clearInterval(housekeepingInterval) });
        }).catch((err) => {
            vscode.window.showWarningMessage(`Champion MCP failed to start: ${err.message}`);
        });
    }

    // ── Commands ──────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.showPanel', () => {
            if (!councilPanel) {
                councilPanel = new CouncilPanel(
                    context.extensionUri, mcpManager, context, nostrService, githubService,
                    modelEvaluator, marketplaceIndex, ipfsPinning
                );
            }
            councilPanel.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.startMCP', async () => {
            await mcpManager.start();
            vscode.window.showInformationMessage('Champion MCP Server started');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.stopMCP', async () => {
            await mcpManager.stop();
            vscode.window.showInformationMessage('Champion MCP Server stopped');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.listSlots', async () => {
            try {
                const result = await mcpManager.callTool('list_slots', {});
                const channel = vscode.window.createOutputChannel('Champion Slots');
                channel.appendLine(JSON.stringify(result, null, 2));
                channel.show();
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.plugModel', async () => {
            const modelId = await vscode.window.showInputBox({
                prompt: 'HuggingFace model ID',
                placeHolder: 'BAAI/bge-small-en'
            });
            if (!modelId) { return; }

            const slotName = await vscode.window.showInputBox({
                prompt: 'Slot name (optional)',
                placeHolder: 'my-slot'
            });

            try {
                const result = await mcpManager.callTool('plug_model', {
                    model_id: modelId,
                    slot_name: slotName || undefined
                });
                vscode.window.showInformationMessage(`Plugged: ${modelId}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.getStatus', async () => {
            try {
                const result = await mcpManager.callTool('get_status', {});
                const channel = vscode.window.createOutputChannel('Champion Status');
                channel.appendLine(JSON.stringify(result, null, 2));
                channel.show();
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.generateMCPConfig', async () => {
            try {
                const configPath = await mcpManager.generateMCPConfig();
                vscode.window.showInformationMessage(`MCP config written: ${configPath}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.deliberate', async () => {
            const question = await vscode.window.showInputBox({
                prompt: 'Question for deliberation',
                placeHolder: 'What approach should I take for...'
            });
            if (!question) { return; }

            try {
                const result = await mcpManager.callToolParsed('deliberate', { question });
                const channel = vscode.window.createOutputChannel('Champion Deliberation');
                channel.appendLine(JSON.stringify(result, null, 2));
                channel.show();
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.hubSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search HuggingFace Hub',
                placeHolder: 'embedding model for code'
            });
            if (!query) { return; }

            try {
                const result = await mcpManager.callToolParsed('hub_search', { query, limit: 20 });
                const channel = vscode.window.createOutputChannel('HuggingFace Search');
                channel.appendLine(JSON.stringify(result, null, 2));
                channel.show();
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        })
    );

    // ── Status Bar ───────────────────────────────────────────

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.command = 'champion.showPanel';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    mcpManager.onStatusChange((status) => {
        switch (status) {
            case 'running':
                statusBarItem.text = '$(circle-filled) CHAMPION';
                statusBarItem.tooltip = `Champion Council MCP - Port ${mcpManager.port}`;
                statusBarItem.backgroundColor = undefined;
                break;
            case 'starting':
                statusBarItem.text = '$(loading~spin) CHAMPION';
                statusBarItem.tooltip = 'Champion Council MCP - Starting...';
                statusBarItem.backgroundColor = undefined;
                break;
            case 'error':
                statusBarItem.text = '$(error) CHAMPION';
                statusBarItem.tooltip = 'Champion Council MCP - Error';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            default:
                statusBarItem.text = '$(circle-outline) CHAMPION';
                statusBarItem.tooltip = 'Champion Council MCP - Stopped';
                statusBarItem.backgroundColor = undefined;
        }
        if (sidebarView) {
            renderSidebarView(sidebarView);
        }
    });

    // ── Settings Change Listener ─────────────────────────────

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('champion')) {
                // If tool toggles or port changed, restart server
                if (e.affectsConfiguration('champion.tools') ||
                    e.affectsConfiguration('champion.mcpPort') ||
                    e.affectsConfiguration('champion.pythonPath') ||
                    e.affectsConfiguration('champion.capsulePath')) {
                    if (mcpManager.status === 'running') {
                        mcpManager.restart().catch((err) => {
                            vscode.window.showErrorMessage(`Restart failed: ${err.message}`);
                        });
                    }
                }
                // Reload IPFS pinning config on change
                if (e.affectsConfiguration('champion.ipfs')) {
                    ipfsPinning.reloadConfig();
                }
            }
        })
    );

    // ── Webview View Provider (Activity Bar) ─────────────────

    const renderSidebarView = (view: vscode.WebviewView) => {
        const status = mcpManager.status;
        const toolCounts = mcpManager.getToolCounts();
        const categories = mcpManager.getEnabledCategories();
        const enabledCategoryCount = Object.values(categories).filter(Boolean).length;
        const totalCategoryCount = Object.keys(TOOL_CATEGORIES).length;
        const relayCount = nostrService ? Number(nostrService.relayCount || 0) : 0;

        const statusLabel = status === 'running'
            ? 'RUNNING'
            : status === 'starting'
                ? 'STARTING'
                : status === 'error'
                    ? 'ERROR'
                    : 'STOPPED';

        const statusColor = status === 'running'
            ? '#22c55e'
            : status === 'starting'
                ? '#f59e0b'
                : status === 'error'
                    ? '#ef4444'
                    : '#94a3b8';

        const relayLine = nostrService
            ? (relayCount > 0 ? `${relayCount} connected` : '0 connected')
            : 'Nostr disabled';

        view.webview.html = `<!DOCTYPE html>
<html>
<body style="padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);line-height:1.4;">
  <div style="font-size:10px;letter-spacing:1.2px;opacity:0.7;text-transform:uppercase;">Champion Council</div>
  <div style="margin-top:4px;font-size:12px;opacity:0.9;">Control Snapshot</div>

  <div style="margin-top:10px;border:1px solid var(--vscode-panel-border);padding:10px;">
    <div style="font-size:10px;opacity:0.75;text-transform:uppercase;">MCP Status</div>
    <div style="margin-top:4px;font-weight:700;color:${statusColor};">${statusLabel}</div>
    <div style="margin-top:4px;font-size:11px;opacity:0.85;">Port: ${mcpManager.port}</div>
    <div style="font-size:11px;opacity:0.85;">Tools: ${toolCounts.enabled}/${toolCounts.total}</div>
    <div style="font-size:11px;opacity:0.85;">Categories: ${enabledCategoryCount}/${totalCategoryCount}</div>
    <div style="font-size:11px;opacity:0.85;">Nostr Relays: ${relayLine}</div>
  </div>

  <div style="display:grid;gap:6px;margin-top:10px;">
    <a href="command:champion.showPanel" style="text-decoration:none;padding:8px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:12px;text-align:center;">Open Full Control Panel</a>
    <a href="command:champion.startMCP" style="text-decoration:none;padding:6px 10px;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-size:11px;text-align:center;">Start MCP</a>
    <a href="command:champion.stopMCP" style="text-decoration:none;padding:6px 10px;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-size:11px;text-align:center;">Stop MCP</a>
  </div>

  <div style="margin-top:12px;font-size:11px;opacity:0.8;">
    If this panel looks stale, close and reopen the Champion sidebar view.
  </div>

  <div id="dreamer-section" style="border-top: 1px solid var(--vscode-panel-border); margin-top: 12px; padding-top: 8px;">
    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
      <span style="font-weight: bold; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Dreamer</span>
      <span id="dreamer-dot" style="width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); display: inline-block;"></span>
    </div>
    <div style="font-size: 11px; line-height: 1.6; font-family: var(--vscode-editor-font-family);">
      <div style="display: flex; justify-content: space-between;"><span style="opacity: 0.7;">Value</span><span id="dreamer-value" style="font-variant-numeric: tabular-nums;">\u2014</span></div>
      <div id="dreamer-value-bar" style="height: 3px; background: var(--vscode-progressBar-background); border-radius: 2px; margin: 2px 0 4px;">
        <div id="dreamer-value-fill" style="height: 100%; width: 0%; background: var(--vscode-charts-blue); border-radius: 2px; transition: width 0.3s;"></div>
      </div>
      <div style="display: flex; justify-content: space-between;"><span style="opacity: 0.7;">Fitness</span><span id="dreamer-fitness">\u2014</span></div>
      <div style="display: flex; justify-content: space-between;"><span style="opacity: 0.7;">Buffer</span><span id="dreamer-buffer">\u2014</span></div>
      <div style="display: flex; justify-content: space-between;"><span style="opacity: 0.7;">Rewards</span><span id="dreamer-rewards">\u2014</span></div>
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

  <script>
    const vscode = acquireVsCodeApi();

    function updateDreamerDisplay(data) {
      if (!data || data.error) {
        document.getElementById('dreamer-dot').style.background = 'var(--vscode-charts-red)';
        return;
      }
      document.getElementById('dreamer-dot').style.background = data.active ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-yellow)';
      const value = data.critic_value ?? 0;
      document.getElementById('dreamer-value').textContent = value.toFixed(3) + (value > 0 ? ' \\u25B2' : value < 0 ? ' \\u25BC' : '');
      const valuePct = Math.max(0, Math.min(100, (value + 1) * 50));
      document.getElementById('dreamer-value-fill').style.width = valuePct + '%';
      document.getElementById('dreamer-fitness').textContent = (data.fitness ?? 0).toFixed(3);
      document.getElementById('dreamer-buffer').textContent = (data.obs_buffer_size ?? 0) + ' / ' + (data.reward_buffer_size ?? 0);
      const rr = data.reward_rate ?? 0;
      document.getElementById('dreamer-rewards').textContent = '+' + (data.reward_count ?? 0) + ' (' + rr + '/min)';

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
          html += '<div style="display:flex;align-items:center;gap:4px;">';
          html += '<span style="width:12px;' + (isBest ? 'color:var(--vscode-charts-green);' : 'opacity:0.5;') + '">' + (isBest ? '\\u25BA' : ' ') + i + '</span>';
          html += '<div style="flex:1;height:6px;background:var(--vscode-progressBar-background);border-radius:2px;">';
          html += '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px;transition:width 0.3s;"></div>';
          html += '</div>';
          html += '<span style="width:36px;text-align:right;">' + v.toFixed(2) + '</span>';
          html += '</div>';
        });
        barsEl.innerHTML = html;
      } else {
        document.getElementById('dreamer-imagination').style.display = 'none';
      }

      document.getElementById('dreamer-train-count').textContent = data.training_cycles ?? 0;
      const lastTrain = data.last_train;
      if (lastTrain && lastTrain.accepted !== undefined) {
        const el = document.getElementById('dreamer-train-status');
        el.textContent = lastTrain.accepted ? '\\u2713' : '\\u2717';
        el.style.color = lastTrain.accepted ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)';
      }
    }

    document.getElementById('btn-imagine').addEventListener('click', () => {
      vscode.postMessage({ command: 'callTool', tool: 'imagine', args: { scenario: 'current state projection', steps: 15 } });
    });
    document.getElementById('btn-train').addEventListener('click', () => {
      vscode.postMessage({ command: 'callTool', tool: 'show_rssm', args: {} });
    });

    window.addEventListener('message', event => {
      if (event.data.type === 'dreamerStatus') { updateDreamerDisplay(event.data.data); }
    });

    setInterval(() => { vscode.postMessage({ command: 'dreamerStatus' }); }, 5000);
  </script>
</body>
</html>`;
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('championPanel', {
            resolveWebviewView(webviewView: vscode.WebviewView) {
                sidebarView = webviewView;
                webviewView.webview.options = {
                    enableScripts: true,
                    enableCommandUris: true
                };
                renderSidebarView(webviewView);

                // Dreamer sidebar message handler
                webviewView.webview.onDidReceiveMessage(async (message: any) => {
                    switch (message.command) {
                        case 'dreamerStatus':
                            if (mcpManager && mcpManager.status === 'running') {
                                try {
                                    const raw = await mcpManager.callTool('get_status', {}, { suppressActivity: true, source: 'internal' });
                                    const text = raw?.content?.[0]?.text || (typeof raw === 'string' ? raw : '{}');
                                    const parsed = JSON.parse(text);
                                    webviewView.webview.postMessage({ type: 'dreamerStatus', data: parsed.dreamer || { active: false } });
                                } catch {
                                    webviewView.webview.postMessage({ type: 'dreamerStatus', data: { error: 'not available' } });
                                }
                            }
                            break;
                        case 'callTool':
                            if (mcpManager && mcpManager.status === 'running') {
                                try {
                                    await mcpManager.callTool(message.tool, message.args || {}, { source: 'extension' });
                                } catch { /* best effort */ }
                            }
                            break;
                        case 'saveDreamerConfig': {
                            const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            const configPath = path.join(wsFolder, 'dreamer_config.json');
                            try {
                                fs.writeFileSync(configPath, JSON.stringify(message.config, null, 2));
                            } catch { /* best effort */ }
                            break;
                        }
                        case 'resetDreamerConfig': {
                            const wsFolder2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            const resetPath = path.join(wsFolder2, 'dreamer_config.json');
                            try {
                                if (fs.existsSync(resetPath)) { fs.unlinkSync(resetPath); }
                            } catch { /* best effort */ }
                            break;
                        }
                    }
                });

                webviewView.onDidDispose(() => {
                    if (sidebarView === webviewView) {
                        sidebarView = undefined;
                    }
                });
            }
        })
    );

    if (nostrService && typeof nostrService.onRelayChange === 'function') {
        context.subscriptions.push(
            nostrService.onRelayChange(() => {
                if (sidebarView) {
                    renderSidebarView(sidebarView);
                }
            })
        );
    }
}

export async function deactivate() {
    // Stop audio bridge
    stopMicCapture();
    stopAudioWsServer();
    // Auto-save FelixBag before shutdown
    if (mcpManager && mcpManager.status === 'running' && bagSnapshotPath) {
        try {
            await mcpManager.callTool('save_bag', { file_path: bagSnapshotPath }, { suppressActivity: true, source: 'internal' });
            console.log('[FelixBag] Auto-saved to', bagSnapshotPath);
        } catch (err: any) {
            console.warn('[FelixBag] Auto-save failed:', err.message);
        }
    }
    if (mcpManager) {
        await mcpManager.stop();
    }
    if (nostrService) {
        nostrService.dispose();
    }
    if (githubService) {
        githubService.dispose();
    }
}
