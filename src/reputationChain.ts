// ══════════════════════════════════════════════════════════════════════════════
// Verifiable Reputation Chain
// Merkle-linked W3C Verifiable Credentials forming a tamper-evident history.
// Each entry references the previous entry's hash, creating an append-only
// chain that anyone can verify independently.
//
// Chain entries are publishable to Nostr as Kind 30078 events, making
// reputation portable and independently verifiable across the network.
// ══════════════════════════════════════════════════════════════════════════════

import * as crypto from 'crypto';
import { type VerifiableCredential, deriveDIDKey, computeSHA256 } from './web3';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ReputationChainEntry {
    index: number;
    vc: VerifiableCredential;
    prevHash: string;          // SHA-256 of previous entry (genesis = '0'.repeat(64))
    entryHash: string;         // SHA-256 of this entry (vc + prevHash + index)
    action: ReputationAction;
    metadata: Record<string, any>;
    timestamp: number;
}

export type ReputationAction =
    | 'publish_doc'
    | 'receive_zap'
    | 'send_zap'
    | 'get_imported'
    | 'clean_scan'
    | 'flagged_scan'
    | 'daily_presence'
    | 'council_inference'       // new: tracked inference contributed to council
    | 'workflow_executed'       // new: ran a workflow successfully
    | 'safety_attestation';    // new: issued a safety attestation

export interface ChainVerificationResult {
    valid: boolean;
    length: number;
    brokenAt?: number;         // index where chain breaks, if invalid
    reason?: string;
}

export interface MerkleProof {
    index: number;
    entryHash: string;
    prevHash: string;
    chainHead: string;
    chainLength: number;
    verified: boolean;
}

export interface ChainNostrEvent {
    kind: 30078;
    tags: string[][];
    content: string;           // JSON-encoded ReputationChainEntry
}

// ── Constants ───────────────────────────────────────────────────────────────

const GENESIS_HASH = '0'.repeat(64);
const CHAIN_EVENT_KIND = 30078;

// Points awarded per action (mirrors nostrService but extensible here)
const ACTION_POINTS: Record<ReputationAction, number> = {
    publish_doc: 10,
    receive_zap: 1,
    send_zap: 2,
    get_imported: 5,
    clean_scan: 5,
    flagged_scan: -10,
    daily_presence: 1,
    council_inference: 3,
    workflow_executed: 5,
    safety_attestation: 2
};

// ── ReputationChain ─────────────────────────────────────────────────────────

export class ReputationChain {
    private entries: ReputationChainEntry[] = [];
    private issuerPubkey: string;

    constructor(issuerPubkey: string, existingEntries?: ReputationChainEntry[]) {
        this.issuerPubkey = issuerPubkey;
        if (existingEntries && existingEntries.length > 0) {
            this.entries = existingEntries;
        }
    }

    // ── Append a new entry ──────────────────────────────────────────────

    append(
        action: ReputationAction,
        subjectPubkey: string,
        metadata: Record<string, any> = {}
    ): ReputationChainEntry {
        const index = this.entries.length;
        const prevHash = index === 0 ? GENESIS_HASH : this.entries[index - 1].entryHash;
        const points = this.getTotalPoints() + (ACTION_POINTS[action] || 0);
        const level = computeLevel(points);

        const vc = buildVC(this.issuerPubkey, subjectPubkey, level, points, action);

        const entryHash = hashEntry(index, vc, prevHash);

        const entry: ReputationChainEntry = {
            index,
            vc,
            prevHash,
            entryHash,
            action,
            metadata: {
                ...metadata,
                pointsAwarded: ACTION_POINTS[action] || 0,
                totalPoints: points
            },
            timestamp: Date.now()
        };

        this.entries.push(entry);
        return entry;
    }

    // ── Verify entire chain ─────────────────────────────────────────────

    verify(): ChainVerificationResult {
        if (this.entries.length === 0) {
            return { valid: true, length: 0 };
        }

        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];

            // Check prevHash linkage
            const expectedPrev = i === 0 ? GENESIS_HASH : this.entries[i - 1].entryHash;
            if (entry.prevHash !== expectedPrev) {
                return {
                    valid: false,
                    length: this.entries.length,
                    brokenAt: i,
                    reason: `Entry ${i}: prevHash mismatch (expected ${expectedPrev.slice(0, 12)}..., got ${entry.prevHash.slice(0, 12)}...)`
                };
            }

            // Recompute entryHash
            const recomputed = hashEntry(i, entry.vc, entry.prevHash);
            if (entry.entryHash !== recomputed) {
                return {
                    valid: false,
                    length: this.entries.length,
                    brokenAt: i,
                    reason: `Entry ${i}: entryHash tampered (expected ${recomputed.slice(0, 12)}..., got ${entry.entryHash.slice(0, 12)}...)`
                };
            }

