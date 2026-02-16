import * as vscode from 'vscode';
import * as path from 'path';
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

export function activate(context: vscode.ExtensionContext) {
    mcpManager = new MCPServerManager(context);
    let sidebarView: vscode.WebviewView | undefined;
    bagSnapshotPath = path.join(context.globalStorageUri.fsPath, 'felixbag_snapshot.json');

    // ── New services (v0.5.0) ─────────────────────────────────
    modelEvaluator = new ModelEvaluator(context);
    ipfsPinning = new IPFSPinningService(context);

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
    // Try silent auth (picks up existing session without prompting)
    githubService.authenticate(true).catch(() => {});

    // Auto-start MCP server
    const config = vscode.workspace.getConfiguration('champion');
    if (config.get('autoStartMCP', true)) {
        mcpManager.start().then(async () => {
            // Ensure storage dir exists
            try { await vscode.workspace.fs.createDirectory(context.globalStorageUri); } catch {}
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
                } catch {}
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
</body>
</html>`;
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('championPanel', {
            resolveWebviewView(webviewView: vscode.WebviewView) {
                sidebarView = webviewView;
                webviewView.webview.options = {
                    enableScripts: false,
                    enableCommandUris: true
                };
                renderSidebarView(webviewView);
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
