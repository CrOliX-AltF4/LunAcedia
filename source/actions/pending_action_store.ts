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
    /** A third party's text (a mail, an issue) was read before this action was proposed (ADR-017 D2). */
    untrusted?: boolean;
}

export interface PendingMeta {
    origin?: "agent" | "api";
    untrusted?: boolean;
}

const HOUR = 60 * 60 * 1000;

/**
 * Each kind its own delay (ADR-020 §5.11 Q2): what goes stale fast (a reply, a comment) or undoes something (a
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

/**
 * The writes waiting for Master (ADR-020 §5.11 M5a). Durable since M5: a pending action is a list Master comes back to
 * — from the phone, the panel or the dashboard, hours later — so it survives a restart. Each kind expires on its own
 * delay; at confirmation the caller still re-checks the tier (api_server.ts), and nothing read from the disk is
 * executed unless the catalogue knows its kind (merge_pr never). A `null` path keeps it in memory only (tests).
 */
export class PendingActionStore {
    private readonly pending = new Map<string, PendingAction>();
    private writes: Promise<void> = Promise.resolve();
    private readonly created: Array<(p: PendingAction) => void> = [];

    constructor(
        private readonly filePath: string | null = defaultPendingActionsPath(),
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            const t = this.now();
            for (const raw of Array.isArray(parsed) ? parsed : []) {
                const entry = revive(raw, t);
                if (entry) this.pending.set(entry.id, entry);
            }
        } catch {
            // Absent or unreadable — nothing waits, that's fine.
        }
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

    /** Oldest first. */
    list(): PendingAction[] {
        this.purgeExpired();
        return [...this.pending.values()];
    }

    /** Told of each new pending action — the phone's notification (ADR-020 §5.11 M5b). */
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
        if (!file) return;
        const snapshot = JSON.stringify([...this.pending.values()], null, 2);
        this.writes = this.writes.then(async () => {
            try {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const tmp = `${file}.tmp`;
                await fs.writeFile(tmp, snapshot, "utf-8");
                await fs.rename(tmp, file);
            } catch (e) {
                console.error(
                    "[Actions] could not save the pending actions:",
                    (e as Error).message,
                );
            }
        });
    }
}
