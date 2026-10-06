import { describe, it, expect } from "vitest";
import { EventStore } from "../../source/store/event_store.js";
import { selectMail, describeMatch, BULK_LIMIT } from "../../source/actions/mail_selection.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// « Tous les mails qui viennent d'aliexpress » (ADR-023 T2): the box's mails that match, the same structured conditions
// as the guards — never a regex, never a model.

function mail(id: string, from: string, title = `Mail ${id}`, ts = 1_000 + Number(id)): AcediaEvent {
    return {
        type: "email.received",
        ts,
        source: "email",
        title,
        priority: "info",
        dedupeKey: `email-${id}`,
        meta: { messageId: id, from },
        read: false,
    };
}

function box(events: AcediaEvent[]): EventStore {
    const store = new EventStore();
    for (const e of events) store.push(e);
    return store;
}

describe("selectMail", () => {
    const store = box([
        mail("1", "AliExpress <promo@notice.aliexpress.com>", "Soldes"),
        mail("2", "aliexpress-deals@mail.com", "Encore"),
        mail("3", "Banque <info@banque.fr>", "Relevé"),
        {
            ...mail("4", "AliExpress <x@aliexpress.com>"),
            source: "github",
            dedupeKey: "gh-4",
        } as AcediaEvent,
    ]);

    it("takes the box's mails whose sender contains the text, newest first", () => {
        const s = selectMail(store, { fromContains: "aliexpress" });
        expect(s.sourceIds).toEqual(["2", "1"]);
        expect(s.matched).toBe(2);
        expect(s.sample.map((m) => m.title)).toEqual(["Encore", "Soldes"]);
    });

    it("by domain: the sender's domain or a subdomain of it, not a lookalike address", () => {
        expect(selectMail(store, { fromDomain: "aliexpress.com" }).sourceIds).toEqual(["1"]);
    });

    it("ANDs the criteria", () => {
        expect(selectMail(store, { fromContains: "aliexpress", subjectContains: "soldes" }).sourceIds).toEqual(["1"]);
    });

    it("selects nothing without a criterion — never the whole box", () => {
        expect(selectMail(store, {}).sourceIds).toEqual([]);
        expect(selectMail(store, { fromContains: "  " }).sourceIds).toEqual([]);
    });

    it(`stops at ${BULK_LIMIT} mails and says how many matched`, () => {
        const many = box(Array.from({ length: BULK_LIMIT + 5 }, (_, i) => mail(String(i + 1), "spam@pub.com")));
        const s = selectMail(many, { fromDomain: "pub.com" });
        expect(s.sourceIds).toHaveLength(BULK_LIMIT);
        expect(s.matched).toBe(BULK_LIMIT + 5);
        expect(s.sample).toHaveLength(5);
    });
});

describe("describeMatch", () => {
    it("says the criteria in words", () => {
        expect(describeMatch({ fromContains: "aliexpress" })).toBe("expéditeur contenant « aliexpress »");
        expect(describeMatch({ fromDomain: "pub.com", subjectContains: "promo" })).toBe(
            "domaine « pub.com », sujet contenant « promo »",
        );
        expect(describeMatch({ from: "a@b.c" })).toBe("expéditeur « a@b.c »");
    });
});
