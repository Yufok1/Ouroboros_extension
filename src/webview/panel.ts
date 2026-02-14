import * as vscode from 'vscode';
import { MCPServerManager, TOOL_CATEGORIES, ToolCallEvent } from '../mcpServer';
import { NostrService, NostrEvent, PrivacySettings } from '../nostrService';
import { GitHubService } from '../githubService';

type DiagnosticSource =
    | { kind: 'tool'; tool: string; args?: Record<string, any>; label?: string }
    | { kind: 'resource'; uri: string; label?: string };

interface DiagnosticSpec {
    label: string;
    primary: DiagnosticSource;
    fallbacks?: DiagnosticSource[];
    alwaysEnrich?: boolean;
}

interface DiagnosticProbe {
    id: string;
    kind: 'tool' | 'resource';
    label: string;
    data?: any;
    error?: string;
}

export class CouncilPanel {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private activityLog: ToolCallEvent[] = [];
    private _fetchingLiveData = false;

    private nostrDisposable: vscode.Disposable | undefined;

    constructor(
        private extensionUri: vscode.Uri,
        private mcp: MCPServerManager,
        private context: vscode.ExtensionContext,
        private nostr?: NostrService,
        private github?: GitHubService
    ) {
        // Capture activity events
        this.mcp.onActivity((event) => {
            if (event.source === 'internal') { return; }
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

        // Forward Nostr events to webview
        if (this.nostr) {
            this.nostrDisposable = this.nostr.onEvent((event: NostrEvent) => {
                this.send({ type: 'nostrEvent', event });
            });

            // Forward DMs to webview
            this.nostr.onDM(({ event, decrypted }) => {
                this.send({ type: 'nostrDM', event, decrypted });
            });

            // Forward presence updates
            this.nostr.onPresence(({ pubkey, online, ts }) => {
                this.send({ type: 'nostrPresence', pubkey, online, ts });
            });

            // Forward zap receipts to webview
            this.nostr.onZapReceipt(({ eventId, senderPubkey, amountMsats, receipt }) => {
                this.send({ type: 'nostrZapReceipt', eventId, senderPubkey, amountSats: Math.floor(amountMsats / 1000), receipt });
            });

            // Push identity update instantly whenever a relay connects or disconnects.
            this.nostr.onRelayChange(() => {
                this.send({
                    type: 'nostrIdentity',
                    pubkey: this.nostr!.getPublicKey(),
                    npub:   this.nostr!.getNpub(),
                    connected:  this.nostr!.connected,
                    relayCount: this.nostr!.relayCount,
                    relays:     this.nostr!.getConnectedRelays()
                });
            });

            // Start presence heartbeat and DM/presence subscriptions
            this.nostr.startPresenceHeartbeat();
            this.nostr.fetchDMs();
            this.nostr.fetchPresence();
        }

        // Forward GitHub auth changes
        if (this.github) {
            this.github.onAuthChange(({ authenticated, username }) => {
                this.send({ type: 'githubAuth', authenticated, username });
            });
        }
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

        // Fast sync-only refresh (cached state, no MCP tool calls)
        const syncInterval = setInterval(() => {
            if (!this.panel) { clearInterval(syncInterval); return; }
            this.pushSyncState();
        }, 5000);
        this.disposables.push({ dispose: () => clearInterval(syncInterval) });
    }

    private async fetchLiveToolData() {
        if (this._fetchingLiveData) { return; }
        this._fetchingLiveData = true;
        try {
            const status = await this.mcp.callTool('get_status', {}, { suppressActivity: true, source: 'internal' });
            this.send({ type: 'capsuleStatus', data: status });
        } catch { /* server may be busy */ }
        try {
            const slots = await this.mcp.callTool('list_slots', {}, { suppressActivity: true, source: 'internal' });
            this.send({ type: 'slots', data: slots });
        } catch { /* ignore */ }
        this._fetchingLiveData = false;
    }

    private send(msg: any) {
        console.log('[Panel] Sending message:', msg.type);
        if (this.panel && this.panel.webview) {
            this.panel.webview.postMessage(msg);
        }
    }

    private pushSyncState() {
        // Synchronous-only state push — never blocked, never awaited.
        // Safe to call from anywhere including before the panel is open
        // (send() is a no-op when panel is null).
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

        // Nostr identity — always push, even when nostr is unavailable.
        // If we skip this when this.nostr is undefined, the webview stays
        // stuck on "Initializing..." forever because handleNostrIdentity
        // never fires.
        if (this.nostr) {
            this.send({
                type: 'nostrIdentity',
                pubkey: this.nostr.getPublicKey(),
                npub:   this.nostr.getNpub(),
                connected:  this.nostr.connected,
                relayCount: this.nostr.relayCount,
                relays:     this.nostr.getConnectedRelays()
            });
        } else {
            this.send({
                type: 'nostrIdentity',
                pubkey: '',
                npub:   '',
                connected: false,
                relayCount: 0,
                relays: [],
                disabled: true
            });
        }
    }

    private pushFullState() {
        this.pushSyncState();
        // Trigger one immediate live fetch (no background polling loop).
        this.fetchLiveToolData().catch(() => {});
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
            case 'runDiagnostic': {
                try {
                    const data = await this.runDiagnostic(String(msg.diagKey || ''));
                    this.send({ type: 'diagResult', id: msg.id, diagKey: msg.diagKey, data });
                } catch (err: any) {
                    this.send({
                        type: 'diagResult',
                        id: msg.id,
                        diagKey: msg.diagKey,
                        error: err?.message || 'Diagnostic failed'
                    });
                }
                break;
            }
            case 'refresh':
                await this.pushFullState();
                break;
            case 'refreshMemoryCatalog': {
                try {
                    const result = await this.mcp.callTool('bag_catalog', {}, { suppressActivity: true, source: 'internal' });
                    this.send({ type: 'memoryCatalog', data: result });
                } catch (err: any) {
                    this.send({ type: 'memoryCatalog', error: err.message });
                }
                break;
            }
            case 'exportMemory': {
                try {
                    await this.exportMemoryToWorkspace();
                } catch (err: any) {
                    const message = err?.message || 'Unknown export error';
                    vscode.window.showErrorMessage(`FelixBag export failed: ${message}`);
                    this.send({ type: 'memoryExportError', error: message });
                }
                break;
            }
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'champion');
                break;
            // ── NOSTR COMMANDS ──
            case 'nostrGetIdentity': {
                if (this.nostr) {
                    this.send({
                        type: 'nostrIdentity',
                        pubkey: this.nostr.getPublicKey(),
                        npub: this.nostr.getNpub(),
                        connected: this.nostr.connected,
                        relayCount: this.nostr.relayCount,
                        relays: this.nostr.getConnectedRelays()
                    });
                } else {
                    // Always respond — otherwise webview stays stuck on "Initializing..."
                    this.send({
                        type: 'nostrIdentity',
                        pubkey: '',
                        npub: '',
                        connected: false,
                        relayCount: 0,
                        relays: [],
                        disabled: true
                    });
                }
                break;
            }
            case 'nostrPublishChat': {
                if (this.nostr && msg.message) {
                    try {
                        await this.nostr.publishChat(msg.message);
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            case 'nostrPublishWorkflow': {
                if (this.nostr && msg.name && msg.workflow) {
                    try {
                        const event = await this.nostr.publishWorkflow(
                            msg.name,
                            msg.description || '',
                            msg.workflow,
                            msg.tags || [],
                            {
                                category: msg.category,
                                version: msg.version,
                                complexity: msg.complexity,
                                estTime: msg.estTime,
                                gistUrl: msg.gistUrl,
                                gistId: msg.gistId
                            }
                        );
                        this.send({ type: 'nostrWorkflowPublished', event });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            case 'nostrPublishDocument': {
                if (this.nostr && msg.name && msg.body) {
                    try {
                        const event = await this.nostr.publishDocument(
                            msg.docType || 'workflow',
                            msg.name,
                            msg.description || '',
                            msg.body,
                            msg.tags || [],
                            {
                                category: msg.category,
                                version: msg.version,
                                complexity: msg.complexity,
                                estTime: msg.estTime,
                                bodyFormat: msg.bodyFormat,
                                gistUrl: msg.gistUrl,
                                gistId: msg.gistId
                            }
                        );
                        this.send({ type: 'nostrDocumentPublished', event, docType: msg.docType || 'workflow' });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            case 'nostrFetchWorkflows': {
                if (this.nostr) { this.nostr.fetchWorkflows(msg.until); }
                break;
            }
            case 'nostrFetchChat': {
                if (this.nostr) { this.nostr.fetchChat(msg.since); }
                break;
            }
            case 'nostrReact': {
                if (this.nostr && msg.eventId && msg.eventPubkey) {
                    try {
                        await this.nostr.reactToEvent(msg.eventId, msg.eventPubkey, msg.reaction || '+');
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            // ── ZAP COMMANDS (NIP-57) ──
            case 'nostrZap': {
                if (this.nostr && msg.recipientPubkey && msg.eventId && msg.amountSats) {
                    try {
                        const amountMsats = msg.amountSats * 1000;
                        // Step 1: Get recipient profile to find their lud16
                        const profile = await this.nostr.getProfile(msg.recipientPubkey);
                        const lud16 = profile?.lud16;
                        if (!lud16) {
                            this.send({ type: 'nostrZapResult', success: false, error: 'Recipient has no Lightning address (lud16) in their profile.' });
                            break;
                        }
                        // Step 2: Resolve lud16 to LNURL callback
                        const lnurl = await this.nostr.resolveLud16(lud16);
                        if (!lnurl || !lnurl.callback) {
                            this.send({ type: 'nostrZapResult', success: false, error: `Could not resolve Lightning address: ${lud16}` });
                            break;
                        }
                        if (amountMsats < lnurl.minSendable || amountMsats > lnurl.maxSendable) {
                            this.send({ type: 'nostrZapResult', success: false, error: `Amount out of range (${lnurl.minSendable/1000}-${lnurl.maxSendable/1000} sats)` });
                            break;
                        }
                        // Step 3: Create zap request event
                        const zapRequest = await this.nostr.createZapRequest(msg.recipientPubkey, msg.eventId, amountMsats, msg.comment || '');
                        // Step 4: Request invoice
                        let invoice: string | null = null;
                        if (lnurl.allowsNostr) {
                            invoice = await this.nostr.requestZapInvoice(lnurl.callback, zapRequest, amountMsats);
                        }
                        this.send({
                            type: 'nostrZapResult', success: true,
                            invoice: invoice, lud16: lud16,
                            amountSats: msg.amountSats,
                            zapRequestId: zapRequest.id
                        });
                    } catch (err: any) {
                        this.send({ type: 'nostrZapResult', success: false, error: err.message });
                    }
                }
                break;
            }
            case 'nostrResolveLud16': {
                if (this.nostr && msg.lud16) {
                    const result = await this.nostr.resolveLud16(msg.lud16);
                    this.send({ type: 'nostrLud16Result', lud16: msg.lud16, result });
                }
                break;
            }
            case 'nostrGetZapTotal': {
                if (this.nostr && msg.eventId) {
                    this.send({ type: 'nostrZapTotal', eventId: msg.eventId, total: this.nostr.getZapTotal(msg.eventId) });
                }
                break;
            }
            case 'nostrFetchZapReceipts': {
                if (this.nostr) { this.nostr.fetchZapReceipts(); }
                break;
            }
            // ── NIP-15 COMMERCE COMMANDS ──
            case 'nostrCreateStall': {
                if (this.nostr && msg.name) {
                    try {
                        const event = await this.nostr.createStall({
                            name: msg.name, description: msg.description || '',
                            currency: msg.currency || 'sat', shipping: msg.shipping
                        });
                        this.send({ type: 'nostrStallCreated', event });
                    } catch (err: any) { this.send({ type: 'nostrError', error: err.message }); }
                }
                break;
            }
            case 'nostrCreateProduct': {
                if (this.nostr && msg.stallId && msg.name && msg.price !== undefined) {
                    try {
                        const event = await this.nostr.createProduct({
                            stallId: msg.stallId, name: msg.name, description: msg.description || '',
                            price: msg.price, currency: msg.currency, quantity: msg.quantity,
                            images: msg.images, categories: msg.categories,
                            docType: msg.docType, docEventId: msg.docEventId
                        });
                        this.send({ type: 'nostrProductCreated', event });
                    } catch (err: any) { this.send({ type: 'nostrError', error: err.message }); }
                }
                break;
            }
            case 'nostrFetchStallsAndProducts': {
                if (this.nostr) { this.nostr.fetchStallsAndProducts(); }
                break;
            }
            case 'nostrCheckout': {
                if (this.nostr && msg.merchantPubkey && msg.productId) {
                    try {
                        const event = await this.nostr.initiateCheckout(msg.merchantPubkey, {
                            productId: msg.productId, productName: msg.productName || '',
                            quantity: msg.quantity || 1, shippingId: msg.shippingId || 'digital',
                            totalSats: msg.totalSats || 0, message: msg.message
                        });
                        this.send({ type: 'nostrCheckoutSent', event, merchantPubkey: msg.merchantPubkey });
                    } catch (err: any) { this.send({ type: 'nostrError', error: err.message }); }
                }
                break;
            }
            // ── REPUTATION COMMANDS ──
            case 'nostrGetReputation': {
                if (this.nostr && msg.pubkey) {
                    const rep = this.nostr.getReputation(msg.pubkey);
                    this.send({ type: 'nostrReputation', pubkey: msg.pubkey, reputation: rep, level: this.nostr.getRepLevel(msg.pubkey) });
                }
                break;
            }
            case 'nostrGetAllReputation': {
                if (this.nostr) {
                    this.send({ type: 'nostrAllReputation', entries: this.nostr.getAllReputation() });
                }
                break;
            }
            case 'nostrAddReputation': {
                if (this.nostr && msg.pubkey && msg.action) {
                    const rep = this.nostr.addReputation(msg.pubkey, msg.action, msg.multiplier || 1);
                    this.send({ type: 'nostrReputation', pubkey: msg.pubkey, reputation: rep, level: this.nostr.getRepLevel(msg.pubkey) });
                }
                break;
            }
            // ── DM COMMANDS ──
            case 'nostrSendDM': {
                if (this.nostr && msg.recipientPubkey && msg.message) {
                    try {
                        await this.nostr.sendDM(msg.recipientPubkey, msg.message);
                        this.send({ type: 'nostrDMSent', recipientPubkey: msg.recipientPubkey });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            case 'nostrFetchDMs': {
                if (this.nostr) { this.nostr.fetchDMs(); }
                break;
            }
            // ── BLOCKING ──
            case 'nostrBlockUser': {
                if (this.nostr && msg.pubkey) {
                    this.nostr.blockUser(msg.pubkey);
                    this.send({ type: 'nostrBlockList', blocked: this.nostr.getBlockedUsers() });
                }
                break;
            }
            case 'nostrUnblockUser': {
                if (this.nostr && msg.pubkey) {
                    this.nostr.unblockUser(msg.pubkey);
                    this.send({ type: 'nostrBlockList', blocked: this.nostr.getBlockedUsers() });
                }
                break;
            }
            case 'nostrGetBlockList': {
                if (this.nostr) {
                    this.send({ type: 'nostrBlockList', blocked: this.nostr.getBlockedUsers() });
                }
                break;
            }
            // ── DELETE ──
            case 'nostrDeleteEvent': {
                if (this.nostr && msg.eventId) {
                    try {
                        await this.nostr.deleteEvent(msg.eventId, msg.reason);
                        this.send({ type: 'nostrEventDeleted', eventId: msg.eventId });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            // ── PROFILE ──
            case 'nostrSetProfile': {
                if (this.nostr && msg.profile) {
                    try {
                        await this.nostr.setProfile(msg.profile);
                        this.send({ type: 'nostrProfileUpdated', profile: msg.profile });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: err.message });
                    }
                }
                break;
            }
            case 'nostrGetProfile': {
                if (this.nostr) {
                    const profile = msg.pubkey
                        ? this.nostr.getProfile(msg.pubkey)
                        : this.nostr.getOwnProfile();
                    this.send({ type: 'nostrProfile', pubkey: msg.pubkey || this.nostr.getPublicKey(), profile: profile || null });
                }
                break;
            }
            // ── PRIVACY SETTINGS ──
            case 'nostrGetPrivacy': {
                if (this.nostr) {
                    this.send({ type: 'nostrPrivacy', settings: this.nostr.getPrivacy() });
                }
                break;
            }
            case 'nostrSetPrivacy': {
                if (this.nostr && msg.settings) {
                    this.nostr.setPrivacy(msg.settings);
                    this.send({ type: 'nostrPrivacy', settings: this.nostr.getPrivacy() });
                }
                break;
            }
            // ── REDACTION PREVIEW ──
            case 'nostrRedactPreview': {
                if (this.nostr && msg.text) {
                    const result = this.nostr.redact(msg.text);
                    this.send({ type: 'nostrRedactResult', ...result });
                }
                break;
            }
            // ── ONLINE USERS ──
            case 'nostrGetOnlineUsers': {
                if (this.nostr) {
                    this.send({ type: 'nostrOnlineUsers', users: this.nostr.getOnlineUsers() });
                }
                break;
            }
            // ── WEB3: DID, CID, VCs, CATEGORIES ──
            case 'web3GetDID': {
                if (this.nostr) {
                    this.send({ type: 'web3DID', did: this.nostr.getDID(), didDocument: this.nostr.getDIDDocument() });
                }
                break;
            }
            case 'web3ComputeCID': {
                if (msg.content) {
                    const { computeCID } = require('../web3');
                    this.send({ type: 'web3CID', cid: computeCID(msg.content), contentLength: msg.content.length });
                }
                break;
            }
            case 'web3IssueReputationVC': {
                if (this.nostr && msg.pubkey) {
                    const vc = this.nostr.issueReputationCredential(msg.pubkey);
                    this.send({ type: 'web3ReputationVC', pubkey: msg.pubkey, vc });
                }
                break;
            }
            case 'web3GetDocTypes': {
                if (this.nostr) {
                    this.send({ type: 'web3DocTypes', all: [...this.nostr.getAllDocTypes()], web3: [...this.nostr.getWeb3DocTypes()] });
                }
                break;
            }
            case 'web3GetCategories': {
                if (this.nostr) {
                    this.send({ type: 'web3Categories', categories: [...this.nostr.getWeb3Categories()] });
                }
                break;
            }
            case 'weblnPaymentResult': {
                // WebLN payment result from webview — log and fire zap receipt tracking
                if (msg.success && msg.eventId) {
                    console.log(`[WebLN] Payment successful for event ${msg.eventId}, preimage: ${msg.preimage}`);
                }
                break;
            }
            // ── GITHUB AUTH ──
            case 'githubAuth': {
                if (this.github) {
                    try {
                        const ok = await this.github.authenticate(false);
                        this.send({ type: 'githubAuth', authenticated: ok, username: this.github.githubUsername });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'GitHub auth failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubSignOut': {
                if (this.github) {
                    await this.github.signOut();
                    this.send({ type: 'githubAuth', authenticated: false, username: null });
                }
                break;
            }
            case 'githubGetAuth': {
                if (this.github) {
                    this.send({ type: 'githubAuth', authenticated: this.github.isAuthenticated, username: this.github.githubUsername });
                } else {
                    this.send({ type: 'githubAuth', authenticated: false, username: null });
                }
                break;
            }
            // ── GIST OPERATIONS ──
            case 'githubCreateGist': {
                if (this.github && msg.name && msg.workflow) {
                    try {
                        const gist = await this.github.createGist(
                            msg.name, msg.workflow, msg.description || '',
                            msg.isPublic !== false, msg.meta
                        );
                        this.send({ type: 'githubGistCreated', gist });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'Gist create failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubUpdateGist': {
                if (this.github && msg.gistId && msg.name && msg.workflow) {
                    try {
                        const gist = await this.github.updateGist(
                            msg.gistId, msg.name, msg.workflow, msg.description || '', msg.meta
                        );
                        this.send({ type: 'githubGistUpdated', gist });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'Gist update failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubForkGist': {
                if (this.github && msg.gistId) {
                    try {
                        const gist = await this.github.forkGist(msg.gistId);
                        this.send({ type: 'githubGistForked', gist });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'Fork failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubGetHistory': {
                if (this.github && msg.gistId) {
                    try {
                        const history = await this.github.getGistHistory(msg.gistId);
                        this.send({ type: 'githubGistHistory', gistId: msg.gistId, history });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'History fetch failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubGetRevision': {
                if (this.github && msg.gistId && msg.revisionSha) {
                    try {
                        const gist = await this.github.getGistAtRevision(msg.gistId, msg.revisionSha);
                        this.send({ type: 'githubGistRevision', gist });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'Revision fetch failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubImportFromUrl': {
                if (this.github && msg.url) {
                    try {
                        const result = await this.github.importFromGistUrl(msg.url);
                        this.send({ type: 'githubGistImported', result });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'Import failed: ' + err.message });
                    }
                }
                break;
            }
            case 'githubListMyGists': {
                if (this.github) {
                    try {
                        const gists = await this.github.listMyWorkflowGists();
                        this.send({ type: 'githubMyGists', gists });
                    } catch (err: any) {
                        this.send({ type: 'nostrError', error: 'List gists failed: ' + err.message });
                    }
                }
                break;
            }
            // ── UX SETTINGS ──
            case 'uxGetSettings': {
                const settings = this.context.globalState.get('champion.uxSettings', {});
                this.send({ type: 'uxSettings', settings });
                break;
            }
            case 'uxSetSettings': {
                if (msg.settings) {
                    const current = this.context.globalState.get('champion.uxSettings', {}) as Record<string, any>;
                    const merged = { ...current, ...msg.settings };
                    await this.context.globalState.update('champion.uxSettings', merged);
                    this.send({ type: 'uxSettings', settings: merged });
                }
                break;
            }
            case 'uxResetSettings': {
                await this.context.globalState.update('champion.uxSettings', {});
                this.send({ type: 'uxSettings', settings: {} });
                break;
            }
        }
    }

    private getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        const activeUri = vscode.window.activeTextEditor?.document?.uri;
        if (activeUri) {
            const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
            if (activeFolder) {
                return activeFolder;
            }
        }
        return vscode.workspace.workspaceFolders?.[0];
    }

    private parseToolPayload(result: any): any {
        if (typeof result === 'string') {
            try {
                return JSON.parse(result);
            } catch {
                return result;
            }
        }

        const textPayload = result?.content?.[0]?.text;
        if (typeof textPayload === 'string') {
            try {
                return JSON.parse(textPayload);
            } catch {
                return textPayload;
            }
        }

        return result;
    }

    private async callToolParsed(
        toolName: string,
        args: Record<string, any>,
        options: { suppressActivity?: boolean; source?: 'extension' | 'internal' } = {}
    ): Promise<any> {
        const raw = await this.mcp.callTool(toolName, args, options);
        let parsed = this.parseToolPayload(raw);

        if (parsed && typeof parsed === 'object' && parsed._cached && toolName !== 'get_cached') {
            const cachedRaw = await this.mcp.callTool(
                'get_cached',
                { cache_id: parsed._cached },
                { suppressActivity: true, source: 'internal' }
            );
            parsed = this.parseToolPayload(cachedRaw);
            if (typeof parsed === 'string') {
                try {
                    parsed = JSON.parse(parsed);
                } catch {
                    // Keep raw string if not JSON.
                }
            }
        }

        return parsed;
    }

    private parseResourcePayload(result: any): any {
        const parsed = this.parseToolPayload(result);
        if (typeof parsed === 'string') {
            try {
                return JSON.parse(parsed);
            } catch {
                return parsed;
            }
        }

        const textCandidates = [
            result?.contents?.[0]?.text,
            result?.contents?.[0]?.textContent,
            result?.content?.[0]?.text,
            result?.text,
            result?.TextData?.Text
        ];

        for (const text of textCandidates) {
            if (typeof text !== 'string') { continue; }
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }

        return parsed;
    }

    private async readResourceParsed(uri: string): Promise<any> {
        const raw = await this.mcp.readResource(uri);
        return this.parseResourcePayload(raw);
    }

    private getDiagnosticSpecs(): Record<string, DiagnosticSpec> {
        return {
            verify_integrity: {
                label: 'Verify Integrity',
                primary: { kind: 'tool', tool: 'verify_integrity', label: 'verify_integrity' },
                fallbacks: [
                    { kind: 'tool', tool: 'verify_hash', label: 'verify_hash' },
                    { kind: 'resource', uri: 'brain://hash', label: 'brain://hash' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            verify_hash: {
                label: 'Verify Hash',
                primary: { kind: 'tool', tool: 'verify_hash', label: 'verify_hash' },
                fallbacks: [
                    { kind: 'tool', tool: 'verify_integrity', label: 'verify_integrity' },
                    { kind: 'resource', uri: 'brain://hash', label: 'brain://hash' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            get_provenance: {
                label: 'Provenance Chain',
                primary: { kind: 'tool', tool: 'get_provenance', label: 'get_provenance' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_genesis', label: 'get_genesis' },
                    { kind: 'tool', tool: 'get_identity', label: 'get_identity' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            tree: {
                label: 'Structure Tree',
                primary: { kind: 'tool', tool: 'tree', label: 'tree' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_genesis', label: 'get_genesis' },
                    { kind: 'tool', tool: 'get_identity', label: 'get_identity' },
                    { kind: 'tool', tool: 'get_provenance', label: 'get_provenance' }
                ]
            },
            show_weights: {
                label: 'Weights',
                primary: { kind: 'tool', tool: 'show_weights', label: 'show_weights' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            show_dims: {
                label: 'Dimensions',
                primary: { kind: 'tool', tool: 'show_dims', label: 'show_dims' },
                fallbacks: [
                    { kind: 'tool', tool: 'show_rssm', label: 'show_rssm' },
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            show_rssm: {
                label: 'RSSM',
                primary: { kind: 'tool', tool: 'show_rssm', label: 'show_rssm' },
                fallbacks: [
                    { kind: 'tool', tool: 'show_dims', label: 'show_dims' },
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            show_lora: {
                label: 'LoRA',
                primary: { kind: 'tool', tool: 'show_lora', label: 'show_lora' },
                fallbacks: [
                    { kind: 'tool', tool: 'show_weights', label: 'show_weights' },
                    { kind: 'tool', tool: 'show_dims', label: 'show_dims' },
                    { kind: 'tool', tool: 'get_status', label: 'get_status' }
                ]
            },
            export_pt: {
                label: 'Export .pt',
                primary: { kind: 'tool', tool: 'export_pt', label: 'export_pt' },
                fallbacks: [{ kind: 'tool', tool: 'get_status', label: 'get_status' }]
            },
            export_onnx: {
                label: 'Export .onnx',
                primary: { kind: 'tool', tool: 'export_onnx', label: 'export_onnx' },
                fallbacks: [{ kind: 'tool', tool: 'get_status', label: 'get_status' }]
            },
            export_docs: {
                label: 'Export Docs',
                primary: { kind: 'tool', tool: 'export_docs', label: 'export_docs' },
                fallbacks: [{ kind: 'tool', tool: 'get_readme', label: 'get_readme' }]
            },
            save_state: {
                label: 'Save State',
                primary: { kind: 'tool', tool: 'save_state', label: 'save_state' },
                fallbacks: [{ kind: 'tool', tool: 'get_status', label: 'get_status' }]
            },
            demo: {
                label: 'Run Demo',
                primary: { kind: 'tool', tool: 'demo', label: 'demo' },
                fallbacks: [{ kind: 'tool', tool: 'get_status', label: 'get_status' }]
            },
            cascade_graph_stats: {
                label: 'Cascade Graph Stats',
                primary: { kind: 'tool', tool: 'cascade_graph', args: { operation: 'stats' }, label: 'cascade_graph(stats)' },
                fallbacks: [{ kind: 'tool', tool: 'get_status', label: 'get_status' }]
            },
            cascade_genesis: {
                label: 'Cascade Genesis',
                primary: { kind: 'tool', tool: 'cascade_chain', args: { operation: 'genesis' }, label: 'cascade_chain(genesis)' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_genesis', label: 'get_genesis' },
                    { kind: 'tool', tool: 'get_identity', label: 'get_identity' }
                ]
            },
            cascade_identity: {
                label: 'Cascade Identity',
                primary: { kind: 'tool', tool: 'cascade_chain', args: { operation: 'identity' }, label: 'cascade_chain(identity)' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_identity', label: 'get_identity' },
                    { kind: 'tool', tool: 'get_genesis', label: 'get_genesis' }
                ]
            },
            cascade_session_stats: {
                label: 'Cascade Session Stats',
                primary: { kind: 'tool', tool: 'cascade_record', args: { operation: 'session_stats' }, label: 'cascade_record(session_stats)' },
                fallbacks: [
                    { kind: 'tool', tool: 'heartbeat', label: 'heartbeat' },
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            cascade_proxy_status: {
                label: 'Cascade Proxy Status',
                primary: { kind: 'tool', tool: 'cascade_proxy', args: { operation: 'status' }, label: 'cascade_proxy(status)' },
                fallbacks: [{ kind: 'tool', tool: 'relay_status', label: 'relay_status' }]
            },
            heartbeat: {
                label: 'Heartbeat',
                primary: { kind: 'tool', tool: 'heartbeat', label: 'heartbeat' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            },
            get_about: {
                label: 'About',
                primary: { kind: 'tool', tool: 'get_about', label: 'get_about' },
                fallbacks: [
                    { kind: 'tool', tool: 'get_status', label: 'get_status' },
                    { kind: 'tool', tool: 'get_capabilities', label: 'get_capabilities' },
                    { kind: 'resource', uri: 'brain://state', label: 'brain://state' }
                ]
            }
        };
    }

    private async probeDiagnosticSource(source: DiagnosticSource): Promise<DiagnosticProbe> {
        const id = source.kind === 'tool' ? source.tool : source.uri;
        const label = source.label || id;
        try {
            const data = source.kind === 'tool'
                ? await this.callToolParsed(source.tool, source.args || {}, { suppressActivity: true, source: 'internal' })
                : await this.readResourceParsed(source.uri);
            return { id, kind: source.kind, label, data };
        } catch (err: any) {
            return { id, kind: source.kind, label, error: err?.message || 'Unknown diagnostic probe error' };
        }
    }

    private hasDiagnosticError(result: any): boolean {
        return !!(result && typeof result === 'object' && typeof result.error === 'string' && result.error.trim().length > 0);
    }

    private isDiagnosticDeadZone(diagKey: string, result: any): boolean {
        if (result == null) { return true; }
        if (typeof result === 'string') { return result.trim().length === 0; }
        if (this.hasDiagnosticError(result)) { return true; }

        switch (diagKey) {
            case 'tree': {
                const root = String(result.root || '').trim().toLowerCase();
                const lineageEmpty = !Array.isArray(result.lineage) || result.lineage.length === 0;
                const childrenEmpty = !Array.isArray(result.children) || result.children.length === 0;
                return (!root || root === 'unknown') && lineageEmpty && childrenEmpty;
            }
            case 'show_dims': {
                const cfg = result?.config || {};
                const values = [
                    result?.input_dim,
                    result?.adapter_dim,
                    result?.output_dim,
                    result?.latent_dim,
                    result?.deter_dim,
                    cfg?.deter_dim,
                    cfg?.stoch_dim,
                    cfg?.stoch_classes,
                    cfg?.action_dim
                ];
                return !values.some((v) => typeof v === 'number' && v > 0);
            }
            case 'show_rssm': {
                const values = [
                    result?.deter_dim,
                    result?.stoch_dim,
                    result?.stoch_classes,
                    result?.hidden_dim,
                    result?.action_dim,
                    result?.total_latent
                ];
                return !values.some((v) => typeof v === 'number' && v > 0);
            }
            case 'show_lora':
                return !(typeof result?.lora_rank === 'number' && result.lora_rank > 0);
            case 'show_weights':
                return !result?.params && !result?.adapter_in && !result?.lora_A;
            case 'cascade_genesis':
                return this.hasDiagnosticError(result) || (!result?.genesis_root && result?.lineage_valid == null && result?.lineage_verified == null);
            case 'cascade_identity':
                return this.hasDiagnosticError(result) || String(result?.model_id || result?.identity || '').includes("model_id='unknown'");
            case 'cascade_session_stats': {
                const s = result?.stats;
                if (!s || typeof s !== 'object') { return true; }
                const keys = ['uptime_seconds', 'operations', 'kleene_entries', 'interpretive_entries'];
                return keys.every((k) => Number((s as any)[k] || 0) === 0);
            }
            default:
                return false;
        }
    }

    private normalizeDiagnosticResult(diagKey: string, probes: DiagnosticProbe[]): any {
        const successful = probes.filter((p) => !p.error);
        const best = successful.find((p) => !this.isDiagnosticDeadZone(diagKey, p.data)) || successful[0];
        let resolved: any = best ? JSON.parse(JSON.stringify(best.data)) : { error: probes[0]?.error || 'No diagnostic data available' };

        const probeData = (id: string) => successful.find((p) => p.id === id)?.data;
        const status = probeData('get_status') || {};
        const genesis = probeData('get_genesis') || {};
        const identity = probeData('get_identity') || {};
        const heartbeat = probeData('heartbeat') || {};
        const brainState = probeData('brain://state') || {};

        if (diagKey === 'tree' && resolved && typeof resolved === 'object') {
            const root = String(resolved.root || '').trim();
            if (!root || root.toLowerCase() === 'unknown') {
                const recoveredRoot = genesis.genesis_root || identity.parent_root;
                if (recoveredRoot) {
                    resolved = { ...resolved, root: recoveredRoot, recovered_root: true };
                }
            }
        }

        if (diagKey === 'cascade_genesis') {
            const chainProbe = probes.find((p) => p.id === 'cascade_chain');
            const chainFailed = !chainProbe || !!chainProbe.error || this.hasDiagnosticError(chainProbe.data);
            if (this.isDiagnosticDeadZone(diagKey, resolved)) {
                const recoveredRoot = genesis.genesis_root || identity.parent_root;
                if (recoveredRoot) {
                    resolved = {
                        genesis_root: recoveredRoot,
                        agent_id: genesis.agent_id || identity.model_id,
                        generation: genesis.generation,
                        fitness: genesis.fitness,
                        quine_hash: genesis.quine_hash,
                    };
                }
            }
            if (chainFailed && resolved && typeof resolved === 'object') {
                resolved.lineage_verified = false;
                if (!resolved.source) { resolved.source = 'fallback:get_genesis'; }
                if (!resolved.note) { resolved.note = 'Lineage verification was not performed (cascade_chain errored). Genesis data from get_genesis.'; }
            }
        }

        if (diagKey === 'cascade_identity') {
            const chainProbe = probes.find((p) => p.id === 'cascade_chain');
            const chainFailed = !chainProbe || !!chainProbe.error || this.hasDiagnosticError(chainProbe.data)
                || String(chainProbe.data?.model_id || chainProbe.data?.identity || '').includes("model_id='unknown'");
            if (this.isDiagnosticDeadZone(diagKey, resolved) && identity && Object.keys(identity).length > 0) {
                resolved = { ...identity };
            }
            if (chainFailed && resolved && typeof resolved === 'object') {
                if (!resolved.source) { resolved.source = 'fallback:get_identity'; }
                if (!resolved.note) { resolved.note = 'Primary cascade_chain(identity) returned incomplete data. Identity from get_identity.'; }
            }
        }

        if (diagKey === 'cascade_session_stats') {
            const stats = (resolved && typeof resolved === 'object' && resolved.stats && typeof resolved.stats === 'object')
                ? { ...resolved.stats }
                : {};
            const enriched: Record<string, any> = {};
            if (Number(stats.operations || 0) === 0 && typeof brainState?.inference_count === 'number') {
                stats.operations = brainState.inference_count;
                enriched.operations = 'brain://state.inference_count';
            }
            if (Number(stats.uptime_seconds || 0) === 0 && typeof heartbeat?.uptime_seconds === 'number') {
                stats.uptime_seconds = heartbeat.uptime_seconds;
                enriched.uptime_seconds = 'heartbeat.uptime_seconds';
            }
            resolved = {
                stats,
                slots_active: status?.slots_filled ?? heartbeat?.slots_plugged,
                slots_total: status?.slots_total ?? heartbeat?.slots_total,
                enriched_from: Object.keys(enriched).length > 0 ? enriched : undefined,
                source: 'session_stats+fallback_enrichment'
            };
        }

        if ((diagKey === 'show_dims' || diagKey === 'show_rssm') && this.isDiagnosticDeadZone(diagKey, resolved)) {
            const brainType = String(resolved?.brain_type || status?.brain_type || brainState?.type || 'unknown');
            const isOuroboros = brainType.toLowerCase().includes('ouroboros');
            if (isOuroboros) {
                const defaults = {
                    deter_dim: 4096,
                    stoch_dim: 32,
                    stoch_classes: 32,
                    hidden_dim: 4096,
                    action_dim: 8,
                    imagine_horizon: 15
                };
                const totalLatent = defaults.deter_dim + defaults.stoch_dim * defaults.stoch_classes;
                if (diagKey === 'show_dims') {
                    resolved = {
                        brain_type: brainType,
                        config: {
                            deter_dim: defaults.deter_dim,
                            stoch_dim: defaults.stoch_dim,
                            stoch_classes: defaults.stoch_classes,
                            hidden_dim: defaults.hidden_dim,
                            action_dim: defaults.action_dim
                        },
                        total_latent: totalLatent,
                        source: 'fallback:_OUROBOROS_CONFIG_defaults',
                        note: 'Runtime dims endpoint returned null fields. Values shown are from _OUROBOROS_CONFIG init defaults, not live runtime reads.'
                    };
                } else {
                    resolved = {
                        deter_dim: defaults.deter_dim,
                        stoch_dim: defaults.stoch_dim,
                        stoch_classes: defaults.stoch_classes,
                        hidden_dim: defaults.hidden_dim,
                        action_dim: defaults.action_dim,
                        imagine_horizon: defaults.imagine_horizon,
                        total_latent: totalLatent,
                        source: 'fallback:_OUROBOROS_CONFIG_defaults',
                        note: 'Runtime RSSM endpoint returned null fields. Values shown are from _OUROBOROS_CONFIG init defaults, not live runtime reads.'
                    };
                }
            }
        }

        if (diagKey === 'show_lora' && this.isDiagnosticDeadZone(diagKey, resolved)) {
            resolved = {
                brain_type: resolved?.brain_type || status?.brain_type || brainState?.type || 'unknown',
                lora_available: false,
                slots_filled: status?.slots_filled,
                slots_total: status?.slots_total,
                source: 'fallback:runtime_status',
                note: 'No active LoRA adapter is exposed on the current runtime path.'
            };
        }

        if ((diagKey === 'verify_hash' || diagKey === 'verify_integrity') && resolved && typeof resolved === 'object') {
            const hash = probeData('brain://hash');
            if (typeof hash === 'string' && hash.trim().length > 0 && !resolved.current_hash && !resolved.expected_hash) {
                resolved = { ...resolved, quine_hash: hash };
            }
        }

        if (diagKey === 'get_about' && (this.hasDiagnosticError(resolved) || !resolved || typeof resolved !== 'object')) {
            resolved = {
                name: 'Glass Box AI Capsule',
                brain_type: status?.brain_type || brainState?.type || 'unknown',
                generation: status?.generation ?? brainState?.generation,
                fitness: status?.fitness ?? brainState?.fitness,
                quine_hash: status?.quine_hash || brainState?.quine_hash,
                source: 'fallback:get_status+brain_state'
            };
        }

        return resolved;
    }

    private async runDiagnostic(diagKey: string): Promise<any> {
        const specs = this.getDiagnosticSpecs();
        const spec = specs[diagKey];
        if (!spec) {
            throw new Error(`Unknown diagnostic key: ${diagKey}`);
        }

        const probes: DiagnosticProbe[] = [];
        const primaryProbe = await this.probeDiagnosticSource(spec.primary);
        probes.push(primaryProbe);

        const shouldProbeFallbacks =
            spec.alwaysEnrich === true ||
            !!primaryProbe.error ||
            this.isDiagnosticDeadZone(diagKey, primaryProbe.data);

        if (shouldProbeFallbacks && spec.fallbacks?.length) {
            for (const fallback of spec.fallbacks) {
                probes.push(await this.probeDiagnosticSource(fallback));
            }
        }

        const resolved = this.normalizeDiagnosticResult(diagKey, probes);
        const healthy = !this.isDiagnosticDeadZone(diagKey, resolved);

        return {
            key: diagKey,
            label: spec.label,
            timestamp: new Date().toISOString(),
            healthy,
            fallback_used: probes.length > 1,
            resolved,
            probes: probes.map((p) => ({
                id: p.id,
                kind: p.kind,
                label: p.label,
                ok: !p.error,
                error: p.error,
                data: p.data
            }))
        };
    }

    private normalizeCatalogItems(catalog: any): Array<{
        key: string;
        name: string;
        type?: string;
        preview?: string;
        size?: number;
        version?: number;
    }> {
        const byKey = new Map<string, {
            key: string;
            name: string;
            type?: string;
            preview?: string;
            size?: number;
            version?: number;
        }>();

        const upsert = (item: {
            key: string;
            name?: string;
            type?: string;
            preview?: string;
            size?: number;
            version?: number;
        }) => {
            const key = String(item.key || '').trim();
            if (!key) { return; }

            const existing = byKey.get(key) || { key, name: key };
            const merged = {
                ...existing,
                name: item.name || existing.name || key,
                type: item.type || existing.type,
                preview: item.preview || existing.preview,
                size: typeof item.size === 'number' ? item.size : existing.size,
                version: typeof item.version === 'number' ? item.version : existing.version
            };
            byKey.set(key, merged);
        };

        if (Array.isArray(catalog?.all_ids)) {
            for (let i = 0; i < catalog.all_ids.length; i += 2) {
                upsert({ key: catalog.all_ids[i], name: catalog.all_ids[i + 1] });
            }
        }

        if (Array.isArray(catalog?.items)) {
            for (const item of catalog.items) {
                if (typeof item === 'string') {
                    upsert({ key: item, name: item });
                    continue;
                }
                if (!item || typeof item !== 'object') { continue; }

                const sizeNum = Number(item.size);
                const versionNum = Number(item.version);
                upsert({
                    key: item.id || item.key || item.name,
                    name: item.name,
                    type: item.type,
                    preview: item.preview,
                    size: Number.isFinite(sizeNum) ? sizeNum : undefined,
                    version: Number.isFinite(versionNum) ? versionNum : undefined
                });
            }
        }

        return Array.from(byKey.values());
    }

    private stringifyContent(value: any): string {
        if (value === null || typeof value === 'undefined') {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    private async collectBagEntries(items: Array<{
        key: string;
        name: string;
        type?: string;
        preview?: string;
        size?: number;
        version?: number;
    }>): Promise<Array<{
        key: string;
        name: string;
        type?: string;
        preview?: string;
        size?: number;
        version?: number;
        value: any;
    }>> {
        const entries: Array<{
            key: string;
            name: string;
            type?: string;
            preview?: string;
            size?: number;
            version?: number;
            value: any;
        }> = [];

        for (const item of items) {
            try {
                const fetched = await this.callToolParsed(
                    'bag_get',
                    { key: item.key },
                    { suppressActivity: true, source: 'internal' }
                );
                const value = fetched && typeof fetched === 'object' && Object.prototype.hasOwnProperty.call(fetched, 'value')
                    ? fetched.value
                    : fetched;
                entries.push({ ...item, value });
            } catch (err: any) {
                entries.push({ ...item, value: { error: err?.message || 'Failed to fetch item' } });
            }
        }

        return entries;
    }

    private csvEscape(value: any): string {
        const raw = value == null ? '' : String(value);
        const escaped = raw.replace(/"/g, '""');
        return /[",\n]/.test(raw) ? `"${escaped}"` : escaped;
    }

    private renderCatalogAsMarkdown(
        items: Array<{ key: string; name: string; type?: string; preview?: string; size?: number; version?: number; value: any }>,
        workspaceName: string,
        exportedAt: string
    ): string {
        const lines: string[] = [
            '# FelixBag Export',
            '',
            `- Exported at: ${exportedAt}`,
            `- Workspace: ${workspaceName}`,
            `- Item count: ${items.length}`,
            '',
            '## Items',
            ''
        ];

        if (items.length === 0) {
            lines.push('_No items in FelixBag._');
            return lines.join('\n');
        }

        for (const item of items) {
            lines.push(`### ${item.name}`);
            lines.push(`- Key: \`${item.key}\``);
            if (item.type) { lines.push(`- Type: ${item.type}`); }
            if (item.preview) { lines.push(`- Preview: ${item.preview}`); }
            if (typeof item.size === 'number') { lines.push(`- Size: ${item.size}`); }
            if (typeof item.version === 'number') { lines.push(`- Version: ${item.version}`); }
            lines.push('- Content:');
            lines.push('```');
            lines.push(this.stringifyContent(item.value));
            lines.push('```');
            lines.push('');
        }

        return lines.join('\n');
    }

    private renderCatalogAsText(
        items: Array<{ key: string; name: string; type?: string; preview?: string; size?: number; version?: number; value: any }>,
        workspaceName: string,
        exportedAt: string
    ): string {
        const lines: string[] = [
            'FELIXBAG EXPORT',
            `Exported at: ${exportedAt}`,
            `Workspace: ${workspaceName}`,
            `Item count: ${items.length}`,
            ''
        ];

        if (items.length === 0) {
            lines.push('No items in FelixBag.');
            return lines.join('\n');
        }

        for (const item of items) {
            lines.push(`- ${item.name}`);
            lines.push(`  key: ${item.key}`);
            if (item.type) { lines.push(`  type: ${item.type}`); }
            if (item.preview) { lines.push(`  preview: ${item.preview}`); }
            if (typeof item.size === 'number') { lines.push(`  size: ${item.size}`); }
            if (typeof item.version === 'number') { lines.push(`  version: ${item.version}`); }
            lines.push('  content:');
            const contentLines = this.stringifyContent(item.value).split('\n');
            for (const contentLine of contentLines) {
                lines.push(`    ${contentLine}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    private renderCatalogAsCsv(
        items: Array<{ key: string; name: string; type?: string; preview?: string; size?: number; version?: number; value: any }>
    ): string {
        const header = 'key,name,type,preview,size,version,content';
        const rows = items.map((item) => [
            this.csvEscape(item.key),
            this.csvEscape(item.name),
            this.csvEscape(item.type || ''),
            this.csvEscape(item.preview || ''),
            this.csvEscape(typeof item.size === 'number' ? item.size : ''),
            this.csvEscape(typeof item.version === 'number' ? item.version : ''),
            this.csvEscape(this.stringifyContent(item.value))
        ].join(','));
        return [header, ...rows].join('\n');
    }

    private async exportMemoryToWorkspace(): Promise<void> {
        const workspaceFolder = this.getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open. Open a folder/workspace and try again.');
        }

        const formatPick = await vscode.window.showQuickPick([
            { label: 'JSON (.json)', value: 'json', description: 'Full FelixBag snapshot via bag_export' },
            { label: 'Markdown (.md)', value: 'md', description: 'Readable catalog summary' },
            { label: 'Plain Text (.txt)', value: 'txt', description: 'Simple catalog summary' },
            { label: 'CSV (.csv)', value: 'csv', description: 'Spreadsheet-ready catalog rows' }
        ], {
            placeHolder: 'Choose export format for FelixBag',
            title: 'Export FelixBag'
        });

        if (!formatPick) {
            return;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileType = formatPick.value;
        const fileName = `felixbag-export-${stamp}.${fileType}`;
        const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);

        if (fileType === 'json') {
            const result = await this.callToolParsed(
                'bag_export',
                { output_path: targetUri.fsPath },
                { suppressActivity: true, source: 'internal' }
            );
            if (result && typeof result === 'object' && result.error) {
                throw new Error(result.error);
            }
        } else {
            const catalog = await this.callToolParsed(
                'bag_catalog',
                {},
                { suppressActivity: true, source: 'internal' }
            );
            if (catalog && typeof catalog === 'object' && catalog.error) {
                throw new Error(catalog.error);
            }

            const items = this.normalizeCatalogItems(catalog || {});
            const entries = await this.collectBagEntries(items);
            const exportedAt = new Date().toISOString();

            let fileContents = '';
            if (fileType === 'md') {
                fileContents = this.renderCatalogAsMarkdown(entries, workspaceFolder.name, exportedAt);
            } else if (fileType === 'txt') {
                fileContents = this.renderCatalogAsText(entries, workspaceFolder.name, exportedAt);
            } else {
                fileContents = this.renderCatalogAsCsv(entries);
            }

            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(fileContents, 'utf8'));
        }

        this.send({ type: 'memoryExported', path: targetUri.fsPath, fileType });
        vscode.window.showInformationMessage(`FelixBag exported to workspace: ${targetUri.fsPath}`);
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
    /* ── UX OVERRIDE LAYER (set by theme engine) ── */
    --ux-font-size: 12px;
    --ux-font-size-sm: 10px;
    --ux-font-size-xs: 9px;
    --ux-font-size-lg: 14px;
    --ux-spacing: 12px;
    --ux-spacing-sm: 8px;
    --ux-spacing-xs: 4px;
    --ux-radius: 0px;
    --ux-transition: 0.15s;
    --ux-msg-padding: 8px 12px;
    --ux-card-padding: 12px 14px;
    --ux-header-size: 14px;
    --ux-line-height: 1.5;
    --ux-opacity-dim: 0.55;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--mono);
    background: var(--vscode-editor-background, #0a0a1a);
    color: var(--text);
    font-size: var(--ux-font-size);
    line-height: var(--ux-line-height);
    overflow-x: hidden;
    transition: font-size var(--ux-transition), color var(--ux-transition);
}
body.reduce-motion, body.reduce-motion * { transition: none !important; animation: none !important; }

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
/* ── MCP CONFIG SECTION ── */
.mcp-config-section {
    margin-top: 24px;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 14px;
}
.mcp-config-section .config-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}
.mcp-config-section pre {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 10px 12px;
    font-size: 11px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
    color: var(--text);
    cursor: pointer;
    position: relative;
}
.mcp-config-section pre:hover { border-color: var(--accent); }
.mcp-config-section .config-paths {
    margin-top: 10px;
    font-size: 9px;
    color: var(--text-dim);
    line-height: 1.8;
}
.mcp-config-section .config-paths strong { color: var(--text); }
.mcp-config-section .config-paths code {
    background: var(--surface2);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 9px;
}
.copy-toast {
    display: inline-block;
    padding: 2px 8px;
    background: var(--accent);
    color: var(--bg);
    font-size: 9px;
    font-weight: 700;
    border-radius: 3px;
    opacity: 0;
    transition: opacity 0.2s;
}
.copy-toast.show { opacity: 1; }
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
.memory-stats .stat-box {
    background: var(--surface2);
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 11px;
    color: var(--text-dim);
}
.memory-stats .stat-box strong {
    color: var(--accent);
    font-size: 14px;
    margin-right: 4px;
}
.memory-list {
    border: 1px solid var(--border);
    max-height: 400px;
    overflow-y: auto;
}
.memory-item {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: default;
}
.memory-item:hover { background: var(--surface2); }
.memory-item .mi-header {
    display: flex;
    align-items: center;
    gap: 8px;
}
.memory-item .mi-name {
    font-weight: 600;
    color: var(--text);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
}
.memory-item .mi-type {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg);
    white-space: nowrap;
    flex-shrink: 0;
}
.memory-item .mi-type[data-type="model"]   { background: #7c3aed; color: #fff; }
.memory-item .mi-type[data-type="text"]    { background: #0891b2; color: #fff; }
.memory-item .mi-type[data-type="code"]    { background: #16a34a; color: #fff; }
.memory-item .mi-type[data-type="file"]    { background: #ca8a04; color: #fff; }
.memory-item .mi-type[data-type="json"]    { background: #e11d48; color: #fff; }
.memory-item .mi-preview {
    color: var(--text-dim);
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: italic;
}
.memory-item .mi-meta {
    display: flex;
    gap: 12px;
    font-size: 9px;
    color: var(--text-dim);
    opacity: 0.7;
}
.memory-item .mi-meta span { white-space: nowrap; }
.memory-item .mi-id {
    font-family: monospace;
    font-size: 9px;
    color: var(--text-dim);
    opacity: 0.5;
}

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
    padding: 0;
    font-size: 11px;
    max-height: 460px;
    overflow: auto;
    white-space: normal;
    word-break: normal;
}
.diag-shell {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
}
.diag-shell.error { border-left: 3px solid var(--red); }
.diag-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
}
.diag-head-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
}
.diag-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.diag-badge {
    display: inline-block;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 9px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: var(--text-dim);
}
.diag-badge.ok { border-color: var(--green); color: var(--green); }
.diag-badge.warn { border-color: var(--amber); color: var(--amber); }
.diag-badge.err { border-color: var(--red); color: var(--red); }
.diag-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    color: var(--text-dim);
    font-size: 10px;
}
.diag-kv-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
}
.diag-kv {
    border: 1px solid var(--border);
    background: var(--surface2);
    padding: 7px 9px;
}
.diag-k {
    font-size: 9px;
    letter-spacing: 0.7px;
    color: var(--text-dim);
    text-transform: uppercase;
}
.diag-v {
    margin-top: 2px;
    color: var(--text);
    font-size: 11px;
    word-break: break-word;
}
.diag-note {
    border-left: 2px solid var(--accent);
    padding: 8px 10px;
    background: var(--surface2);
    color: var(--text);
    font-size: 10px;
    line-height: 1.45;
}
.diag-details {
    border: 1px solid var(--border);
    background: var(--surface2);
}
.diag-details > summary {
    cursor: pointer;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.9px;
    color: var(--text-dim);
    padding: 8px 10px;
}
.diag-details pre {
    margin: 0;
    padding: 0 10px 10px 10px;
    color: var(--text);
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
}
.diag-probe-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 10px 8px 10px;
}
.diag-probe-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 10px;
    padding: 4px 0;
    border-bottom: 1px dashed var(--border);
}
.diag-probe-item:last-child { border-bottom: none; }
.diag-probe-name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.diag-empty {
    color: var(--text-dim);
    font-size: 10px;
    padding: 4px 0;
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
    border-radius: 6px;
    padding: 20px;
    width: 500px;
    max-width: 90%;
    max-height: 90vh;
    overflow-y: auto;
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

/* ── COMMUNITY TAB ── */
.nostr-identity {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    background: var(--surface);
    margin-bottom: 8px;
    font-size: 11px;
}
.nostr-identity .npub {
    font-family: var(--mono);
    color: var(--accent);
    font-size: 10px;
}
.nostr-identity .relay-count {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 10px;
}
.community-toolbar {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
    flex-wrap: wrap;
}
.community-toolbar button { font-size: 9px; padding: 3px 8px; }
.community-toolbar .active { background: var(--accent); color: #000; }
.online-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border: 1px solid var(--border);
    background: var(--surface);
    margin-bottom: 12px;
    font-size: 10px;
    color: var(--text-dim);
}
.online-bar .online-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); display: inline-block; }
.community-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    min-height: 400px;
}
.community-panel {
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
}
.community-panel-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.community-feed {
    flex: 1;
    overflow-y: auto;
    max-height: 350px;
    padding: 0;
}
.community-msg {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    position: relative;
}
.community-msg:hover { background: var(--surface2); }
.community-msg .msg-author {
    color: var(--blue);
    font-weight: 600;
    font-size: 10px;
    cursor: pointer;
}
.community-msg .msg-author:hover { text-decoration: underline; }
.community-msg .msg-time {
    color: var(--text-dim);
    font-size: 9px;
    margin-left: 8px;
}
.community-msg .msg-text {
    margin-top: 4px;
    line-height: 1.4;
}
.community-msg .msg-reactions {
    margin-top: 6px;
    display: flex;
    gap: 6px;
    font-size: 10px;
}
.community-msg .msg-reactions .react-btn {
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 3px;
}
.community-msg .msg-reactions .react-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(255,255,255,0.04);
}
.community-msg .msg-reactions .react-btn.reacted {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(255,170,0,0.1);
}
.community-msg .msg-reactions .react-count {
    font-weight: 700;
    font-size: 9px;
    min-width: 10px;
    text-align: center;
}
.msg-ctx-btn {
    position: absolute;
    top: 6px;
    right: 8px;
    opacity: 0.3;
    font-size: 14px;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text-dim);
    cursor: pointer;
    transition: opacity 0.15s;
    line-height: 1;
}
.community-msg:hover .msg-ctx-btn { opacity: 1; }
.msg-ctx-btn:hover { color: var(--text); border-color: var(--text-dim); background: var(--surface2); }
.ctx-menu {
    position: fixed;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 4px;
    z-index: 200;
    min-width: 140px;
    max-width: calc(100vw - 8px);
    max-height: calc(100vh - 8px);
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
.ctx-menu-item {
    padding: 6px 12px;
    font-size: 10px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: var(--mono);
    color: var(--text);
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    display: block;
}
.ctx-menu-item:hover { background: var(--accent); color: #000; }
.ctx-menu-item.danger { color: var(--red); }
.ctx-menu-item.danger:hover { background: var(--red); color: #fff; }
.chat-input-row {
    display: flex;
    gap: 4px;
    padding: 8px;
    border-top: 1px solid var(--border);
}
.chat-input-row input { flex: 1; }
.redact-warn {
    padding: 4px 8px;
    background: rgba(255,170,0,0.15);
    border: 1px solid var(--amber);
    color: var(--amber);
    font-size: 9px;
    margin: 4px 8px;
    display: none;
}
.redact-warn.visible { display: block; }
/* ── MARKETPLACE ── */
.mp-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 12px;
}
.mp-stat {
    padding: 8px 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    text-align: center;
}
.mp-stat .mp-stat-val {
    font-size: 16px;
    font-weight: 700;
    color: var(--accent);
}
.mp-stat .mp-stat-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    margin-top: 2px;
}
.mp-controls {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
    align-items: center;
}
.mp-controls input {
    flex: 1;
    font-size: 10px;
    padding: 5px 10px;
}
.mp-controls select {
    width: auto;
    font-size: 10px;
    padding: 5px 6px;
    min-width: 100px;
}
.mp-categories {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
}
.mp-cat-pill {
    font-size: 9px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
}
.mp-cat-pill:hover { border-color: var(--text-dim); color: var(--text); }
.mp-cat-pill.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.mp-cat-pill .pill-count {
    font-size: 8px;
    opacity: 0.6;
    margin-left: 3px;
}
.wf-card {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    cursor: default;
}
.wf-card:hover { background: var(--surface2); }
.wf-card .wf-header { display: flex; justify-content: space-between; align-items: flex-start; }
.wf-card .wf-title {
    font-weight: 600;
    font-size: 11px;
    color: var(--accent);
}
.wf-card .wf-cat-badge {
    font-size: 8px;
    padding: 2px 6px;
    border: 1px solid var(--accent-dim);
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
}
.wf-card .wf-author {
    font-size: 9px;
    color: var(--text-dim);
    margin-top: 2px;
}
.wf-card .wf-desc {
    font-size: 10px;
    color: var(--text);
    margin-top: 4px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.wf-card .wf-meta {
    display: flex;
    gap: 12px;
    margin-top: 6px;
    font-size: 9px;
    color: var(--text-dim);
}
.wf-card .wf-meta span { display: flex; align-items: center; gap: 3px; }
.wf-card .wf-tags {
    margin-top: 6px;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
.wf-card .wf-tags span {
    font-size: 8px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    color: var(--text-dim);
}
.wf-card .wf-actions {
    margin-top: 8px;
    display: flex;
    gap: 6px;
}
.wf-doctype-badge {
    font-size: 7px;
    font-weight: 700;
    letter-spacing: 0.8px;
    padding: 1px 5px;
    border: 1px solid;
    border-radius: 2px;
    margin-right: 6px;
    flex-shrink: 0;
}
.wf-safety-badge {
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 1px 5px;
    border-radius: 2px;
    margin-left: auto;
    flex-shrink: 0;
}
.wf-safety-badge.safe { color: var(--green); border: 1px solid var(--green); }
.wf-safety-badge.flagged { color: #fbbf24; border: 1px solid #fbbf24; background: rgba(251,191,36,0.08); }
.wf-safety-badge.blocked { color: #ef4444; border: 1px solid #ef4444; background: rgba(239,68,68,0.08); }
.wf-card-flagged { border-left: 2px solid #fbbf24; }
.wf-flag-warn {
    font-size: 9px;
    color: #fbbf24;
    margin-top: 6px;
    padding: 4px 8px;
    background: rgba(251,191,36,0.06);
    border: 1px solid rgba(251,191,36,0.2);
}
/* ── DETAIL OVERLAY ── */
.wf-detail-overlay {
    display: none;
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--vscode-editor-background, #0a0a1a);
    z-index: 50;
    overflow-y: auto;
    padding: 16px;
}
.wf-detail-overlay.visible { display: block; }
.wf-detail-overlay .wf-detail-back {
    font-size: 10px;
    margin-bottom: 12px;
}
.wf-detail-overlay .wf-detail-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 4px;
}
.wf-detail-overlay .wf-detail-meta {
    font-size: 10px;
    color: var(--text-dim);
    margin-bottom: 12px;
}
.wf-detail-overlay .wf-detail-section {
    margin-bottom: 14px;
}
.wf-detail-overlay .wf-detail-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    font-weight: 600;
    margin-bottom: 6px;
}
.wf-detail-overlay .wf-detail-body {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text);
}
.wf-detail-overlay pre {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 10px;
    font-size: 10px;
    overflow-x: auto;
    max-height: 200px;
    white-space: pre-wrap;
    word-break: break-all;
}
.mp-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-dim);
    font-size: 11px;
}
/* ── APPEARANCE PANEL ── */
.ux-presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
    margin-bottom: 14px;
}
.ux-preset-card {
    border: 1px solid var(--border);
    padding: 10px;
    cursor: pointer;
    transition: border-color var(--ux-transition), background var(--ux-transition);
    text-align: center;
}
.ux-preset-card:hover { border-color: var(--text-dim); background: var(--surface); }
.ux-preset-card.active { border-color: var(--accent); background: var(--accent-dim); }
.ux-preset-card .ux-preset-icon { font-size: 18px; margin-bottom: 4px; }
.ux-preset-card .ux-preset-name {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1px; color: var(--text);
}
.ux-preset-card.active .ux-preset-name { color: var(--accent); }
.ux-preset-card .ux-preset-desc {
    font-size: 8px; color: var(--text-dim); margin-top: 2px; line-height: 1.3;
}
.ux-preset-card .ux-security-badge {
    display: inline-block; font-size: 7px; padding: 1px 5px; margin-top: 4px;
    text-transform: uppercase; letter-spacing: 0.8px; border: 1px solid;
}
.ux-security-badge.high { color: var(--green); border-color: var(--green); }
.ux-security-badge.medium { color: var(--amber); border-color: var(--amber); }
.ux-security-badge.low { color: var(--red); border-color: var(--red); }
.ux-category {
    border: 1px solid var(--border);
    margin-bottom: 6px;
    transition: border-color var(--ux-transition);
}
.ux-category:hover { border-color: var(--text-dim); }
.ux-category-header {
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
}
.ux-category-header:hover { background: var(--surface); }
.ux-category-title {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--text);
}
.ux-category-value {
    font-size: 9px; color: var(--accent); text-transform: uppercase;
}
.ux-category-arrow {
    font-size: 10px; color: var(--text-dim); transition: transform 0.2s;
    margin-right: 6px;
}
.ux-category.open .ux-category-arrow { transform: rotate(90deg); }
.ux-category-body {
    display: none;
    padding: 8px 12px 12px;
    border-top: 1px solid var(--border);
}
.ux-category.open .ux-category-body { display: block; }
.ux-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 8px;
}
.ux-control:last-child { margin-bottom: 0; }
.ux-control label {
    font-size: 9px; color: var(--text-dim); white-space: nowrap; min-width: 80px;
}
.ux-control input[type="range"] {
    flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
    background: var(--border); outline: none; border-radius: 2px;
    cursor: pointer;
}
.ux-control input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 12px; height: 12px; background: var(--accent);
    border-radius: 50%; cursor: pointer;
}
.ux-control .ux-range-val {
    font-size: 9px; color: var(--accent); min-width: 32px; text-align: right;
    font-variant-numeric: tabular-nums;
}
.ux-control select {
    font-size: 9px; padding: 3px 6px; min-width: 90px;
}
.ux-control input[type="color"] {
    width: 24px; height: 24px; border: 1px solid var(--border);
    background: none; cursor: pointer; padding: 0;
}
.ux-control .toggle-switch { flex-shrink: 0; }
.ux-note {
    font-size: 8px; color: var(--text-dim); line-height: 1.4;
    padding: 6px 8px; border-left: 2px solid var(--border); margin-top: 8px;
}
.ux-note.security {
    border-left-color: var(--amber);
    color: var(--amber);
}
.ux-reset-row {
    display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;
}
/* ── DM PANEL ── */
.dm-conversations {
    border: 1px solid var(--border);
    max-height: 150px;
    overflow-y: auto;
    margin-bottom: 8px;
}
.dm-conv-item {
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font-size: 10px;
    display: flex;
    justify-content: space-between;
}
.dm-conv-item:hover { background: var(--surface2); }
.dm-conv-item.active { border-left: 2px solid var(--accent); background: var(--surface2); }
.dm-conv-item .dm-conv-name { color: var(--blue); font-weight: 600; }
.dm-conv-item .dm-conv-time { color: var(--text-dim); font-size: 9px; }
/* ── PRIVACY PANEL ── */
.privacy-panel {
    border: 1px solid var(--border);
    padding: 12px;
    background: var(--surface);
    margin-top: 12px;
}
.privacy-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 10px;
}
.privacy-row:last-child { border-bottom: none; }
.privacy-row label { color: var(--text); text-transform: uppercase; letter-spacing: 0.5px; }
.toggle-switch {
    width: 36px;
    height: 18px;
    border-radius: 9px;
    background: #333;
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
    border: none;
    padding: 0;
}
.toggle-switch.on { background: var(--accent); }
.toggle-switch::after {
    content: '';
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: left 0.2s;
}
.toggle-switch.on::after { left: 20px; }
/* ── BLOCK LIST ── */
.block-list {
    border: 1px solid var(--border);
    max-height: 120px;
    overflow-y: auto;
    margin-top: 8px;
}
.block-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 10px;
}
.block-item .block-pubkey { color: var(--text-dim); font-family: var(--mono); }
.disabled-overlay {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 30px;
    color: var(--text-dim);
    font-size: 11px;
    text-align: center;
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
    <button class="tab" data-tab="community">Community</button>
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
            <div class="meta-label">Capsule Hash</div>
            <div class="meta-value small" id="ov-hash" style="font-size:10px;word-break:break-all;">1f74574c...</div>
        </div>
    </div>

    <div class="section-head" style="margin-top:24px;">TOOL CATEGORIES</div>
    <div class="cat-bars" id="cat-bars"></div>

    <div class="mcp-config-section">
        <div class="section-head" style="margin-bottom:10px;">MCP CONFIG</div>

        <div class="config-header">
            <span style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">New config file (paste as entire file)</span>
            <div style="display:flex;align-items:center;gap:8px;">
                <span class="copy-toast" id="config-copy-toast">COPIED</span>
                <button id="copy-mcp-config">COPY</button>
            </div>
        </div>
        <pre id="mcp-config-block">Loading...</pre>

        <div class="config-header" style="margin-top:12px;">
            <span style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Add to existing config (paste inside "mcpServers": { })</span>
            <div style="display:flex;align-items:center;gap:8px;">
                <span class="copy-toast" id="config-entry-toast">COPIED</span>
                <button id="copy-mcp-entry">COPY</button>
            </div>
        </div>
        <pre id="mcp-entry-block">Loading...</pre>

        <div class="config-paths">
            <strong>Config file locations:</strong><br>
            <strong>Windsurf:</strong> <code>~/.codeium/windsurf/mcp_config.json</code><br>
            <strong>Cursor:</strong> <code>~/.cursor/mcp.json</code><br>
            <strong>VS Code (Cline):</strong> <code>~/.vscode/cline_mcp_settings.json</code><br>
            <strong>Continue:</strong> <code>~/.continue/config.json</code><br>
            <strong>Claude Desktop (Win):</strong> <code>%APPDATA%/Claude/claude_desktop_config.json</code><br>
            <strong>Claude Desktop (Mac):</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
        </div>
    </div>
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
        <button onclick="startMemoryExport()">EXPORT</button>
        <button class="btn-dim" onclick="openInductModal()">INDUCT ITEM</button>
    </div>
    <div id="mem-export-status" style="margin-top:8px;font-size:10px;color:var(--text-dim);min-height:14px;"></div>
    <!-- Artifact detail viewer -->
    <div id="mem-detail" style="display:none;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <button class="btn-dim" onclick="closeMemDetail()" style="padding:4px 10px;font-size:11px;">← BACK</button>
            <span id="mem-detail-title" style="font-weight:700;color:var(--accent);font-size:13px;"></span>
            <span id="mem-detail-type" class="mi-type" style="font-size:9px;"></span>
        </div>
        <div id="mem-detail-meta" style="font-size:10px;color:var(--text-dim);margin-bottom:8px;"></div>
        <div id="mem-detail-content" style="border:1px solid var(--border);border-radius:6px;max-height:500px;overflow:auto;background:var(--surface);font-family:monospace;font-size:11px;line-height:1.5;"></div>
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
        <button onclick="runDiagnostic('verify_integrity')">VERIFY INTEGRITY</button>
        <button onclick="runDiagnostic('verify_hash')">VERIFY HASH</button>
        <button onclick="runDiagnostic('get_provenance')">PROVENANCE CHAIN</button>
        <button onclick="runDiagnostic('tree')">STRUCTURE TREE</button>
        <button onclick="runDiagnostic('show_weights')">WEIGHTS</button>
        <button onclick="runDiagnostic('show_dims')">DIMENSIONS</button>
        <button onclick="runDiagnostic('show_rssm')">RSSM</button>
        <button onclick="runDiagnostic('show_lora')">LORA</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button class="btn-dim" onclick="runDiagnostic('export_pt')">EXPORT .PT</button>
        <button class="btn-dim" onclick="runDiagnostic('export_onnx')">EXPORT .ONNX</button>
        <button class="btn-dim" onclick="runDiagnostic('export_docs')">EXPORT DOCS</button>
        <button class="btn-dim" onclick="runDiagnostic('save_state')">SAVE STATE</button>
        <button class="btn-dim" onclick="runDiagnostic('demo')">RUN DEMO</button>
    </div>
    <div class="section-head" style="margin-top:20px;">CASCADE LATTICE</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button onclick="runDiagnostic('cascade_graph_stats')">GRAPH STATS</button>
        <button onclick="runDiagnostic('cascade_genesis')">GENESIS</button>
        <button onclick="runDiagnostic('cascade_identity')">IDENTITY</button>
        <button onclick="runDiagnostic('cascade_session_stats')">SESSION STATS</button>
        <button class="btn-dim" onclick="runDiagnostic('cascade_proxy_status')">PROXY STATUS</button>
        <button class="btn-dim" onclick="runDiagnostic('heartbeat')">HEARTBEAT</button>
        <button class="btn-dim" onclick="runDiagnostic('get_about')">ABOUT</button>
    </div>
    <div class="diag-section">
        <div class="diag-title">OUTPUT</div>
        <div class="diag-output" id="diag-output">Run a diagnostic command above.</div>
    </div>
</div>

<!-- ═══════════════ COMMUNITY TAB ═══════════════ -->
<div class="content" id="tab-community">
    <div class="section-head">OUROBOROS COMMUNITY</div>
    <div class="nostr-identity" id="nostr-identity">
        <span class="dot off" id="nostr-dot"></span>
        <span>IDENTITY:</span>
        <span class="npub" id="nostr-npub">Initializing...</span>
        <span class="relay-count" id="nostr-relays">0 relays</span>
        <button class="btn-dim" id="nostr-profile-btn" style="font-size:9px;padding:2px 6px;margin-left:8px;">PROFILE</button>
    </div>
    <div class="nostr-identity" id="github-identity" style="margin-bottom:8px;">
        <span class="dot off" id="gh-dot"></span>
        <span>GITHUB:</span>
        <span class="npub" id="gh-username">Not connected</span>
        <button class="btn-dim" id="gh-auth-btn" style="font-size:9px;padding:2px 6px;margin-left:auto;">CONNECT</button>
    </div>
    <div class="online-bar" id="online-bar">
        <span class="online-dot"></span> <span id="online-count">0</span> online
    </div>
    <!-- SUB-TAB NAVIGATION -->
    <div class="community-toolbar" id="community-tabs">
        <button class="active" data-ctab="chat">CHAT</button>
        <button data-ctab="dms">DMs</button>
        <button data-ctab="marketplace">MARKETPLACE</button>
        <button data-ctab="privacy">PRIVACY</button>
        <button data-ctab="appearance">UX</button>
    </div>

    <!-- ── CHAT SUB-TAB ── -->
    <div class="community-subtab active" id="ctab-chat">
        <div class="community-panel" style="min-height:350px;">
            <div class="community-panel-header">
                <span>LIVE CHAT</span>
                <button class="btn-dim" id="nostr-fetch-chat">REFRESH</button>
            </div>
            <div class="community-feed" id="nostr-chat-feed">
                <div class="community-msg" style="color:var(--text-dim);text-align:center;padding:20px;">
                    Connect to relays to join chat...
                </div>
            </div>
            <div class="redact-warn" id="chat-redact-warn">Sensitive data detected and will be auto-redacted before sending.</div>
            <div class="chat-input-row">
                <input id="nostr-chat-input" placeholder="Type a message..." />
                <button id="nostr-chat-send">SEND</button>
            </div>
        </div>
    </div>

    <!-- ── DMs SUB-TAB ── -->
    <div class="community-subtab" id="ctab-dms" style="display:none;">
        <div class="community-panel" style="min-height:350px;">
            <div class="community-panel-header">
                <span>DIRECT MESSAGES</span>
                <div style="display:flex;gap:4px;">
                    <button class="btn-dim" id="nostr-fetch-dms">REFRESH</button>
                    <button id="nostr-new-dm">NEW DM</button>
                </div>
            </div>
            <div class="dm-conversations" id="dm-conv-list">
                <div style="color:var(--text-dim);text-align:center;padding:12px;font-size:10px;">No conversations yet</div>
            </div>
            <div class="community-feed" id="dm-thread-feed" style="min-height:160px;">
                <div style="color:var(--text-dim);text-align:center;padding:20px;font-size:10px;">Select a conversation or start a new DM</div>
            </div>
            <div class="redact-warn" id="dm-redact-warn">Sensitive data detected and will be auto-redacted before sending.</div>
            <div class="chat-input-row">
                <input id="dm-input" placeholder="Type a private message..." disabled />
                <button id="dm-send" disabled>SEND</button>
            </div>
        </div>
    </div>

    <!-- ── MARKETPLACE SUB-TAB ── -->
    <div class="community-subtab" id="ctab-marketplace" style="display:none;">
        <!-- STATS BAR -->
        <div class="mp-stats" id="mp-stats">
            <div class="mp-stat"><div class="mp-stat-val" id="mp-wf-count">0</div><div class="mp-stat-label">Documents</div></div>
            <div class="mp-stat"><div class="mp-stat-val" id="mp-pub-count">0</div><div class="mp-stat-label">Publishers</div></div>
            <div class="mp-stat"><div class="mp-stat-val" id="mp-cat-count">0</div><div class="mp-stat-label">Categories</div></div>
            <div class="mp-stat"><div class="mp-stat-val" id="mp-node-count">0</div><div class="mp-stat-label">Total Nodes</div></div>
        </div>
        <!-- SEARCH + SORT + ACTIONS -->
        <div class="mp-controls">
            <input id="mp-search" placeholder="Search documents, tags, authors..." />
            <select id="mp-sort">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name-az">Name A-Z</option>
                <option value="name-za">Name Z-A</option>
                <option value="nodes">Most Nodes</option>
                <option value="safety">Safety Score</option>
            </select>
            <button class="btn-dim" id="nostr-fetch-wf">REFRESH</button>
            <button class="btn-dim" id="mp-import-gist-btn">FROM GIST</button>
            <button id="nostr-publish-wf">PUBLISH</button>
        </div>
        <!-- DOC TYPE PILLS -->
        <div class="mp-categories" id="mp-doctype-pills" style="margin-bottom:2px;">
            <button class="mp-cat-pill active" data-mp-dtype="all">ALL</button>
        </div>
        <!-- CATEGORY PILLS -->
        <div class="mp-categories" id="mp-categories">
            <button class="mp-cat-pill active" data-mp-cat="all">ALL</button>
        </div>
        <!-- DOCUMENT FEED (positioned relative for detail overlay) -->
        <div style="position:relative;">
            <div class="community-feed" id="nostr-wf-feed" style="max-height:500px;">
                <div class="mp-empty">Connect to relays to browse documents...</div>
            </div>
            <!-- DETAIL OVERLAY (slides over the feed) -->
            <div class="wf-detail-overlay" id="wf-detail-overlay"></div>
        </div>
    </div>

    <!-- ── APPEARANCE / UX SUB-TAB ── -->
    <div class="community-subtab" id="ctab-appearance" style="display:none;">
        <div class="section-head" style="margin-top:0;">UX PROFILE</div>
        <div class="ux-presets" id="ux-presets">
            <div class="ux-preset-card active" data-ux-preset="commander">
                <div class="ux-preset-icon">&#9878;</div>
                <div class="ux-preset-name">Commander</div>
                <div class="ux-preset-desc">Balanced clarity. Info without noise.</div>
                <span class="ux-security-badge medium">MED SEC</span>
            </div>
            <div class="ux-preset-card" data-ux-preset="operator">
                <div class="ux-preset-icon">&#9881;</div>
                <div class="ux-preset-name">Operator</div>
                <div class="ux-preset-desc">Dense, compact. Every pixel earns its place.</div>
                <span class="ux-security-badge medium">MED SEC</span>
            </div>
            <div class="ux-preset-card" data-ux-preset="observer">
                <div class="ux-preset-icon">&#9737;</div>
                <div class="ux-preset-name">Observer</div>
                <div class="ux-preset-desc">Read-focused, relaxed spacing, large type.</div>
                <span class="ux-security-badge medium">MED SEC</span>
            </div>
            <div class="ux-preset-card" data-ux-preset="stealth">
                <div class="ux-preset-icon">&#128373;</div>
                <div class="ux-preset-name">Stealth</div>
                <div class="ux-preset-desc">Max privacy. No presence, no identity leaks.</div>
                <span class="ux-security-badge high">HIGH SEC</span>
            </div>
            <div class="ux-preset-card" data-ux-preset="accessible">
                <div class="ux-preset-icon">&#9855;</div>
                <div class="ux-preset-name">Accessible</div>
                <div class="ux-preset-desc">High contrast, large text, no motion.</div>
                <span class="ux-security-badge high">HIGH SEC</span>
            </div>
        </div>

        <div class="section-head">FINE-TUNE</div>

        <!-- 1. LAYOUT & DENSITY -->
        <div class="ux-category" data-ux-cat="layout">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Layout &amp; Density</span></div>
                <span class="ux-category-value" id="ux-val-layout">Standard</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Density</label>
                    <select data-ux="density"><option value="compact">Compact</option><option value="standard" selected>Standard</option><option value="spacious">Spacious</option></select>
                </div>
                <div class="ux-control">
                    <label>Spacing</label>
                    <input type="range" min="4" max="24" value="12" data-ux="spacing" /><span class="ux-range-val">12px</span>
                </div>
                <div class="ux-control">
                    <label>Border Radius</label>
                    <input type="range" min="0" max="12" value="0" data-ux="borderRadius" /><span class="ux-range-val">0px</span>
                </div>
                <div class="ux-control">
                    <label>Card Padding</label>
                    <input type="range" min="4" max="20" value="12" data-ux="cardPadding" /><span class="ux-range-val">12px</span>
                </div>
            </div>
        </div>

        <!-- 2. TYPOGRAPHY -->
        <div class="ux-category" data-ux-cat="typography">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Typography</span></div>
                <span class="ux-category-value" id="ux-val-typography">12px</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Base Size</label>
                    <input type="range" min="8" max="18" value="12" data-ux="fontSize" /><span class="ux-range-val">12px</span>
                </div>
                <div class="ux-control">
                    <label>Line Height</label>
                    <input type="range" min="10" max="24" value="15" data-ux="lineHeight" /><span class="ux-range-val">1.5</span>
                </div>
                <div class="ux-control">
                    <label>Header Size</label>
                    <input type="range" min="10" max="20" value="14" data-ux="headerSize" /><span class="ux-range-val">14px</span>
                </div>
                <div class="ux-control">
                    <label>Font</label>
                    <select data-ux="fontFamily"><option value="mono" selected>Monospace</option><option value="sans">Sans-Serif</option><option value="system">System UI</option></select>
                </div>
            </div>
        </div>

        <!-- 3. COLORS & THEME -->
        <div class="ux-category" data-ux-cat="colors">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Colors &amp; Theme</span></div>
                <span class="ux-category-value" id="ux-val-colors">Default</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Accent</label>
                    <input type="color" value="#00ff88" data-ux="accentColor" />
                </div>
                <div class="ux-control">
                    <label>Surface</label>
                    <input type="color" value="#1a1a2e" data-ux="surfaceColor" />
                </div>
                <div class="ux-control">
                    <label>Border</label>
                    <input type="color" value="#2a2a4a" data-ux="borderColor" />
                </div>
                <div class="ux-control">
                    <label>Dim Opacity</label>
                    <input type="range" min="20" max="80" value="55" data-ux="dimOpacity" /><span class="ux-range-val">55%</span>
                </div>
                <div class="ux-control">
                    <label>Contrast</label>
                    <select data-ux="contrast"><option value="normal" selected>Normal</option><option value="high">High</option><option value="ultra">Ultra</option></select>
                </div>
            </div>
        </div>

        <!-- 4. ANIMATION & MOTION -->
        <div class="ux-category" data-ux-cat="motion">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Animation &amp; Motion</span></div>
                <span class="ux-category-value" id="ux-val-motion">Enabled</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Transitions</label>
                    <button class="toggle-switch on" data-ux-toggle="transitions"></button>
                </div>
                <div class="ux-control">
                    <label>Pulse Effects</label>
                    <button class="toggle-switch on" data-ux-toggle="pulseEffects"></button>
                </div>
                <div class="ux-control">
                    <label>Speed</label>
                    <input type="range" min="0" max="500" value="150" step="50" data-ux="transitionSpeed" /><span class="ux-range-val">150ms</span>
                </div>
                <div class="ux-control">
                    <label>Smooth Scroll</label>
                    <button class="toggle-switch on" data-ux-toggle="smoothScroll"></button>
                </div>
            </div>
        </div>

        <!-- 5. INFORMATION DENSITY -->
        <div class="ux-category" data-ux-cat="info">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Information Density</span></div>
                <span class="ux-category-value" id="ux-val-info">Standard</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Card Detail</label>
                    <select data-ux="cardDetail"><option value="minimal">Minimal</option><option value="standard" selected>Standard</option><option value="full">Full</option></select>
                </div>
                <div class="ux-control">
                    <label>Desc Truncate</label>
                    <input type="range" min="40" max="300" value="120" step="20" data-ux="truncateLength" /><span class="ux-range-val">120</span>
                </div>
                <div class="ux-control">
                    <label>Timestamp</label>
                    <select data-ux="timestampFormat"><option value="relative">Relative (2m ago)</option><option value="time" selected>Time Only</option><option value="full">Full DateTime</option></select>
                </div>
                <div class="ux-control">
                    <label>Show Stats Bar</label>
                    <button class="toggle-switch on" data-ux-toggle="showStats"></button>
                </div>
                <div class="ux-control">
                    <label>Compact Messages</label>
                    <button class="toggle-switch" data-ux-toggle="compactMessages"></button>
                </div>
            </div>
        </div>

        <!-- 6. PRIVACY APPEARANCE -->
        <div class="ux-category" data-ux-cat="privappear">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Privacy Appearance</span></div>
                <span class="ux-category-value" id="ux-val-privappear">Standard</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Pubkey Display</label>
                    <select data-ux="pubkeyDisplay"><option value="full">Full (64 chars)</option><option value="short" selected>Short (8...4)</option><option value="hidden">Hidden</option></select>
                </div>
                <div class="ux-control">
                    <label>Online Bar</label>
                    <button class="toggle-switch on" data-ux-toggle="showOnlineBar"></button>
                </div>
                <div class="ux-control">
                    <label>Identity Bar</label>
                    <button class="toggle-switch on" data-ux-toggle="showIdentityBar"></button>
                </div>
                <div class="ux-control">
                    <label>Reaction Buttons</label>
                    <button class="toggle-switch on" data-ux-toggle="showReactions"></button>
                </div>
                <div class="ux-note security">
                    Pubkey visibility affects screenshot safety. "Hidden" prevents accidental doxxing in screen shares or recordings. Stealth preset forces this.
                </div>
            </div>
        </div>

        <!-- 7. NOTIFICATIONS -->
        <div class="ux-category" data-ux-cat="notif">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Notifications</span></div>
                <span class="ux-category-value" id="ux-val-notif">All</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Redaction Warnings</label>
                    <button class="toggle-switch on" data-ux-toggle="showRedactWarn"></button>
                </div>
                <div class="ux-control">
                    <label>Error Display</label>
                    <select data-ux="errorDisplay"><option value="inline" selected>Inline</option><option value="toast">Toast Only</option><option value="silent">Silent (Log Only)</option></select>
                </div>
                <div class="ux-control">
                    <label>Success Feedback</label>
                    <button class="toggle-switch on" data-ux-toggle="showSuccess"></button>
                </div>
            </div>
        </div>

        <!-- 8. ACCESSIBILITY -->
        <div class="ux-category" data-ux-cat="a11y">
            <div class="ux-category-header">
                <div><span class="ux-category-arrow">&#9654;</span><span class="ux-category-title">Accessibility</span></div>
                <span class="ux-category-value" id="ux-val-a11y">Default</span>
            </div>
            <div class="ux-category-body">
                <div class="ux-control">
                    <label>Reduced Motion</label>
                    <button class="toggle-switch" data-ux-toggle="reducedMotion"></button>
                </div>
                <div class="ux-control">
                    <label>High Contrast</label>
                    <button class="toggle-switch" data-ux-toggle="highContrast"></button>
                </div>
                <div class="ux-control">
                    <label>Focus Indicators</label>
                    <button class="toggle-switch on" data-ux-toggle="focusIndicators"></button>
                </div>
                <div class="ux-control">
                    <label>Screen Reader Hints</label>
                    <button class="toggle-switch" data-ux-toggle="ariaHints"></button>
                </div>
                <div class="ux-note">
                    Reduced Motion disables all CSS transitions and animations. High Contrast boosts text/border contrast for low-vision users.
                </div>
            </div>
        </div>

        <div class="ux-reset-row">
            <button class="btn-dim" id="ux-export-btn">EXPORT</button>
            <button class="btn-dim" id="ux-import-btn">IMPORT</button>
            <button class="btn-dim" id="ux-reset-btn">RESET TO DEFAULT</button>
        </div>
    </div>

    <!-- ── PRIVACY SUB-TAB ── -->
    <div class="community-subtab" id="ctab-privacy" style="display:none;">
        <div class="section-head" style="margin-top:0;">PRIVACY &amp; SECURITY SETTINGS</div>
        <div class="privacy-panel" id="privacy-panel">
            <div class="privacy-row">
                <label>Public Chat</label>
                <button class="toggle-switch on" data-privacy="chatEnabled" id="priv-chat"></button>
            </div>
            <div class="privacy-row">
                <label>Direct Messages (Encrypted)</label>
                <button class="toggle-switch on" data-privacy="dmsEnabled" id="priv-dms"></button>
            </div>
            <div class="privacy-row">
                <label>Workflow Marketplace</label>
                <button class="toggle-switch on" data-privacy="marketplaceEnabled" id="priv-marketplace"></button>
            </div>
            <div class="privacy-row">
                <label>Auto-Redact Sensitive Data</label>
                <button class="toggle-switch on" data-privacy="autoRedact" id="priv-redact"></button>
            </div>
            <div class="privacy-row">
                <label>Share Online Presence</label>
                <button class="toggle-switch on" data-privacy="presenceEnabled" id="priv-presence"></button>
            </div>
        </div>
        <div class="section-head" style="margin-top:16px;">BLOCKED USERS</div>
        <div class="block-list" id="block-list">
            <div style="color:var(--text-dim);text-align:center;padding:8px;font-size:10px;">No blocked users</div>
        </div>
        <div class="section-head" style="margin-top:16px;">LIGHTNING ADDRESS (RECEIVE ZAPS)</div>
        <div style="border:1px solid var(--border);padding:12px;">
            <div class="field" style="margin:0;">
                <label style="font-size:9px;">Your Lightning Address (lud16)</label>
                <div style="display:flex;gap:6px;">
                    <input id="lud16-input" placeholder="you@getalby.com" style="flex:1;" />
                    <button class="btn-dim" id="lud16-save">SAVE</button>
                    <button class="btn-dim" id="lud16-test">TEST</button>
                </div>
                <div id="lud16-status" style="font-size:8px;color:var(--text-dim);margin-top:4px;"></div>
            </div>
            <details style="margin-top:8px;">
                <summary style="font-size:9px;color:var(--accent);cursor:pointer;">How to get a Lightning address</summary>
                <div style="font-size:9px;color:var(--text-dim);padding:6px 0;line-height:1.6;">
                    A Lightning address looks like an email (you@wallet.com) and lets anyone send you Bitcoin via the Lightning Network.<br><br>
                    <strong>Free providers:</strong><br>
                    &bull; <strong>Alby</strong> &mdash; getalby.com (browser extension + address)<br>
                    &bull; <strong>Wallet of Satoshi</strong> &mdash; walletofsatoshi.com (mobile)<br>
                    &bull; <strong>Zeus</strong> &mdash; zeusln.com (self-custodial mobile)<br>
                    &bull; <strong>Stacker News</strong> &mdash; stacker.news (earn + receive)<br><br>
                    Once you have an address, paste it above and hit SAVE. It will be included in your Nostr profile so others can zap your marketplace listings.
                </div>
            </details>
        </div>
        <div class="section-head" style="margin-top:16px;">AUTO-REDACTION INFO</div>
        <div style="border:1px solid var(--border);padding:12px;font-size:10px;color:var(--text-dim);line-height:1.5;">
            When enabled, the following are automatically scrubbed before any message leaves your machine:<br>
            API keys &middot; AWS credentials &middot; GitHub/GitLab tokens &middot; Private keys (Nostr/crypto) &middot;
            Bearer tokens &middot; Passwords &middot; Email addresses &middot; IP addresses &middot; SSNs &middot;
            Credit card numbers &middot; File paths with usernames &middot; Connection strings &middot; Phone numbers &middot;
            Environment variables (OPENAI_API_KEY, etc.)<br><br>
            <span style="color:var(--amber);">This runs on ALL outbound messages (chat, DMs, workflow descriptions).</span>
        </div>
    </div>
</div>
<!-- Context menu (dynamically positioned) -->
<div class="ctx-menu" id="ctx-menu" style="display:none;"></div>

<!-- ═══════════════ PUBLISH DOCUMENT MODAL ═══════════════ -->
<div class="modal-overlay" id="publish-wf-modal">
    <div class="modal" style="width:600px;">
        <div class="modal-title">PUBLISH TO MARKETPLACE</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
            <div class="field">
                <label>Document Type</label>
                <select id="pub-wf-doctype">
                    <option value="workflow">Workflow</option>
                    <option value="skill">Skill</option>
                    <option value="playbook">Playbook</option>
                    <option value="recipe">Recipe</option>
                </select>
            </div>
            <div class="field">
                <label>Name</label>
                <input id="pub-wf-name" placeholder="My Awesome Document" />
            </div>
            <div class="field">
                <label>Category</label>
                <select id="pub-wf-category">
                    <option value="">Select category...</option>
                    <option value="devops">DevOps &amp; CI/CD</option>
                    <option value="data-eng">Data Engineering &amp; ETL</option>
                    <option value="ml-ai">ML / AI Pipelines</option>
                    <option value="security">Security &amp; Compliance</option>
                    <option value="code-analysis">Code Analysis &amp; Review</option>
                    <option value="testing">Testing &amp; QA</option>
                    <option value="docs">Documentation</option>
                    <option value="infra">Infrastructure &amp; Cloud</option>
                    <option value="monitoring">Monitoring &amp; Observability</option>
                    <option value="api">API Integration</option>
                    <option value="database">Database Operations</option>
                    <option value="content">Content Generation</option>
                    <option value="research">Research &amp; Analysis</option>
                    <option value="finance">Financial Operations</option>
                    <option value="healthcare">Healthcare &amp; Biotech</option>
                    <option value="iot">IoT &amp; Edge Computing</option>
                    <option value="legal">Legal &amp; Compliance</option>
                    <option value="automation">General Automation</option>
                    <option value="council">Council &amp; Multi-Agent</option>
                    <option value="memory">Memory &amp; Knowledge</option>
                    <option value="other">Other</option>
                </select>
            </div>
        </div>
        <div class="field">
            <label>Description</label>
            <input id="pub-wf-desc" placeholder="What does this workflow do? Be detailed." />
        </div>
        <div class="field">
            <label id="pub-wf-body-label">Content (Workflow JSON / Skill markdown / Playbook steps)</label>
            <textarea id="pub-wf-json" placeholder='Paste your document content here...' style="font-size:9px;min-height:80px;resize:vertical;font-family:monospace;" rows="4"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
            <div class="field">
                <label>Version</label>
                <input id="pub-wf-version" placeholder="1.0.0" value="1.0.0" />
            </div>
            <div class="field">
                <label>Complexity</label>
                <select id="pub-wf-complexity">
                    <option value="simple">Simple (1-3 nodes)</option>
                    <option value="moderate" selected>Moderate (4-8 nodes)</option>
                    <option value="complex">Complex (9-15 nodes)</option>
                    <option value="advanced">Advanced (16+ nodes)</option>
                </select>
            </div>
            <div class="field">
                <label>Est. Run Time</label>
                <select id="pub-wf-time">
                    <option value="instant">Instant (&lt;1s)</option>
                    <option value="fast" selected>Fast (1-10s)</option>
                    <option value="moderate">Moderate (10-60s)</option>
                    <option value="long">Long (1-5min)</option>
                    <option value="extended">Extended (5min+)</option>
                </select>
            </div>
        </div>
        <div class="field">
            <label>Tags (comma-separated)</label>
            <input id="pub-wf-tags" placeholder="embedding, search, automation, gpu, batch" />
        </div>
        <div style="border:1px solid var(--border);padding:8px 12px;margin-top:8px;display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="pub-wf-gist" checked />
            <label for="pub-wf-gist" style="font-size:10px;color:var(--text);">Back with GitHub Gist (versioned, forkable)</label>
            <span id="pub-wf-gist-status" style="font-size:9px;color:var(--text-dim);margin-left:auto;"></span>
        </div>
        <div class="modal-actions">
            <button onclick="doPublishWorkflow()">PUBLISH TO MARKETPLACE</button>
            <button class="btn-dim" onclick="closeModals()">CANCEL</button>
        </div>
    </div>
</div>

<!-- ═══════════════ IMPORT FROM GIST MODAL ═══════════════ -->
<div class="modal-overlay" id="import-gist-modal">
    <div class="modal">
        <div class="modal-title">IMPORT FROM GITHUB GIST</div>
        <div class="field">
            <label>Gist URL or ID</label>
            <input id="import-gist-url" placeholder="https://gist.github.com/user/abc123... or just the ID" />
        </div>
        <div class="modal-actions">
            <button id="import-gist-btn">IMPORT</button>
            <button class="btn-dim" onclick="closeModals()">CANCEL</button>
        </div>
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
