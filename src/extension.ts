import * as vscode from 'vscode';
import { MCPServerManager } from './mcpServer';
import { CouncilPanel } from './webview/panel';

let mcpManager: MCPServerManager;
let councilPanel: CouncilPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    mcpManager = new MCPServerManager(context);

    // Auto-start MCP server
    const config = vscode.workspace.getConfiguration('champion');
    if (config.get('autoStartMCP', true)) {
        mcpManager.start().then(() => {
            // Auto-generate mcp.json for IDE agent discovery
            mcpManager.generateMCPConfig().catch(() => {
                // No workspace open, skip
            });
        }).catch((err) => {
            vscode.window.showWarningMessage(`Champion MCP failed to start: ${err.message}`);
        });
    }

    // ── Commands ──────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('champion.showPanel', () => {
            if (!councilPanel) {
                councilPanel = new CouncilPanel(context.extensionUri, mcpManager, context);
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
                const result = await mcpManager.callTool('deliberate', { question });
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
                const result = await mcpManager.callTool('hub_search', { query, limit: 20 });
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
            }
        })
    );

    // ── Webview View Provider (Activity Bar) ─────────────────

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('championPanel', {
            resolveWebviewView(webviewView: vscode.WebviewView) {
                webviewView.webview.options = { enableScripts: true };
                webviewView.webview.html = `<!DOCTYPE html>
                    <html><body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);">
                        <p style="text-transform:uppercase;letter-spacing:2px;font-size:11px;opacity:0.6;">Champion Council</p>
                        <button id="openBtn" style="margin-top:8px;padding:8px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:13px;width:100%;">
                            Open Full Control Panel
                        </button>
                        <script>
                            const vscode = acquireVsCodeApi();
                            document.getElementById('openBtn').addEventListener('click', () => {
                                vscode.postMessage({ command: 'openPanel' });
                            });
                        </script>
                    </body></html>`;
                webviewView.webview.onDidReceiveMessage((msg) => {
                    if (msg.command === 'openPanel') {
                        vscode.commands.executeCommand('champion.showPanel');
                    }
                });
            }
        })
    );
}

export function deactivate() {
    if (mcpManager) {
        mcpManager.stop();
    }
}
