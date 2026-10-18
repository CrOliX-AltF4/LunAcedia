import { describe, it, expect } from "vitest";
import {
    indexDossiers,
    names,
    addressOf,
    subjectOf,
    type Dossier,
    type IndexInput,
} from "../../source/dossiers/dossier_index.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

// Dossiers: the sources grouped without any model — a thread, a label, Master's hand; a person only
// proposes; nothing a model may not read.

function mail(
    key: string,
    thread: string,
    opts: Partial<AcediaEvent> & { from?: string; mailClass?: string } = {},
): AcediaEvent {
    const { from = "Léa <lea@acme.fr>", mailClass = "pro", ...rest } = opts;
    return {
        type: "email.received",
        ts: 1000,
        source: "email",
        title: "Devis",
        priority: "normal",
        dedupeKey: key,
        meta: { threadId: thread, from, mailClass },
        ...rest,
    };
}

function event(id: string, title: string, attendees?: string[]): PlanningEvent {
    return {
        id,
        calendarId: "primary",
        title,
        start: "2026-10-20T10:00:00Z",
        end: "2026-10-20T11:00:00Z",
        allDay: false,
        recurring: false,
        updatedAt: 0,
        ...(attendees && { attendees }),
    };
}

function task(id: string, title: string): PlanningTask {
    return { id, listId: "l", listTitle: "Tâches", title, status: "open", updatedAt: 5 };
}

let n = 0;
function input(over: Partial<IndexInput> = {}): IndexInput {
    return {
        items: [],
        readable: (e) => !["perso", "pub"].includes(String(e.meta?.["mailClass"])),
        events: [],
        tasks: [],
        now: 9999,
        newId: () => `d${++n}`,
        ...over,
    };
}

function labelled(label: string, repos: string[] = []): Dossier {
    return {
        id: `lab-${label}`,
        title: label,
        label,
        repos,
        members: [],
        detached: [],
        dismissed: [],
        createdAt: 1,
        updatedAt: 1,
    };
}

describe("dossier helpers", () => {
    it("a label names a title as whole words, accents and case aside", () => {
        expect(names("Réunion ACME lundi", "acme")).toBe(true);
        expect(names("Acmeo — devis", "ACME")).toBe(false);
        expect(names("Projet Été 2027", "projet ete")).toBe(true);
    });

    it("reads an address out of a From header, and a subject out of its « Re: »", () => {
        expect(addressOf("Léa <Lea@Acme.fr>")).toBe("lea@acme.fr");
        expect(addressOf("lea@acme.fr")).toBe("lea@acme.fr");
        expect(subjectOf("Re: TR : Devis")).toBe("Devis");
    });
});

describe("indexDossiers", () => {
    it("two mails of one thread make a dossier, named after the subject; one alone makes none", () => {
        const r = indexDossiers(
            [],
            input({
                items: [
                    mail("m1", "t1", { title: "Devis", ts: 1 }),
                    mail("m2", "t1", { title: "Re: Devis", ts: 2 }),
                    mail("m3", "t2"),
                ],
            }),
        );
        expect(r.dossiers).toHaveLength(1);
        expect(r.dossiers[0]).toMatchObject({
            title: "Devis",
            members: [
                { ref: "m1", reason: "thread" },
                { ref: "m2", reason: "thread" },
            ],
        });
        expect(r.changed).toBe(true);
    });

    it("is the same dossier when indexed again — nothing changes, nothing is written", () => {
        const items = [mail("m1", "t1"), mail("m2", "t1")];
        const first = indexDossiers([], input({ items }));
        const again = indexDossiers(first.dossiers, input({ items }));
        expect(again.dossiers).toEqual(first.dossiers);
        expect(again.changed).toBe(false);
    });

    it("a thread already in a dossier brings its next mail there, and keeps the ones that left the box", () => {
        const first = indexDossiers([], input({ items: [mail("m1", "t1"), mail("m2", "t1")] }));
        const r = indexDossiers(first.dossiers, input({ items: [mail("m3", "t1")] }));
        expect(r.dossiers[0]!.members.map((m) => m.ref)).toEqual(["m1", "m2", "m3"]);
    });

    it("never holds what a model may not read — and lets go of a mail filed personal later", () => {
        const r = indexDossiers(
            [],
            input({
                items: [
                    mail("m1", "t1", { mailClass: "perso" }),
                    mail("m2", "t1", { mailClass: "perso" }),
                ],
            }),
        );
        expect(r.dossiers).toEqual([]);

        const first = indexDossiers([], input({ items: [mail("m1", "t1"), mail("m2", "t1")] }));
        const refiled = indexDossiers(
            first.dossiers,
            input({ items: [mail("m1", "t1", { mailClass: "perso" }), mail("m2", "t1")] }),
        );
        expect(refiled.dossiers[0]!.members.map((m) => m.ref)).toEqual(["m2"]);
    });

    it("a labelled dossier gathers the mails tagged with it, their thread, the events and tasks it names", () => {
        const r = indexDossiers(
            [labelled("ACME")],
            input({
                items: [mail("m1", "t1", { tags: ["acme"] }), mail("m2", "t1")],
                events: [event("e1", "Réunion ACME"), event("e2", "Dentiste")],
                tasks: [task("k1", "Envoyer le devis ACME"), task("k2", "Courses")],
            }),
        );
        expect(r.dossiers).toHaveLength(1);
        expect(r.dossiers[0]!.members.map((m) => [m.ref, m.reason])).toEqual(
            expect.arrayContaining([
                ["m1", "label"],
                ["m2", "thread"],
                ["e1", "label"],
                ["k1", "label"],
            ]),
        );
        expect(r.dossiers[0]!.members).toHaveLength(4);
    });

    it("a repository given to a dossier brings its GitHub notifications", () => {
        const gh: AcediaEvent = {
            type: "github.push",
            ts: 3,
            source: "github",
            title: "[CrOliX-AltF4/LunAcedia] fix",
            priority: "info",
            dedupeKey: "gh-1",
        };
        const r = indexDossiers(
            [labelled("Lun", ["crolix-altf4/lunacedia"])],
            input({ items: [gh] }),
        );
        expect(r.dossiers[0]!.members).toMatchObject([{ kind: "github", ref: "gh-1" }]);
    });

    it("a detached item never comes back on its own", () => {
        const d = { ...labelled("ACME"), detached: ["e1"] };
        const r = indexDossiers([d], input({ events: [event("e1", "Réunion ACME")] }));
        expect(r.dossiers[0]!.members).toEqual([]);
        expect(r.changed).toBe(false);
    });

    it("a person only proposes — an event shared with a correspondent, with its reason", () => {
        const items = [mail("m1", "t1"), mail("m2", "t1")];
        const r = indexDossiers(
            [],
            input({
                items,
                events: [
                    event("e1", "Point", ["lea@acme.fr"]),
                    event("e2", "Autre", ["paul@x.fr"]),
                ],
            }),
        );
        expect(r.dossiers[0]!.members.map((m) => m.ref)).toEqual(["m1", "m2"]);
        expect(r.proposals).toEqual([
            {
                dossierId: r.dossiers[0]!.id,
                member: expect.objectContaining({ ref: "e1", kind: "event" }),
                why: "même participant : lea@acme.fr",
            },
        ]);
        // Declined once, never proposed again.
        const dismissed = indexDossiers(
            [{ ...r.dossiers[0]!, dismissed: ["e1"] }],
            input({ items, events: [event("e1", "Point", ["lea@acme.fr"])] }),
        );
        expect(dismissed.proposals).toEqual([]);
    });
});
