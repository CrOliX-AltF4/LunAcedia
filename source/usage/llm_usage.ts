/**
 * LunAcedia's LLM usage ledger (ADR-021 P2, on the Core's model): every model call by day, caller, purpose and model —
 * tokens and an estimated cost in dollars. It MEASURES, it never blocks (D2): LunAcedia is a standalone product whose
 * owner manages spend at the provider; the ledger and its alerts make spend visible.
 *
 * Attribution without touching any signature: the HTTP layer runs each request inside withUsageContext({ caller,
 * purpose }) and every call below is recorded under it (AsyncLocalStorage). A call outside any context is recorded as
 * "unattributed" — visible, so a forgotten entry point shows.
 *
 * Persisted next to the other LunAcedia settings (STORAGE_DIR/llm_usage.json), 90 days kept.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Who asked: the Core (wired), the phone's topics, a direct API client (the app, the dashboard), a background pass. */
export type UsageCaller = "core" | "topics" | "api" | "background" | "unattributed";
export const USAGE_CALLERS: readonly UsageCaller[] = ["core", "topics", "api", "background", "unattributed"];

export interface UsageContext {
    caller: UsageCaller;
    /** What the call is for: "agent", "chat", "digest", "proposals", "intent", "topic_title"… */
    purpose: string;
}

const UNATTRIBUTED: UsageContext = { caller: "unattributed", purpose: "unknown" };
const als = new AsyncLocalStorage<UsageContext>();

/** Runs `fn` with calls attributed to `ctx`; a missing field is inherited from the enclosing context. */
export function withUsageContext<T>(ctx: Partial<UsageContext>, fn: () => T): T {
    const parent = als.getStore() ?? UNATTRIBUTED;
    return als.run({ caller: ctx.caller ?? parent.caller, purpose: ctx.purpose ?? parent.purpose }, fn);
}

export function currentUsageContext(): UsageContext {
    return als.getStore() ?? UNATTRIBUTED;
}

/** Names what a call is for, keeping the caller; outside any caller it counts as background. */
export function withUsagePurpose<T>(purpose: string, fn: () => T): T {
    const parent = currentUsageContext();
    return withUsageContext({ caller: parent.caller === "unattributed" ? "background" : parent.caller, purpose }, fn);
}

/** The caller of an agent request, from its declared callerId. */
export function callerOf(callerId: string | undefined): UsageCaller {
    if (callerId === "natsume-core") return "core";
    if (callerId === "topic") return "topics";
    return "api";
}

// ── Prices ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dollars per million tokens [input, output] — an estimate; override or complete with LLM_PRICES (JSON). */
const DEFAULT_PRICES: Record<string, [number, number]> = {
    "gpt-4o-mini": [0.15, 0.6],
    "gpt-4o": [2.5, 10],
    "gpt-4.1": [2, 8],
    "gpt-4.1-mini": [0.4, 1.6],
    "gpt-4.1-nano": [0.1, 0.4],
};

/** Local models cost nothing per token. */
export const LOCAL_MODEL_PREFIX = "ollama:";

export function priceOf(model: string, overrides: string | undefined = process.env["LLM_PRICES"]): [number, number] | null {
    if (model.startsWith(LOCAL_MODEL_PREFIX)) return [0, 0];
    if (overrides) {
        try {
            const p = (JSON.parse(overrides) as Record<string, unknown>)[model];
            if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && n >= 0)) {
                return [p[0] as number, p[1] as number];
            }
        } catch {
            // A malformed override never hides the defaults.
        }
    }
    return DEFAULT_PRICES[model] ?? null;
}

// ── Ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface UsageRow {
    /** Local day (TZ), YYYY-MM-DD. */
    day: string;
    caller: UsageCaller;
    purpose: string;
    model: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    /** Estimated dollars; null when the model has no known price. */
    costUsd: number | null;
}

export interface UsageDay {
    day: string;
    totalUsd: number;
    byCaller: Partial<Record<UsageCaller, number>>;
    calls: number;
    /** Calls whose model has no known price — their cost is not in the totals. */
    unpricedCalls: number;
}

export interface RecordedCall {
    at: number;
    model: string;
    context: UsageContext;
    costUsd: number | null;
}

const RETENTION_DAYS = 90;
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function defaultUsagePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "llm_usage.json");
}

export function localDay(at: number): string {
    return new Date(at).toLocaleDateString("sv-SE");
}

export class UsageLedger {
    private rows = new Map<string, UsageRow>();
    private recent: RecordedCall[] = [];
    private saving: Promise<void> = Promise.resolve();
    private dirty = false;
    private readonly listeners = new Set<(call: RecordedCall) => void>();

