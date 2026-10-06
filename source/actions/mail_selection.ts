/**
 * A selection of the box's mails (ADR-023 T2): « tous les mails qui viennent d'aliexpress ». The same structured
 * conditions as the guards — substring, exact sender, domain — never a regex, never a model; criteria are ANDed and
 * at least one is required, so a selection is never the whole box by accident.
 */
import type { EventStore } from "../store/event_store.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { GuardCondition } from "../guards/guard_types.js";
import { conditionsMatch } from "../guards/guard_engine.js";

export type MailMatch = Extract<ConnectorAction, { kind: "bulk_email" }>["match"];

/** At most this many mails per confirmation (CrOliX, 2026-10-06) — beyond, a rule takes over. */
export const BULK_LIMIT = 200;
const SAMPLE = 5;

export interface MailSelection {
    /** Gmail message ids, newest first, at most BULK_LIMIT. */
    sourceIds: string[];
    /** How many matched in all (may exceed sourceIds). */
    matched: number;
    sample: Array<{ key: string; title: string; from: string; ts: number }>;
}

const clean = (v: string | undefined): string => (v ?? "").trim();

export function matchConditions(match: MailMatch): GuardCondition[] {
    const out: GuardCondition[] = [];
    if (clean(match.from)) out.push({ field: "from", op: "equals", value: clean(match.from).toLowerCase() });
    if (clean(match.fromContains)) out.push({ field: "from", op: "contains", value: clean(match.fromContains) });
    if (clean(match.fromDomain))
        out.push({ field: "from", op: "domain", value: clean(match.fromDomain).toLowerCase().replace(/^@/, "") });
    if (clean(match.subjectContains))
        out.push({ field: "subject", op: "contains", value: clean(match.subjectContains) });
    return out;
}

export function selectMail(store: EventStore, match: MailMatch): MailSelection {
    const conditions = matchConditions(match);
    if (conditions.length === 0) return { sourceIds: [], matched: 0, sample: [] };
    const { events } = store.query({ source: "email", limit: Number.MAX_SAFE_INTEGER });
    const hits = events.filter(
        (e) => typeof e.meta?.["messageId"] === "string" && conditionsMatch(conditions, e),
    );
    return {
        sourceIds: hits.slice(0, BULK_LIMIT).map((e) => e.meta!["messageId"] as string),
        matched: hits.length,
        sample: hits.slice(0, SAMPLE).map((e) => ({
            key: e.dedupeKey,
            title: e.title ?? "",
            from: typeof e.meta?.["from"] === "string" ? (e.meta["from"] as string) : "",
            ts: e.ts,
        })),
    };
}

/** The criteria in Master's words: « expéditeur contenant « aliexpress » ». */
export function describeMatch(match: MailMatch): string {
    const parts: string[] = [];
    if (clean(match.from)) parts.push(`expéditeur « ${clean(match.from)} »`);
    if (clean(match.fromContains)) parts.push(`expéditeur contenant « ${clean(match.fromContains)} »`);
    if (clean(match.fromDomain)) parts.push(`domaine « ${clean(match.fromDomain)} »`);
    if (clean(match.subjectContains)) parts.push(`sujet contenant « ${clean(match.subjectContains)} »`);
    return parts.join(", ");
}
