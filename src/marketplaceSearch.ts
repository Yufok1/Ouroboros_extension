// ══════════════════════════════════════════════════════════════════════════════
// Semantic Marketplace Search
// Embeds marketplace items using MCP embed_text, stores embeddings locally,
// and searches by meaning rather than tags. Ranks results by combining
// semantic relevance with publisher reputation.
//
// Falls back to tag-based substring search if MCP server is unavailable.
// ══════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import type { MCPServerManager } from './mcpServer';
import type { GistSearchResult } from './githubService';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MarketplaceItem {
    eventId: string;
    pubkey: string;
    name: string;
    description: string;
    docType: string;
    tags: string[];
    category: string;
    body: string;
    bodyFormat: string;
    version?: string;
    contentCID?: string;
    createdAt: number;
    embedding?: number[];       // computed lazily
    source?: 'nostr' | 'gist' | 'local';
}

export interface RankedResult {
    item: MarketplaceItem;
    relevance: number;          // 0-1, semantic similarity
    reputationScore: number;    // 0-1, publisher reputation normalized
    combinedScore: number;      // weighted blend
    matchType: 'semantic' | 'tag' | 'hybrid';
}

export interface IndexStats {
    totalItems: number;
    embeddedItems: number;
    docTypes: Record<string, number>;
    lastIndexed: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
    relevance: 0.7,
    reputation: 0.3
};

const MAX_INDEX_SIZE = 2000;     // cap to prevent unbounded memory growth
const EMBEDDING_BATCH_SIZE = 5;  // embed N items at a time

// ── MarketplaceIndex ────────────────────────────────────────────────────────

export class MarketplaceIndex {
    private items: Map<string, MarketplaceItem> = new Map();
    private mcp: MCPServerManager;
    private context: vscode.ExtensionContext;
    private reputationFn: (pubkey: string) => number;

    constructor(
        mcpManager: MCPServerManager,
        context: vscode.ExtensionContext,
        reputationFn: (pubkey: string) => number = () => 0
    ) {
        this.mcp = mcpManager;
        this.context = context;
        this.reputationFn = reputationFn;
        this.load();
    }

    // ── Persistence ─────────────────────────────────────────────────────

    private load(): void {
        const saved = this.context.globalState.get<[string, MarketplaceItem][]>('champion.marketplace.index');
        if (saved && Array.isArray(saved)) {
            this.items = new Map(saved);
        }
    }

    private save(): void {
        // Trim oldest if over limit
        if (this.items.size > MAX_INDEX_SIZE) {
            const sorted = [...this.items.entries()]
                .sort((a, b) => a[1].createdAt - b[1].createdAt);
            const toRemove = sorted.slice(0, this.items.size - MAX_INDEX_SIZE);
            for (const [key] of toRemove) {
                this.items.delete(key);
            }
        }
        // Strip embeddings before persisting to globalState (saves ~6MB)
        const stripped = [...this.items.entries()].map(([k, v]) => {
            const { embedding, ...rest } = v;
            return [k, rest] as [string, MarketplaceItem];
        });
        this.context.globalState.update('champion.marketplace.index', stripped);
    }

    // ── Index a document from Nostr ─────────────────────────────────────

    indexDocument(
        eventId: string,
        pubkey: string,
        name: string,
        description: string,
        body: string,
        docType: string,
        tags: string[],
        category: string,
        bodyFormat: string,
        version?: string,
        contentCID?: string,
        createdAt?: number
    ): void {
        const item: MarketplaceItem = {
            eventId,
            pubkey,
            name,
            description,
            docType,
            tags,
            category,
            body,
            bodyFormat,
            version,
            contentCID,
            createdAt: createdAt || Date.now()
        };
        this.items.set(eventId, item);
        this.save();
    }

    // ── Remove a document ───────────────────────────────────────────────

    removeDocument(eventId: string): boolean {
        const removed = this.items.delete(eventId);
        if (removed) { this.save(); }
        return removed;
    }

    // ── Compute embeddings for unembedded items ─────────────────────────

