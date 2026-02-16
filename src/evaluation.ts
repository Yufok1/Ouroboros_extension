// ══════════════════════════════════════════════════════════════════════════════
// Cross-Model Evaluation Metrics
// Track inference quality per model, per slot, per council combination.
// A/B testing, latency tracking, consistency scoring.
//
// No external dependencies — uses MCP tools (compare, invoke_slot) and
// local computation. Stores evaluation history in VS Code globalState.
// ══════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface InferenceRecord {
    id: string;
    slotId: number;
    model: string;
    toolName: string;
    inputHash: string;        // SHA-256 of input (privacy-safe)
    inputPreview: string;     // first 80 chars
    outputHash: string;       // SHA-256 of output
    outputPreview: string;    // first 120 chars
    latencyMs: number;
    timestamp: number;
    success: boolean;
    errorMessage?: string;
}

export interface EvaluationMetrics {
    slotId: number;
    model: string;
    totalCalls: number;
    successRate: number;       // 0-1
    avgLatencyMs: number;
    p95LatencyMs: number;
    minLatencyMs: number;
    maxLatencyMs: number;
    consistencyScore: number;  // 0-1 (same input → same output)
    throughput: number;        // calls per minute (last 10 min window)
    lastActive: number;
    errorRate: number;         // 0-1
}

export interface CouncilMetrics {
    slotIds: number[];
    models: string[];
    consensusRate: number;     // how often slots agree (0-1)
    avgLatencyMs: number;
    diversityScore: number;    // output variance (0-1, higher = more diverse)
    bestSlot: number;          // slot with highest consistency
    totalEvaluations: number;
}

export interface ComparisonResult {
    slotA: { id: number; model: string; metrics: EvaluationMetrics };
    slotB: { id: number; model: string; metrics: EvaluationMetrics };
    winner: 'A' | 'B' | 'tie';
    reasoning: string;
    testCount: number;
    agreementRate: number;     // how often they gave same answer
}

export interface ABTestResult {
    input: string;
    slotA: { id: number; output: string; latencyMs: number };
    slotB: { id: number; output: string; latencyMs: number };
    outputsMatch: boolean;
    latencyDiff: number;
    timestamp: number;
}

export interface SlotComboScore {
    slots: number[];
    models: string[];
    score: number;             // composite: consistency × (1/latency) × successRate
    sampleSize: number;
}

// ── Inference tools we track ────────────────────────────────────────────────

const TRACKED_TOOLS = new Set([
    'forward', 'infer', 'generate', 'classify', 'rerank',
    'embed_text', 'deliberate', 'imagine', 'invoke_slot',
    'compare', 'debate', 'chain', 'all_slots'
]);

// ── ModelEvaluator ──────────────────────────────────────────────────────────

export class ModelEvaluator {
    private records: InferenceRecord[] = [];
    private slotModels: Map<number, string> = new Map();
    private context: vscode.ExtensionContext;
    private maxRecords: number;

    constructor(context: vscode.ExtensionContext, maxRecords: number = 5000) {
        this.context = context;
        this.maxRecords = maxRecords;
        this.load();
    }

    // ── Persistence ─────────────────────────────────────────────────────

    private load(): void {
        const saved = this.context.globalState.get<InferenceRecord[]>('champion.evaluation.records');
        if (saved && Array.isArray(saved)) {
            this.records = saved;
        }
        const models = this.context.globalState.get<[number, string][]>('champion.evaluation.slotModels');
        if (models && Array.isArray(models)) {
            this.slotModels = new Map(models);
        }
    }

    private save(): void {
        // Trim if over limit
        if (this.records.length > this.maxRecords) {
            this.records = this.records.slice(-this.maxRecords);
        }
        this.context.globalState.update('champion.evaluation.records', this.records);
        this.context.globalState.update('champion.evaluation.slotModels', [...this.slotModels.entries()]);
    }

    // ── Track which model is in which slot ──────────────────────────────

    registerSlot(slotId: number, modelName: string): void {
        this.slotModels.set(slotId, modelName);
        this.save();
    }

    getSlotModel(slotId: number): string {
        return this.slotModels.get(slotId) || 'unknown';
    }

    // ── Check if a tool should be tracked ───────────────────────────────

    isTrackedTool(toolName: string): boolean {
        return TRACKED_TOOLS.has(toolName);
    }

