/**
 * Alerts on LunAcedia's LLM spend (ADR-021 P2) — they INFORM, they never cut (D2). LunAcedia decides them against its
 * own settings; the phone is told directly in standalone, and the Core relays them when wired (it reads them from
 * GET /api/usage — the hub carries, it does not recompute).
 *
 * Settings (dollars, per local day), set from the dashboard and kept in STORAGE_DIR/usage_alerts.json; the environment
 * gives the defaults of a fresh install:
 *   dailyUsd      paliers for the day's total                       (LLM_ALERT_DAILY_USD, e.g. "5/10/20")
 *   perCallerUsd  paliers per caller: core, topics, api, background  (LLM_ALERT_CALLER_USD, e.g. "topics=1/2, core=5")
 *   spikeFactor   the last hour above FACTOR × the usual hourly spend is unusual (LLM_ALERT_SPIKE_FACTOR, 5; 0 = off)
 *   spikeMinUsd   ...and above this floor                             (LLM_ALERT_SPIKE_MIN_USD, 0.5)
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { USAGE_CALLERS, localDay, type UsageCaller, type UsageLedger } from "./llm_usage.js";

export interface UsageAlertSettings {
    dailyUsd: number[];
    perCallerUsd: Partial<Record<UsageCaller, number[]>>;
    spikeFactor: number;
    spikeMinUsd: number;
}

export interface FiredAlert {
    key: string;
    at: number;
    kind: "daily" | "caller" | "spike";
    title: string;
    body: string;
    priority: "normal" | "urgent";
}

const HOUR_MS = 60 * 60 * 1000;
const SPIKE_CHECK_EVERY_MS = 5 * 60 * 1000;
const FIRED_KEEP_MS = 7 * 24 * HOUR_MS;

const CALLER_LABELS: Record<UsageCaller, string> = {
    core: "Natsume (Core)",
    topics: "sujets du téléphone",
    api: "API directe",
    background: "tâches de fond",
    unattributed: "non attribué",
};

export function defaultAlertsPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "usage_alerts.json");
}

/** "5/10/20" → [5, 10, 20]; anything not a positive amount is dropped. */
export function parsePaliers(raw: string | undefined): number[] {
    if (!raw) return [];
    return raw
        .split("/")
        .map((s) => Number(s.trim().replace(",", ".")))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
}

/** "topics=1/2, core=5" → { topics: [1, 2], core: [5] }; unknown callers ignored. */
export function parseCallerPaliers(
    raw: string | undefined,
): Partial<Record<UsageCaller, number[]>> {
    const out: Partial<Record<UsageCaller, number[]>> = {};
    for (const part of (raw ?? "").split(",")) {
        const [name, values] = part.split("=").map((s) => s?.trim());
        if (!name || !values || !(USAGE_CALLERS as readonly string[]).includes(name)) continue;
        const paliers = parsePaliers(values);
        if (paliers.length) out[name as UsageCaller] = paliers;
    }
    return out;
}

function numberOr(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw.replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): UsageAlertSettings {
    return {
        dailyUsd: parsePaliers(env["LLM_ALERT_DAILY_USD"]),
        perCallerUsd: parseCallerPaliers(env["LLM_ALERT_CALLER_USD"]),
        spikeFactor: numberOr(env["LLM_ALERT_SPIKE_FACTOR"], 5),
        spikeMinUsd: numberOr(env["LLM_ALERT_SPIKE_MIN_USD"], 0.5),
    };
}

/** A settings patch from the dashboard → valid settings, or the reason it is refused. */
export function validateSettings(input: unknown): UsageAlertSettings | { error: string } {
    const b = (input ?? {}) as Record<string, unknown>;
    const amounts = (v: unknown): number[] | null =>
        Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
            ? [...(v as number[])].sort((a, c) => a - c)
            : null;
    const daily = amounts(b["dailyUsd"] ?? []);
    if (!daily) return { error: "dailyUsd must be a list of positive amounts" };
    const perCaller: Partial<Record<UsageCaller, number[]>> = {};
    const raw = (b["perCallerUsd"] ?? {}) as Record<string, unknown>;
    if (typeof raw !== "object" || Array.isArray(raw))
        return { error: "perCallerUsd must be an object" };
    for (const [caller, v] of Object.entries(raw)) {
        if (!(USAGE_CALLERS as readonly string[]).includes(caller))
            return { error: `unknown caller ${caller}` };
        const p = amounts(v);
        if (!p) return { error: `perCallerUsd.${caller} must be a list of positive amounts` };
        if (p.length) perCaller[caller as UsageCaller] = p;
    }
    const factor = b["spikeFactor"] ?? 5;
    const floor = b["spikeMinUsd"] ?? 0.5;
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0)
        return { error: "spikeFactor must be ≥ 0" };
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0)
        return { error: "spikeMinUsd must be ≥ 0" };
    return { dailyUsd: daily, perCallerUsd: perCaller, spikeFactor: factor, spikeMinUsd: floor };
}

const usd = (n: number): string => `${n.toFixed(2)} $`;

interface StoredAlerts {
    settings?: UsageAlertSettings;
    fired?: FiredAlert[];
}