    async embedPending(): Promise<number> {
        const pending = [...this.items.values()].filter(item => !item.embedding);
        if (pending.length === 0) { return 0; }

        let embedded = 0;
        for (let i = 0; i < pending.length; i += EMBEDDING_BATCH_SIZE) {
            const batch = pending.slice(i, i + EMBEDDING_BATCH_SIZE);
            for (const item of batch) {
                try {
                    const text = `${item.name} ${item.description} ${item.tags.join(' ')}`;
                    const result = await this.mcp.callToolParsed('embed_text', { text }, {
                        suppressActivity: true,
                        source: 'internal'
                    });
                    if (result && result.embedding) {
                        item.embedding = result.embedding;
                        this.items.set(item.eventId, item);
                        embedded++;
                    }
                } catch {
                    // MCP unavailable — skip embedding, use tag fallback
                    break;
                }
            }
        }

        if (embedded > 0) { this.save(); }
        return embedded;
    }

    // ── Semantic search ─────────────────────────────────────────────────

    async search(query: string, limit: number = 20): Promise<RankedResult[]> {
        if (this.items.size === 0) { return []; }

        // Try semantic search first
        let queryEmbedding: number[] | null = null;
        try {
            const result = await this.mcp.callToolParsed('embed_text', { text: query }, {
                suppressActivity: true,
                source: 'internal'
            });
            if (result && result.embedding) {
                queryEmbedding = result.embedding;
            }
        } catch {
            // MCP unavailable — fall through to tag search
        }

        const results: RankedResult[] = [];

        for (const item of this.items.values()) {
            let relevance = 0;
            let matchType: 'semantic' | 'tag' | 'hybrid' = 'tag';

            // Semantic similarity (if embeddings available)
            if (queryEmbedding && item.embedding) {
                relevance = cosineSimilarity(queryEmbedding, item.embedding);
                matchType = 'semantic';
            }

            // Tag/text fallback or hybrid boost
            const tagScore = tagMatch(query, item);
            if (matchType === 'semantic' && tagScore > 0) {
                relevance = relevance * 0.8 + tagScore * 0.2;
                matchType = 'hybrid';
            } else if (matchType === 'tag') {
                relevance = tagScore;
            }

            if (relevance <= 0) { continue; }

            const reputationScore = normalizeReputation(this.reputationFn(item.pubkey));
            const combinedScore =
                relevance * DEFAULT_WEIGHTS.relevance +
                reputationScore * DEFAULT_WEIGHTS.reputation;

            results.push({ item, relevance, reputationScore, combinedScore, matchType });
        }

        // Sort by combined score, descending
        results.sort((a, b) => b.combinedScore - a.combinedScore);
        return results.slice(0, limit);
    }

    // ── Rerank results using MCP reranker ───────────────────────────────

    async rerank(query: string, results: RankedResult[]): Promise<RankedResult[]> {
        if (results.length <= 1) { return results; }

        try {
            const documents = results.map(r =>
                `${r.item.name}: ${r.item.description}`
            );
            const reranked = await this.mcp.callToolParsed('rerank', {
                query,
                documents
            }, { suppressActivity: true, source: 'internal' });

            if (reranked && reranked.ranked && Array.isArray(reranked.ranked)) {
                const reorderedResults: RankedResult[] = [];
                for (const entry of reranked.ranked) {
                    const idx = entry.doc_idx ?? entry.index;
                    if (idx >= 0 && idx < results.length) {
                        const original = results[idx];
                        reorderedResults.push({
                            ...original,
                            relevance: entry.score ?? original.relevance,
                            combinedScore: (entry.score ?? original.relevance) * DEFAULT_WEIGHTS.relevance +
                                           original.reputationScore * DEFAULT_WEIGHTS.reputation
                        });
                    }
                }
                return reorderedResults;
            }
        } catch {
            // Reranker unavailable — return original order
        }

        return results;
    }

    // ── Stats ───────────────────────────────────────────────────────────

    getStats(): IndexStats {
        const docTypes: Record<string, number> = {};
        let embeddedCount = 0;
        let lastIndexed = 0;

        for (const item of this.items.values()) {
            docTypes[item.docType] = (docTypes[item.docType] || 0) + 1;
            if (item.embedding) { embeddedCount++; }
            if (item.createdAt > lastIndexed) { lastIndexed = item.createdAt; }
        }

        return {
            totalItems: this.items.size,
            embeddedItems: embeddedCount,
            docTypes,
            lastIndexed
        };
    }

    // ── Get all items (for UI listing) ──────────────────────────────────

