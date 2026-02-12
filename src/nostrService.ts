import * as vscode from 'vscode';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import * as secp256k1 from '@noble/secp256k1';

// ══════════════════════════════════════════════════════════════
// NostrService — Secure Nostr relay client for VS Code extension
// Private key stored in SecretStorage (OS keychain), never exposed
// ══════════════════════════════════════════════════════════════

const SECRET_KEY_ID = 'champion.nostr.privateKey';
const OUROBOROS_WORKFLOW_KIND = 30078; // Parameterized replaceable event for app-specific data
const CHAT_KIND = 1; // Short text note
const REACTION_KIND = 7; // Reaction

export interface NostrEvent {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
}

export interface NostrFilter {
    kinds?: number[];
    authors?: string[];
    '#t'?: string[];
    since?: number;
    limit?: number;
}

type NostrEventCallback = (event: NostrEvent) => void;

export class NostrService {
    private secretStorage: vscode.SecretStorage;
    private privateKey: Uint8Array | null = null;
    private publicKey: string = '';
    private relays: Map<string, WebSocket> = new Map();
    private subscriptions: Map<string, NostrEventCallback> = new Map();
    private eventCallbacks: NostrEventCallback[] = [];
    private _onEvent = new vscode.EventEmitter<NostrEvent>();
    public readonly onEvent = this._onEvent.event;
    private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    // ── KEY MANAGEMENT (SecretStorage only) ──────────────────

    async init(): Promise<string> {
        let hexKey = await this.secretStorage.get(SECRET_KEY_ID);

        if (!hexKey) {
            // Generate new keypair
            const sk = secp256k1.utils.randomSecretKey();
            this.privateKey = sk;
            hexKey = Buffer.from(sk).toString('hex');
            await this.secretStorage.store(SECRET_KEY_ID, hexKey);
        } else {
            this.privateKey = Uint8Array.from(Buffer.from(hexKey, 'hex'));
        }

        const pubBytes = secp256k1.getPublicKey(this.privateKey, true).slice(1);
        this.publicKey = Buffer.from(pubBytes).toString('hex');
        return this.publicKey;
    }

    getPublicKey(): string {
        return this.publicKey;
    }

    getNpub(): string {
        // Simplified bech32 display — first 8 + last 8 chars
        return this.publicKey ? `npub:${this.publicKey.slice(0, 8)}...${this.publicKey.slice(-8)}` : '';
    }

    // ── RELAY CONNECTION ─────────────────────────────────────

    async connectToRelays(relayUrls: string[]): Promise<void> {
        for (const url of relayUrls) {
            if (this.relays.has(url)) { continue; }
            this.connectRelay(url);
        }
    }

    private connectRelay(url: string): void {
        try {
            const ws = new WebSocket(url);

            ws.on('open', () => {
                console.log(`[Nostr] Connected to ${url}`);
                this.relays.set(url, ws);
                // Re-subscribe on reconnect
                for (const [subId, _cb] of this.subscriptions) {
                    this.sendToRelay(ws, JSON.stringify([
                        'REQ', subId,
                        { kinds: [OUROBOROS_WORKFLOW_KIND, CHAT_KIND], '#t': ['ouroboros'], limit: 50 }
                    ]));
                }
            });

            ws.on('message', (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg[0] === 'EVENT' && msg[2]) {
                        const event = msg[2] as NostrEvent;
                        this._onEvent.fire(event);
                        for (const cb of this.eventCallbacks) {
                            cb(event);
                        }
                    }
                } catch { /* ignore malformed */ }
            });

            ws.on('close', () => {
                console.log(`[Nostr] Disconnected from ${url}`);
                this.relays.delete(url);
                // Reconnect after 5s
                const timer = setTimeout(() => this.connectRelay(url), 5000);
                this.reconnectTimers.set(url, timer);
            });

