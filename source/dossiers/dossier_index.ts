import type { AcediaEvent } from "../types/acedia_event.js";
import type { PlanningEvent, PlanningTask } from "../types/planning.js";

/**
 * Dossiers: what LunAcedia's sources say about one matter, grouped without any model. A dossier holds
 * references and headers only — never a mail's body — so it outlives the box (a mail archived leaves the box, not its
 * dossier) and costs nothing to keep.
 *
 * Grouping, deterministic:
 * - **a thread**: two mails of one Gmail thread make a dossier; its later mails join it;
 * - **a label**: a dossier Master labelled « ACME » gathers the mails a guard rule tagged ACME (the rules' `tag`
 *   action, editable at the panel and the dashboard), the events and tasks whose title names it, and the GitHub
 *   notifications of the repositories he gave it;
 * - **by hand**: attached or detached by Master — a detached item never comes back on its own.
 * A person alone never attaches anything (one colleague in every thread would merge them all): an event shared with a
 * dossier's correspondents is only **proposed**, with its reason.
 * Nothing a model may not read (personal mail, advertising) is ever in a dossier.
 */
export type MemberKind = "mail" | "event" | "task" | "github";
export type MemberReason = "thread" | "label" | "manual";

export interface DossierMember {
    kind: MemberKind;
    /** The box key (mail, GitHub) or the planning id (event, task). */
    ref: string;
    title: string;
    /** When it happened: a mail's date, an event's start, a task's due date or last change. */
    at: number;
    /** A mail's sender (the From header). */
    from?: string;
    /** A mail's Gmail thread. */
    thread?: string;
    /** A mail's class when it was gathered — what makes a dossier worth a summary. */
    mailClass?: string;
    reason: MemberReason;
}

export interface Dossier {
    id: string;
    title: string;
    /** Master's label: gathers what is tagged or titled with it. */
    label?: string;
    /** GitHub repositories (owner/name) whose notifications belong here. */
    repos: string[];
    members: DossierMember[];
    /** Refs Master took out: never brought back on their own. */
    detached: string[];
    /** Proposals Master declined: never proposed again. */
    dismissed: string[];
    /** The last summary of the daily pass. */
    digest?: { summary: string; state: string; at: number };
    createdAt: number;
    updatedAt: number;
}

export interface DossierProposal {
    dossierId: string;
    member: DossierMember;
    /** Why it is proposed, said to Master. */
    why: string;
}

export interface IndexInput {
    /** Every item the box holds. */
    items: AcediaEvent[];
    /** Whether a model may read an item (its class of mail): the others never enter a dossier. */
    readable: (event: AcediaEvent) => boolean;
    events: PlanningEvent[];
    tasks: PlanningTask[];
    now: number;
    newId: () => string;
}

export interface IndexResult {
    dossiers: Dossier[];
    proposals: DossierProposal[];
    /** Whether anything changed — the store writes only then. */
    changed: boolean;
}

/** Case, accents and punctuation do not count. */
export function normalize(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/** The label as a whole word or words of the title: « ACME » names « Devis ACME », not « Acmeo ». */
export function names(title: string, label: string): boolean {
    const l = normalize(label);
    return l !== "" && ` ${normalize(title)} `.includes(` ${l} `);
}

/** The address in a From header (« Léa <lea@x.fr> » → lea@x.fr), lower case. */
export function addressOf(from: string): string {
    const m = /<([^>]+)>/.exec(from);
    return (m ? m[1]! : from).trim().toLowerCase();
}

/** A thread's subject without its « Re: », « Fwd: », « TR : »… */
export function subjectOf(title: string): string {
    return title.replace(/^(\s*(re|fwd?|tr|aw|wg)\s*:\s*)+/i, "").trim() || title;
}

export function mailMember(e: AcediaEvent, reason: MemberReason): DossierMember {
    const from = typeof e.meta?.["from"] === "string" ? e.meta["from"] : undefined;
    const thread = typeof e.meta?.["threadId"] === "string" ? e.meta["threadId"] : undefined;
    const mailClass = typeof e.meta?.["mailClass"] === "string" ? e.meta["mailClass"] : undefined;
    return {
        kind: "mail",
        ref: e.dedupeKey,
        title: e.title,
        at: e.ts,
        ...(from && { from }),
        ...(thread && { thread }),
        ...(mailClass && { mailClass }),
        reason,
    };
}

export function eventMember(ev: PlanningEvent, reason: MemberReason): DossierMember {
    return { kind: "event", ref: ev.id, title: ev.title, at: Date.parse(ev.start) || 0, reason };
}

export function taskMember(t: PlanningTask, reason: MemberReason): DossierMember {
    return {
        kind: "task",
        ref: t.id,
        title: t.title,
        at: t.due ? Date.parse(t.due) : t.updatedAt,
        reason,
    };
}

export function githubMember(e: AcediaEvent, reason: MemberReason): DossierMember {
    return { kind: "github", ref: e.dedupeKey, title: e.title, at: e.ts, reason };
}

function repoOf(e: AcediaEvent): string | undefined {
    const repo = e.meta?.["repo"];
    if (typeof repo === "string") return repo;
    // A notification thread names its repository in its title: « [owner/name] … ».
    const m = /^\[([^\]\s]+\/[^\]\s]+)\]/.exec(e.title);
    return m?.[1];
}

