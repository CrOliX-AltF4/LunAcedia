import type { AcediaEvent } from "../types/acedia_event.js";

/**
 * A mail's class, given at collection without any model: first a rule of the user's that classifies it, then the
 * senders the user calls personal, then what Gmail already knows (its categories, a List-Unsubscribe header). Each
 * class says whether its mails show in the box, may be read by a model, and ring.
 */
export const MAIL_CLASSES = ["pro", "perso", "notification", "pub", "inconnu"] as const;
export type MailClass = (typeof MAIL_CLASSES)[number];

export interface ClassSettings {
    /** In the box. Hidden: kept out like a dropped mail — journaled and restorable. */
    visible: boolean;
    /** Read by a model (agent, digest, proposals, a topic about it, the hub's briefing). */
    ai: boolean;
    /** Rings the phone, within the priority filter. */
    rings: boolean;
}

export type ClassTable = Record<MailClass, ClassSettings>;

/** Personal mail and advertising are never read by a model unless the user says so; nothing is hidden by default. */
export const DEFAULT_CLASSES: ClassTable = {
    pro: { visible: true, ai: true, rings: true },
    perso: { visible: true, ai: false, rings: true },
    notification: { visible: true, ai: true, rings: false },
    pub: { visible: true, ai: false, rings: false },
    inconnu: { visible: true, ai: true, rings: true },
};

export function isMailClass(v: unknown): v is MailClass {
    return typeof v === "string" && (MAIL_CLASSES as readonly string[]).includes(v);
}

const PROMOTIONS = "category_promotions";
const NOTIFICATION_LABELS = new Set(["category_social", "category_updates", "category_forums"]);

function labelsOf(event: AcediaEvent): string[] {
    const labels = event.meta?.["labels"];
    return Array.isArray(labels) ? labels.map((l) => String(l).toLowerCase()) : [];
}

function hasUnsubscribe(event: AcediaEvent): boolean {
    const headers = event.meta?.["headers"];
    return typeof headers === "object" && headers !== null && "list-unsubscribe" in headers;
}

/** Senders matched on the From header, case-insensitively — a name, an address or a part of one. */
export function makeSenderMatcher(senders: string[]): (event: AcediaEvent) => boolean {
    const list = senders.map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
    return (event) => {
        if (list.length === 0) return false;
        const from =
            typeof event.meta?.["from"] === "string" ? event.meta["from"].toLowerCase() : "";
        return list.some((s) => from.includes(s));
    };
}

export function classifyMail(
    event: AcediaEvent,
    opts: { ruleClass?: MailClass; personal: boolean; vip: boolean },
): MailClass {
    if (opts.ruleClass) return opts.ruleClass;
    if (opts.personal) return "perso";
    // A VIP is never filed away as bulk mail, whatever Gmail's category says.
    if (opts.vip) return "inconnu";
    const labels = labelsOf(event);
    if (labels.includes(PROMOTIONS)) return "pub";
    if (labels.some((l) => NOTIFICATION_LABELS.has(l)) || hasUnsubscribe(event))
        return "notification";
    return "inconnu";
}

/** The class a mail was given at collection — « inconnu » for one collected before the classes; other sources have none. */
export function classOf(event: AcediaEvent): MailClass | undefined {
    if (event.source !== "email") return undefined;
    const c = event.meta?.["mailClass"];
    return isMailClass(c) ? c : "inconnu";
}

/** Whether a model may read this item — the one check every call that hands the box to a model goes through. */
export function readableByAi(event: AcediaEvent, table: ClassTable): boolean {
    const c = classOf(event);
    return c === undefined || table[c].ai;
}

/** Whether its class lets it ring — the priority filter still applies on top. */
export function classRings(event: AcediaEvent, table: ClassTable): boolean {
    const c = classOf(event);
    return c === undefined || table[c].rings;
}