            // Check index continuity
            if (entry.index !== i) {
                return {
                    valid: false,
                    length: this.entries.length,
                    brokenAt: i,
                    reason: `Entry ${i}: index mismatch (expected ${i}, got ${entry.index})`
                };
            }
        }

        return { valid: true, length: this.entries.length };
    }

    // ── Get Merkle proof for a specific entry ───────────────────────────

    getProof(index: number): MerkleProof | null {
        if (index < 0 || index >= this.entries.length) { return null; }

        const entry = this.entries[index];
        const recomputed = hashEntry(index, entry.vc, entry.prevHash);

        return {
            index,
            entryHash: entry.entryHash,
            prevHash: entry.prevHash,
            chainHead: this.entries[this.entries.length - 1].entryHash,
            chainLength: this.entries.length,
            verified: recomputed === entry.entryHash
        };
    }

    // ── Accessors ───────────────────────────────────────────────────────

    getHead(): ReputationChainEntry | null {
        return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
    }

    getEntry(index: number): ReputationChainEntry | null {
        return this.entries[index] || null;
    }

    getLength(): number {
        return this.entries.length;
    }

    getEntries(): ReputationChainEntry[] {
        return [...this.entries];
    }

    getTotalPoints(): number {
        if (this.entries.length === 0) { return 0; }
        const last = this.entries[this.entries.length - 1];
        return (last.metadata?.totalPoints as number) || 0;
    }

    getLevel(): number {
        return computeLevel(this.getTotalPoints());
    }

    getLevelLabel(): string {
        const labels = ['New', 'Active', 'Trusted', 'Verified'];
        return labels[this.getLevel()] || 'Unknown';
    }

    getActionCount(action: ReputationAction): number {
        return this.entries.filter(e => e.action === action).length;
    }

    // ── Serialization to/from Nostr ─────────────────────────────────────

    toNostrEvents(): ChainNostrEvent[] {
        return this.entries.map(entry => ({
            kind: CHAIN_EVENT_KIND,
            tags: [
                ['t', 'ouroboros'],
                ['t', 'ouroboros-rep-chain'],
                ['d', `rep-chain:${this.issuerPubkey}:${entry.index}`],
                ['chain-index', String(entry.index)],
                ['chain-prev', entry.prevHash],
                ['chain-hash', entry.entryHash],
                ['action', entry.action],
                ['points', String(entry.metadata?.totalPoints || 0)],
                ['level', String(computeLevel(entry.metadata?.totalPoints || 0))]
            ],
            content: JSON.stringify(entry)
        }));
    }

    static fromNostrEvents(events: Array<{ content: string }>): ReputationChain | null {
        if (events.length === 0) { return null; }

        const entries: ReputationChainEntry[] = [];
        for (const event of events) {
            try {
                const entry = JSON.parse(event.content) as ReputationChainEntry;
                entries.push(entry);
            } catch {
                continue; // skip malformed entries
            }
        }

        // Sort by index
        entries.sort((a, b) => a.index - b.index);

        if (entries.length === 0) { return null; }

        // Extract issuer from first VC
        const issuerDID = entries[0].vc.issuer;
        // Reverse DID:key → pubkey is not trivial; store pubkey in metadata
        const pubkey = entries[0].vc.credentialSubject?.nostrPubkey || '';

        const chain = new ReputationChain(pubkey, entries);
        return chain;
    }

    // ── JSON serialization ──────────────────────────────────────────────

    toJSON(): { issuerPubkey: string; entries: ReputationChainEntry[] } {
        return {
            issuerPubkey: this.issuerPubkey,
            entries: this.entries
        };
    }

    static fromJSON(data: { issuerPubkey: string; entries: ReputationChainEntry[] }): ReputationChain {
        return new ReputationChain(data.issuerPubkey, data.entries);
    }

    // ── Summary ─────────────────────────────────────────────────────────

    summary(): string {
        const v = this.verify();
        return [
            `Reputation Chain: ${this.issuerPubkey.slice(0, 16)}...`,
            `Length: ${this.entries.length} entries`,
            `Points: ${this.getTotalPoints()} (${this.getLevelLabel()})`,
            `Chain integrity: ${v.valid ? 'VALID' : `BROKEN at index ${v.brokenAt}`}`,
            `Head hash: ${this.getHead()?.entryHash.slice(0, 16) || 'empty'}...`
        ].join('\n');
    }
}

// ── Utility functions ───────────────────────────────────────────────────────

function hashEntry(index: number, vc: VerifiableCredential, prevHash: string): string {
    const payload = JSON.stringify({ index, vc, prevHash });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function computeLevel(points: number): number {
    if (points >= 200) { return 3; }
    if (points >= 75) { return 2; }
    if (points >= 15) { return 1; }
    return 0;
}

function buildVC(
    issuerPubkey: string,
    subjectPubkey: string,
    level: number,
    points: number,
    action: ReputationAction
): VerifiableCredential {
    const issuerDID = deriveDIDKey(issuerPubkey);
    const subjectDID = deriveDIDKey(subjectPubkey);
    const now = new Date().toISOString();
    const labels = ['New', 'Active', 'Trusted', 'Verified'];

    const vc: VerifiableCredential = {
        '@context': [
            'https://www.w3.org/2018/credentials/v1',
            'https://w3id.org/security/suites/secp256k1-2019/v1'
        ],
        type: ['VerifiableCredential', 'ReputationCredential'],
        issuer: issuerDID,
        issuanceDate: now,
        credentialSubject: {
            id: subjectDID,
            reputationLevel: level,
            reputationLabel: labels[level] || 'Unknown',
            reputationPoints: points,
            action,
            platform: 'ouroboros-champion-council',
            nostrPubkey: subjectPubkey
        }
    };

    // Tamper-evidence proof
    const proofInput = JSON.stringify({ ...vc, proof: undefined });
    const proofHash = crypto.createHash('sha256').update(proofInput).digest('hex');

    vc.proof = {
        type: 'Sha256ContentIntegrity2024',
        created: now,
        proofPurpose: 'assertionMethod',
        verificationMethod: `${issuerDID}#key-1`,
        proofValue: proofHash
    };

    return vc;
}