    // ── Record an inference ─────────────────────────────────────────────

    record(
        slotId: number,
        toolName: string,
        input: string,
        output: string,
        latencyMs: number,
        success: boolean = true,
        errorMessage?: string
    ): InferenceRecord {
        const record: InferenceRecord = {
            id: crypto.randomUUID(),
            slotId,
            model: this.getSlotModel(slotId),
            toolName,
            inputHash: hash(input),
            inputPreview: input.slice(0, 80),
            outputHash: hash(output),
            outputPreview: output.slice(0, 120),
            latencyMs,
            timestamp: Date.now(),
            success,
            errorMessage
        };
        this.records.push(record);
        this.save();
        return record;
    }

    // ── Per-Slot Evaluation ─────────────────────────────────────────────

    evaluate(slotId: number): EvaluationMetrics {
        const slotRecords = this.records.filter(r => r.slotId === slotId);
        if (slotRecords.length === 0) {
            return emptyMetrics(slotId, this.getSlotModel(slotId));
        }

        const successful = slotRecords.filter(r => r.success);
        const latencies = successful.map(r => r.latencyMs).sort((a, b) => a - b);
        const now = Date.now();
        const tenMinAgo = now - 600_000;
        const recentCalls = slotRecords.filter(r => r.timestamp > tenMinAgo).length;

        // Consistency: for repeated inputs, how often is the output the same?
        const inputGroups = new Map<string, string[]>();
        for (const r of successful) {
            const existing = inputGroups.get(r.inputHash) || [];
            existing.push(r.outputHash);
            inputGroups.set(r.inputHash, existing);
        }
        let consistentPairs = 0;
        let totalPairs = 0;
        for (const outputs of inputGroups.values()) {
            if (outputs.length < 2) { continue; }
            for (let i = 0; i < outputs.length; i++) {
                for (let j = i + 1; j < outputs.length; j++) {
                    totalPairs++;
                    if (outputs[i] === outputs[j]) { consistentPairs++; }
                }
            }
        }
        const consistency = totalPairs > 0 ? consistentPairs / totalPairs : 1;

        return {
            slotId,
            model: this.getSlotModel(slotId),
            totalCalls: slotRecords.length,
            successRate: successful.length / slotRecords.length,
            avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
            p95LatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0,
            minLatencyMs: latencies.length > 0 ? latencies[0] : 0,
            maxLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
            consistencyScore: consistency,
            throughput: recentCalls / 10, // per minute
            lastActive: slotRecords[slotRecords.length - 1].timestamp,
            errorRate: 1 - (successful.length / slotRecords.length)
        };
    }

    // ── Council-wide evaluation ─────────────────────────────────────────

    evaluateCouncil(slotIds: number[]): CouncilMetrics {
        const metrics = slotIds.map(id => this.evaluate(id));
        const activeMetrics = metrics.filter(m => m.totalCalls > 0);

        if (activeMetrics.length === 0) {
            return {
                slotIds,
                models: slotIds.map(id => this.getSlotModel(id)),
                consensusRate: 0,
                avgLatencyMs: 0,
                diversityScore: 0,
                bestSlot: slotIds[0] || 0,
                totalEvaluations: 0
            };
        }

        // Consensus: for same inputs across slots, how often do they agree?
        const inputToSlotOutputs = new Map<string, Map<number, string>>();
        for (const r of this.records.filter(r => slotIds.includes(r.slotId) && r.success)) {
            if (!inputToSlotOutputs.has(r.inputHash)) {
                inputToSlotOutputs.set(r.inputHash, new Map());
            }
            inputToSlotOutputs.get(r.inputHash)!.set(r.slotId, r.outputHash);
        }

        let agreements = 0;
        let comparisons = 0;
        for (const slotOutputs of inputToSlotOutputs.values()) {
            if (slotOutputs.size < 2) { continue; }
            const outputs = [...slotOutputs.values()];
            for (let i = 0; i < outputs.length; i++) {
                for (let j = i + 1; j < outputs.length; j++) {
                    comparisons++;
                    if (outputs[i] === outputs[j]) { agreements++; }
                }
            }
        }

        const avgLatency = activeMetrics.reduce((s, m) => s + m.avgLatencyMs, 0) / activeMetrics.length;
        const diversityScore = comparisons > 0 ? 1 - (agreements / comparisons) : 0;
        const bestSlot = activeMetrics.reduce((best, m) =>
            m.consistencyScore > best.consistencyScore ? m : best
        ).slotId;

        return {
            slotIds,
            models: slotIds.map(id => this.getSlotModel(id)),
            consensusRate: comparisons > 0 ? agreements / comparisons : 0,
            avgLatencyMs: avgLatency,
            diversityScore,
            bestSlot,
            totalEvaluations: activeMetrics.reduce((s, m) => s + m.totalCalls, 0)
        };
    }

