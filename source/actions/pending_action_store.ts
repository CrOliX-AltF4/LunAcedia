import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConnectorAction } from "../types/connector_action.js";
import { DEFAULT_ACTION_TIERS, IMMUTABLE_TIERS } from "../types/action_tier.js";

export interface PendingAction {
    id: string;
    connector: string;
    action: ConnectorAction;
    createdAt: number;
    /** After this instant nothing is done — announced to Master, journaled when it passes. */
    expiresAt: number;
    /** Who asked: the agent (on Master's request) or a direct API call. */
    origin?: "agent" | "api";
    /** A third party's text (a mail, an issue) was read before this action was proposed. */
    untrusted?: boolean;
}

export interface PendingMeta {
    origin?: "agent" | "api";
    untrusted?: boolean;
}

/** How a pending action ended. Confirmed and cancelled are Master's hand; expired and failed are said as such. */
export type ActionEnd = "confirmed" | "cancelled" | "expired" | "failed" | "refused";

export interface ActionOutcome {
    status: ActionEnd;
    at: number;
    kind: string;
    /** Why it failed or was refused — "nothing was done" always says why. */
    reason?: string;
}

/** Where an action stands: still waiting, or how it ended. */
export type ActionState = { status: "pending"; expiresAt: number } | ActionOutcome;

const HOUR = 60 * 60 * 1000;
/** How long the end of an action is remembered — a topic reopened weeks later still shows it. */
const OUTCOME_KEEP_MS = 30 * 24 * HOUR;
const OUTCOME_MAX = 2000;

/**
 * Each kind its own delay: what goes stale fast (a reply, a comment) or undoes something (a
 * deletion, a closing) waits 2 hours; what creates or plans (an event, a task, an issue) waits a day.
 */
const LONG_LIVED = new Set<string>(["create_event", "update_event", "create_task", "create_issue"]);

export function pendingTtlMs(kind: string): number {
    return LONG_LIVED.has(kind) ? 24 * HOUR : 2 * HOUR;
}

export function defaultPendingActionsPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "pending_actions.json");
}

const KNOWN_KINDS = new Set<string>(Object.keys(DEFAULT_ACTION_TIERS));

/** A stored entry is trusted only if the catalogue would have produced it — the disk never widens what can run. */
function revive(raw: unknown, now: number): PendingAction | null {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    const action = e["action"] as { kind?: unknown } | undefined;
    const kind = typeof action?.kind === "string" ? action.kind : "";
    if (!KNOWN_KINDS.has(kind) || kind in IMMUTABLE_TIERS) return null;
    if (typeof e["id"] !== "string" || typeof e["connector"] !== "string") return null;
    if (typeof e["createdAt"] !== "number" || typeof e["expiresAt"] !== "number") return null;
    if (e["expiresAt"] <= now) return null;
    return {
        id: e["id"],
        connector: e["connector"],
        action: action as ConnectorAction,
        createdAt: e["createdAt"],
        expiresAt: e["expiresAt"],
        ...((e["origin"] === "agent" || e["origin"] === "api") && { origin: e["origin"] }),
        ...(e["untrusted"] === true && { untrusted: true }),
    };
}

const ENDS = new Set<string>(["confirmed", "cancelled", "expired", "failed", "refused"]);

function reviveOutcome(raw: unknown): { id: string; at: number; outcome: ActionOutcome } | null {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    if (typeof e["id"] !== "string" || typeof e["at"] !== "number") return null;
    if (typeof e["status"] !== "string" || !ENDS.has(e["status"])) return null;
    if (typeof e["kind"] !== "string") return null;
    return {
        id: e["id"],
        at: e["at"],
        outcome: {
            status: e["status"] as ActionEnd,
            at: e["at"],
            kind: e["kind"],
            ...(typeof e["reason"] === "string" && { reason: e["reason"] }),
        },
    };
}

/**
 * The writes waiting for Master. Durable since M5: a pending action is a list Master comes back to
 * — from the phone, the panel or the dashboard, hours later — so it survives a restart. Each kind expires on its own
 * delay; at confirmation the caller still re-checks the tier (api_server.ts), and nothing read from the disk is
 * executed unless the catalogue knows its kind (merge_pr never). A `null` path keeps it in memory only (tests).
 */
export class PendingActionStore {
    private readonly pending = new Map<string, PendingAction>();
    /** What became of the actions no longer pending: a card in a topic shows it instead of staying active. */
    private readonly outcomes = new Map<string, ActionOutcome>();
    private writes: Promise<void> = Promise.resolve();
    private readonly created: Array<(p: PendingAction) => void> = [];
    private readonly settled: Array<(p: PendingAction, outcome: ActionOutcome) => void> = [];

