import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { IConnector } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import { REMOVING_SOURCE_KINDS, type RuleSourceKind } from "./guard_types.js";

/** One mail a rule acted on at the source — never silent. */
export interface RuleActionEntry {
    ts: number;
    ruleId: string;
    action: RuleSourceKind;
    label?: string;
    key: string;
    title: string;
    from: string;
    ok: boolean;
    error?: string;
}

const KEEP = 500;

function resolvePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "guard_actions.jsonl");
}

/** The last KEEP actions rules took at the source, newest first; appended to disk, trimmed on load. */
export class RuleActionJournal {
    private entries: RuleActionEntry[] = [];
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly filePath: string = resolvePath()) {}

    async load(): Promise<void> {
        try {
            const lines = (await fs.readFile(this.filePath, "utf-8")).split("\n").filter(Boolean);
            const parsed: RuleActionEntry[] = [];
            for (const line of lines) {
                try {
                    parsed.push(JSON.parse(line) as RuleActionEntry);
                } catch {
                    // A torn last line after a crash: skipped, the rest stands.
                }
            }
            this.entries = parsed.slice(-KEEP).reverse();
            if (parsed.length > KEEP) {
                const kept = [...this.entries].reverse().map((e) => JSON.stringify(e));
                await fs.writeFile(this.filePath, `${kept.join("\n")}\n`, "utf-8");
            }
        } catch {
            // No journal yet.
        }
    }

    record(entry: RuleActionEntry): void {
        this.entries.unshift(entry);
        if (this.entries.length > KEEP) this.entries.length = KEEP;
        this.writing = this.writing
            .then(async () => {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
            })
            .catch((e: unknown) => console.error("[Rules] journal write failed:", (e as Error).message));
    }

    list(limit = 100): RuleActionEntry[] {
        return this.entries.slice(0, limit);
    }

    flush(): Promise<void> {
        return this.writing;
    }
}

export interface RuleActorDeps {
    connectors: IConnector[];
    journal: RuleActionJournal;
    now?: () => number;
}

/**
 * Carries out what the matching rules do at the source, on one collected mail: the rule was confirmed once, so each
 * mail is not asked again (CrOliX, 2026-10-06) — but each one is journaled, and a refusal leaves the mail in the box.
 */
export function createRuleActor(deps: RuleActorDeps) {
    const now = deps.now ?? Date.now;
    return async (
        event: AcediaEvent,
        actions: Array<{ ruleId: string; action: RuleSourceKind; label?: string }>,
    ): Promise<{ removed: boolean; read: boolean }> => {
        const sourceId = event.meta?.["messageId"];
        const connector = deps.connectors.find((c) => c.slug === event.source && c.executeAction);
        const result = { removed: false, read: false };
        if (typeof sourceId !== "string" || !connector?.executeAction) return result;
        const from = typeof event.meta?.["from"] === "string" ? (event.meta["from"] as string) : "";
        // What keeps the mail (a label, a star, read) before what takes it out of the inbox.
        const ordered = [...actions].sort(
            (x, y) => Number(REMOVING_SOURCE_KINDS.has(x.action)) - Number(REMOVING_SOURCE_KINDS.has(y.action)),
        );
        for (const a of ordered) {
            const action = (
                a.action === "label_email"
                    ? { kind: "label_email", sourceId, label: a.label ?? "" }
                    : { kind: a.action, sourceId }
            ) as ConnectorAction;
            const base = {
                ts: now(),
                ruleId: a.ruleId,
                action: a.action,
                ...(a.label && { label: a.label }),
                key: event.dedupeKey,
                title: event.title ?? "",
                from,
            };
            try {
                await connector.executeAction(action);
                deps.journal.record({ ...base, ok: true });
                if (REMOVING_SOURCE_KINDS.has(a.action)) result.removed = true;
                if (a.action === "mark_email_read") result.read = true;
                // Out of the inbox: what other rules would still do to it no longer matters.
                if (result.removed) break;
            } catch (e) {
                const error = (e as Error).message;
                console.error(`[Rules] ${a.ruleId}: ${a.action} on ${event.dedupeKey} failed — ${error}`);
                deps.journal.record({ ...base, ok: false, error });
            }
        }
        return result;
    };
}