/**
 * The dossiers brought up to date with what the sources hold — a pure function of its input, so the same box and the
 * same planning always give the same dossiers. Members are only ever added by it (or by Master); a mail leaves a
 * dossier only when it can no longer be read by a model.
 */
export function indexDossiers(current: Dossier[], input: IndexInput): IndexResult {
    const dossiers = current.map((d) => ({ ...d, members: [...d.members] }));
    let changed = false;
    const touch = (d: Dossier): void => {
        d.updatedAt = input.now;
        changed = true;
    };
    const add = (d: Dossier, m: DossierMember): void => {
        if (d.detached.includes(m.ref) || d.members.some((x) => x.ref === m.ref)) return;
        d.members.push(m);
        touch(d);
    };

    const mails = input.items.filter((e) => e.source === "email");
    const readable = mails.filter((e) => input.readable(e));
    const unreadable = new Set(mails.filter((e) => !input.readable(e)).map((e) => e.dedupeKey));

    // Never anything a model may not read — even attached by hand, even filed in another class later.
    for (const d of dossiers) {
        const kept = d.members.filter((m) => !(m.kind === "mail" && unreadable.has(m.ref)));
        if (kept.length !== d.members.length) {
            d.members = kept;
            touch(d);
        }
    }

    // Labels first: a tagged mail goes to its label's dossier, its thread with it.
    const labelled = dossiers.filter((d) => d.label);
    const threadHome = new Map<string, Dossier>();
    for (const d of dossiers)
        for (const m of d.members)
            if (m.thread && !threadHome.has(m.thread)) threadHome.set(m.thread, d);
    for (const e of readable) {
        const tags = e.tags ?? [];
        for (const d of labelled) {
            if (!tags.some((t) => normalize(t) === normalize(d.label!))) continue;
            const member = mailMember(e, "label");
            add(d, member);
            if (member.thread && !threadHome.has(member.thread)) threadHome.set(member.thread, d);
        }
    }

    // Threads: two mails make a dossier; a thread already in one brings its new mails there.
    const byThread = new Map<string, AcediaEvent[]>();
    for (const e of readable) {
        const t = e.meta?.["threadId"];
        if (typeof t !== "string") continue;
        byThread.set(t, [...(byThread.get(t) ?? []), e]);
    }
    for (const [thread, list] of byThread) {
        let home = threadHome.get(thread);
        if (!home && list.length < 2) continue;
        if (!home) {
            const first = [...list].sort((a, b) => a.ts - b.ts)[0]!;
            home = {
                id: input.newId(),
                title: subjectOf(first.title),
                repos: [],
                members: [],
                detached: [],
                dismissed: [],
                createdAt: input.now,
                updatedAt: input.now,
            };
            dossiers.push(home);
            threadHome.set(thread, home);
            changed = true;
        }
        for (const e of list) add(home, mailMember(e, "thread"));
    }

    // A label also names events and tasks; a repository given to a dossier brings its GitHub notifications.
    for (const d of labelled) {
        for (const ev of input.events)
            if (names(ev.title, d.label!)) add(d, eventMember(ev, "label"));
        for (const t of input.tasks) if (names(t.title, d.label!)) add(d, taskMember(t, "label"));
    }
    for (const d of dossiers) {
        if (d.repos.length === 0) continue;
        const repos = new Set(d.repos.map((r) => r.toLowerCase()));
        for (const e of input.items) {
            if (e.source !== "github") continue;
            const repo = repoOf(e);
            if (repo && repos.has(repo.toLowerCase())) add(d, githubMember(e, "label"));
        }
    }

    // A person only proposes: an event shared with the dossier's correspondents.
    const proposals: DossierProposal[] = [];
    for (const d of dossiers) {
        const people = new Set(d.members.filter((m) => m.from).map((m) => addressOf(m.from!)));
        if (people.size === 0) continue;
        for (const ev of input.events) {
            if (
                d.members.some((m) => m.ref === ev.id) ||
                d.detached.includes(ev.id) ||
                d.dismissed.includes(ev.id)
            )
                continue;
            const shared = (ev.attendees ?? []).find((a) => people.has(a.toLowerCase()));
            if (shared)
                proposals.push({
                    dossierId: d.id,
                    member: eventMember(ev, "manual"),
                    why: `même participant : ${shared}`,
                });
        }
    }

    for (const d of dossiers) d.members.sort((a, b) => a.at - b.at);
    return { dossiers, proposals, changed };
}

/**
 * The member a ref names, for Master's « attach »: a box item (a mail, a GitHub notification) or a planning object (an
 * event, a task). Undefined when nothing does — or when it is something a model may not read.
 */
export function memberFor(
    ref: string,
    sources: {
        item: (key: string) => AcediaEvent | undefined;
        readable: (event: AcediaEvent) => boolean;
        event: (id: string) => PlanningEvent | undefined;
        task: (id: string) => PlanningTask | undefined;
    },
): DossierMember | undefined {
    const item = sources.item(ref);
    if (item) {
        if (!sources.readable(item)) return undefined;
        if (item.source === "email") return mailMember(item, "manual");
        if (item.source === "github") return githubMember(item, "manual");
        return undefined;
    }
    const ev = sources.event(ref);
    if (ev) return eventMember(ev, "manual");
    const t = sources.task(ref);
    return t ? taskMember(t, "manual") : undefined;
}
