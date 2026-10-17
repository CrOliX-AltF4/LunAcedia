/**
 * The box: Master's own gestures on an item, applied at the source — Gmail, GitHub — then
 * followed by the item and told to the Core (ItemLifecycle, the same path as a change seen at the
 * source, R8). A gesture is Master's own hand, not an autonomous decision: it runs directly, without the
 * tier gate that governs the agent (D1), and every gesture is journaled.
 *
 *   GET  /api/inbox                          { items (newest first), unread }
 *   POST /api/inbox/:key/:gesture            open | read | archive | trash | spam | done
 *   POST /api/inbox/:key/solve/:n            a conflict's n-th way out: its event moved there
 *   GET  /api/inbox/trash?page=…             Gmail's trash (30 days, kept by Gmail), a page at a time:
 *                                            { items, next?, skipped }
 *   POST /api/inbox/trash/:messageId/restore back to the inbox, collected again at the next pass
 *   GET  /api/inbox/journal                  the last 100 gestures, newest first
 */
import type http from "node:http";
import type { EventStore } from "../store/event_store.js";
import type { IngestionHub } from "../hub/ingestion_hub.js";
import type { ItemLifecycle } from "../hub/item_lifecycle.js";
import type { IConnector, InboxGesture } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { TrashPage } from "../connectors/email/gmail_connector.js";

const GESTURES: readonly InboxGesture[] = ["open", "read", "archive", "trash", "spam", "done"];
const JOURNAL_SIZE = 100;
const BOX_SIZE = 200;

export interface InboxJournalEntry {
    at: string;
    key: string;
    gesture: InboxGesture | "restore" | "solve";
    ok: boolean;
    error?: string;
}

/** Trash-capable connector (Gmail). */
interface TrashCapable {
    listTrash(page?: string): Promise<TrashPage>;
    restoreMessage(id: string): Promise<void>;
}

function isTrashCapable(c: IConnector): c is IConnector & TrashCapable {
    const t = c as Partial<TrashCapable>;
    return typeof t.listTrash === "function" && typeof t.restoreMessage === "function";
}

