import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { DossierStore, validateDossierEdit } from "../../source/dossiers/dossier_store.js";
import { memberFor, type DossierMember } from "../../source/dossiers/dossier_index.js";
import { DossierRoutes } from "../../source/http/dossier_routes.js";
import { readToolDefinitions, runReadTool } from "../../source/capabilities/read_tools.js";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// The dossiers on disk, Master's gestures on them, their routes and the agent's tools.

function mail(key: string, thread: string, mailClass = "pro"): AcediaEvent {
    return {
        type: "email.received",
        ts: Number(key.replace(/\D/g, "")) || 1,
        source: "email",
        title: "Devis ACME",
        priority: "normal",
        dedupeKey: key,
        meta: { threadId: thread, from: "Léa <lea@acme.fr>", mailClass },
    };
}

const readable = (e: AcediaEvent) => e.meta?.["mailClass"] !== "perso";
const indexWith = (store: DossierStore, items: AcediaEvent[]) =>
    store.index({ items, readable, events: [], tasks: [], now: 5000 });

let dir: string;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dossiers-"));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe("DossierStore", () => {
    it("keeps its dossiers across a restart, and writes nothing when an index changes nothing", async () => {
        const file = path.join(dir, "dossiers.json");
        const store = new DossierStore(file);
        indexWith(store, [mail("m1", "t1"), mail("m2", "t1")]);
        await store.flush();
        const written = (await fs.stat(file)).mtimeMs;

        const again = new DossierStore(file);
        await again.load();
        expect(again.list().map((d) => d.members.length)).toEqual([2]);
        await new Promise((r) => setTimeout(r, 20));
        indexWith(again, [mail("m1", "t1"), mail("m2", "t1")]);
        await again.flush();
        expect((await fs.stat(file)).mtimeMs).toBe(written);
    });

    it("an unreadable file is no dossier yet, never a crash", async () => {
        const file = path.join(dir, "dossiers.json");
        await fs.writeFile(file, "{ torn", "utf-8");
        const store = new DossierStore(file);
        await store.load();
        expect(store.list()).toEqual([]);
    });

    it("a project label gathers what is tagged with it; detached, it stays out", () => {
        const store = new DossierStore();
        const d = store.create({ label: "ACME" });
        expect(d.title).toBe("ACME");
        const tagged = { ...mail("m1", "t9"), tags: ["ACME"] };
        indexWith(store, [tagged]);
        expect(store.get(d.id)!.members.map((m) => m.ref)).toEqual(["m1"]);
        store.detach(d.id, "m1");
        indexWith(store, [tagged]);
        expect(store.get(d.id)!.members).toEqual([]);
        // Attached again by hand: in, by Master's hand.
        store.attach(d.id, {
            kind: "mail",
            ref: "m1",
            title: "Devis ACME",
            at: 1,
            reason: "thread",
        });
        expect(store.get(d.id)!.members).toMatchObject([{ ref: "m1", reason: "manual" }]);
    });

    it("refuses an edit with nothing to call the dossier, or a repository not « owner/name »", () => {
        expect(validateDossierEdit({}, true)).toMatch(/title or a label/);
        expect(validateDossierEdit({ repos: ["nope"] })).toMatch(/owner\/name/);
        expect(
            validateDossierEdit({ label: "ACME", repos: ["CrOliX-AltF4/LunAcedia"] }, true),
        ).toBeNull();
    });
});

describe("memberFor — what « attach » may take", () => {
    const box = new Map<string, AcediaEvent>([
        ["m1", mail("m1", "t1")],
        ["p1", mail("p1", "t2", "perso")],
    ]);
    const sources = {
        item: (k: string) => box.get(k),
        readable,
        event: (id: string) =>
            id === "primary/e1"
                ? {
                      id,
                      calendarId: "primary",
                      title: "Point",
                      start: "2026-10-20T10:00:00Z",
                      end: "2026-10-20T11:00:00Z",
                      allDay: false,
                      recurring: false,
                      updatedAt: 0,
                  }
                : undefined,
        task: () => undefined,
    };

    it("a mail of the box, an event of the planning — never a mail a model may not read", () => {
        expect(memberFor("m1", sources)).toMatchObject({ kind: "mail", ref: "m1", thread: "t1" });
        expect(memberFor("primary/e1", sources)).toMatchObject({ kind: "event", title: "Point" });
        expect(memberFor("p1", sources)).toBeUndefined();
        expect(memberFor("nothing", sources)).toBeUndefined();
    });
});