    constructor(
        private readonly filePath: string | null = defaultPendingActionsPath(),
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        if (!this.filePath) return;
        const t = this.now();
        try {
            const parsed = JSON.parse(await fs.readFile(this.outcomesPath()!, "utf-8")) as unknown;
            for (const raw of Array.isArray(parsed) ? parsed : []) {
                const o = reviveOutcome(raw);
                if (o && o.at > t - OUTCOME_KEEP_MS) this.outcomes.set(o.id, o.outcome);
            }
        } catch {
            // Absent or unreadable — no history, that's fine.
        }
        let expiredWhileDown = false;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            for (const raw of Array.isArray(parsed) ? parsed : []) {
                const entry = revive(raw, 0);
                if (!entry) continue;
                if (entry.expiresAt > t) this.pending.set(entry.id, entry);
                else {
                    this.record(entry, "expired", undefined, entry.expiresAt);
                    expiredWhileDown = true;
                }
            }
        } catch {
            // Absent or unreadable — nothing waits, that's fine.
        }
        if (expiredWhileDown) this.persist();
    }

    create(connector: string, action: ConnectorAction, meta: PendingMeta = {}): PendingAction {
        this.purgeExpired();
        const createdAt = this.now();
        const entry: PendingAction = {
            id: `${createdAt}-${Math.random().toString(36).slice(2, 9)}`,
            connector,
            action,
            createdAt,
            expiresAt: createdAt + pendingTtlMs(action.kind),
            ...(meta.origin && { origin: meta.origin }),
            ...(meta.untrusted && { untrusted: true }),
        };
        this.pending.set(entry.id, entry);
        this.persist();
        for (const listener of this.created) listener(entry);
        return entry;
    }

    get(id: string): PendingAction | undefined {
        this.purgeExpired();
        return this.pending.get(id);
    }

    consume(id: string): PendingAction | undefined {
        const entry = this.get(id);
        if (entry) {
            this.pending.delete(id);
            this.persist();
        }
        return entry;
    }

    /** Records how a consumed action ended — confirmed, cancelled, failed or refused (with why). */
    settle(entry: PendingAction, status: ActionEnd, reason?: string): void {
        this.record(entry, status, reason, this.now());
        this.persist();
    }

    /** Still waiting, or how it ended (kept 30 days); undefined for an id never seen or long forgotten. */
    stateOf(id: string): ActionState | undefined {
        this.purgeExpired();
        const entry = this.pending.get(id);
        if (entry) return { status: "pending", expiresAt: entry.expiresAt };
        return this.outcomes.get(id);
    }

    private record(
        entry: PendingAction,
        status: ActionEnd,
        reason: string | undefined,
        at: number,
    ): void {
        const outcome: ActionOutcome = {
            status,
            at,
            kind: entry.action.kind,
            ...(reason && { reason }),
        };
        this.outcomes.set(entry.id, outcome);
        for (const listener of this.settled) {
            try {
                listener(entry, outcome);
            } catch {
                // a listener never stops the record
            }
        }
    }

    private outcomesPath(): string | null {
        return this.filePath
            ? path.join(path.dirname(this.filePath), "action_outcomes.json")
            : null;
    }

    /** Oldest first. */
    list(): PendingAction[] {
        this.purgeExpired();
        return [...this.pending.values()];
    }

    /** Told of each action that ended — decided, failed, refused or expired (the views follow, the notification goes). */
    onSettle(listener: (p: PendingAction, outcome: ActionOutcome) => void): void {
        this.settled.push(listener);
    }

    /** Told of each new pending action — the phone's notification. */
    onCreate(listener: (p: PendingAction) => void): void {
        this.created.push(listener);
    }

    /** Resolves once every change so far is on disk. */
    flush(): Promise<void> {
        return this.writes;
    }

    private purgeExpired(): void {
        const t = this.now();
        let changed = false;
        for (const [id, entry] of this.pending) {
            if (entry.expiresAt <= t) {
                this.pending.delete(id);
                this.record(entry, "expired", undefined, entry.expiresAt);
                changed = true;
                console.warn(
                    `[Actions] pending ${entry.action.kind} ${id} expired — nothing was done`,
                );
            }
        }
        if (changed) this.persist();
    }

    /** One write at a time, in order; a temporary file then a rename, so a crash never leaves half a list. */
    private persist(): void {
        const file = this.filePath;
        const outcomesFile = this.outcomesPath();
        if (!file || !outcomesFile) return;
        const snapshot = JSON.stringify([...this.pending.values()], null, 2);
        const cutoff = this.now() - OUTCOME_KEEP_MS;
        const kept = [...this.outcomes]
            .filter(([, o]) => o.at > cutoff)
            .sort(([, a], [, b]) => b.at - a.at)
            .slice(0, OUTCOME_MAX);
        const outcomes = JSON.stringify(kept.map(([id, o]) => ({ id, ...o })));
        this.writes = this.writes.then(async () => {
            try {
                await fs.mkdir(path.dirname(file), { recursive: true });
                for (const [target, text] of [
                    [file, snapshot],
                    [outcomesFile, outcomes],
                ] as const) {
                    const tmp = `${target}.tmp`;
                    await fs.writeFile(tmp, text, "utf-8");
                    await fs.rename(tmp, target);
                }
            } catch (e) {
                console.error(
                    "[Actions] could not save the pending actions:",
                    (e as Error).message,
                );
            }
        });
    }
}
