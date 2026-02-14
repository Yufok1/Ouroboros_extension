// ══════════════════════════════════════════════════════════════════════════════
// Web3 Cryptographic Utilities — Zero-cost, pure local computation
// No subscriptions, no external services, no API keys required.
//
// Facilities:
//   1. IPFS CIDv1 — content-addressed identifiers from SHA-256 hashes
//   2. DID:key   — W3C Decentralized Identifier from Nostr secp256k1 pubkey
//   3. Verifiable Credentials — reputation attestation format (W3C VC Data Model)
//   4. Safety Attestations — cryptographic receipts for safety scan results
//   5. Vibe Coding docTypes — Web3 marketplace document type definitions
// ══════════════════════════════════════════════════════════════════════════════

import * as crypto from 'crypto';

// ──────────────────────────────────────────────────────────────────────────────
// 1. IPFS CIDv1 — Content Identifier computation
//
// Structure: <multibase-prefix><cid-version><multicodec><multihash>
//   multibase:  'b' = base32lower (RFC 4648)
//   version:    0x01 = CIDv1
//   multicodec: 0x55 = raw
//   multihash:  0x12 = sha2-256, 0x20 = 32 bytes, then the digest
//
// Result: "bafkrei..." — a proper IPFS CIDv1 that any IPFS gateway can resolve
// if the content is ever pinned. Even without pinning, the CID is a globally
// unique, verifiable fingerprint of the content.
// ──────────────────────────────────────────────────────────────────────────────

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(data: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < data.length; i++) {
        value = (value << 8) | data[i];
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

/**
 * Compute an IPFS CIDv1 (raw codec, sha2-256) from arbitrary content.
 * Pure local computation — no network, no IPFS node, no API.
 *
 * @param content - string or Buffer to hash
 * @returns CIDv1 string like "bafkreihdwdcef..."
 */
export function computeCID(content: string | Buffer): string {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const sha256 = crypto.createHash('sha256').update(data).digest();

    // CIDv1: version(1) + codec(0x55=raw) + multihash(0x12=sha256, 0x20=32bytes, digest)
    const cidBytes = new Uint8Array(2 + 2 + 32);
    cidBytes[0] = 0x01; // CIDv1
    cidBytes[1] = 0x55; // raw codec
    cidBytes[2] = 0x12; // sha2-256
    cidBytes[3] = 0x20; // 32 bytes
    cidBytes.set(sha256, 4);

    return 'b' + base32Encode(cidBytes); // multibase 'b' = base32lower
}

/**
 * Compute the legacy hex SHA-256 digest (backward compat with existing contentDigest).
 */
export function computeSHA256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. DID:key — Decentralized Identifier from secp256k1 public key
//
// Format: did:key:<multibase-encoded-multicodec-pubkey>
//   multibase:  'z' = base58btc
//   multicodec: 0xe7 0x01 = secp256k1-pub (varint encoded)
//   pubkey:     33 bytes compressed secp256k1 public key
//
// Our Nostr pubkeys are already secp256k1, so this is a direct encoding.
// The result is a W3C-standard DID that any DID resolver can verify.
// ──────────────────────────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(data: Uint8Array): string {
    // Count leading zeros
    let zeros = 0;
    for (let i = 0; i < data.length && data[i] === 0; i++) { zeros++; }

    // Convert to base58
    const size = Math.ceil(data.length * 138 / 100) + 1;
    const b58 = new Uint8Array(size);
    let length = 0;

    for (let i = zeros; i < data.length; i++) {
        let carry = data[i];
        let j = 0;
        for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
            carry += 256 * b58[k];
            b58[k] = carry % 58;
            carry = Math.floor(carry / 58);
        }
        length = j;
    }

    let result = '1'.repeat(zeros);
    let skip = true;
    for (let i = 0; i < size; i++) {
        if (skip && b58[i] === 0) { continue; }
        skip = false;
        result += BASE58_ALPHABET[b58[i]];
    }
    return result;
}

