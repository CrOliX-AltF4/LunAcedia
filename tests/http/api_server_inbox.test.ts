import { describe, it, expect, afterEach, vi } from "vitest";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { MailClassStore } from "../../source/guards/mail_class_store.js";
import type { GuardServices } from "../../source/guards/guard_services.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { hubOnBox, recordingLifecycle } from "../hub/recording_lifecycle.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { AgentService } from "../../source/agent/agent_service.js";
import type {
    IConnector,
    InboxGesture,
    InboxGestureResult,
} from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// Master's own gestures act at the source, directly (D1), are journaled, and the item
// follows (R8): same path as a change seen at the source.

async function call(
    method: string,
    url: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

function mail(id: string, read = false): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: `Mail ${id}`,
        priority: "normal",
        dedupeKey: `email-${id}`,
        meta: { messageId: id },
        read,
    };
}

type FakeGmail = IConnector & {
    gestures: Array<[InboxGesture, string]>;
    listTrash: ReturnType<typeof vi.fn>;
    restoreMessage: ReturnType<typeof vi.fn>;
};

function fakeGmail(fail = false): FakeGmail {
    const gestures: Array<[InboxGesture, string]> = [];
    const results: Record<string, InboxGestureResult> = {
        open: { change: "read", body: "Texte intégral" },
        read: { change: "read" },
        unread: { change: "unread" },
        archive: { change: "removed" },
        trash: { change: "removed" },
        spam: { change: "removed" },
    };
    return {
        slug: "email",
        name: "Gmail",
        poll: async () => [],
        gestures,
        inboxGesture: async (g: InboxGesture, e: AcediaEvent) => {
            if (fail) throw new Error("Gmail said no");
            if (!(g in results)) throw new Error(`"${g}" does not apply to a mail`);
            gestures.push([g, e.dedupeKey]);
            return results[g]!;
        },
        listTrash: vi.fn(async () => ({
            items: [{ id: "t1", title: "Vieille pub", from: "x@y.z", ts: 1 }],
            next: "p2",
            skipped: 0,
        })),
        restoreMessage: vi.fn(async () => {}),
    };
}

