import * as vscode from 'vscode';
import WebSocket from 'ws';
import { computeCID, deriveDIDKey, createDIDDocument, issueReputationVC, createSafetyAttestation, WEB3_DOC_TYPES, WEB3_CATEGORIES, WEB3_DOC_SCHEMA_RULES, type Web3DocType, type VerifiableCredential, type SafetyAttestation } from './web3';
// nostr-tools has proper CJS exports – safe for VS Code extension host
const nostrTools = require('nostr-tools');

// ——————————————————————————————————————————————————————————————————————————————————————————
// NostrService – Secure Nostr relay client for VS Code extension
// Private key stored in SecretStorage (OS keychain), never exposed
// ——————————————————————————————————————————————————————————————————————————————————————————

const SECRET_KEY_ID = 'champion.nostr.privateKey';
const OUROBOROS_WORKFLOW_KIND = 30078; // Parameterized replaceable event for app-specific data
const CHAT_KIND = 1; // Short text note
const REACTION_KIND = 7; // Reaction
const DM_KIND = 4; // NIP-04 encrypted DM
const DELETION_KIND = 5; // NIP-09 event deletion
const METADATA_KIND = 0; // NIP-01 user metadata
const PRESENCE_KIND = 10002; // Ephemeral presence heartbeat
const ZAP_REQUEST_KIND = 9734; // NIP-57 zap request
const ZAP_RECEIPT_KIND = 9735; // NIP-57 zap receipt
const STALL_KIND = 30017; // NIP-15 merchant stall
const PRODUCT_KIND = 30018; // NIP-15 product listing

// ——————————————————————————————————————————————————————————————————————————————————————————
// MARKETPLACE DOCUMENT SCHEMA VALIDATION
// Validates structure before publish + import. Per-docType rules.
// ——————————————————————————————————————————————————————————————————————————————————————————

const SCHEMA_VERSION = 1;
const VALID_DOC_TYPES = ['workflow', 'skill', 'playbook', 'recipe', ...WEB3_DOC_TYPES] as const;
type DocType = typeof VALID_DOC_TYPES[number];
const VALID_BODY_FORMATS = ['json', 'markdown', 'yaml', 'text'] as const;
type BodyFormat = typeof VALID_BODY_FORMATS[number];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;

interface DocSchemaRules {
    maxBodyBytes: number;
    minBodyBytes: number;
    defaultBodyFormat: BodyFormat;
    bodyValidator?: (body: string) => string | null; // returns error or null
}

const DOC_SCHEMA_RULES: Record<string, DocSchemaRules> = {
    workflow: {
        maxBodyBytes: 512000,
        minBodyBytes: 2,
        defaultBodyFormat: 'json',
        bodyValidator: (body: string) => {
            try { const parsed = JSON.parse(body); if (!parsed || typeof parsed !== 'object') { return 'Workflow body must be a JSON object'; } }
            catch { return 'Workflow body is not valid JSON'; }
            return null;
        }
    },
    skill: {
        maxBodyBytes: 102400,
        minBodyBytes: 10,
        defaultBodyFormat: 'markdown',
    },
    playbook: {
        maxBodyBytes: 204800,
        minBodyBytes: 10,
        defaultBodyFormat: 'markdown',
    },
    recipe: {
        maxBodyBytes: 102400,
        minBodyBytes: 10,
        defaultBodyFormat: 'text',
    },
    // Web3 / Vibe Coding document types
    ...WEB3_DOC_SCHEMA_RULES
};

interface DocValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