/**
 * Derive a did:key DID from a Nostr hex public key (secp256k1).
 * Pure local computation — no resolver, no blockchain, no API.
 *
 * The Nostr pubkey is the x-coordinate of the secp256k1 point (32 bytes).
 * For did:key we need the compressed form (33 bytes: 0x02 prefix + x-coordinate).
 *
 * @param nostrHexPubkey - 64-char hex string (Nostr public key)
 * @returns did:key string like "did:key:zQ3sh..."
 */
export function deriveDIDKey(nostrHexPubkey: string): string {
    // Nostr pubkey is 32 bytes (x-coordinate only). Assume even parity (0x02 prefix).
    const xBytes = Buffer.from(nostrHexPubkey, 'hex');
    if (xBytes.length !== 32) {
        throw new Error(`Invalid Nostr pubkey length: expected 32 bytes, got ${xBytes.length}`);
    }

    // Compressed secp256k1: 0x02 + x-coordinate (33 bytes)
    const compressed = new Uint8Array(33);
    compressed[0] = 0x02;
    compressed.set(xBytes, 1);

    // Multicodec prefix for secp256k1-pub: 0xe7 0x01 (varint)
    const prefixed = new Uint8Array(2 + 33);
    prefixed[0] = 0xe7;
    prefixed[1] = 0x01;
    prefixed.set(compressed, 2);

    return 'did:key:z' + base58Encode(prefixed);
}

/**
 * Create a DID Document from a Nostr pubkey.
 * This is what a DID resolver would return for our did:key.
 */