describe("AcediaApiServer — inbox routes", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(
        connector: IConnector,
        events: AcediaEvent[],
        tiers: Record<string, string> = {},
        guards?: GuardServices,
    ) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-inbox-"));
        const store = new EventStore();
        for (const e of events) store.push(e);
        const hub = hubOnBox([connector], { store }).hub;
        const tierStore = new ActionTierStore(path.join(dir, "t.json"), path.join(dir, "o.json"));
        if (Object.keys(tiers).length) await tierStore.patch(tiers as never);
        const { life, emitted } = recordingLifecycle(store);
        server = new AcediaApiServer(
            store,
            [connector],
            hub,
            null,
            new NullAIProvider(),
            undefined,
            tierStore,
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            guards,
            new AgentService(),
            life,
        );
        let port = 0;
        port = await server.start(0);
        return { base: `http://localhost:${port}`, store, emitted, hub };
    }

    // « Classer… » (ADR-041 D0): a mail filed by hand, or every mail of its sender through a rule.
    async function sortingGuards() {
        const rules = new GuardRulesStore(path.join(dir, "rules.json"));
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const stats = new GuardStats(path.join(dir, "stats.json"));
        const classes = new MailClassStore(path.join(dir, "classes.json"));
        const pipeline = new GuardPipeline({
            rules,
            journal,
            stats,
            vipSenders: () => [],
            classes,
        });
        return { pipeline, rules, journal, stats, classes } satisfies GuardServices;
    }

    it("lists what no model may read, and files a mail — or every mail of its sender — in another class", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-inbox-"));
        const guards = await sortingGuards();
        const from = (id: string, sender: string, mailClass = "inconnu"): AcediaEvent => ({
            ...mail(id),
            meta: { ...mail(id).meta, from: sender, mailClass },
        });
        const { base, store } = await start(
            fakeGmail(),
            [
                from("a", "Prof <prof@espi.fr>"),
                from("b", "Admin <admin@espi.fr>"),
                from("c", "Maman <maman@famille.fr>", "perso"),
            ],
            {},
            guards,
        );
        const listed = await call("GET", `${base}/api/inbox`);
        expect(listed.body.items.find((i: AcediaEvent) => i.dedupeKey === "email-c").ai).toBe(
            false,
        );
        expect(
            listed.body.items.find((i: AcediaEvent) => i.dedupeKey === "email-a").ai,
        ).toBeUndefined();

        const once = await call("POST", `${base}/api/inbox/email-c/class-pro`, {});
        expect(once.status).toBe(200);
        expect(store.get("email-c")!.meta).toMatchObject({
            mailClass: "pro",
            mailClassByHand: true,
        });

        const always = await call("POST", `${base}/api/inbox/email-a/class-pro`, { always: true });
        expect(always.body.rule.name).toBe("De « espi.fr » → Pro");
        expect(guards.rules.getRules()).toHaveLength(1);
        expect(store.get("email-b")!.meta?.["mailClass"]).toBe("pro");

        await guards.classes.patch({ classes: { pub: { visible: false } } });
        const out = await call("POST", `${base}/api/inbox/email-b/class-pub`, {});
        expect(out.body.change).toBe("removed");
        expect(store.has("email-b")).toBe(false);
        expect(guards.journal.get("email-b")!.ruleId).toBe("class:pub");
        expect((await call("POST", `${base}/api/inbox/email-a/class-spam`, {})).status).toBe(400);
    });

    // An action carried out (the agent, a confirmation) follows the box's own path: the wire, the views and a closed
    // phone's notification learn it — the store changed alone told nobody, and the next sync never would.
    it("an action carried out tells everyone, like a gesture in the box", async () => {
        const gmail = { ...fakeGmail(), executeAction: vi.fn(async () => {}) };
        const { base, store, emitted } = await start(gmail, [mail("a"), mail("b")], {
            mark_email_read: "auto",
            delete_email: "auto",
        });
        expect(
            (
                await call("POST", `${base}/api/actions`, {
                    connector: "Gmail",
                    action: { kind: "mark_email_read", sourceId: "a" },
                })
            ).status,
        ).toBe(204);
        expect(
            (
                await call("POST", `${base}/api/actions`, {
                    connector: "Gmail",
                    action: { kind: "delete_email", sourceId: "b" },
                })
            ).status,
        ).toBe(204);
        expect(store.get("email-a")!.read).toBe(true);
        expect(store.get("email-b")).toBeUndefined();
        expect(emitted).toEqual([
            { op: "read", key: "email-a", source: "email" },
            { op: "removed", key: "email-b", source: "email" },
        ]);
    });

    it("lists the box, newest first, with the unread count", async () => {
        const { base } = await start(fakeGmail(), [mail("a", true), mail("b")]);
        const r = await call("GET", `${base}/api/inbox`);
        expect(r.status).toBe(200);
        expect(r.body.items.map((i: AcediaEvent) => i.dedupeKey)).toEqual(["email-b", "email-a"]);
        expect(r.body.unread).toBe(1);
    });

    it("opens a mail: the whole text, marked read in the box, the Core told", async () => {
        const gmail = fakeGmail();
        const { base, store, emitted } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/open`);
        expect(r.body).toEqual({ ok: true, change: "read", body: "Texte intégral" });
        expect(store.get("email-a")!.read).toBe(true);
        expect(emitted).toEqual([{ op: "read", key: "email-a", source: "email" }]);
    });

    it("opens an item of a source without gestures: its text, marked read in the box, the Core told", async () => {
        const rss: IConnector = { slug: "rss", name: "RSS", poll: async () => [] };
        const item: AcediaEvent = {
            type: "rss.item",
            ts: Date.now(),
            source: "rss",
            title: "Article",
            body: "Le résumé gardé",
            priority: "info",
            dedupeKey: "rss-1",
        };
        const { base, store, emitted } = await start(rss, [item]);
        const r = await call("POST", `${base}/api/inbox/rss-1/open`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, change: "read", body: "Le résumé gardé" });
        expect(store.get("rss-1")!.read).toBe(true);
        expect(emitted).toEqual([{ op: "read", key: "rss-1", source: "rss" }]);
        // Only "open": the other gestures still need the source.
        expect((await call("POST", `${base}/api/inbox/rss-1/archive`)).status).toBe(400);
    });

    it("reports a mail as spam directly, and it leaves the box (D1)", async () => {
        const gmail = fakeGmail();
        const { base, store } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/spam`);
        expect(r.body).toEqual({ ok: true, change: "removed" });
        expect(gmail.gestures).toEqual([["spam", "email-a"]]);
        expect(store.get("email-a")).toBeUndefined();
    });

    it("trashes a mail directly — no tier, no pending: Master's click is the decision (D1)", async () => {
        const gmail = fakeGmail();
        const { base, store, emitted } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/trash`);
        expect(r.body).toEqual({ ok: true, change: "removed" });
        expect(gmail.gestures).toEqual([["trash", "email-a"]]);
        expect(store.get("email-a")).toBeUndefined();
        expect(emitted).toEqual([{ op: "removed", key: "email-a", source: "email" }]);
        expect((await call("GET", `${base}/api/actions/pending`)).body).toEqual([]);
    });

    it("journals every gesture, successful or not", async () => {
        const { base } = await start(fakeGmail(), [mail("a"), mail("b")]);
        await call("POST", `${base}/api/inbox/email-a/archive`);
        await call("POST", `${base}/api/inbox/email-b/done`);
        const j = await call("GET", `${base}/api/inbox/journal`);
        expect(
            j.body.map((e: { key: string; gesture: string; ok: boolean }) => [
                e.key,
                e.gesture,
                e.ok,
            ]),
        ).toEqual([
            ["email-b", "done", false],
            ["email-a", "archive", true],
        ]);
    });

    it("answers 404 for an unknown item and 400 for an unknown gesture", async () => {
        const { base } = await start(fakeGmail(), [mail("a")]);
        expect((await call("POST", `${base}/api/inbox/email-zz/read`)).status).toBe(404);
        expect((await call("POST", `${base}/api/inbox/email-a/explode`)).status).toBe(400);
        // "Non lu" is no longer a gesture of the box (opening is reading); the agent can still do it.
        expect((await call("POST", `${base}/api/inbox/email-a/unread`)).status).toBe(400);
    });

    it("gives the trash one page at a time: the page asked for, and the token of the next", async () => {
        const gmail = fakeGmail();
        const { base } = await start(gmail, []);
        const r = await call("GET", `${base}/api/inbox/trash?page=p1`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({
            items: [{ id: "t1", title: "Vieille pub", from: "x@y.z", ts: 1 }],
            next: "p2",
            skipped: 0,
        });
        expect(gmail.listTrash).toHaveBeenCalledWith("p1");
    });

    it("reports a refusal from the source as 502 and changes nothing", async () => {
        const { base, store, emitted } = await start(fakeGmail(true), [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/trash`);
        expect(r.status).toBe(502);
        expect(r.body.error).toContain("Gmail said no");
        expect(store.get("email-a")).toBeDefined();
        expect(emitted).toEqual([]);
    });

    // a conflict's way out is Master's gesture — the event moved at the calendar, the conflict gone.
    it("opens then solves a conflict: its own text, then its event moved to the chosen slot, the conflict out of the box", async () => {
        const executeAction = vi.fn(async () => {});
        // The calendar reads an event of its own on "open" — a conflict is not one.
        const inboxGesture = vi.fn(async () => {
            throw new Error("[GCal] item has no event id");
        });
        const calendar = {
            slug: "calendar" as const,
            name: "Calendar",
            poll: async () => [],
            executeAction,
            inboxGesture,
        };
        const conflict: AcediaEvent = {
            type: "planning.conflict",
            ts: 1,
            source: "calendar",
            title: "Conflit — A et B",
            body: "10:30–11:00 : « B » chevauche « A ».",
            priority: "normal",
            dedupeKey: "conflict-primary/a-primary/b",
            read: false,
            meta: {
                conflict: true,
                moving: "primary/b",
                solutions: [
                    {
                        eventId: "primary/b",
                        start: "2026-10-20T13:00:00.000Z",
                        end: "2026-10-20T14:00:00.000Z",
                    },
                ],
            },
        };
        const { base, store, emitted } = await start(calendar as never, [conflict]);
        const key = encodeURIComponent(conflict.dedupeKey);

        const opened = await call("POST", `${base}/api/inbox/${key}/open`);
        expect(opened.body).toEqual({
            ok: true,
            change: "read",
            body: "10:30–11:00 : « B » chevauche « A ».",
        });
        expect(inboxGesture).not.toHaveBeenCalled();
        expect((await call("POST", `${base}/api/inbox/${key}/solve-3`)).status).toBe(400);
        const r = await call("POST", `${base}/api/inbox/${key}/solve-0`);
        expect(r.status).toBe(200);
        expect(executeAction).toHaveBeenCalledWith({
            kind: "update_event",
            sourceId: "primary/b",
            fields: { start: "2026-10-20T13:00:00.000Z", end: "2026-10-20T14:00:00.000Z" },
        });
        expect(store.has(conflict.dedupeKey)).toBe(false);
        expect(emitted.at(-1)).toMatchObject({ op: "removed", key: conflict.dedupeKey });
        expect((await call("POST", `${base}/api/inbox/${key}/solve-0`)).status).toBe(404);
    });

    // « Laisser tel quel »: both events stay, the conflict leaves and is remembered — not brought back while it lasts.
    it("leaves a conflict as it is: out of the box, remembered as gone", async () => {
        const conflict: AcediaEvent = {
            type: "planning.conflict",
            ts: 1,
            source: "calendar",
            title: "Conflit — A et B",
            priority: "normal",
            dedupeKey: "conflict-primary/a-primary/b",
            read: false,
            meta: { conflict: true, solutions: [] },
        };
        const mailItem = mail("x");
        const { base, store } = await start(fakeGmail(), [conflict, mailItem]);
        expect(
            (
                await call(
                    "POST",
                    `${base}/api/inbox/${encodeURIComponent(mailItem.dedupeKey)}/leave`,
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await call(
                    "POST",
                    `${base}/api/inbox/${encodeURIComponent(conflict.dedupeKey)}/leave`,
                )
            ).status,
        ).toBe(200);
        expect(store.has(conflict.dedupeKey)).toBe(false);
        expect(store.isGone(conflict.dedupeKey)).toBe(true);
    });

    it("lists Gmail's trash and restores a mail, which comes back at the next collection", async () => {
        const gmail = fakeGmail();
        const { base, store } = await start(gmail, []);
        // Taken out at the source by a rule earlier: remembered as gone, it would never come back.
        store.markGone("email-t1");
        expect((await call("GET", `${base}/api/inbox/trash`)).body.items[0]).toMatchObject({
            id: "t1",
        });
        const r = await call("POST", `${base}/api/inbox/trash/t1/restore`);
        expect(r.body).toEqual({ ok: true });
        expect(gmail.restoreMessage).toHaveBeenCalledWith("t1");
        expect(store.knows("email-t1")).toBe(false);
    });
});
