import fs from "node:fs/promises";
import path from "node:path";
import type { AcediaEventPriority } from "../types/acedia_event.js";
import type { EmailClassificationStore } from "../connectors/email/email_classification_store.js";
import { parseRules } from "../connectors/email/email_rules.js";
import type { GuardRulesStore } from "./guard_rules_store.js";

/**
 * One way to set a mail's priority: the keyword lists of the classification store and GMAIL_RULES become guard rules,
 * once, at startup. Every mail keeps the priority it had:
 *   - the old match was a substring of « sender + subject »: each entry becomes two rules, « sender contains » and
 *     « subject contains » (the owner may tighten them afterwards);
 *   - the old order is kept: the user's own guard rules first (they ran after the classifier and won), then urgent
 *     keywords, then normal ones — the first rule that sets a priority wins; the VIP list still wins over all;
 *   - GMAIL_RULES only counted while the store was empty: otherwise it is listed as skipped, not moved.
 * The parity list (priority_migration.json) says what was moved or not, and marks the migration done.
 */

export interface MigratedEntry {
    source: "urgentKeywords" | "normalKeywords" | "GMAIL_RULES";
    pattern: string;
    priority: AcediaEventPriority;
    rules: string[];
}

export interface SkippedEntry {
    source: "GMAIL_RULES";
    pattern: string;
    priority: AcediaEventPriority;
    why: string;
}

export interface MigrationReport {
    at: string;
    migrated: MigratedEntry[];
    skipped: SkippedEntry[];
}

export interface PriorityMigrationDeps {
    classification: EmailClassificationStore;
    rules: GuardRulesStore;
    /** The raw GMAIL_RULES value, if any. */
    gmailRules?: string;
    storageDir: string;
    now?: () => Date;
}

const MARKER = "priority_migration.json";
const NAME_PATTERN_MAX = 40;
const KIND: Record<MigratedEntry["source"], string> = {
    urgentKeywords: "mot-clé urgent",
    normalKeywords: "mot-clé normal",
    GMAIL_RULES: "GMAIL_RULES",
};

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/** Null when it already ran. Throws when the rules cannot take the migrated ones — nothing is then marked done. */
export async function migrateLegacyPriority(
    deps: PriorityMigrationDeps,
): Promise<MigrationReport | null> {
    const marker = path.join(deps.storageDir, MARKER);
    if (await exists(marker)) return null;

    const config = deps.classification.getAll();
    const entries: Array<Omit<MigratedEntry, "rules">> = [
        ...config.urgentKeywords.map((pattern) => ({
            source: "urgentKeywords" as const,
            pattern,
            priority: "urgent" as const,
        })),
        ...config.normalKeywords.map((pattern) => ({
            source: "normalKeywords" as const,
            pattern,
            priority: "normal" as const,
        })),
    ];
    const skipped: SkippedEntry[] = [];
    const legacy = parseRules(deps.gmailRules ?? "[]").filter((r) => r.senderPattern.trim());
    for (const r of legacy) {
        const entry = {
            source: "GMAIL_RULES" as const,
            pattern: r.senderPattern,
            priority: r.priority,
        };
        if (deps.classification.isConfigured())
            skipped.push({ ...entry, why: "ignored before: the classification store was set" });
        else entries.push(entry);
    }

    const migrated: MigratedEntry[] = [];
    const added: unknown[] = [];
    for (const entry of entries) {
        const pattern = entry.pattern.trim();
        if (!pattern) continue;
        const shown =
            pattern.length > NAME_PATTERN_MAX
                ? `${pattern.slice(0, NAME_PATTERN_MAX - 1)}…`
                : pattern;
        const base = `(migré) ${KIND[entry.source]} « ${shown} »`;
        const action = { type: "set_priority", priority: entry.priority };
        const names = [`${base} — expéditeur`, `${base} — sujet`];
        added.push(
            {
                name: names[0],
                enabled: true,
                conditions: [{ field: "from", op: "contains", value: pattern }],
                actions: [action],
            },
            {
                name: names[1],
                enabled: true,
                conditions: [{ field: "subject", op: "contains", value: pattern }],
                actions: [action],
            },
        );
        migrated.push({ ...entry, pattern, rules: names });
    }

    if (added.length > 0) {
        const result = await deps.rules.replaceAll([...deps.rules.getRules(), ...added]);
        if (!result.ok)
            throw new Error(`[Priority] migration refused by the rules: ${result.error}`);
    }
    if (config.urgentKeywords.length > 0 || config.normalKeywords.length > 0) {
        await fs.writeFile(
            path.join(deps.storageDir, "email_classification.json.pre-v2"),
            JSON.stringify(config, null, 2),
            "utf-8",
        );
        await deps.classification.patch({ urgentKeywords: [], normalKeywords: [] });
    }

    const report: MigrationReport = {
        at: (deps.now?.() ?? new Date()).toISOString(),
        migrated,
        skipped,
    };
    await fs.mkdir(deps.storageDir, { recursive: true });
    await fs.writeFile(marker, JSON.stringify(report, null, 2), "utf-8");
    return report;
}
