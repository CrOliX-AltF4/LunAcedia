/**
 * The box: Master's own gestures on an item, applied at the source — Gmail, GitHub — then
 * followed by the item and told to the Core (InboxSync.applyLocal, the same path as a change seen at the
 * source, R8). A gesture is Master's own hand, not an autonomous decision: it runs directly, without the
 * tier gate that governs the agent (D1), and every gesture is journaled.
 *
 *   GET  /api/inbox                          { items (newest first), unread }
 *   POST /api/inbox/:key/:gesture            open | read | unread | archive | trash | done
 *   GET  /api/inbox/trash                    Gmail's trash (30 days, kept by Gmail)
 *   POST /api/inbox/trash/:messageId/restore back to the inbox, collected again at the next pass
 *   GET  /api/inbox/journal                  the last 100 gestures, newest first
 */
import type http from "node:http";
import type { EventStore } from "../store/event_store.js";
import type { IngestionHub } from "../hub/ingestion_hub.js";
import type { InboxSync } from "../hub/inbox_sync.js";
import type { IConnector, InboxGesture } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";

const GESTURES: readonly InboxGesture[] = ["open", "read", "unread", "archive", "trash", "done"];
const JOURNAL_SIZE = 100;
const BOX_SIZE = 200;

export interface InboxJournalEntry {
    at: string;
    key: string;
    gesture: InboxGesture | "restore";
    ok: boolean;
    error?: string;
}

/** Trash-capable connector (Gmail). */
interface TrashCapable {
    listTrash(): Promise<Array<{ id: string; title: string; from: string; ts: number }>>;
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
    sync: InboxSync;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export class InboxRoutes {
    private readonly journal: InboxJournalEntry[] = [];

    constructor(private readonly deps: InboxRouteDeps) {}

    /** Handles the request if it is an inbox route; returns false otherwise. */
    async handle(method: string, path: string, res: http.ServerResponse): Promise<boolean> {
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
                json(res, 200, { items: [] });
                return true;
            }
            try {
                json(res, 200, { items: await gmail.listTrash() });
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
                this.deps.hub.forget(key);
                void this.deps.hub.pollOne(gmail.slug);
                this.record(key, "restore", true);
                json(res, 200, { ok: true });
            } catch (e) {
                this.record(key, "restore", false, (e as Error).message);
                json(res, 502, { error: (e as Error).message });
            }
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
            if (!connector?.inboxGesture) {
                this.record(key, gesture, false, "source cannot do gestures");
                json(res, 400, { error: `No gestures for ${item.source}` });
                return true;
            }
            try {
                const result = await connector.inboxGesture(gesture, item);
                if (result.change) {
                    this.deps.sync.applyLocal({ op: result.change, key, source: item.source });
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

    private record(
        key: string,
        gesture: InboxGesture | "restore",
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
