import type { AcediaEventPriority } from "../types/acedia_event.js";
import type { RuleSourceKind } from "../types/connector_action.js";

/**
 * Ingestion guards: user-editable, deterministic rules evaluated on every
 * event between a connector's poll() and dispatch. Conditions are STRUCTURED on purpose (decision
 * C-013): no free-form regex — a rule stays readable in a form and can never become a ReDoS vector.
 * No LLM anywhere in this layer (mail content is untrusted data).
 *
 * Conditions of a rule are ANDed. Everything is case-insensitive.
 */
export type GuardCondition =
    /** `from` is the raw From header. `domain` matches the sender's domain or any subdomain of it. */
    | { field: "from"; op: "equals" | "contains" | "domain"; value: string }
    | { field: "subject"; op: "contains"; value: string }
    /** The event body — for mail, Gmail's 200-character preview, NOT the full message. */
    | { field: "snippet"; op: "contains"; value: string }
    /** A source-provided label (Gmail: CATEGORY_PROMOTIONS, …), read from `meta.labels`. */
    | { field: "label"; op: "equals"; value: string }
    /** A source header is present (e.g. `List-Unsubscribe`), read from `meta.headers`. */
    | { field: "header"; op: "present"; name: string };

/** What a rule may do at the source, on each mail it matches at collection. */
export type { RuleSourceKind };

/** The source actions that take a mail out of the inbox — never applied to a VIP. */
export const REMOVING_SOURCE_KINDS: ReadonlySet<RuleSourceKind> = new Set([
    "archive_email",
    "delete_email",
    "mark_spam",
]);

export type GuardAction =
    | { type: "drop" }
    /** Acts in Gmail itself, without asking again: the rule was confirmed once (CrOliX, 2026-10-06). Journaled. */
    | { type: "source"; action: RuleSourceKind; label?: string }
    | { type: "tag"; tag: string }
    | { type: "set_priority"; priority: AcediaEventPriority };

export interface GuardRule {
    id: string;
    name: string;
    enabled: boolean;
    conditions: GuardCondition[];
    actions: GuardAction[];
}

export interface GuardVerdict {
    /** True when a matching enabled rule drops the event AND the sender is not protected. */
    drop: boolean;
    /** Union of every matching rule's tags, first occurrence order, case-insensitively unique. */
    tags: string[];
    /** The first matching `set_priority`; undefined leaves the connector's own priority. */
    priority?: AcediaEventPriority;
    /** The rule responsible for the drop; otherwise the first matching rule with a visible effect. */
    ruleId?: string;
    matchedRuleIds: string[];
    /** A drop was requested but suppressed: the sender is on the VIP allowlist (which always wins). */
    vipProtected: boolean;
    /** What the matching rules do at the source, once each — absent when nothing. */
    source?: Array<{ ruleId: string; action: RuleSourceKind; label?: string }>;
}