export class UsageAlerts {
    private settings: UsageAlertSettings = defaultSettings();
    private fired: FiredAlert[] = [];
    private lastSpikeCheck = 0;
    private lastSpikeAlert = 0;
    private saving: Promise<void> = Promise.resolve();

    /** No file = in memory only (tests). */
    constructor(
        private readonly filePath?: string,
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const stored = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as StoredAlerts;
            if (stored.settings) {
                const valid = validateSettings(stored.settings);
                if (!("error" in valid)) this.settings = valid;
            }
            if (Array.isArray(stored.fired)) this.fired = stored.fired;
        } catch {
            // Missing or unreadable: the environment's defaults.
        }
        this.pruneFired();
    }

    getSettings(): UsageAlertSettings {
        return structuredClone(this.settings);
    }

    async setSettings(settings: UsageAlertSettings): Promise<void> {
        this.settings = structuredClone(settings);
        await this.save();
    }

    /** Alerts fired in the last `ms` milliseconds (default: the week), newest first. */
    recent(ms = FIRED_KEEP_MS): FiredAlert[] {
        const since = this.now() - ms;
        return this.fired.filter((a) => a.at >= since).sort((a, b) => b.at - a.at);
    }

    /** Watches the ledger; `deliver` is called once per new alert (the phone, the log). Returns an unsubscribe. */
    watch(ledger: UsageLedger, deliver: (alert: FiredAlert) => unknown): () => void {
        return ledger.onRecord(() => {
            for (const alert of this.evaluate(ledger)) {
                try {
                    void Promise.resolve(deliver(alert)).catch((e: unknown) =>
                        console.warn("[Usage] could not deliver an alert:", (e as Error).message),
                    );
                } catch (e) {
                    console.warn("[Usage] could not deliver an alert:", (e as Error).message);
                }
            }
        });
    }

    /** The alerts the current spend calls for and that were not fired yet — recorded as fired. */
    evaluate(ledger: UsageLedger): FiredAlert[] {
        const out: FiredAlert[] = [];
        const t = this.now();
        const day = localDay(t);
        const today = ledger.day(day);
        const has = (key: string): boolean => this.fired.some((a) => a.key === key);

        for (const palier of this.settings.dailyUsd) {
            const key = `${day}|total|${palier}`;
            if (today.totalUsd < palier || has(key)) continue;
            out.push({
                key,
                at: t,
                kind: "daily",
                priority: "normal",
                title: `LunAcedia — dépense LLM : ${usd(palier)} atteints aujourd'hui`,
                body: `${usd(today.totalUsd)} estimés aujourd'hui. Rien n'est coupé : c'est une information.`,
            });
        }
        for (const [caller, paliers] of Object.entries(this.settings.perCallerUsd) as [
            UsageCaller,
            number[],
        ][]) {
            const spent = today.byCaller[caller] ?? 0;
            for (const palier of paliers) {
                const key = `${day}|${caller}|${palier}`;
                if (spent < palier || has(key)) continue;
                out.push({
                    key,
                    at: t,
                    kind: "caller",
                    priority: "normal",
                    title: `LunAcedia — dépense LLM (${CALLER_LABELS[caller]}) : ${usd(palier)} atteints aujourd'hui`,
                    body: `${usd(spent)} estimés aujourd'hui pour cet appelant. Rien n'est coupé : c'est une information.`,
                });
            }
        }
        if (t - this.lastSpikeCheck >= SPIKE_CHECK_EVERY_MS && this.settings.spikeFactor > 0) {
            this.lastSpikeCheck = t;
            const lastHour = ledger.spentSince(HOUR_MS);
            const usual = ledger.hourlyBaseline();
            if (
                lastHour >= this.settings.spikeMinUsd &&
                lastHour >= this.settings.spikeFactor * usual &&
                t - this.lastSpikeAlert >= HOUR_MS
            ) {
                this.lastSpikeAlert = t;
                out.push({
                    key: `${day}|spike|${new Date(t).getHours()}`,
                    at: t,
                    kind: "spike",
                    priority: "urgent",
                    title: "LunAcedia — dépense LLM inhabituelle",
                    body:
                        `${usd(lastHour)} sur la dernière heure, pour ${usd(usual)} par heure d'habitude. ` +
                        "Une boucle tourne peut-être. Rien n'est coupé.",
                });
            }
        }
        if (out.length) {
            this.fired.push(...out);
            this.pruneFired();
            void this.save();
        }
        return out;
    }

    flush(): Promise<void> {
        return this.saving;
    }

    private pruneFired(): void {
        const since = this.now() - FIRED_KEEP_MS;
        this.fired = this.fired.filter((a) => a.at >= since);
    }

    private save(): Promise<void> {
        if (!this.filePath) return Promise.resolve();
        const file = this.filePath;
        this.saving = this.saving.then(async () => {
            try {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const stored: StoredAlerts = { settings: this.settings, fired: this.fired };
                await fs.writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2), "utf-8");
                await fs.rename(`${file}.tmp`, file);
            } catch (err) {
                console.warn("[Usage] could not persist the alerts:", (err as Error).message);
            }
        });
        return this.saving;
    }
}