    // ── Compare two slots ───────────────────────────────────────────────

    compare(slotA: number, slotB: number): ComparisonResult {
        const metricsA = this.evaluate(slotA);
        const metricsB = this.evaluate(slotB);

        // Find shared inputs
        const aOutputs = new Map<string, string>();
        const bOutputs = new Map<string, string>();
        for (const r of this.records.filter(r => r.success)) {
            if (r.slotId === slotA) { aOutputs.set(r.inputHash, r.outputHash); }
            if (r.slotId === slotB) { bOutputs.set(r.inputHash, r.outputHash); }
        }

        let agreements = 0;
        let sharedInputs = 0;
        for (const [input, outputA] of aOutputs) {
            const outputB = bOutputs.get(input);
            if (outputB !== undefined) {
                sharedInputs++;
                if (outputA === outputB) { agreements++; }
            }
        }

        const scoreA = compositeScore(metricsA);
        const scoreB = compositeScore(metricsB);
        const diff = Math.abs(scoreA - scoreB);
        const winner: 'A' | 'B' | 'tie' = diff < 0.05 ? 'tie' : scoreA > scoreB ? 'A' : 'B';

        const reasons: string[] = [];
        if (metricsA.avgLatencyMs < metricsB.avgLatencyMs) {
            reasons.push(`Slot ${slotA} is ${Math.round(metricsB.avgLatencyMs - metricsA.avgLatencyMs)}ms faster`);
        } else if (metricsB.avgLatencyMs < metricsA.avgLatencyMs) {
            reasons.push(`Slot ${slotB} is ${Math.round(metricsA.avgLatencyMs - metricsB.avgLatencyMs)}ms faster`);
        }
        if (metricsA.consistencyScore > metricsB.consistencyScore) {
            reasons.push(`Slot ${slotA} is more consistent (${(metricsA.consistencyScore * 100).toFixed(0)}% vs ${(metricsB.consistencyScore * 100).toFixed(0)}%)`);
        } else if (metricsB.consistencyScore > metricsA.consistencyScore) {
            reasons.push(`Slot ${slotB} is more consistent`);
        }
        if (metricsA.successRate > metricsB.successRate) {
            reasons.push(`Slot ${slotA} has higher success rate`);
        } else if (metricsB.successRate > metricsA.successRate) {
            reasons.push(`Slot ${slotB} has higher success rate`);
        }

        return {
            slotA: { id: slotA, model: metricsA.model, metrics: metricsA },
            slotB: { id: slotB, model: metricsB.model, metrics: metricsB },
            winner,
            reasoning: reasons.length > 0 ? reasons.join('. ') : 'Insufficient data for comparison',
            testCount: sharedInputs,
            agreementRate: sharedInputs > 0 ? agreements / sharedInputs : 0
        };
    }

    // ── Find best council combination ───────────────────────────────────

    getBestCombo(maxSlots: number = 3): SlotComboScore | null {
        const activeSlots = [...this.slotModels.keys()].filter(
            id => this.records.some(r => r.slotId === id && r.success)
        );

        if (activeSlots.length === 0) { return null; }
        if (activeSlots.length <= maxSlots) {
            const council = this.evaluateCouncil(activeSlots);
            return {
                slots: activeSlots,
                models: activeSlots.map(id => this.getSlotModel(id)),
                score: council.consensusRate * 0.4 + (1 - council.diversityScore) * 0.3 +
                       (1 / (1 + council.avgLatencyMs / 1000)) * 0.3,
                sampleSize: council.totalEvaluations
            };
        }

        // Try all combinations of maxSlots from activeSlots
        const combos = combinations(activeSlots, maxSlots);
        let best: SlotComboScore | null = null;

        for (const combo of combos) {
            const council = this.evaluateCouncil(combo);
            const score = council.consensusRate * 0.4 +
                         (1 - council.diversityScore) * 0.3 +
                         (1 / (1 + council.avgLatencyMs / 1000)) * 0.3;
            if (!best || score > best.score) {
                best = {
                    slots: combo,
                    models: combo.map(id => this.getSlotModel(id)),
                    score,
                    sampleSize: council.totalEvaluations
                };
            }
        }
        return best;
    }