    getAllItems(): MarketplaceItem[] {
        return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    getItem(eventId: string): MarketplaceItem | undefined {
        return this.items.get(eventId);
    }

    // ── Clear ───────────────────────────────────────────────────────────

    clear(): void {
        this.items.clear();
        this.save();
    }

    hasItem(eventId: string): boolean {
        return this.items.has(eventId);
    }
}

// ── Gist → MarketplaceItem Normalizer ────────────────────────────────────────

const GIST_DOCTYPE_MAP: Record<string, string> = {
    'sol': 'smartcontract',
    'vy': 'smartcontract',
    'py': 'skill',
    'js': 'skill',
    'ts': 'skill',
    'toml': 'testnet-config',
    'yaml': 'testnet-config',
    'yml': 'testnet-config',
};

const DOCTYPE_CATEGORY_MAP: Record<string, string> = {
    smartcontract: 'security',
    skill: 'automation',
    workflow: 'automation',
    recipe: 'api',
    playbook: 'devops',
    'testnet-config': 'infra',
    'dapp-template': 'infra',
    'audit-report': 'security',
    'chain-recipe': 'api',
};

function detectDocTypeFromFiles(files: Record<string, any>): { docType: string; language: string } {
    const fileNames = Object.keys(files);
    for (const fname of fileNames) {
        const lower = fname.toLowerCase();
        // Check for explicit workflow JSON
        if (lower.endsWith('.workflow.json') || lower.includes('workflow')) {
            return { docType: 'workflow', language: 'json' };
        }
        // Extension-based detection
        const ext = lower.split('.').pop() || '';
        if (GIST_DOCTYPE_MAP[ext]) {
            const lang = files[fname]?.language || ext;
            return { docType: GIST_DOCTYPE_MAP[ext], language: String(lang).toLowerCase() };
        }
    }
    // Check file languages
    for (const f of Object.values(files)) {
        const lang = String((f as any)?.language || '').toLowerCase();
        if (lang === 'solidity') { return { docType: 'smartcontract', language: 'solidity' }; }
        if (lang === 'python') { return { docType: 'skill', language: 'python' }; }
        if (lang === 'javascript' || lang === 'typescript') { return { docType: 'skill', language: lang }; }
    }
    return { docType: 'recipe', language: 'text' };
}

export function normalizeGistToMarketplaceItem(gist: GistSearchResult): MarketplaceItem {
    const { docType, language } = detectDocTypeFromFiles(gist.files);
    const firstFile = Object.values(gist.files)[0];
    const name = gist.description || (firstFile?.filename) || 'Untitled Gist';

    // Build tags from language and docType
    const tags: string[] = ['gist'];
    if (language && language !== 'text') { tags.push(language); }
    if (docType) { tags.push(docType); }

    // Get body from first file (truncated for embedding)
    const body = ''; // Content fetched on-demand, not during indexing

    return {
        eventId: `gist:${gist.id}`,
        pubkey: gist.owner ? `github:${gist.owner.login}` : 'github:anonymous',
        name: name.slice(0, 200),
        description: gist.description || '',
        docType,
        tags,
        category: DOCTYPE_CATEGORY_MAP[docType] || 'other',
        body,
        bodyFormat: language === 'json' ? 'json' : 'text',
        version: '1.0.0',
        createdAt: gist.created_at ? new Date(gist.created_at).getTime() : Date.now(),
        source: 'gist'
    };
}

export async function indexGistBatch(
    gists: GistSearchResult[],
    index: MarketplaceIndex
): Promise<number> {
    let indexed = 0;
    for (const gist of gists) {
        const eventId = `gist:${gist.id}`;
        if (index.hasItem(eventId)) { continue; }
        const item = normalizeGistToMarketplaceItem(gist);
        index.indexDocument(
            item.eventId, item.pubkey, item.name, item.description,
            item.body, item.docType, item.tags, item.category,
            item.bodyFormat, item.version, item.contentCID, item.createdAt
        );
        indexed++;
    }
    return indexed;
}

// ── Utility functions ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) { return 0; }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
}

function tagMatch(query: string, item: MarketplaceItem): number {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 1);
    if (queryTerms.length === 0) { return 0; }

    const searchable = [
        item.name,
        item.description,
        item.docType,
        item.category,
        ...item.tags
    ].join(' ').toLowerCase();

    let matches = 0;
    for (const term of queryTerms) {
        if (searchable.includes(term)) { matches++; }
    }
    return matches / queryTerms.length;
}

function normalizeReputation(rawPoints: number): number {
    // Sigmoid-like normalization: 0 → 0, 200 → ~0.95
    return rawPoints / (rawPoints + 50);
}
