import { describe, it, expect, vi } from "vitest";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { pendingActionEvent, summarizeAction } from "../../source/push/pending_push.js";

// A write waiting for Master rings the phone, which opens "À valider"; nothing goes in the box.
describe("pending action notification", () => {
    it("says what waits, in words, with what it would write", () => {
        expect(
            summarizeAction({ kind: "reply", sourceId: "m1", body: "C'est noté pour jeudi." }),
        ).toBe("Répondre à un mail — C'est noté pour jeudi.");
        expect(
            summarizeAction({
                kind: "create_event",
                fields: { summary: "Banque", start: "2026-10-06T10:00", end: "2026-10-06T11:00" },
            }),
        ).toBe("Créer un événement — Banque");
        expect(summarizeAction({ kind: "close_issue", sourceId: "o/r#2" })).toBe(
            "Fermer un ticket GitHub — o/r#2",
        );
    });

    it("cuts a long text", () => {
        const s = summarizeAction({ kind: "reply", sourceId: "m1", body: "x".repeat(300) });
        expect(s.length).toBeLessThanOrEqual(130);
        expect(s.endsWith("…")).toBe(true);
    });

    it("rings as an urgent system notification keyed by the action, never a box item", () => {
        const store = new PendingActionStore(null);
        const p = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "Noté." });
        const e = pendingActionEvent(p);
        expect(e).toMatchObject({
            type: "system.action_pending",
            source: "system",
            priority: "urgent",
            title: "Action à valider",
            body: "Répondre à un mail — Noté.",
            dedupeKey: `action-${p.id}`,
        });
    });

    it("the store tells every new pending action, and only new ones", () => {
        const store = new PendingActionStore(null);
        const seen = vi.fn();
        store.onCreate(seen);
        const p = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "Noté." });
        store.consume(p.id);
        expect(seen).toHaveBeenCalledTimes(1);
        expect(seen).toHaveBeenCalledWith(p);
    });
});