    /** No file = in memory only (tests); load(file) makes it persistent. */
    constructor(
        private filePath?: string,
        private readonly now: () => number = Date.now,
    ) {}

    async load(filePath?: string): Promise<void> {
        if (filePath) this.filePath = filePath;
        if (!this.filePath) return;
        try {
            const saved = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            for (const r of Array.isArray(saved) ? (saved as UsageRow[]) : []) {
                if (r && typeof r.day === "string" && typeof r.model === "string") this.rows.set(keyOf(r), r);
            }
        } catch {
            // Missing or unreadable: start empty.
        }
        this.prune();
    }

    onRecord(fn: (call: RecordedCall) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** One model call. Never throws: measuring must not break a call. */
    record(model: string, tokensIn: number, tokensOut: number, context: UsageContext = currentUsageContext()): void {
        try {
            const at = this.now();
            const price = priceOf(model);
            const costUsd = price ? (tokensIn * price[0] + tokensOut * price[1]) / 1_000_000 : null;
            const fresh: UsageRow = {
                day: localDay(at),
                caller: context.caller,
                purpose: context.purpose,
                model,
                calls: 0,
                tokensIn: 0,
                tokensOut: 0,
                costUsd: price ? 0 : null,
            };
            const key = keyOf(fresh);
            const row = this.rows.get(key) ?? fresh;
            row.calls += 1;
            row.tokensIn += tokensIn;
            row.tokensOut += tokensOut;
            if (costUsd !== null) row.costUsd = (row.costUsd ?? 0) + costUsd;
            this.rows.set(key, row);

            const call: RecordedCall = { at, model, context, costUsd };
            this.recent.push(call);
            while (this.recent.length && this.recent[0]!.at < at - RECENT_WINDOW_MS) this.recent.shift();

            this.persist();
            for (const fn of this.listeners) {
                try {
                    fn(call);
                } catch {
                    // A listener never breaks the measure.
                }
            }
        } catch (err) {
            console.warn("[Usage] could not record an LLM call:", (err as Error).message);
        }
    }

    /** Rows of the last `days` days (today included), newest day first. */
    list(days = 30): UsageRow[] {
        const from = localDay(this.now() - (days - 1) * 86_400_000);
        return [...this.rows.values()]
            .filter((r) => r.day >= from)
            .map((r) => ({ ...r }))
            .sort((a, b) => b.day.localeCompare(a.day) || (b.costUsd ?? 0) - (a.costUsd ?? 0));
    }

    day(day: string = localDay(this.now())): UsageDay {
        const out: UsageDay = { day, totalUsd: 0, byCaller: {}, calls: 0, unpricedCalls: 0 };
        for (const r of this.rows.values()) {
            if (r.day !== day) continue;
            out.calls += r.calls;
            if (r.costUsd === null) {
                out.unpricedCalls += r.calls;
                continue;
            }
            out.totalUsd += r.costUsd;
            out.byCaller[r.caller] = (out.byCaller[r.caller] ?? 0) + r.costUsd;
        }
        return out;
    }

    spentSince(ms: number): number {
        const since = this.now() - ms;
        return this.recent.filter((c) => c.at >= since).reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
    }

    /** Average spend per hour over the `days` days before today. */
    hourlyBaseline(days = 7): number {
        const today = localDay(this.now());
        const from = localDay(this.now() - days * 86_400_000);
        let total = 0;
        for (const r of this.rows.values()) {
            if (r.day >= from && r.day < today && r.costUsd !== null) total += r.costUsd;
        }
        return total / (days * 24);
    }

    flush(): Promise<void> {
        return this.saving;
    }

    private prune(): void {
        const from = localDay(this.now() - (RETENTION_DAYS - 1) * 86_400_000);
        for (const [k, r] of this.rows) if (r.day < from) this.rows.delete(k);
    }

    private persist(): void {
        if (!this.filePath || this.dirty) return;
        this.dirty = true;
        const file = this.filePath;
        this.saving = this.saving.then(async () => {
            this.dirty = false;
            this.prune();
            try {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(`${file}.tmp`, JSON.stringify([...this.rows.values()]), "utf-8");
                await fs.rename(`${file}.tmp`, file);
            } catch (err) {
                console.warn("[Usage] could not persist the LLM usage:", (err as Error).message);
            }
        });
    }
}

function keyOf(r: Pick<UsageRow, "day" | "caller" | "purpose" | "model">): string {
    return `${r.day}|${r.caller}|${r.purpose}|${r.model}`;
}

/** LunAcedia's ledger — the providers record into it; index.ts loads it with its file. */
export const usageLedger = new UsageLedger();