    // ── History ─────────────────────────────────────────────────────────

    getHistory(slotId?: number, limit: number = 50): InferenceRecord[] {
        let filtered = slotId !== undefined
            ? this.records.filter(r => r.slotId === slotId)
            : this.records;
        return filtered.slice(-limit);
    }

    // ── All active slots ────────────────────────────────────────────────

    getActiveSlots(): number[] {
        return [...new Set(this.records.map(r => r.slotId))];
    }

    // ── Export ───────────────────────────────────────────────────────────

    exportReport(): string {
        const lines: string[] = ['# Council Evaluation Report', ''];
        const activeSlots = this.getActiveSlots();

        lines.push(`**Total records**: ${this.records.length}`);
        lines.push(`**Active slots**: ${activeSlots.length}`);
        lines.push(`**Report generated**: ${new Date().toISOString()}`);
        lines.push('');

        for (const slotId of activeSlots) {
            const m = this.evaluate(slotId);
            lines.push(`## Slot ${slotId}: ${m.model}`);
            lines.push(`| Metric | Value |`);
            lines.push(`|--------|-------|`);
            lines.push(`| Total calls | ${m.totalCalls} |`);
            lines.push(`| Success rate | ${(m.successRate * 100).toFixed(1)}% |`);
            lines.push(`| Avg latency | ${m.avgLatencyMs.toFixed(0)}ms |`);
            lines.push(`| P95 latency | ${m.p95LatencyMs.toFixed(0)}ms |`);
            lines.push(`| Consistency | ${(m.consistencyScore * 100).toFixed(1)}% |`);
            lines.push(`| Throughput | ${m.throughput.toFixed(1)} calls/min |`);
            lines.push('');
        }

        if (activeSlots.length >= 2) {
            const council = this.evaluateCouncil(activeSlots);
            lines.push('## Council Summary');
            lines.push(`| Metric | Value |`);
            lines.push(`|--------|-------|`);
            lines.push(`| Consensus rate | ${(council.consensusRate * 100).toFixed(1)}% |`);
            lines.push(`| Diversity score | ${(council.diversityScore * 100).toFixed(1)}% |`);
            lines.push(`| Best slot | ${council.bestSlot} (${this.getSlotModel(council.bestSlot)}) |`);
            lines.push('');
        }

        const best = this.getBestCombo();
        if (best) {
            lines.push('## Recommended Combo');
            lines.push(`Slots: ${best.slots.join(', ')} (${best.models.join(', ')})`);
            lines.push(`Score: ${best.score.toFixed(3)} (sample: ${best.sampleSize})`);
        }

        return lines.join('\n');
    }

    // ── Clear ───────────────────────────────────────────────────────────

    clear(): void {
        this.records = [];
        this.save();
    }
}

// ── Utility functions ───────────────────────────────────────────────────────

function hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function emptyMetrics(slotId: number, model: string): EvaluationMetrics {
    return {
        slotId, model, totalCalls: 0, successRate: 0, avgLatencyMs: 0,
        p95LatencyMs: 0, minLatencyMs: 0, maxLatencyMs: 0, consistencyScore: 0,
        throughput: 0, lastActive: 0, errorRate: 0
    };
}

function compositeScore(m: EvaluationMetrics): number {
    return m.consistencyScore * 0.4 +
           m.successRate * 0.3 +
           (1 / (1 + m.avgLatencyMs / 1000)) * 0.3;
}

function combinations<T>(arr: T[], k: number): T[][] {
    if (k === 0) { return [[]]; }
    if (arr.length < k) { return []; }
    const result: T[][] = [];
    for (let i = 0; i <= arr.length - k; i++) {
        const rest = combinations(arr.slice(i + 1), k - 1);
        for (const combo of rest) {
            result.push([arr[i], ...combo]);
        }
    }
    return result;
}