describe("DossierRoutes", () => {
    function setup() {
        const store = new DossierStore();
        indexWith(store, [mail("m1", "t1"), mail("m2", "t1")]);
        const json = vi.fn();
        const member: DossierMember = {
            kind: "event",
            ref: "primary/e1",
            title: "Point",
            at: 3,
            reason: "manual",
        };
        const routes = new DossierRoutes({
            store,
            resolve: (ref) => (ref === "primary/e1" ? member : undefined),
            readBody: async (req) => (req as unknown as { body: unknown }).body,
            json,
        });
        const call = (method: string, p: string, body?: unknown) =>
            routes.handle(
                method,
                p,
                { body } as unknown as http.IncomingMessage,
                {} as http.ServerResponse,
            );
        const last = () => json.mock.calls.at(-1)!;
        return { store, json, call, last };
    }

    it("lists the dossiers with their count and latest item", async () => {
        const { call, last } = setup();
        expect(await call("GET", "/api/dossiers")).toBe(true);
        const [, status, body] = last();
        expect(status).toBe(200);
        expect(body.dossiers).toMatchObject([
            { title: "Devis ACME", count: 2, last: { kind: "mail" } },
        ]);
    });

    it("creates a project, attaches an event to it, detaches it", async () => {
        const { call, last } = setup();
        await call("POST", "/api/dossiers", { label: "ACME", repos: ["acme/site"] });
        const [, created, dossier] = last();
        expect(created).toBe(201);
        await call("POST", `/api/dossiers/${dossier.id}/attach`, { ref: "primary/e1" });
        expect(last()[2].members).toMatchObject([{ ref: "primary/e1", reason: "manual" }]);
        await call("POST", `/api/dossiers/${dossier.id}/detach`, { ref: "primary/e1" });
        expect(last()[2]).toMatchObject({ members: [], detached: ["primary/e1"] });
    });

    it("refuses to attach what nothing names (or a model may not read), and answers 404 for no dossier", async () => {
        const { call, last, store } = setup();
        const id = store.list()[0]!.id;
        await call("POST", `/api/dossiers/${id}/attach`, { ref: "p1" });
        expect(last()[1]).toBe(404);
        await call("GET", "/api/dossiers/dos_none");
        expect(last()[1]).toBe(404);
        await call("POST", "/api/dossiers", {});
        expect(last()[1]).toBe(400);
    });

    it("leaves other paths alone", async () => {
        const { call } = setup();
        expect(await call("GET", "/api/planning")).toBe(false);
    });
});

describe("the agent's dossier tools", () => {
    const store = new DossierStore();
    indexWith(store, [mail("m1", "t1"), mail("m2", "t1")]);
    const deps = {
        store: new EventStore(),
        busyIntervals: () => [],
        now: () => 0,
        dossiers: store,
    };

    it("are offered only with the dossiers", () => {
        expect(readToolDefinitions().map((t) => t.name)).not.toContain("list_dossiers");
        expect(readToolDefinitions({ dossiers: true }).map((t) => t.name)).toEqual(
            expect.arrayContaining(["list_dossiers", "get_dossier"]),
        );
    });

    it("list and read a dossier — its items as data from someone else", () => {
        const list = runReadTool("list_dossiers", { text: "acme" }, deps);
        expect(list).toMatchObject({
            ok: true,
            external: true,
            result: { total: 1, dossiers: [{ title: "Devis ACME", items: 2 }] },
        });
        const id = (list as { result: { dossiers: { id: string }[] } }).result.dossiers[0]!.id;
        const one = runReadTool("get_dossier", { id }, deps);
        expect(one).toMatchObject({
            ok: true,
            result: { items: [{ ref: "m1", why: "thread" }, { ref: "m2" }] },
        });
        expect(runReadTool("get_dossier", { id: "nope" }, deps)).toMatchObject({ ok: false });
    });
});