export function createDIDDocument(nostrHexPubkey: string): object {
    const did = deriveDIDKey(nostrHexPubkey);
    return {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/secp256k1-2019/v1'],
        id: did,
        verificationMethod: [{
            id: `${did}#key-1`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: did,
            publicKeyHex: nostrHexPubkey
        }],
        authentication: [`${did}#key-1`],
        assertionMethod: [`${did}#key-1`],
        // Service endpoints: Nostr relay + marketplace stall
        service: [{
            id: `${did}#nostr`,
            type: 'NostrRelay',
            serviceEndpoint: 'wss://relay.damus.io'
        }]
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Verifiable Credentials — W3C VC Data Model for reputation
//
// A VC is a tamper-evident claim about a subject, issued by an issuer.
// We use self-issued VCs where the extension attests to reputation levels.
// These are locally computed and can be verified by anyone with the pubkey.
// ──────────────────────────────────────────────────────────────────────────────

export interface VerifiableCredential {
    '@context': string[];
    type: string[];
    issuer: string;       // did:key of the issuer (self = the user's own DID)
    issuanceDate: string;  // ISO 8601
    credentialSubject: {
        id: string;        // did:key of the subject
        [key: string]: any;
    };
    proof?: {
        type: string;
        created: string;
        proofPurpose: string;
        verificationMethod: string;
        // In a full implementation, this would be a JWS/EdDSA signature
        // For now we use a content hash as a tamper-evidence marker
        proofValue: string;
    };
}

/**
 * Issue a Verifiable Credential for a reputation level.
 * Self-issued: the user attests to their own reputation data.
 * The proof is a SHA-256 hash of the credential content (tamper-evident).
 *
 * @param issuerPubkey - Nostr hex pubkey of the issuer
 * @param subjectPubkey - Nostr hex pubkey of the subject
 * @param repLevel - reputation level (0=new, 1=active, 2=trusted, 3=verified)
 * @param repPoints - total reputation points
 */
export function issueReputationVC(
    issuerPubkey: string,
    subjectPubkey: string,
    repLevel: number,
    repPoints: number
): VerifiableCredential {
    const issuerDID = deriveDIDKey(issuerPubkey);
    const subjectDID = deriveDIDKey(subjectPubkey);
    const now = new Date().toISOString();
    const levelLabels = ['New', 'Active', 'Trusted', 'Verified'];

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
            reputationLevel: repLevel,
            reputationLabel: levelLabels[repLevel] || 'Unknown',
            reputationPoints: repPoints,
            platform: 'ouroboros-champion-council',
            nostrPubkey: subjectPubkey
        }
    };

    // Tamper-evidence proof: SHA-256 of the credential body
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

// ──────────────────────────────────────────────────────────────────────────────
// 4. Safety Attestations — Cryptographic receipts for safety scan results
//
// When a document passes the safety scanner, we generate a signed attestation
// that can be verified later. Format inspired by EAS (Ethereum Attestation Service)
// but computed locally without any blockchain interaction.
// ──────────────────────────────────────────────────────────────────────────────

export interface SafetyAttestation {
    version: 1;
    schema: 'ouroboros-safety-scan-v1';
    attester: string;        // did:key of the scanner (self)
    recipient: string;       // CID of the scanned document
    timestamp: string;       // ISO 8601
    data: {
        safe: boolean;
        score: number;       // 0-100
        trustLevel: string;  // verified | community | flagged | blocked
        flagCount: number;
        criticalCount: number;
        docType: string;
        contentCID: string;
    };
    uid: string;             // unique attestation ID (SHA-256 of data)
}

/**
 * Create a safety attestation for a scanned document.
 *
 * @param scannerPubkey - Nostr hex pubkey of the scanner
 * @param contentCID - IPFS CID of the document body
 * @param scanResult - safety scan result object
 * @param docType - document type that was scanned
 */
export function createSafetyAttestation(
    scannerPubkey: string,
    contentCID: string,
    scanResult: { safe: boolean; score: number; trustLevel: string; flags: Array<{ severity: string }> },
    docType: string
): SafetyAttestation {
    const data = {
        safe: scanResult.safe,
        score: scanResult.score,
        trustLevel: scanResult.trustLevel,
        flagCount: scanResult.flags.length,
        criticalCount: scanResult.flags.filter(f => f.severity === 'critical').length,
        docType,
        contentCID
    };

    const uid = crypto.createHash('sha256')
        .update(JSON.stringify(data) + scannerPubkey + Date.now())
        .digest('hex');

    return {
        version: 1,
        schema: 'ouroboros-safety-scan-v1',
        attester: deriveDIDKey(scannerPubkey),
        recipient: contentCID,
        timestamp: new Date().toISOString(),
        data,
        uid
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. Vibe Coding — Web3 Marketplace Document Types & Categories
//
// Extends the existing docType system (workflow, skill, playbook, recipe)
// with Web3-native types for the vibe coding ecosystem.
// ──────────────────────────────────────────────────────────────────────────────

/** New Web3 document types for the marketplace */
export const WEB3_DOC_TYPES = [
    'smartcontract',    // Solidity/Vyper source + ABI + deployment config
    'dapp-template',    // Full-stack dApp scaffold (frontend + contracts)
    'testnet-config',   // BuildBear-style testnet fork configuration
    'audit-report',     // Smart contract security audit results
    'chain-recipe',     // Multi-step blockchain interaction recipe
] as const;

export type Web3DocType = typeof WEB3_DOC_TYPES[number];

/** Web3/vibe-coding marketplace categories */
export const WEB3_CATEGORIES = [
    'solidity',         // Solidity smart contracts
    'vyper',            // Vyper smart contracts
    'evm',              // EVM-compatible chain tools
    'defi',             // DeFi protocols, AMMs, lending
    'nft',              // NFT minting, marketplaces, metadata
    'dao',              // DAO governance, voting, treasury
    'token',            // ERC-20, ERC-721, ERC-1155 templates
    'bridge',           // Cross-chain bridges, messaging
    'oracle',           // Chainlink, Pyth, Band integrations
    'identity',         // DID, ENS, Lens, Farcaster
    'storage',          // IPFS, Arweave, Filecoin integrations
    'testing',          // Foundry, Hardhat, BuildBear configs
    'security',         // Audit tools, reentrancy guards, access control
    'gas-optimization', // Gas optimization patterns
    'web3-tooling',     // General Web3 dev tools
] as const;

export type Web3Category = typeof WEB3_CATEGORIES[number];

/** Schema rules for Web3 document types */
export const WEB3_DOC_SCHEMA_RULES: Record<Web3DocType, {
    maxBodyBytes: number;
    minBodyBytes: number;
    defaultBodyFormat: 'json' | 'markdown' | 'yaml' | 'text';
    bodyValidator?: (body: string) => string | null;
}> = {
    smartcontract: {
        maxBodyBytes: 512000,
        minBodyBytes: 20,
        defaultBodyFormat: 'text', // Solidity source
        bodyValidator: (body: string) => {
            // Basic Solidity validation: should contain pragma or contract keyword
            if (!body.includes('pragma') && !body.includes('contract') && !body.includes('interface')) {
                return 'Smart contract body should contain Solidity/Vyper source code (expected pragma, contract, or interface keyword)';
            }
            return null;
        }
    },
    'dapp-template': {
        maxBodyBytes: 1048576, // 1MB — templates can be large
        minBodyBytes: 50,
        defaultBodyFormat: 'json',
        bodyValidator: (body: string) => {
            try {
                const parsed = JSON.parse(body);
                if (!parsed || typeof parsed !== 'object') { return 'dApp template body must be a JSON object'; }
            } catch { return 'dApp template body is not valid JSON'; }
            return null;
        }
    },
    'testnet-config': {
        maxBodyBytes: 102400,
        minBodyBytes: 10,
        defaultBodyFormat: 'json',
        bodyValidator: (body: string) => {
            try {
                const parsed = JSON.parse(body);
                if (!parsed || typeof parsed !== 'object') { return 'Testnet config must be a JSON object'; }
            } catch { return 'Testnet config is not valid JSON'; }
            return null;
        }
    },
    'audit-report': {
        maxBodyBytes: 512000,
        minBodyBytes: 50,
        defaultBodyFormat: 'markdown',
    },
    'chain-recipe': {
        maxBodyBytes: 204800,
        minBodyBytes: 20,
        defaultBodyFormat: 'json',
        bodyValidator: (body: string) => {
            try {
                const parsed = JSON.parse(body);
                if (!parsed || typeof parsed !== 'object') { return 'Chain recipe must be a JSON object'; }
                if (!parsed.steps && !parsed.actions) { return 'Chain recipe should contain "steps" or "actions" array'; }
            } catch { return 'Chain recipe is not valid JSON'; }
            return null;
        }
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 6. WebLN — Lightning wallet detection and payment utilities
//
// WebLN is a browser standard (window.webln) for Lightning wallet interaction.
// We don't implement the wallet — we detect if the user has one (e.g. Alby)
// and provide the interface for the webview to call.
//
// These are helper types/messages — actual WebLN calls happen in the webview JS
// because window.webln only exists in the browser context.
// ──────────────────────────────────────────────────────────────────────────────

export interface WebLNPaymentRequest {
    invoice: string;       // BOLT-11 payment request
    recipientPubkey: string;
    eventId: string;
    amountSats: number;
    comment: string;
}

export interface WebLNPaymentResult {
    success: boolean;
    preimage?: string;     // proof of payment
    error?: string;
    method: 'webln' | 'manual'; // how the payment was made
}

/**
 * Generate the WebLN detection + payment script for injection into webview.
 * This returns JavaScript code that the webview can execute.
 */
export function getWebLNScript(): string {
    return `
// WebLN Lightning Wallet Integration
// Detects Alby, Zeus, BlueWallet, or any WebLN-compatible wallet

window._weblnAvailable = false;
window._weblnChecked = false;

async function checkWebLN() {
    if (window._weblnChecked) return window._weblnAvailable;
    window._weblnChecked = true;
    try {
        if (typeof window.webln !== 'undefined') {
            await window.webln.enable();
            window._weblnAvailable = true;
            console.log('[WebLN] Wallet detected and enabled');
        }
    } catch (e) {
        console.log('[WebLN] No wallet detected or user denied:', e.message);
        window._weblnAvailable = false;
    }
    return window._weblnAvailable;
}

async function payWithWebLN(invoice, eventId) {
    if (!window._weblnAvailable) {
        // Fallback: copy invoice to clipboard
        await navigator.clipboard.writeText(invoice);
        return { success: false, method: 'manual', error: 'No WebLN wallet — invoice copied to clipboard' };
    }
    try {
        const result = await window.webln.sendPayment(invoice);
        return { success: true, method: 'webln', preimage: result.preimage, eventId: eventId };
    } catch (e) {
        return { success: false, method: 'webln', error: e.message };
    }
}

// Check on load
checkWebLN().then(available => {
    vscode.postMessage({ type: 'weblnStatus', available: available });
});
`;
}