export interface InboxRouteDeps {
    store: EventStore;
    connectors: IConnector[];
    hub: IngestionHub;
    life: Pick<ItemLifecycle, "changed" | "mayReturn">;
    /** The planning, read again once a conflict's event was moved — absent where it is not wired. */
    planningSync?: { syncNow(): Promise<void> };
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export class InboxRoutes {
    private readonly journal: InboxJournalEntry[] = [];

    constructor(private readonly deps: InboxRouteDeps) {}

    /** Handles the request if it is an inbox route; returns false otherwise. */
    async handle(
        method: string,
        path: string,
        res: http.ServerResponse,
        query: URLSearchParams = new URLSearchParams(),
    ): Promise<boolean> {
        const { json, store } = this.deps;
        if (!path.startsWith("/api/inbox")) return false;

        if (method === "GET" && path === "/api/inbox") {
            const { events } = store.query({ limit: BOX_SIZE });
            const items = events as AcediaEvent[];
            json(res, 200, { items, unread: items.filter((e) => !e.read).length });
            return true;
        }

        if (method === "GET" && path === "/api/inbox/journal") {
            json(res, 200, this.journal);
            return true;
        }

        if (method === "GET" && path === "/api/inbox/trash") {
            const gmail = this.deps.connectors.find(isTrashCapable);
            if (!gmail) {
                json(res, 200, { items: [], skipped: 0 });
                return true;
            }
            try {
                json(res, 200, await gmail.listTrash(query.get("page") ?? undefined));
            } catch (e) {
                json(res, 502, { error: (e as Error).message });
            }
            return true;
        }

        const restore = path.match(/^\/api\/inbox\/trash\/([^/]+)\/restore$/);
        if (method === "POST" && restore) {
            const id = decodeURIComponent(restore[1]!);
            const gmail = this.deps.connectors.find(isTrashCapable);
            if (!gmail) {
                json(res, 404, { error: "No trash-capable connector" });
                return true;
            }
            const key = `email-${id}`;
            try {
                await gmail.restoreMessage(id);
                // Back in the inbox at the source: let the next collection take it again (R8).
                this.deps.life.mayReturn(key);
                void this.deps.hub.pollOne(gmail.slug);
                this.record(key, "restore", true);
                json(res, 200, { ok: true });
            } catch (e) {
                this.record(key, "restore", false, (e as Error).message);
                json(res, 502, { error: (e as Error).message });
            }
            return true;
        }

        // A conflict's way out, chosen by Master: his hand, carried out at once like any gesture of the box.
        const solve = path.match(/^\/api\/inbox\/([^/]+)\/solve\/(\d+)$/);
        if (method === "POST" && solve) {
            await this.solve(res, decodeURIComponent(solve[1]!), Number(solve[2]));
            return true;
        }

        const gestureMatch = path.match(/^\/api\/inbox\/([^/]+)\/([^/]+)$/);
        if (method === "POST" && gestureMatch) {
            const key = decodeURIComponent(gestureMatch[1]!);
            const gesture = gestureMatch[2] as InboxGesture;
            if (!GESTURES.includes(gesture)) {
                json(res, 400, { error: `Unknown gesture "${gesture}"` });
                return true;
            }
            const item = store.get(key);
            if (!item) {
                json(res, 404, { error: "No such item in the box" });
                return true;
            }
            const connector = this.deps.connectors.find((c) => c.slug === item.source);
            // Opening is reading, for every source: one without gestures gives the text the box holds,
            // and the item is read in the box (there is no read state to change at its source).
            if (gesture === "open" && !connector?.inboxGesture) {
                const change = item.read ? null : "read";
                if (change) this.deps.life.changed(key, change, "gesture");
                this.record(key, gesture, true);
                json(res, 200, { ok: true, change, body: item.body ?? "" });
                return true;
            }
            if (!connector?.inboxGesture) {
                this.record(key, gesture, false, "source cannot do gestures");
                json(res, 400, { error: `No gestures for ${item.source}` });
                return true;
            }
            try {
                const result = await connector.inboxGesture(gesture, item);
                if (result.change) {
                    this.deps.life.changed(key, result.change, "gesture");
                }
                this.record(key, gesture, true);
                json(res, 200, {
                    ok: true,
                    change: result.change,
                    ...(result.body !== undefined && { body: result.body }),
                });
            } catch (e) {
                const message = (e as Error).message;
                this.record(key, gesture, false, message);
                // A gesture the source cannot do for this item is the caller's mistake, not the source's.
                const status = /does not apply|has no/.test(message) ? 400 : 502;
                json(res, status, { error: message });
            }
            return true;
        }

        return false;
    }

    /** Moves the conflict's event to the chosen slot at the calendar, then the conflict leaves the box. */
    private async solve(res: http.ServerResponse, key: string, n: number): Promise<void> {
        const { json } = this.deps;
        const item = this.deps.store.get(key);
        if (!item || item.type !== "planning.conflict") {
            json(res, 404, { error: "No such conflict in the box" });
            return;
        }
        const solutions = (item.meta?.["solutions"] ?? []) as {
            eventId: string;
            start: string;
            end: string;
        }[];
        const chosen = solutions[n];
        if (!chosen) {
            json(res, 400, { error: `No way out number ${n}` });
            return;
        }
        const calendar = this.deps.connectors.find((c) => c.slug === "calendar");
        if (!calendar?.executeAction) {
            json(res, 503, { error: "No calendar to move the event in" });
            return;
        }
        try {
            await calendar.executeAction({
                kind: "update_event",
                sourceId: chosen.eventId,
                fields: { start: chosen.start, end: chosen.end },
            });
        } catch (e) {
            this.record(key, "solve", false, (e as Error).message);
            json(res, 502, { error: (e as Error).message });
            return;
        }
        this.record(key, "solve", true);
        this.deps.life.changed(key, "removed", "gesture");
        void this.deps.planningSync?.syncNow();
        json(res, 200, { ok: true, moved: chosen });
    }

    private record(
        key: string,
        gesture: InboxGesture | "restore" | "solve",
        ok: boolean,
        error?: string,
    ): void {
        this.journal.unshift({
            at: new Date().toISOString(),
            key,
            gesture,
            ok,
            ...(error && { error }),
        });
        if (this.journal.length > JOURNAL_SIZE) this.journal.length = JOURNAL_SIZE;
    }
}