            ws.on('error', (err) => {
                console.error(`[Nostr] Relay error ${url}:`, err.message);
            });
        } catch (err) {
            console.error(`[Nostr] Failed to connect to ${url}`);
        }
    }

    private sendToRelay(ws: WebSocket, data: string): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }

    // ── SUBSCRIBE ────────────────────────────────────────────

    subscribe(filter: NostrFilter, callback: NostrEventCallback): string {
        const subId = 'sub_' + Math.random().toString(36).slice(2, 10);
        this.subscriptions.set(subId, callback);
        this.eventCallbacks.push(callback);

        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, JSON.stringify(['REQ', subId, filter]));
        }

        return subId;
    }

    unsubscribe(subId: string): void {
        this.subscriptions.delete(subId);
        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, JSON.stringify(['CLOSE', subId]));
        }
    }

    // ── EVENT CREATION & SIGNING ─────────────────────────────

    private async signEvent(event: Omit<NostrEvent, 'id' | 'sig'>): Promise<NostrEvent> {
        if (!this.privateKey) { throw new Error('Nostr not initialized'); }

        // Compute event ID (SHA256 of serialized event)
        const serialized = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]);
        const hash = crypto.createHash('sha256').update(serialized).digest();
        const id = hash.toString('hex');

        // Sign with schnorr
        const sigBytes = await secp256k1.schnorr.sign(new Uint8Array(hash), this.privateKey);
        const sig = Buffer.from(sigBytes).toString('hex');

        return { ...event, id, sig };
    }

    // ── PUBLISH WORKFLOW ──────────────────────────────────────

    async publishWorkflow(name: string, description: string, workflowJson: string, tags: string[]): Promise<NostrEvent> {
        const nostrTags: string[][] = [
            ['t', 'ouroboros'],
            ['t', 'ouroboros-workflow'],
            ['d', name.toLowerCase().replace(/\s+/g, '-')], // NIP-33 identifier
            ['title', name],
            ['summary', description],
            ...tags.map(t => ['t', t])
        ];

        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: OUROBOROS_WORKFLOW_KIND,
            tags: nostrTags,
            content: JSON.stringify({
                name,
                description,
                workflow: workflowJson,
                version: '1.0.0',
                tool_count: 140
            })
        });

        await this.broadcast(event);
        return event;
    }

    // ── PUBLISH CHAT MESSAGE ─────────────────────────────────

    async publishChat(message: string): Promise<NostrEvent> {
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: CHAT_KIND,
            tags: [
                ['t', 'ouroboros'],
                ['t', 'ouroboros-chat']
            ],
            content: message
        });

        await this.broadcast(event);
        return event;
    }

    // ── REACT TO EVENT ───────────────────────────────────────

    async reactToEvent(eventId: string, eventPubkey: string, reaction: string = '+'): Promise<NostrEvent> {
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: REACTION_KIND,
            tags: [
                ['e', eventId],
                ['p', eventPubkey]
            ],
            content: reaction
        });

        await this.broadcast(event);
        return event;
    }

    // ── BROADCAST TO ALL RELAYS ──────────────────────────────

    private async broadcast(event: NostrEvent): Promise<void> {
        const msg = JSON.stringify(['EVENT', event]);
        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, msg);
        }
    }

    // ── FETCH WORKFLOWS ──────────────────────────────────────

    fetchWorkflows(): void {
        const filter: NostrFilter = {
            kinds: [OUROBOROS_WORKFLOW_KIND],
            '#t': ['ouroboros-workflow'],
            limit: 50
        };

        for (const [_url, ws] of this.relays) {
            const subId = 'wf_' + Math.random().toString(36).slice(2, 8);
            this.sendToRelay(ws, JSON.stringify(['REQ', subId, filter]));
        }
    }

    // ── FETCH CHAT ───────────────────────────────────────────

    fetchChat(since?: number): void {
        const filter: NostrFilter = {
            kinds: [CHAT_KIND],
            '#t': ['ouroboros-chat'],
            limit: 100,
            ...(since ? { since } : {})
        };

        for (const [_url, ws] of this.relays) {
            const subId = 'chat_' + Math.random().toString(36).slice(2, 8);
            this.sendToRelay(ws, JSON.stringify(['REQ', subId, filter]));
        }
    }

    // ── CLEANUP ──────────────────────────────────────────────

    dispose(): void {
        for (const [_url, ws] of this.relays) {
            ws.close();
        }
        this.relays.clear();
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();
        this._onEvent.dispose();
    }

    get connected(): boolean {
        return this.relays.size > 0;
    }

    get relayCount(): number {
        return this.relays.size;
    }

    getConnectedRelays(): string[] {
        return Array.from(this.relays.keys());
    }
}
