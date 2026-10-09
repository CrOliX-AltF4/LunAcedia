import type http from "node:http";
import type { AcediaEvent } from "../types/acedia_event.js";

/**
 * What changed, never the content: a view that learns it reloads what concerns it — the server stays the only truth,
 * and a lost message costs nothing a slow refresh does not catch up. `key` names the one object when there is one (a
 * box item, an action, a topic), so a reader open on it knows that *its* object moved.
 */
export type ChangeScope = "box" | "actions" | "topics";

export interface Change {
    scope: ChangeScope;
    key?: string;
    /** The object is settled (read, gone, decided, expired): a notification about it has nothing left to say. */
    settled?: boolean;
    at: number;
}

/** One feed of changes for the whole server: every source of change emits here, every stream listens here. */
export class ChangeFeed {
    private readonly listeners = new Set<(change: Change) => void>();

    constructor(private readonly now: () => number = Date.now) {}

    emit(scope: ChangeScope, key?: string, settled = false): void {
        const change: Change = {
            scope,
            ...(key && { key }),
            ...(settled && { settled }),
            at: this.now(),
        };
        for (const listener of this.listeners) {
            try {
                listener(change);
            } catch {
                // a listener that fails never stops the others
            }
        }
    }

    subscribe(listener: (change: Change) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get listening(): number {
        return this.listeners.size;
    }
}

/** A change on the WebSocket the Core listens to (system.change) — the Core relays it to its own views. */
export function changeEvent(change: Change): AcediaEvent {
    return {
        type: "system.change",
        ts: change.at,
        source: "system",
        title: change.scope,
        priority: "info",
        dedupeKey: `change-${change.scope}-${change.key ?? ""}-${change.at}`,
        meta: {
            scope: change.scope,
            ...(change.key && { key: change.key }),
            ...(change.settled && { settled: true }),
        },
    };
}

const HEARTBEAT_MS = 25_000;

/**
 * The feed as Server-Sent Events: `event: change` with the change as JSON, a comment every 25 s so proxies keep the
 * connection open, and nothing kept once the client leaves.
 */
export function serveChanges(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    feed: ChangeFeed,
    heartbeatMs = HEARTBEAT_MS,
): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx and friends: do not buffer a stream
        "X-Accel-Buffering": "no",
    });
    res.write("retry: 5000\n\n");
    const unsubscribe = feed.subscribe((change) => {
        res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
}
