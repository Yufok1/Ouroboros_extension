// ══════════════════════════════════════════════════════════════════════════════
// IPFS Pinning Service Integration
// Pins CIDs computed by web3.ts to remote pinning services for persistence.
// Supports Pinata and web3.storage (Storacha) via their HTTP APIs.
//
// CIDs are computed locally (free, instant). Pinning is optional and requires
// an API key from the chosen provider. Without pinning, CIDs are still valid
// content-addressed identifiers — they just aren't guaranteed to be available
// on the IPFS network.
// ══════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

// ── Interfaces ──────────────────────────────────────────────────────────────

export type PinningProvider = 'pinata' | 'web3storage' | 'none';

export interface PinningConfig {
    provider: PinningProvider;
    apiKey: string;              // JWT or API key
    gateway?: string;            // custom gateway URL
}

export interface PinResult {
    success: boolean;
    cid: string;
    provider: PinningProvider;
    gatewayUrl: string;
    timestamp: number;
    size?: number;
    error?: string;
}

export interface PinInfo {
    cid: string;
    name: string;
    provider: PinningProvider;
    pinned: boolean;
    gatewayUrl: string;
    pinnedAt: number;
    size?: number;
}

export interface PinningStats {
    provider: PinningProvider;
    totalPinned: number;
    totalSize: number;
    lastPinned: number;
    configured: boolean;
}

// ── Default gateways ────────────────────────────────────────────────────────

const GATEWAYS: Record<PinningProvider, string> = {
    pinata: 'https://gateway.pinata.cloud/ipfs/',
    web3storage: 'https://w3s.link/ipfs/',
    none: ''
};

// ── IPFSPinningService ──────────────────────────────────────────────────────

