import type { EventStore } from "../store/event_store.js";
import type { ItemLifecycle } from "../hub/item_lifecycle.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import { extractAddress, senderDomain } from "./guard_engine.js";
import type { GuardPipeline } from "./guard_pipeline.js";
import type { GuardRulesStore } from "./guard_rules_store.js";
import type { GuardRule } from "./guard_types.js";
import type { MailClass } from "./mail_class.js";

/** Webmail domains: « always for this sender » means the address there, never everyone on the domain. */
const SHARED_DOMAINS = new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "outlook.fr",
    "hotmail.com",
    "hotmail.fr",
    "live.com",
    "live.fr",
    "yahoo.com",
    "yahoo.fr",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
    "orange.fr",
    "wanadoo.fr",
    "free.fr",
    "sfr.fr",
    "laposte.net",
    "gmx.fr",
    "gmx.com",
]);

const LABELS: Record<MailClass, string> = {
    pro: "Pro",
    perso: "Perso",
    notification: "Notifications",
    pub: "Pub",
    inconnu: "Non classé",
};

export interface ReclassDeps {
    store: EventStore;
    life: Pick<ItemLifecycle, "refreshed" | "changed">;
    pipeline: GuardPipeline;
    rules: GuardRulesStore;
    hidden: (c: MailClass) => boolean;
}

export type ReclassResult =
    | { ok: true; change: "removed" | null; rule?: GuardRule }
    | { ok: false; status: number; error: string };

/** The rule « always for this sender »: its domain, or its address on a webmail. */
export function senderRule(event: AcediaEvent, mailClass: MailClass): GuardRule | null {
    const from = typeof event.meta?.["from"] === "string" ? event.meta["from"] : "";
    const address = extractAddress(from);
    const domain = senderDomain(from);
    if (!address || !domain) return null;
    const byAddress = SHARED_DOMAINS.has(domain);
    const value = byAddress ? address : domain;
    return {
        id: `class-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: `De « ${value} » → ${LABELS[mailClass]}`,
        enabled: true,
        conditions: [
            byAddress
                ? { field: "from", op: "equals", value }
                : { field: "from", op: "domain", value },
        ],
        actions: [{ type: "classify", mailClass }],
    };
}

/**
 * Master files a mail in another class (« Classer… »): this mail by hand — kept over what the source and the rules
 * would say — or, with `always`, every mail of its sender through a new rule, the box's mails included. A class kept
 * out of the box takes the mail out, journaled and restorable.
 */
export async function reclassify(
    deps: ReclassDeps,
    key: string,
    mailClass: MailClass,
    always: boolean,
): Promise<ReclassResult> {
    const item = deps.store.get(key);
    if (!item) return { ok: false, status: 404, error: "No such item in the box" };
    if (item.source !== "email")
        return { ok: false, status: 400, error: "Only a mail has a class" };

    let rule: GuardRule | undefined;
    if (always) {
        const made = senderRule(item, mailClass);
        if (!made) return { ok: false, status: 400, error: "This mail has no sender address" };
        const saved = await deps.rules.replaceAll([...deps.rules.getRules(), made]);
        if (!saved.ok) return { ok: false, status: 400, error: saved.error };
        rule = made;
        // The box's other mails of this sender follow the rule now, not at the next collection.
        for (const held of deps.store.query({ source: "email", limit: Number.MAX_SAFE_INTEGER })
            .events as AcediaEvent[]) {
            if (held.dedupeKey === key || held.meta?.["mailClassByHand"] === true) continue;
            const next = deps.pipeline.prioritize(held);
            if (next.meta?.["mailClass"] === held.meta?.["mailClass"]) continue;
            if (deps.hidden(mailClass) && next.meta?.["mailClass"] === mailClass) {
                deps.pipeline.keepOut(next, made.id);
                deps.life.changed(held.dedupeKey, "removed", "gesture");
            } else deps.life.refreshed(next);
        }
    }

    const filed: AcediaEvent = {
        ...item,
        meta: { ...item.meta, mailClass, ...(!always && { mailClassByHand: true }) },
    };
    if (deps.hidden(mailClass)) {
        deps.pipeline.keepOut(filed, rule?.id ?? `class:${mailClass}`);
        deps.life.changed(key, "removed", "gesture");
        return { ok: true, change: "removed", ...(rule && { rule }) };
    }
    deps.life.refreshed(filed);
    return { ok: true, change: null, ...(rule && { rule }) };
}
