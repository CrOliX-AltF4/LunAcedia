import type { AcediaEvent } from "../types/acedia_event.js";
import type { GuardCondition, GuardRule, GuardVerdict } from "./guard_types.js";

/** Neutral, connector-independent view of an event — rules are written against this, never
 *  against a connector's own types (ADR-009), so the same engine serves every source. */
interface EventView {
    from: string;
    subject: string;
    snippet: string;
    labels: string[];
    headers: Set<string>;
}

function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function viewOf(event: AcediaEvent): EventView {
    const meta = event.meta ?? {};
    const labels = Array.isArray(meta["labels"]) ? (meta["labels"] as unknown[]).map(asString) : [];
    const rawHeaders = meta["headers"];
    const headers = new Set<string>();
    if (rawHeaders && typeof rawHeaders === "object") {
        for (const name of Object.keys(rawHeaders as Record<string, unknown>))
            headers.add(name.toLowerCase());
    }
    return {
        from: asString(meta["from"]),
        subject: event.title ?? "",
        snippet: event.body ?? "",
        labels,
        headers,
    };
}

/** "Name <a@b.com>" or "a@b.com" → "a@b.com" (lowercase); "" when there is no address. */
export function extractAddress(from: string): string {
    const angle = /<([^>]+)>/.exec(from);
    const candidate = (angle ? angle[1]! : from).trim().toLowerCase();
    return candidate.includes("@") ? candidate : "";
}

export function senderDomain(from: string): string {
    const address = extractAddress(from);
    const at = address.lastIndexOf("@");
    return at === -1 ? "" : address.slice(at + 1);
}

function conditionMatches(c: GuardCondition, view: EventView): boolean {
    switch (c.field) {
        case "from": {
            const value = c.value.toLowerCase();
            if (c.op === "equals")
                return (
                    extractAddress(view.from) === value || view.from.trim().toLowerCase() === value
                );
            if (c.op === "contains") return view.from.toLowerCase().includes(value);
            // domain: the sender's domain, or any subdomain of it (mail.aliexpress.com ⊂ aliexpress.com)
            const domain = senderDomain(view.from);
            return domain !== "" && (domain === value || domain.endsWith(`.${value}`));
        }
        case "subject":
            return view.subject.toLowerCase().includes(c.value.toLowerCase());
        case "snippet":
            return view.snippet.toLowerCase().includes(c.value.toLowerCase());
        case "label":
            return view.labels.some((l) => l.toLowerCase() === c.value.toLowerCase());
        case "header":
            return view.headers.has(c.name.toLowerCase());
    }
}

function ruleMatches(rule: GuardRule, view: EventView): boolean {
    // A rule without conditions would match everything — refuse it here as well as at validation.
    return (
        rule.enabled &&
        rule.conditions.length > 0 &&
        rule.conditions.every((c) => conditionMatches(c, view))
    );
}

/**
 * The legacy VIP allowlist keeps its exact historical semantics (substring, case-insensitive, on
 * "from subject" — see connectors/email/email_rules.ts) so a VIP is protected against a drop by
 * the very same patterns that already make the mail urgent.
 */
export function makeVipMatcher(vipSenders: string[]): (event: AcediaEvent) => boolean {
    return (event) => {
        if (vipSenders.length === 0) return false;
        const meta = event.meta ?? {};
        const haystack = `${asString(meta["from"])} ${event.title ?? ""}`.toLowerCase();
        return vipSenders.some((p) => p.trim() !== "" && haystack.includes(p.toLowerCase()));
    };
}

/**
 * Pure evaluation — no I/O. Rules run in order and ALL matching rules contribute: tags accumulate,
 * the first `set_priority` wins, and a `drop` is decisive unless the sender is on the VIP allowlist
 * (the allowlist always wins over a drop, even after the rules are edited).
 */
export function evaluateGuard(
    event: AcediaEvent,
    rules: GuardRule[],
    isVip: (event: AcediaEvent) => boolean,
): GuardVerdict {
    const view = viewOf(event);
    const verdict: GuardVerdict = {
        drop: false,
        tags: [],
        matchedRuleIds: [],
        vipProtected: false,
    };
    const seenTags = new Set<string>();
    let wantsDrop = false;
    let dropRuleId: string | undefined;
    let firstEffectRuleId: string | undefined;

    for (const rule of rules) {
        if (!ruleMatches(rule, view)) continue;
        verdict.matchedRuleIds.push(rule.id);
        for (const action of rule.actions) {
            if (action.type === "drop") {
                if (!wantsDrop) {
                    wantsDrop = true;
                    dropRuleId = rule.id;
                }
                firstEffectRuleId ??= rule.id;
            } else if (action.type === "tag") {
                const key = action.tag.toLowerCase();
                if (!seenTags.has(key)) {
                    seenTags.add(key);
                    verdict.tags.push(action.tag);
                }
                firstEffectRuleId ??= rule.id;
            } else if (action.type === "set_priority") {
                if (verdict.priority === undefined) verdict.priority = action.priority;
                firstEffectRuleId ??= rule.id;
            }
        }
    }

    if (wantsDrop) {
        if (isVip(event)) verdict.vipProtected = true;
        else verdict.drop = true;
    }
    verdict.ruleId = verdict.drop ? dropRuleId : firstEffectRuleId;
    return verdict;
}
