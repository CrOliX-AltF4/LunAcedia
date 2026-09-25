import { describe, it, expect } from "vitest";
import { EventStore } from "../../source/store/event_store.js";
import {
    readToolDefinitions,
    runReadTool,
    type ReadToolDeps,
} from "../../source/capabilities/read_tools.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

function mail(id: string, over: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: NOW - 60_000,
        source: "email",
        title: `Mail ${id}`,
        body: `Body of ${id}`,
        priority: "normal",
        dedupeKey: `email-${id}`,
        meta: { messageId: id, threadId: `t-${id}`, from: "paul@example.com", internal: "x" },
        read: false,
        ...over,
    };
}

function deps(events: AcediaEvent[], busy: { start: number; end: number }[] = []): ReadToolDeps {
    const store = new EventStore();
    for (const e of events) store.push(e);
    return { store, busyIntervals: () => busy, now: () => NOW };
}

describe("readToolDefinitions (ADR-017 M2)", () => {
    it("offers search_events, get_event and free_slots with object schemas", () => {
        const defs = readToolDefinitions();
        expect(defs.map((d) => d.name)).toEqual(["search_events", "get_event", "free_slots"]);
        for (const d of defs) expect(d.parameters.type).toBe("object");
    });
});

describe("search_events", () => {
    it("filters by source, priority and unread, newest first", () => {
        const d = deps([
            mail("1", { ts: NOW - 3_000, priority: "urgent" }),
            mail("2", { ts: NOW - 2_000, priority: "urgent", read: true }),
            mail("3", { ts: NOW - 1_000, priority: "normal" }),
        ]);
        const r = runReadTool(
            "search_events",
            { source: "email", priority: "urgent", unread: true },
            d,
        );
        expect(r.ok).toBe(true);
        if (r.ok)
            expect((r.result as { events: { key: string }[] }).events.map((e) => e.key)).toEqual([
                "email-1",
            ]);
    });

    it("matches free text in title or body, case-insensitively", () => {
        const d = deps([
            mail("1", { title: "Facture EDF" }),
            mail("2", { body: "rendez-vous chez le DENTISTE" }),
        ]);
        const keys = (q: string) => {
            const r = runReadTool("search_events", { text: q }, d);
            return r.ok ? (r.result as { events: { key: string }[] }).events.map((e) => e.key) : [];
        };
        expect(keys("facture")).toEqual(["email-1"]);
        expect(keys("dentiste")).toEqual(["email-2"]);
    });

    it("keeps only the recent window when sinceHours is given", () => {
        const d = deps([
            mail("old", { ts: NOW - 5 * 3_600_000 }),
            mail("new", { ts: NOW - 3_600_000 }),
        ]);
        const r = runReadTool("search_events", { sinceHours: 2 }, d);
        expect(r.ok).toBe(true);
        if (r.ok)
            expect((r.result as { events: { key: string }[] }).events.map((e) => e.key)).toEqual([
                "email-new",
            ]);
    });

    it("returns compact items: the ids actions need, a short snippet, no full body", () => {
        const d = deps([mail("1", { body: "x".repeat(1_000) })]);
        const r = runReadTool("search_events", {}, d);
        if (!r.ok) throw new Error("expected ok");
        const item = (r.result as { events: Record<string, unknown>[] }).events[0]!;
        expect(item["ids"]).toEqual({ messageId: "1", threadId: "t-1" });
        expect(String(item["snippet"]).length).toBeLessThanOrEqual(161);
        expect(item).not.toHaveProperty("body");
    });

    it("caps the number of results and says how many matched in total", () => {
        const d = deps(Array.from({ length: 40 }, (_, i) => mail(String(i))));
        const r = runReadTool("search_events", { limit: 5 }, d);
        if (!r.ok) throw new Error("expected ok");
        const res = r.result as { events: unknown[]; total: number };
        expect(res.events).toHaveLength(5);
        expect(res.total).toBe(40);
    });

    it("flags the result as external content when it carries mail text", () => {
        const r = runReadTool("search_events", {}, deps([mail("1")]));
        expect(r.ok && r.external).toBe(true);
    });

    it("rejects invalid arguments instead of guessing", () => {
        expect(runReadTool("search_events", { priority: "critical" }, deps([])).ok).toBe(false);
        expect(runReadTool("search_events", { limit: 500 }, deps([])).ok).toBe(false);
    });
});

describe("get_event", () => {
    it("returns the full event body, truncated to a bounded size, as external content", () => {
        const d = deps([mail("1", { body: "y".repeat(10_000) })]);
        const r = runReadTool("get_event", { key: "email-1" }, d);
        if (!r.ok) throw new Error("expected ok");
        expect(r.external).toBe(true);
        const ev = r.result as { body: string; key: string };
        expect(ev.key).toBe("email-1");
        expect(ev.body.length).toBeLessThanOrEqual(4_001);
    });

    it("says plainly when the event is unknown", () => {
        const r = runReadTool("get_event", { key: "email-nope" }, deps([]));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("email-nope");
    });
});

describe("free_slots", () => {
    it("lists open slots in the window from the calendar's busy intervals", () => {
        const busy = [{ start: NOW + 3_600_000, end: NOW + 2 * 3_600_000 }];
        const r = runReadTool("free_slots", { hours: 4, minGapMin: 30 }, deps([], busy));
        if (!r.ok) throw new Error("expected ok");
        const slots = (r.result as { slots: { start: string; end: string }[] }).slots;
        expect(slots[0]).toEqual({
            start: new Date(NOW).toISOString(),
            end: new Date(NOW + 3_600_000).toISOString(),
        });
        expect(r.external).toBe(false);
    });
});

describe("runReadTool", () => {
    it("refuses an unknown tool name", () => {
        expect(runReadTool("delete_everything", {}, deps([])).ok).toBe(false);
    });
});