export class IPFSPinningService {
    private config: PinningConfig;
    private pinCache: Map<string, PinInfo> = new Map();
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.config = this.loadConfig();
        this.loadCache();
    }

    // ── Configuration ───────────────────────────────────────────────────

    private loadConfig(): PinningConfig {
        const cfg = vscode.workspace.getConfiguration('champion');
        return {
            provider: cfg.get<PinningProvider>('ipfs.provider', 'none'),
            apiKey: cfg.get<string>('ipfs.apiKey', ''),
            gateway: cfg.get<string>('ipfs.gateway', '')
        };
    }

    reloadConfig(): void {
        this.config = this.loadConfig();
    }

    get isConfigured(): boolean {
        return this.config.provider !== 'none' && this.config.apiKey.length > 0;
    }

    get provider(): PinningProvider {
        return this.config.provider;
    }

    // ── Cache persistence ───────────────────────────────────────────────

    private loadCache(): void {
        const saved = this.context.globalState.get<[string, PinInfo][]>('champion.ipfs.pinCache');
        if (saved && Array.isArray(saved)) {
            this.pinCache = new Map(saved);
        }
    }

    private static readonly MAX_PIN_CACHE = 500;

    private saveCache(): void {
        // Trim oldest pins if cache exceeds limit (marathon session hardening)
        if (this.pinCache.size > IPFSPinningService.MAX_PIN_CACHE) {
            const entries = [...this.pinCache.entries()]
                .sort((a, b) => new Date(a[1].pinnedAt).getTime() - new Date(b[1].pinnedAt).getTime());
            this.pinCache = new Map(entries.slice(entries.length - IPFSPinningService.MAX_PIN_CACHE));
        }
        this.context.globalState.update('champion.ipfs.pinCache', [...this.pinCache.entries()]);
    }

    // ── Pin content ─────────────────────────────────────────────────────

    async pin(cid: string, content: string | Buffer, name?: string): Promise<PinResult> {
        if (!this.isConfigured) {
            return {
                success: false, cid, provider: 'none',
                gatewayUrl: '', timestamp: Date.now(),
                error: 'No pinning provider configured'
            };
        }

        const contentBuf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
        const pinName = name || `ouroboros-${cid.slice(0, 16)}`;

        try {
            let result: PinResult;

            switch (this.config.provider) {
                case 'pinata':
                    result = await this.pinToPinata(cid, contentBuf, pinName);
                    break;
                case 'web3storage':
                    result = await this.pinToWeb3Storage(cid, contentBuf, pinName);
                    break;
                default:
                    return {
                        success: false, cid, provider: this.config.provider,
                        gatewayUrl: '', timestamp: Date.now(),
                        error: `Unknown provider: ${this.config.provider}`
                    };
            }

            if (result.success) {
                this.pinCache.set(cid, {
                    cid,
                    name: pinName,
                    provider: this.config.provider,
                    pinned: true,
                    gatewayUrl: result.gatewayUrl,
                    pinnedAt: Date.now(),
                    size: contentBuf.length
                });
                this.saveCache();
            }

            return result;
        } catch (error: any) {
            return {
                success: false, cid, provider: this.config.provider,
                gatewayUrl: '', timestamp: Date.now(),
                error: error.message || 'Unknown error'
            };
        }
    }

    // ── Pinata API ──────────────────────────────────────────────────────

    private pinToPinata(cid: string, content: Buffer, name: string): Promise<PinResult> {
        const gateway = this.config.gateway || GATEWAYS.pinata;

        // Pinata: POST /pinning/pinFileToIPFS (multipart)
        const boundary = `----OuroborosBoundary${Date.now()}`;
        const header = [
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="${name}"`,
            'Content-Type: application/octet-stream',
            ''
        ].join('\r\n');
        const metaPart = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="pinataMetadata"',
            'Content-Type: application/json',
            '',
            JSON.stringify({ name, keyvalues: { source: 'ouroboros', expectedCID: cid } })
        ].join('\r\n');
        const footer = `\r\n--${boundary}--\r\n`;

        const body = Buffer.concat([
            Buffer.from(header + '\r\n'),
            content,
            Buffer.from('\r\n' + metaPart + '\r\n' + footer)
        ]);

        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.pinata.cloud',
                path: '/pinning/pinFileToIPFS',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode === 200 && json.IpfsHash) {
                            resolve({
                                success: true,
                                cid: json.IpfsHash,
                                provider: 'pinata',
                                gatewayUrl: `${gateway}${json.IpfsHash}`,
                                timestamp: Date.now(),
                                size: json.PinSize
                            });
                        } else {
                            resolve({
                                success: false, cid, provider: 'pinata',
                                gatewayUrl: '', timestamp: Date.now(),
                                error: json.error?.details || json.message || `HTTP ${res.statusCode}`
                            });
                        }
                    } catch {
                        resolve({
                            success: false, cid, provider: 'pinata',
                            gatewayUrl: '', timestamp: Date.now(),
                            error: `Invalid response: ${data.slice(0, 200)}`
                        });
                    }
                });
            });
            req.on('error', (e) => {
                resolve({
                    success: false, cid, provider: 'pinata',
                    gatewayUrl: '', timestamp: Date.now(),
                    error: e.message
                });
            });
            req.write(body);
            req.end();
        });
    }

    // ── web3.storage (Storacha) API ─────────────────────────────────────

    private pinToWeb3Storage(cid: string, content: Buffer, name: string): Promise<PinResult> {
        const gateway = this.config.gateway || GATEWAYS.web3storage;

        // web3.storage: POST /upload with Bearer token
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.web3.storage',
                path: '/upload',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/octet-stream',
                    'X-Name': name,
                    'Content-Length': content.length
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode === 200 && json.cid) {
                            resolve({
                                success: true,
                                cid: json.cid,
                                provider: 'web3storage',
                                gatewayUrl: `${gateway}${json.cid}`,
                                timestamp: Date.now(),
                                size: content.length
                            });
                        } else {
                            resolve({
                                success: false, cid, provider: 'web3storage',
                                gatewayUrl: '', timestamp: Date.now(),
                                error: json.message || `HTTP ${res.statusCode}`
                            });
                        }
                    } catch {
                        resolve({
                            success: false, cid, provider: 'web3storage',
                            gatewayUrl: '', timestamp: Date.now(),
                            error: `Invalid response: ${data.slice(0, 200)}`
                        });
                    }
                });
            });
            req.on('error', (e) => {
                resolve({
                    success: false, cid, provider: 'web3storage',
                    gatewayUrl: '', timestamp: Date.now(),
                    error: e.message
                });
            });
            req.write(content);
            req.end();
        });
    }

    // ── Check if pinned ─────────────────────────────────────────────────

    isPinned(cid: string): boolean {
        return this.pinCache.has(cid) && (this.pinCache.get(cid)?.pinned === true);
    }

    // ── Get gateway URL ─────────────────────────────────────────────────

    getGatewayUrl(cid: string): string {
        const cached = this.pinCache.get(cid);
        if (cached) { return cached.gatewayUrl; }
        const gateway = this.config.gateway || GATEWAYS[this.config.provider] || GATEWAYS.web3storage;
        return `${gateway}${cid}`;
    }

    // ── List cached pins ────────────────────────────────────────────────

    listPins(limit: number = 100): PinInfo[] {
        return [...this.pinCache.values()]
            .sort((a, b) => b.pinnedAt - a.pinnedAt)
            .slice(0, limit);
    }

    // ── Stats ───────────────────────────────────────────────────────────

    getStats(): PinningStats {
        const pins = [...this.pinCache.values()];
        return {
            provider: this.config.provider,
            totalPinned: pins.filter(p => p.pinned).length,
            totalSize: pins.reduce((s, p) => s + (p.size || 0), 0),
            lastPinned: pins.length > 0 ? Math.max(...pins.map(p => p.pinnedAt)) : 0,
            configured: this.isConfigured
        };
    }

    // ── Clear cache ─────────────────────────────────────────────────────

    clearCache(): void {
        this.pinCache.clear();
        this.saveCache();
    }
}