function validateDocument(doc: {
    docType?: string; name?: string; description?: string; version?: string;
    body?: string; bodyFormat?: string; tags?: string[];
}): DocValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // docType
    const docType = doc.docType || 'workflow';
    if (!VALID_DOC_TYPES.includes(docType as DocType)) {
        warnings.push(`Unknown docType "${docType}". Will use generic rendering.`);
    }
    const rules = DOC_SCHEMA_RULES[docType as DocType];

    // name
    if (!doc.name || doc.name.trim().length === 0) { errors.push('Name is required.'); }
    else if (doc.name.length > 100) { errors.push('Name must be 100 characters or fewer.'); }

    // description
    if (doc.description && doc.description.length > 2000) { errors.push('Description must be 2000 characters or fewer.'); }

    // version (semver)
    const version = doc.version || '1.0.0';
    if (!SEMVER_RE.test(version)) { errors.push(`Version "${version}" is not valid semver (expected X.Y.Z).`); }

    // body
    if (!doc.body || doc.body.trim().length === 0) { errors.push('Body content is required.'); }
    else if (rules) {
        const bodyBytes = new TextEncoder().encode(doc.body).length;
        if (bodyBytes > rules.maxBodyBytes) { errors.push(`Body exceeds ${Math.round(rules.maxBodyBytes / 1024)}KB limit (got ${Math.round(bodyBytes / 1024)}KB).`); }
        if (bodyBytes < rules.minBodyBytes) { errors.push('Body content is too short.'); }
        if (rules.bodyValidator) {
            const bodyErr = rules.bodyValidator(doc.body);
            if (bodyErr) { errors.push(bodyErr); }
        }
    }

    // bodyFormat
    if (doc.bodyFormat && !VALID_BODY_FORMATS.includes(doc.bodyFormat as BodyFormat)) {
        warnings.push(`Unknown bodyFormat "${doc.bodyFormat}". Defaulting to "text".`);
    }

    // tags
    if (doc.tags && doc.tags.length > 20) { errors.push('Maximum 20 tags allowed.'); }
    if (doc.tags) {
        for (const t of doc.tags) {
            if (t.length > 50) { errors.push(`Tag "${t.slice(0, 20)}..." exceeds 50 character limit.`); break; }
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

function computeContentDigest(body: string): { hex: string; cid: string } {
    const crypto = require('crypto');
    const hex = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    const cid = computeCID(body);
    return { hex, cid };
}

// ——————————————————————————————————————————————————————————————————————————————————————————
// MARKETPLACE SAFETY SCANNER
// Scans documents for malicious patterns before publish or import.
// Severity: critical (blocks), warning (user override), info (logged)
// ——————————————————————————————————————————————————————————————————————————————————————————

interface SafetyFlag {
    severity: 'critical' | 'warning' | 'info';
    pattern: string;
    location: string;
    match: string;
}

interface SafetyScanResult {
    safe: boolean;
    trustLevel: 'verified' | 'community' | 'flagged' | 'blocked';
    score: number; // 0-100 (100 = clean)
    flags: SafetyFlag[];
}

const SAFETY_PATTERNS: Array<{
    name: string; pattern: RegExp; severity: 'critical' | 'warning' | 'info'; description: string;
}> = [
    // Code execution
    { name: 'eval_call', pattern: /\beval\s*\(/gi, severity: 'critical', description: 'eval() execution' },
    { name: 'function_constructor', pattern: /new\s+Function\s*\(/gi, severity: 'critical', description: 'Function constructor' },
    { name: 'exec_call', pattern: /\bexec\s*\(\s*['"`]/gi, severity: 'warning', description: 'exec() call' },
    { name: 'setTimeout_string', pattern: /setTimeout\s*\(\s*['"`]/gi, severity: 'warning', description: 'setTimeout with string eval' },
    // Shell injection
    { name: 'shell_subst', pattern: /\$\([^)]{4,}\)/g, severity: 'critical', description: 'Shell command substitution' },
    { name: 'backtick_exec', pattern: /`[^`]*(?:curl|wget|rm|chmod|bash|sh|powershell|cmd)[^`]*`/gi, severity: 'critical', description: 'Backtick shell execution' },
    { name: 'pipe_bash', pattern: /\|\s*(?:ba)?sh\b/gi, severity: 'critical', description: 'Pipe to shell' },
    { name: 'curl_bash', pattern: /curl\s+[^\s|]+\s*\|\s*(?:ba)?sh/gi, severity: 'critical', description: 'curl | bash pattern' },
    // File system access
    { name: 'fs_read', pattern: /(?:fs|require\s*\(\s*['"]fs['"]\s*\))\.(?:readFile|readdir|writeFile|appendFile|unlink|rmdir)/gi, severity: 'warning', description: 'File system access' },
    { name: 'sensitive_paths', pattern: /(?:\/etc\/(?:passwd|shadow|hosts)|~\/\.ssh|%APPDATA%|%USERPROFILE%|\.env\b)/gi, severity: 'critical', description: 'Sensitive file path reference' },
    // Environment access
    { name: 'process_env', pattern: /process\.env\b/gi, severity: 'warning', description: 'Environment variable access' },
    { name: 'os_environ', pattern: /os\.environ/gi, severity: 'warning', description: 'Python environ access' },
    { name: 'getenv', pattern: /\bgetenv\s*\(/gi, severity: 'warning', description: 'getenv() call' },
    // Suspicious URLs
    { name: 'http_raw_ip', pattern: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/gi, severity: 'warning', description: 'HTTP to raw IP address' },
    { name: 'data_uri', pattern: /data:[^;]{1,30};base64,/gi, severity: 'warning', description: 'Base64 data URI' },
    // Credential harvesting
    { name: 'password_field', pattern: /["'](?:password|passwd|secret|api_key|api_secret|private_key|access_token)["']\s*:/gi, severity: 'info', description: 'Credential-like field name' },
    { name: 'input_password', pattern: /type\s*=\s*["']password["']/gi, severity: 'warning', description: 'Password input field' },
    // Encoded blobs
    { name: 'large_base64', pattern: /[A-Za-z0-9+\/=]{500,}/g, severity: 'warning', description: 'Large base64-like blob' },
    { name: 'large_hex', pattern: /(?:0x)?[0-9a-f]{200,}/gi, severity: 'info', description: 'Large hex blob' },
    // Social engineering
    { name: 'paste_token', pattern: /paste\s+(?:your|the)\s+(?:token|key|password|secret|credential)/gi, severity: 'warning', description: 'Social engineering: asks for credentials' },
    { name: 'share_key', pattern: /(?:share|send|enter|provide)\s+(?:your|the)\s+(?:api[_\s]?key|private[_\s]?key|secret|password)/gi, severity: 'warning', description: 'Social engineering: requests sensitive data' },
    // Network exfiltration
    { name: 'fetch_external', pattern: /(?:fetch|XMLHttpRequest|axios|require\s*\(\s*['"]https?['"]\s*\))\s*\(/gi, severity: 'info', description: 'External network request' },
    { name: 'webhook_url', pattern: /(?:webhook|callback|exfil|beacon)[\s_-]*(?:url|endpoint|uri)/gi, severity: 'warning', description: 'Webhook/callback URL reference' },
];

function scanDocumentSafety(doc: {
    name?: string; description?: string; body?: string; tags?: string[];
}): SafetyScanResult {
    const flags: SafetyFlag[] = [];
    const fields: Array<{ name: string; value: string }> = [
        { name: 'name', value: doc.name || '' },
        { name: 'description', value: doc.description || '' },
        { name: 'body', value: doc.body || '' },
        { name: 'tags', value: (doc.tags || []).join(' ') },
    ];

    for (const field of fields) {
        if (!field.value) { continue; }
        for (const rule of SAFETY_PATTERNS) {
            // Reset regex lastIndex for global patterns
            rule.pattern.lastIndex = 0;
            const match = rule.pattern.exec(field.value);
            if (match) {
                // Downgrade severity for body content inside code fences (likely educational)
                let sev = rule.severity;
                if (field.name === 'body' && sev !== 'info') {
                    const before = field.value.substring(Math.max(0, match.index - 100), match.index);
                    if (/```[a-z]*\s*$/i.test(before)) {
                        sev = sev === 'critical' ? 'warning' : 'info';
                    }
                }
                flags.push({
                    severity: sev,
                    pattern: rule.name,
                    location: field.name,
                    match: match[0].slice(0, 60)
                });
            }
        }
    }

    // Entropy check: if body is >80% non-alphanumeric or base64 chars, flag it
    if (doc.body && doc.body.length > 200) {
        const alphaRatio = (doc.body.match(/[a-zA-Z\s]/g) || []).length / doc.body.length;
        if (alphaRatio < 0.2) {
            flags.push({ severity: 'warning', pattern: 'high_entropy', location: 'body', match: 'Body has unusually low readable text ratio' });
        }
    }

    const criticalCount = flags.filter(f => f.severity === 'critical').length;
    const warningCount = flags.filter(f => f.severity === 'warning').length;
    const score = Math.max(0, 100 - (criticalCount * 30) - (warningCount * 10) - (flags.length * 2));

    let trustLevel: SafetyScanResult['trustLevel'];
    if (criticalCount > 0) { trustLevel = 'blocked'; }
    else if (score < 40) { trustLevel = 'flagged'; }
    else if (score < 80) { trustLevel = 'flagged'; }
    else { trustLevel = 'community'; }

    return { safe: criticalCount === 0, trustLevel, score, flags };
}

// ——————————————————————————————————————————————————————————————————————————————————————————
// REPUTATION POINTS SYSTEM
// Tracks publisher reputation. Non-monetary, non-transferable. Local computation.
// Points unlock: featured placement, priority in search, trust badge upgrades.
// ——————————————————————————————————————————————————————————————————————————————————————————

interface ReputationEntry {
    pubkey: string;
    points: number;
    publishCount: number;
    zapsSent: number;
    zapsReceived: number;
    importCount: number;
    cleanScans: number;     // listings that passed safety scan first try
    flaggedScans: number;   // listings that had safety flags
    level: number;          // computed: 0=new, 1=active, 2=trusted, 3=verified
    lastActivity: number;   // unix timestamp
}

const REPUTATION_POINTS = {
    PUBLISH_DOC: 10,
    RECEIVE_ZAP: 1,       // per 100 sats
    SEND_ZAP: 2,
    GET_IMPORTED: 5,
    CLEAN_SCAN: 5,
    FLAGGED_SCAN: -10,
    DAILY_PRESENCE: 1,
};

function computeRepLevel(points: number): number {
    if (points >= 200) { return 3; }  // verified
    if (points >= 75) { return 2; }   // trusted
    if (points >= 15) { return 1; }   // active
    return 0;                          // new
}

const REP_LEVEL_LABELS = ['New', 'Active', 'Trusted', 'Verified'];

// ——————————————————————————————————————————————————————————————————————————————————————————
// SENSITIVE DATA REDACTION ENGINE
// Catches API keys, passwords, file paths, emails, IPs, SSNs, credit cards, private keys,
// env vars, and other PII before it leaves the machine.
// ——————————————————————————————————————————————————————————————————————————————————————————

interface RedactionResult {
    redacted: string;
    wasRedacted: boolean;
    matches: string[];
}

const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
    // API keys (generic patterns)
    { name: 'api_key_generic', pattern: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)[\s:="']+[A-Za-z0-9\-_.\/+=]{16,}/gi, replacement: '[REDACTED:API_KEY]' },
    // AWS keys
    { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED:AWS_KEY]' },
    { name: 'aws_secret', pattern: /(?:aws[_-]?secret[_-]?access[_-]?key)[\s:="']+[A-Za-z0-9\/+=]{40}/gi, replacement: '[REDACTED:AWS_SECRET]' },
    // GitHub/GitLab tokens
    { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED:GITHUB_TOKEN]' },
    { name: 'gitlab_token', pattern: /glpat-[A-Za-z0-9\-_]{20,}/g, replacement: '[REDACTED:GITLAB_TOKEN]' },
    // Nostr/crypto private keys
    { name: 'nostr_nsec', pattern: /nsec1[a-z0-9]{58,}/g, replacement: '[REDACTED:NOSTR_PRIVATE_KEY]' },
    { name: 'hex_privkey', pattern: /(?:private[_-]?key|privkey|secret[_-]?key|nsec)[\s:="']+[0-9a-f]{64}/gi, replacement: '[REDACTED:PRIVATE_KEY]' },
    // Generic bearer/auth tokens
    { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9\-_.\/+=]{20,}/g, replacement: 'Bearer [REDACTED:TOKEN]' },
    { name: 'auth_header', pattern: /(?:Authorization|x-api-key|x-auth-token)[\s:]+[A-Za-z0-9\-_.\/+=]{16,}/gi, replacement: '[REDACTED:AUTH]' },
    // Passwords in common formats
    { name: 'password_field', pattern: /(?:password|passwd|pwd|pass)[\s:="']+\S{4,}/gi, replacement: '[REDACTED:PASSWORD]' },
    // Email addresses
    { name: 'email', pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED:EMAIL]' },
    // IPv4 addresses (non-loopback, non-relay)
    { name: 'ipv4', pattern: /(?<!\d)(?!127\.0\.0\.1)(?!0\.0\.0\.0)((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/g, replacement: '[REDACTED:IP]' },
    // SSN
    { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED:SSN]' },
    // Credit card numbers (basic Luhn-length patterns)
    { name: 'credit_card', pattern: /\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, replacement: '[REDACTED:CARD]' },
    // Windows file paths with usernames
    { name: 'win_path', pattern: /[A-Z]:\\(?:Users|Documents and Settings)\\[^\s\\]+(?:\\[^\s"'<>|]+)*/gi, replacement: '[REDACTED:PATH]' },
    // Unix home paths
    { name: 'unix_home', pattern: /\/(?:home|Users)\/[^\s\/]+(?:\/[^\s"'<>|]+)*/g, replacement: '[REDACTED:PATH]' },
    // Environment variable assignments
    { name: 'env_var', pattern: /(?:export\s+)?(?:DATABASE_URL|DB_PASSWORD|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|HF_TOKEN)[\s=]+\S+/gi, replacement: '[REDACTED:ENV]' },
    // Connection strings
    { name: 'connection_string', pattern: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s"']+/gi, replacement: '[REDACTED:CONNECTION_STRING]' },
    // Phone numbers (US format)
    { name: 'phone', pattern: /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, replacement: '[REDACTED:PHONE]' },
];

function redactSensitiveData(text: string): RedactionResult {
    let redacted = text;
    const matches: string[] = [];
    for (const { name, pattern, replacement } of SENSITIVE_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;
        const found = redacted.match(pattern);
        if (found) {
            matches.push(`${name}(${found.length})`);
            redacted = redacted.replace(pattern, replacement);
        }
    }
    return { redacted, wasRedacted: matches.length > 0, matches };
}

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
    '#p'?: string[];
    '#e'?: string[];
    since?: number;
    limit?: number;
}

export interface UserProfile {
    name?: string;
    about?: string;
    picture?: string;
    nip05?: string;
    lud16?: string;  // Lightning address (user@wallet.com) — NIP-57
    lud06?: string;  // LNURL pay endpoint — NIP-57 fallback
}

export interface PrivacySettings {
    chatEnabled: boolean;
    dmsEnabled: boolean;
    marketplaceEnabled: boolean;
    autoRedact: boolean;
    presenceEnabled: boolean;
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
    private _onRelayChange = new vscode.EventEmitter<number>();
    public readonly onRelayChange = this._onRelayChange.event;
    private _onDM = new vscode.EventEmitter<{ event: NostrEvent; decrypted: string }>();
    public readonly onDM = this._onDM.event;
    private _onPresence = new vscode.EventEmitter<{ pubkey: string; online: boolean; ts: number }>();
    public readonly onPresence = this._onPresence.event;

    // Persistent subscription IDs
    private workflowSubId: string | undefined;
    private chatSubId: string | undefined;
    private dmSubId: string | undefined;
    private presenceSubId: string | undefined;

    // User data (bounded for marathon sessions)
    private static readonly MAX_PROFILES = 500;
    private static readonly MAX_ZAP_TOTALS = 1000;
    private static readonly MAX_REPUTATION = 2000;
    private static readonly MAX_RELAY_RETRIES = 20;
    private blockedUsers: Set<string> = new Set();
    private profiles: Map<string, UserProfile> = new Map();
    private onlineUsers: Map<string, number> = new Map(); // pubkey -> last seen ts
    private reputation: Map<string, ReputationEntry> = new Map();
    private _relayRetryCount: Map<string, number> = new Map();
    private context: vscode.ExtensionContext;
    private _privacy: PrivacySettings = {
        chatEnabled: true,
        dmsEnabled: true,
        marketplaceEnabled: true,
        autoRedact: true,
        presenceEnabled: true
    };

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
        this.context = context;
        // Load persisted block list and privacy settings
        const saved = context.globalState.get<string[]>('champion.blockedUsers', []);
        this.blockedUsers = new Set(saved);
        const privSaved = context.globalState.get<PrivacySettings>('champion.privacySettings');
        if (privSaved) { this._privacy = { ...this._privacy, ...privSaved }; }
        // Load persisted reputation data
        const repSaved = context.globalState.get<Record<string, ReputationEntry>>('champion.reputation', {});
        for (const [k, v] of Object.entries(repSaved)) { this.reputation.set(k, v); }
    }

    // ── CACHE BOUNDING (marathon session hardening) ───────────────
    /** Trim a Map to maxSize by evicting oldest entries (insertion order) */
    private trimMap<V>(map: Map<string, V>, maxSize: number): void {
        if (map.size <= maxSize) { return; }
        const excess = map.size - maxSize;
        const iter = map.keys();
        for (let i = 0; i < excess; i++) {
            const key = iter.next().value;
            if (key !== undefined) { map.delete(key); }
        }
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // KEY MANAGEMENT (SecretStorage only)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async init(): Promise<string> {
        let hexKey = await this.secretStorage.get(SECRET_KEY_ID);

        if (!hexKey) {
            // Generate new keypair
            const sk = nostrTools.generateSecretKey();
            this.privateKey = sk;
            hexKey = Buffer.from(sk).toString('hex');
            await this.secretStorage.store(SECRET_KEY_ID, hexKey);
        } else {
            this.privateKey = Uint8Array.from(Buffer.from(hexKey, 'hex'));
        }

        this.publicKey = nostrTools.getPublicKey(this.privateKey);
        return this.publicKey;
    }

    getPublicKey(): string {
        return this.publicKey;
    }

    getNpub(): string {
        // Simplified bech32 display – first 8 + last 8 chars
        return this.publicKey ? `npub:${this.publicKey.slice(0, 8)}...${this.publicKey.slice(-8)}` : '';
    }

    getPrivacy(): PrivacySettings { return { ...this._privacy }; }

    setPrivacy(settings: Partial<PrivacySettings>): void {
        this._privacy = { ...this._privacy, ...settings };
        this.context.globalState.update('champion.privacySettings', this._privacy);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // REDACTION (public for pre-send preview)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    redact(text: string): RedactionResult {
        if (!this._privacy.autoRedact) {
            return { redacted: text, wasRedacted: false, matches: [] };
        }
        return redactSensitiveData(text);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // BLOCKING
    // ——————————————————————————————————————————————————————————————————————————————————————————

    blockUser(pubkey: string): void {
        this.blockedUsers.add(pubkey);
        this.context.globalState.update('champion.blockedUsers', Array.from(this.blockedUsers));
    }

    unblockUser(pubkey: string): void {
        this.blockedUsers.delete(pubkey);
        this.context.globalState.update('champion.blockedUsers', Array.from(this.blockedUsers));
    }

    isBlocked(pubkey: string): boolean {
        return this.blockedUsers.has(pubkey);
    }

    getBlockedUsers(): string[] {
        return Array.from(this.blockedUsers);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // REPUTATION TRACKING
    // ——————————————————————————————————————————————————————————————————————————————————————————

    private ensureRepEntry(pubkey: string): ReputationEntry {
        if (!this.reputation.has(pubkey)) {
            this.reputation.set(pubkey, {
                pubkey, points: 0, publishCount: 0, zapsSent: 0, zapsReceived: 0,
                importCount: 0, cleanScans: 0, flaggedScans: 0, level: 0,
                lastActivity: Math.floor(Date.now() / 1000)
            });
        }
        return this.reputation.get(pubkey)!;
    }

    private persistReputation(): void {
        // Cap reputation entries before persisting (marathon session hardening)
        this.trimMap(this.reputation, NostrService.MAX_REPUTATION);
        const obj: Record<string, ReputationEntry> = {};
        for (const [k, v] of this.reputation) { obj[k] = v; }
        this.context.globalState.update('champion.reputation', obj);
    }

    addReputation(pubkey: string, action: keyof typeof REPUTATION_POINTS, multiplier: number = 1): ReputationEntry {
        const entry = this.ensureRepEntry(pubkey);
        const pts = REPUTATION_POINTS[action] * multiplier;
        entry.points = Math.max(0, entry.points + pts);
        entry.level = computeRepLevel(entry.points);
        entry.lastActivity = Math.floor(Date.now() / 1000);
        switch (action) {
            case 'PUBLISH_DOC': entry.publishCount++; break;
            case 'RECEIVE_ZAP': entry.zapsReceived += multiplier; break;
            case 'SEND_ZAP': entry.zapsSent += multiplier; break;
            case 'GET_IMPORTED': entry.importCount += multiplier; break;
            case 'CLEAN_SCAN': entry.cleanScans++; break;
            case 'FLAGGED_SCAN': entry.flaggedScans++; break;
        }
        this.persistReputation();
        return entry;
    }

    getReputation(pubkey: string): ReputationEntry {
        return this.ensureRepEntry(pubkey);
    }

    getAllReputation(): ReputationEntry[] {
        return Array.from(this.reputation.values()).sort((a, b) => b.points - a.points);
    }

    getRepLevel(pubkey: string): string {
        const entry = this.ensureRepEntry(pubkey);
        return REP_LEVEL_LABELS[entry.level] || 'New';
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // WEB3: DID, VERIFIABLE CREDENTIALS, CATEGORIES
    // Pure local crypto — no subscriptions, no external services
    // ——————————————————————————————————————————————————————————————————————————————————————————

    getDID(): string {
        if (!this.publicKey) { return ''; }
        return deriveDIDKey(this.publicKey);
    }

    getDIDDocument(): object {
        if (!this.publicKey) { return {}; }
        return createDIDDocument(this.publicKey);
    }

    issueReputationCredential(subjectPubkey: string): VerifiableCredential {
        const entry = this.ensureRepEntry(subjectPubkey);
        return issueReputationVC(this.publicKey, subjectPubkey, entry.level, entry.points);
    }

    getWeb3Categories(): readonly string[] {
        return WEB3_CATEGORIES;
    }

    getWeb3DocTypes(): readonly string[] {
        return WEB3_DOC_TYPES;
    }

    getAllDocTypes(): readonly string[] {
        return VALID_DOC_TYPES;
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // PROFILES (NIP-01 kind 0)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async setProfile(profile: UserProfile): Promise<NostrEvent> {
        const current = this.profiles.get(this.publicKey) || {};
        const patchEntries = Object.entries(profile || {}).filter(([_k, v]) => v !== undefined && v !== null);
        const mergedProfile: UserProfile = { ...current, ...Object.fromEntries(patchEntries) };
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: METADATA_KIND,
            tags: [],
            content: JSON.stringify(mergedProfile)
        });
        await this.broadcast(event);
        this.profiles.set(this.publicKey, mergedProfile);
        return event;
    }

    getProfile(pubkey: string): UserProfile | undefined {
        return this.profiles.get(pubkey);
    }

    getOwnProfile(): UserProfile | undefined {
        return this.profiles.get(this.publicKey);
    }

    getAllProfiles(): Map<string, UserProfile> {
        return new Map(this.profiles);
    }

    async fetchProfileFromRelays(pubkey: string, timeoutMs: number = 3500): Promise<UserProfile | null> {
        if (!pubkey) { return null; }

        return new Promise((resolve) => {
            let settled = false;
            let subId = '';
            let timer: NodeJS.Timeout | undefined;

            const done = (profile: UserProfile | null) => {
                if (settled) { return; }
                settled = true;
                if (timer) { clearTimeout(timer); }
                if (subId) { this.unsubscribe(subId); }
                resolve(profile);
            };

            const cached = this.profiles.get(pubkey);
            if (cached) {
                done(cached);
                return;
            }

            subId = this.subscribe({ kinds: [METADATA_KIND], authors: [pubkey], limit: 1 }, (event) => {
                if (!event || event.kind !== METADATA_KIND || event.pubkey !== pubkey) { return; }
                try {
                    const profile = JSON.parse(event.content || '{}') as UserProfile;
                    this.profiles.set(pubkey, profile);
                    done(profile);
                } catch {
                    done(null);
                }
            });

            timer = setTimeout(() => {
                done(this.profiles.get(pubkey) || null);
            }, timeoutMs);
        });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // RELAY CONNECTION
    // ——————————————————————————————————————————————————————————————————————————————————————————

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
                this._relayRetryCount.delete(url); // reset retry count on success
                this.relays.set(url, ws);
                this._onRelayChange.fire(this.relays.size);
                // Re-subscribe on reconnect
                for (const [subId, cb] of this.subscriptions) {
                    // Re-calculate filter for this subscription if possible, 
                    // but here we rely on the fact that we don't store the filter in the map.
                    // WAIT: We need to store the filter to resubscribe!
                    // The previous code had a BUG here too:
                    // for (const [subId, _cb] of this.subscriptions) { ... }
                    // It sent a hardcoded 'ouroboros' filter for ALL subscriptions. 
                    // We must fix this to store filters.
                }
                
                // FIXED: Resend all active subscriptions with their specific filters
                this.resubscribeAll(ws);
            });

            ws.on('message', (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg[0] === 'EVENT' && msg[2]) {
                        const event = msg[2] as NostrEvent;
                        // Block filter — drop events from blocked users
                        if (this.blockedUsers.has(event.pubkey)) { return; }
                        // Cache profile metadata
                        if (event.kind === METADATA_KIND) {
                            try {
                                const profile = JSON.parse(event.content);
                                this.profiles.set(event.pubkey, profile);
                                this.trimMap(this.profiles, NostrService.MAX_PROFILES);
                            } catch { /* malformed profile */ }
                        }
                        // Handle DMs separately (decrypt)
                        if (event.kind === DM_KIND) {
                            this.handleIncomingDM(event);
                            return;
                        }
                        // Handle presence
                        if (event.kind === PRESENCE_KIND) {
                            this.onlineUsers.set(event.pubkey, event.created_at);
                            this._onPresence.fire({ pubkey: event.pubkey, online: true, ts: event.created_at });
                            return;
                        }
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
                this._onRelayChange.fire(this.relays.size);
                // Reconnect after 5s (max retries to prevent infinite churn)
                const retries = (this._relayRetryCount.get(url) || 0) + 1;
                this._relayRetryCount.set(url, retries);
                if (retries > NostrService.MAX_RELAY_RETRIES) {
                    console.warn(`[Nostr] Relay ${url} exceeded ${NostrService.MAX_RELAY_RETRIES} retries — giving up`);
                    return;
                }
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

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // SUBSCRIBE
    // ——————————————————————————————————————————————————————————————————————————————————————————

    // Store filters to allow re-subscription on reconnect
    private subscriptionFilters: Map<string, NostrFilter> = new Map();

    subscribe(filter: NostrFilter, callback: NostrEventCallback): string {
        const subId = 'sub_' + Math.random().toString(36).slice(2, 10);
        this.subscriptions.set(subId, callback);
        this.subscriptionFilters.set(subId, filter);
        this.eventCallbacks.push(callback);

        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, JSON.stringify(['REQ', subId, filter]));
        }

        return subId;
    }

    unsubscribe(subId: string): void {
        const cb = this.subscriptions.get(subId);
        this.subscriptions.delete(subId);
        this.subscriptionFilters.delete(subId);
        if (cb) {
            this.eventCallbacks = this.eventCallbacks.filter((fn) => fn !== cb);
        }
        
        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, JSON.stringify(['CLOSE', subId]));
        }
    }

    private resubscribeAll(ws: WebSocket) {
        for (const [subId, filter] of this.subscriptionFilters) {
            this.sendToRelay(ws, JSON.stringify(['REQ', subId, filter]));
        }
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // EVENT CREATION & SIGNING
    // ——————————————————————————————————————————————————————————————————————————————————————————

    private async signEvent(event: Omit<NostrEvent, 'id' | 'sig'>): Promise<NostrEvent> {
        if (!this.privateKey) { throw new Error('Nostr not initialized'); }

        const template = {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content
        };

        const signed = nostrTools.finalizeEvent(template, this.privateKey);
        return signed as NostrEvent;
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // PUBLISH DOCUMENT (multi-doc marketplace with schema validation)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async publishDocument(
        docType: string,
        name: string,
        description: string,
        body: string,
        tags: string[],
        meta?: { category?: string; version?: string; complexity?: string; estTime?: string;
                 bodyFormat?: string; gistUrl?: string; gistId?: string }
    ): Promise<NostrEvent> {
        if (!this._privacy.marketplaceEnabled) {
            throw new Error('Marketplace publishing is disabled in privacy settings');
        }

        const resolvedType = VALID_DOC_TYPES.includes(docType as DocType) ? docType : 'workflow';
        const bodyFormat = meta?.bodyFormat || DOC_SCHEMA_RULES[resolvedType as DocType]?.defaultBodyFormat || 'text';
        const category = meta?.category || 'other';
        const version  = meta?.version  || '1.0.0';
        const complexity = meta?.complexity || 'moderate';
        const estTime = meta?.estTime || 'fast';
        const gistUrl = meta?.gistUrl || '';
        const gistId = meta?.gistId || '';

        // Schema validation — reject invalid documents before signing
        const validation = validateDocument({ docType: resolvedType, name, description, version, body, bodyFormat, tags });
        if (!validation.valid) {
            throw new Error(`Document validation failed:\n${validation.errors.join('\n')}`);
        }

        // Safety scan — block publish if critical patterns found
        const scan = scanDocumentSafety({ name, description, body, tags });
        if (!scan.safe) {
            const criticals = scan.flags.filter(f => f.severity === 'critical');
            throw new Error(`Document blocked by safety scanner:\n${criticals.map(f => `[${f.pattern}] ${f.match} (in ${f.location})`).join('\n')}`);
        }

        // Auto-redact the description
        const { redacted: safeDesc } = this.redact(description);
        const { hex: contentDigestHex, cid: contentCID } = computeContentDigest(body);

        // Generate safety attestation with CID
        const attestation = createSafetyAttestation(this.publicKey, contentCID, scan, resolvedType);

        const nostrTags: string[][] = [
            ['t', 'ouroboros'],
            ['t', 'ouroboros-doc'],
            ['t', `ouroboros-${resolvedType}`],
            ['d', name.toLowerCase().replace(/\s+/g, '-')],
            ['title', name],
            ['summary', safeDesc],
            ['c', category],
            ...tags.map(t => ['t', t]),
            // IPFS CID for content verification
            ['i', contentCID],
            // NIP-57 zap split: creator 80%, platform 20% (platform = self until configured)
            ...NostrService.buildZapSplitTags(this.publicKey)
        ];

        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: OUROBOROS_WORKFLOW_KIND,
            tags: nostrTags,
            content: JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                docType: resolvedType,
                name,
                description: safeDesc,
                body,
                bodyFormat,
                version,
                category,
                complexity,
                estTime,
                contentDigest: contentDigestHex,
                contentCID,
                safetyAttestation: attestation.uid,
                ...(gistUrl ? { gistUrl } : {}),
                ...(gistId ? { gistId } : {})
            })
        });

        await this.broadcast(event);

        // Award reputation points
        this.addReputation(this.publicKey, 'PUBLISH_DOC');
        if (scan.flags.length === 0) {
            this.addReputation(this.publicKey, 'CLEAN_SCAN');
        } else {
            this.addReputation(this.publicKey, 'FLAGGED_SCAN');
        }

        return event;
    }

    // Backward-compat wrapper — existing callers pass workflowJson as body
    async publishWorkflow(
        name: string,
        description: string,
        workflowJson: string,
        tags: string[],
        meta?: { category?: string; version?: string; complexity?: string; estTime?: string; gistUrl?: string; gistId?: string }
    ): Promise<NostrEvent> {
        return this.publishDocument('workflow', name, description, workflowJson, tags, { ...meta, bodyFormat: 'json' });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // PUBLISH CHAT MESSAGE
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async publishChat(message: string): Promise<NostrEvent> {
        if (!this._privacy.chatEnabled) {
            throw new Error('Public chat is disabled in privacy settings');
        }
        // Auto-redact sensitive data
        const { redacted, wasRedacted, matches } = this.redact(message);
        if (wasRedacted) {
            console.log(`[Nostr] Auto-redacted: ${matches.join(', ')}`);
        }
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: CHAT_KIND,
            tags: [
                ['t', 'ouroboros'],
                ['t', 'ouroboros-chat']
            ],
            content: redacted
        });

        await this.broadcast(event);
        return event;
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // ENCRYPTED DIRECT MESSAGES (NIP-04)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async sendDM(recipientPubkey: string, message: string): Promise<NostrEvent> {
        if (!this._privacy.dmsEnabled) {
            throw new Error('Direct messages are disabled in privacy settings');
        }
        if (!this.privateKey) { throw new Error('Nostr not initialized'); }
        if (this.blockedUsers.has(recipientPubkey)) {
            throw new Error('Cannot send DM to blocked user');
        }
        // Auto-redact even in DMs (user might accidentally paste creds)
        const { redacted } = this.redact(message);
        const nip04 = nostrTools.nip04 || require('nostr-tools/nip04');
        const encrypted = await nip04.encrypt(this.privateKey, recipientPubkey, redacted);

        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: DM_KIND,
            tags: [
                ['p', recipientPubkey]
            ],
            content: encrypted
        });

        await this.broadcast(event);
        return event;
    }

    private async handleIncomingDM(event: NostrEvent): Promise<void> {
        if (!this._privacy.dmsEnabled) { return; }
        if (!this.privateKey) { return; }
        // Only process DMs addressed to us or sent by us
        const isToUs = event.tags.some(t => t[0] === 'p' && t[1] === this.publicKey);
        const isFromUs = event.pubkey === this.publicKey;
        if (!isToUs && !isFromUs) { return; }

        try {
            const nip04 = nostrTools.nip04 || require('nostr-tools/nip04');
            const senderPubkey = isFromUs
                ? event.tags.find(t => t[0] === 'p')?.[1] || ''
                : event.pubkey;
            const decrypted = await nip04.decrypt(this.privateKey, senderPubkey, event.content);
            this._onDM.fire({ event, decrypted });
        } catch (err) {
            console.error('[Nostr] Failed to decrypt DM:', err);
        }
    }

    fetchDMs(): void {
        if (!this._privacy.dmsEnabled) { return; }
        if (this.dmSubId) { this.unsubscribe(this.dmSubId); }

        const filter: NostrFilter = {
            kinds: [DM_KIND],
            '#p': [this.publicKey],
            limit: 100
        };
        this.dmSubId = this.subscribe(filter, (_event) => {
            // Handled by message listener → handleIncomingDM
        });

        // Also fetch DMs we sent
        const sentFilter: NostrFilter = {
            kinds: [DM_KIND],
            authors: [this.publicKey],
            limit: 100
        };
        this.subscribe(sentFilter, (_event) => {});
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // EVENT DELETION (NIP-09)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async deleteEvent(eventId: string, reason?: string): Promise<NostrEvent> {
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: DELETION_KIND,
            tags: [['e', eventId]],
            content: reason || ''
        });
        await this.broadcast(event);
        return event;
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // CHAT REACTIONS (kind 7 on specific messages)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async reactToChat(eventId: string, eventPubkey: string, emoji: string = '+'): Promise<NostrEvent> {
        return this.reactToEvent(eventId, eventPubkey, emoji);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // NIP-57 LIGHTNING ZAPS
    // Zap Request (kind 9734): signed by sender, sent to recipient's LNURL callback
    // Zap Receipt (kind 9735): created by the LNURL server after invoice is paid
    // ——————————————————————————————————————————————————————————————————————————————————————————

    private zapTotals: Map<string, number> = new Map(); // eventId -> total sats
    private _onZapReceipt = new vscode.EventEmitter<{ eventId: string; senderPubkey: string; amountMsats: number; receipt: NostrEvent }>();
    public readonly onZapReceipt = this._onZapReceipt.event;

    // Build zap split tags for marketplace listings: creator gets 80%, platform gets 20%
    static buildZapSplitTags(creatorPubkey: string, platformPubkey?: string): string[][] {
        const tags: string[][] = [
            ['zap', creatorPubkey, 'wss://relay.damus.io', '80'],
        ];
        if (platformPubkey) {
            tags.push(['zap', platformPubkey, 'wss://relay.damus.io', '20']);
        }
        return tags;
    }

    // Create a NIP-57 zap request event (kind 9734)
    // This is signed locally and then sent to the recipient's LNURL callback
    async createZapRequest(
        recipientPubkey: string,
        eventId: string,
        amountMsats: number,
        comment: string = '',
        relays?: string[]
    ): Promise<NostrEvent> {
        const zapRelays = relays || Array.from(this.relays.keys()).slice(0, 3);

        const zapTags: string[][] = [
            ['p', recipientPubkey],
            ['e', eventId],
            ['amount', amountMsats.toString()],
            ['relays', ...zapRelays],
        ];

        const zapRequest = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: ZAP_REQUEST_KIND,
            tags: zapTags,
            content: comment
        });

        // Award reputation for sending a zap
        this.addReputation(this.publicKey, 'SEND_ZAP');

        return zapRequest;
    }

    // Resolve a Lightning address (lud16) to its LNURL pay endpoint
    async resolveLud16(lud16: string): Promise<{ callback: string; minSendable: number; maxSendable: number; allowsNostr: boolean; nostrPubkey?: string } | null> {
        try {
            const [name, domain] = lud16.split('@');
            if (!name || !domain) { return null; }
            const url = `https://${domain}/.well-known/lnurlp/${name}`;
            const resp = await fetch(url);
            if (!resp.ok) { return null; }
            const data: any = await resp.json();
            return {
                callback: data.callback || '',
                minSendable: data.minSendable || 1000,
                maxSendable: data.maxSendable || 100000000,
                allowsNostr: !!data.allowsNostr,
                nostrPubkey: data.nostrPubkey
            };
        } catch {
            return null;
        }
    }

    // Request a Lightning invoice from the recipient's LNURL callback with the zap request attached
    async requestZapInvoice(
        lnurlCallback: string,
        zapRequest: NostrEvent,
        amountMsats: number
    ): Promise<string | null> {
        try {
            const encoded = encodeURIComponent(JSON.stringify(zapRequest));
            const url = `${lnurlCallback}?amount=${amountMsats}&nostr=${encoded}`;
            const resp = await fetch(url);
            if (!resp.ok) { return null; }
            const data: any = await resp.json();
            return data.pr || null; // BOLT-11 payment request
        } catch {
            return null;
        }
    }

    // Handle incoming zap receipt events (kind 9735)
    handleZapReceipt(event: NostrEvent): void {
        if (event.kind !== ZAP_RECEIPT_KIND) { return; }

        // Extract zapped event ID and amount
        const eTag = event.tags.find(t => t[0] === 'e');
        const descTag = event.tags.find(t => t[0] === 'description');
        const bolt11Tag = event.tags.find(t => t[0] === 'bolt11');

        if (!eTag) { return; }
        const eventId = eTag[1];

        // Parse amount from the zap request description
        let amountMsats = 0;
        let senderPubkey = '';
        if (descTag) {
            try {
                const zapReq = JSON.parse(descTag[1]);
                senderPubkey = zapReq.pubkey || '';
                const amtTag = (zapReq.tags || []).find((t: string[]) => t[0] === 'amount');
                if (amtTag) { amountMsats = parseInt(amtTag[1], 10) || 0; }
            } catch { /* ignore parse errors */ }
        }

        // Update totals (bounded)
        const current = this.zapTotals.get(eventId) || 0;
        this.zapTotals.set(eventId, current + Math.floor(amountMsats / 1000));
        this.trimMap(this.zapTotals, NostrService.MAX_ZAP_TOTALS);

        // Award reputation to recipient
        const pTag = event.tags.find(t => t[0] === 'p');
        if (pTag) {
            const satsAmount = Math.floor(amountMsats / 1000);
            const repMultiplier = Math.floor(satsAmount / 100); // 1 rep point per 100 sats
            if (repMultiplier > 0) {
                this.addReputation(pTag[1], 'RECEIVE_ZAP', repMultiplier);
            }
        }

        this._onZapReceipt.fire({ eventId, senderPubkey, amountMsats, receipt: event });
    }

    getZapTotal(eventId: string): number {
        return this.zapTotals.get(eventId) || 0;
    }

    // Subscribe to zap receipts for our events
    fetchZapReceipts(): void {
        const filter: NostrFilter = {
            kinds: [ZAP_RECEIPT_KIND],
            '#p': [this.publicKey],
            limit: 100
        };
        this.subscribe(filter, (event) => {
            this.handleZapReceipt(event);
        });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // NIP-15 MARKETPLACE COMMERCE (Stalls & Products)
    // Stall (kind 30017): merchant storefront with shipping/payment info
    // Product (kind 30018): individual listing with price, currency, images
    // Checkout: buyer sends order via NIP-04 encrypted DM to merchant
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async createStall(stall: {
        name: string; description: string; currency: string;
        shipping?: Array<{ id: string; name: string; cost: number; regions: string[] }>;
    }): Promise<NostrEvent> {
        const stallId = 'ouroboros-stall-' + Date.now();
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: STALL_KIND,
            tags: [
                ['d', stallId],
                ['t', 'ouroboros'],
                ['t', 'ouroboros-stall'],
            ],
            content: JSON.stringify({
                id: stallId,
                name: stall.name,
                description: stall.description,
                currency: stall.currency || 'sat',
                shipping: stall.shipping || [{ id: 'digital', name: 'Digital Delivery', cost: 0, regions: ['worldwide'] }],
            })
        });
        await this.broadcast(event);
        return event;
    }

    async createProduct(product: {
        stallId: string; name: string; description: string;
        price: number; currency?: string; quantity?: number;
        images?: string[]; categories?: string[];
        docType?: string; docEventId?: string;
    }): Promise<NostrEvent> {
        const productId = 'ouroboros-product-' + Date.now();
        const tags: string[][] = [
            ['d', productId],
            ['t', 'ouroboros'],
            ['t', 'ouroboros-product'],
        ];
        if (product.categories) {
            product.categories.forEach(c => tags.push(['t', c]));
        }
        if (product.docEventId) {
            tags.push(['e', product.docEventId]); // link to the marketplace doc event
        }

        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: PRODUCT_KIND,
            tags,
            content: JSON.stringify({
                id: productId,
                stall_id: product.stallId,
                name: product.name,
                description: product.description,
                price: product.price,
                currency: product.currency || 'sat',
                quantity: product.quantity ?? null,
                images: product.images || [],
                specs: [
                    ...(product.docType ? [['docType', product.docType]] : []),
                    ...(product.docEventId ? [['docEventId', product.docEventId]] : []),
                ],
            })
        });
        await this.broadcast(event);
        return event;
    }

    fetchStallsAndProducts(): void {
        // Fetch stalls
        const stallFilter: NostrFilter = {
            kinds: [STALL_KIND],
            '#t': ['ouroboros-stall'],
            limit: 50
        };
        this.subscribe(stallFilter, (_event) => {});

        // Fetch products
        const productFilter: NostrFilter = {
            kinds: [PRODUCT_KIND],
            '#t': ['ouroboros-product'],
            limit: 100
        };
        this.subscribe(productFilter, (_event) => {});
    }

    // Checkout: send purchase order to merchant via encrypted DM
    async initiateCheckout(merchantPubkey: string, order: {
        productId: string; productName: string; quantity: number;
        shippingId: string; totalSats: number; message?: string;
    }): Promise<NostrEvent> {
        const orderMsg = JSON.stringify({
            type: 'ouroboros-order',
            version: 1,
            productId: order.productId,
            productName: order.productName,
            quantity: order.quantity,
            shippingId: order.shippingId,
            totalSats: order.totalSats,
            message: order.message || '',
            timestamp: Math.floor(Date.now() / 1000)
        });
        return this.sendDM(merchantPubkey, orderMsg);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // PRESENCE HEARTBEAT
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async sendPresence(): Promise<void> {
        if (!this._privacy.presenceEnabled) { return; }
        if (!this.privateKey) { return; }
        const event = await this.signEvent({
            pubkey: this.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: PRESENCE_KIND,
            tags: [
                ['t', 'ouroboros'],
                ['t', 'ouroboros-presence']
            ],
            content: JSON.stringify({ status: 'online' })
        });
        await this.broadcast(event);
    }

    getOnlineUsers(): Array<{ pubkey: string; lastSeen: number }> {
        const now = Math.floor(Date.now() / 1000);
        const result: Array<{ pubkey: string; lastSeen: number }> = [];
        for (const [pubkey, ts] of this.onlineUsers) {
            // Consider online if seen in last 5 minutes
            if (now - ts < 300) {
                result.push({ pubkey, lastSeen: ts });
            } else {
                // Prune stale entries to prevent unbounded growth
                this.onlineUsers.delete(pubkey);
            }
        }
        return result;
    }

    startPresenceHeartbeat(): NodeJS.Timeout {
        // Send presence every 2 minutes
        this.sendPresence();
        return setInterval(() => this.sendPresence(), 120000);
    }

    fetchPresence(): void {
        const filter: NostrFilter = {
            kinds: [PRESENCE_KIND],
            '#t': ['ouroboros-presence'],
            since: Math.floor(Date.now() / 1000) - 300,
            limit: 50
        };
        this.presenceSubId = this.subscribe(filter, (_event) => {});
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // REACT TO EVENT
    // ——————————————————————————————————————————————————————————————————————————————————————————

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

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // BROADCAST TO ALL RELAYS
    // ——————————————————————————————————————————————————————————————————————————————————————————

    private async broadcast(event: NostrEvent): Promise<void> {
        const msg = JSON.stringify(['EVENT', event]);
        for (const [_url, ws] of this.relays) {
            this.sendToRelay(ws, msg);
        }
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // FETCH MARKETPLACE DOCUMENTS (backward compat: catches old workflow + new doc events)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    fetchWorkflows(until?: number): void {
        if (this.workflowSubId) {
            this.unsubscribe(this.workflowSubId);
        }

        const filter: NostrFilter = {
            kinds: [OUROBOROS_WORKFLOW_KIND],
            '#t': ['ouroboros'],
            limit: 25,
            ...(until ? { until } : {})
        };

        this.workflowSubId = this.subscribe(filter, (_event) => {
            // Event handled by global onEvent emitter
        });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // FETCH CHAT
    // ——————————————————————————————————————————————————————————————————————————————————————————

    fetchChat(since?: number): void {
        if (this.chatSubId) {
            this.unsubscribe(this.chatSubId);
        }

        const filter: NostrFilter = {
            kinds: [CHAT_KIND, REACTION_KIND],
            '#t': ['ouroboros-chat'],
            limit: 100,
            ...(since ? { since } : {})
        };

        // Use subscribe so it auto-replays when relays connect
        this.chatSubId = this.subscribe(filter, (_event) => {
            // Event handled by global onEvent emitter
        });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // CLEANUP
    // ——————————————————————————————————————————————————————————————————————————————————————————

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
        this._onRelayChange.dispose();
        this._onDM.dispose();
        this._onPresence.dispose();
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