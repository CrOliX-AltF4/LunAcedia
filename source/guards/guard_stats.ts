import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface RuleStats {
    hits: number;
    lastHitTs: number;
}

const SAVE_DEBOUNCE_MS = 2_000;

function resolvePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "guard_stats.json");
}

/**
 * Per-rule hit counters — they are how a dead rule (never hit) or an over-eager one (hit constantly)
 * gets noticed. Persisted with a debounce: a rule that matches a burst of mail must not rewrite the
 * file once per message.
 */
export class GuardStats {
    private readonly stats = new Map<string, RuleStats>();
    private readonly filePath: string;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(filePath?: string) {
        this.filePath = filePath ?? resolvePath();
    }

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as Record<
                string,
                Partial<RuleStats>
            >;
            for (const [id, s] of Object.entries(parsed)) {
                if (typeof s.hits === "number" && typeof s.lastHitTs === "number")
                    this.stats.set(id, { hits: s.hits, lastHitTs: s.lastHitTs });
            }
        } catch {
            // no stats yet
        }
    }

    hit(ruleIds: string[], ts: number = Date.now()): void {
        if (ruleIds.length === 0) return;
        for (const id of ruleIds) {
            const s = this.stats.get(id) ?? { hits: 0, lastHitTs: 0 };
            s.hits += 1;
            s.lastHitTs = ts;
            this.stats.set(id, s);
        }
        this.schedule();
    }

    get(ruleId: string): RuleStats {
        return { ...(this.stats.get(ruleId) ?? { hits: 0, lastHitTs: 0 }) };
    }

    getAll(): Record<string, RuleStats> {
        return Object.fromEntries([...this.stats].map(([id, s]) => [id, { ...s }]));
    }

    /** Forgets counters of rules that no longer exist. */
    prune(existingRuleIds: Set<string>): void {
        let changed = false;
        for (const id of this.stats.keys())
            if (!existingRuleIds.has(id)) {
                this.stats.delete(id);
                changed = true;
            }
        if (changed) this.schedule();
    }

    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, SAVE_DEBOUNCE_MS);
        this.timer.unref?.();
    }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(this.getAll(), null, 2), "utf-8");
        } catch (e) {
            console.error("[Guards] Failed to persist guard stats:", (e as Error).message);
        }
    }
}
