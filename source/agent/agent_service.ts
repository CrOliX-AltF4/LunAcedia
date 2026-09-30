/**
 * The agent's switch and journal (ADR-017 M5 — law 3, control): the agent can be turned off from
 * the dashboard or the Core's panel (off = no tool is ever called), and every run is journaled —
 * who asked, what, the outcome, the steps and the actions — for the last 50 runs.
 *
 * The switch persists next to the other LunAcedia settings; the journal is in memory, like the
 * EventStore it reads from.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentAction, AgentRequest, AgentResult, AgentStep } from "./agent_loop.js";

const JOURNAL_SIZE = 50;

/** Next to the other LunAcedia settings (same rule as action_tier_store.ts). */
export function defaultAgentSettingsPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "agent_settings.json");
}
const TEXT_CHARS = 300;

export interface AgentJournalEntry {
    at: string;
    callerId?: string;
    /** The topic the run answered in (ADR-020 amendment 1, S1) — absent for a one-off request. */
    conversationId?: string;
    text: string;
    status: AgentResult["status"];
    limit?: AgentResult["limit"];
    ms: number;
    steps: AgentStep[];
    actions: AgentAction[];
    error?: string;
}

export class AgentService {
    private enabled = true;
    // Writes (reply, create, update, delete an event…) wait for a later v1 (CrOliX, 2026-09-25).
    private writes = false;
    private readonly entries: AgentJournalEntry[] = [];

    /** No settings path = in memory only (tests, or a deployment without STORAGE_DIR). */
    constructor(
        private readonly settingsPath?: string,
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        if (!this.settingsPath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.settingsPath, "utf-8")) as {
                enabled?: unknown;
                writes?: unknown;
            };
            if (typeof parsed.enabled === "boolean") this.enabled = parsed.enabled;
            if (typeof parsed.writes === "boolean") this.writes = parsed.writes;
        } catch {
            // Missing or unreadable: keep the default (on) — the switch is always visible to fix it.
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    writesEnabled(): boolean {
        return this.writes;
    }

    async setEnabled(enabled: boolean): Promise<void> {
        this.enabled = enabled;
        await this.save();
    }

    async setWrites(writes: boolean): Promise<void> {
        this.writes = writes;
        await this.save();
    }

    private async save(): Promise<void> {
        if (!this.settingsPath) return;
        await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
        await fs.writeFile(
            this.settingsPath,
            JSON.stringify({ enabled: this.enabled, writes: this.writes }, null, 2),
            "utf-8",
        );
    }

    /** Runs one agent request and journals it, whatever happens. */
    async run(req: AgentRequest, exec: () => Promise<AgentResult>): Promise<AgentResult> {
        const started = this.now();
        const base = {
            at: new Date(started).toISOString(),
            ...(req.callerId && { callerId: req.callerId }),
            ...(req.conversationId && { conversationId: req.conversationId }),
            text: req.text.length > TEXT_CHARS ? `${req.text.slice(0, TEXT_CHARS)}…` : req.text,
        };
        try {
            const result = await exec();
            this.record({
                ...base,
                status: result.status,
                ...(result.limit && { limit: result.limit }),
                ms: this.now() - started,
                steps: result.steps,
                actions: result.actions,
                ...(result.error && { error: result.error }),
            });
            return result;
        } catch (e) {
            this.record({
                ...base,
                status: "error",
                ms: this.now() - started,
                steps: [],
                actions: [],
                error: (e as Error).message,
            });
            throw e;
        }
    }

    /** Newest first. */
    journal(): AgentJournalEntry[] {
        return [...this.entries];
    }

    private record(entry: AgentJournalEntry): void {
        this.entries.unshift(entry);
        if (this.entries.length > JOURNAL_SIZE) this.entries.length = JOURNAL_SIZE;
    }
}
