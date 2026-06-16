import http from "node:http";
import type { IConnector } from "../connectors/connector_interface.js";
import type { EventStore } from "../store/event_store.js";
import type { FcmSender } from "../push/fcm_sender.js";
import type { IAIProvider } from "../ai/ai_provider.js";
import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";

const SOURCES = new Set<string>(["github", "calendar", "email", "rss", "ha", "tasks", "system"]);
const PRIORITIES = new Set<string>(["urgent", "normal", "info"]);

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
        });
        req.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new Error("invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

/**
 * REST API for LunAcedia mobile clients.
 *
 * Routes (all require Bearer auth if ACEDIA_SECRET is set, except /api/health):
 *   GET  /api/health
 *   GET  /api/events               ?source= &priority= &since= &limit= &offset=
 *   GET  /api/events/:dedupeKey
 *   GET  /api/stats
 *   POST /api/actions              body: ConnectorAction & { connector: string }
 *   POST /api/chat                 body: { text: string }  (requires AI_PROVIDER != none)
 *   GET  /api/digest               synthesize recent events (requires AI_PROVIDER != none)
 *   POST /api/devices/push-token   body: { token: string }
 *   DELETE /api/devices/push-token
 */
export class AcediaApiServer {
    private server: http.Server | null = null;
    private readonly startedAt = Date.now();

    constructor(
        private readonly store: EventStore,
        private readonly connectors: IConnector[],
        private readonly fcm: FcmSender | null,
        private readonly ai: IAIProvider,
        private readonly secret: string | undefined,
    ) {}

    start(port: number): void {
        this.server = http.createServer((req, res) => {
            void this.handle(req, res);
        });
        this.server.listen(port, () => {
            console.warn(`[LunAcedia] HTTP API listening on port ${port}`);
        });
    }

    stop(): void {
        this.server?.close();
    }

    private authenticate(req: http.IncomingMessage): boolean {
        if (!this.secret) return true;
        const auth = req.headers["authorization"] ?? "";
        return auth === `Bearer ${this.secret}`;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        // Health check — no auth required
        if (method === "GET" && path === "/api/health") {
            return json(res, 200, {
                status: "ok",
                uptime: Math.floor((Date.now() - this.startedAt) / 1000),
                connectors: this.connectors.map((c) => c.name),
                events: this.store.size,
                ai: this.ai.mode,
            });
        }

        if (!this.authenticate(req)) {
            return json(res, 401, { error: "Unauthorized" });
        }

        // GET /api/events
        if (method === "GET" && path === "/api/events") {
            const source = url.searchParams.get("source");
            const priority = url.searchParams.get("priority");
            const since = url.searchParams.get("since");
            const limit = url.searchParams.get("limit");
            const offset = url.searchParams.get("offset");

            const result = this.store.query({
                source: source && SOURCES.has(source) ? (source as AcediaEventSource) : undefined,
                priority:
                    priority && PRIORITIES.has(priority)
                        ? (priority as AcediaEventPriority)
                        : undefined,
                since: since ? parseInt(since, 10) : undefined,
                limit: limit ? parseInt(limit, 10) : 50,
                offset: offset ? parseInt(offset, 10) : 0,
            });
            return json(res, 200, result);
        }

        // GET /api/events/:dedupeKey
        const eventMatch = path.match(/^\/api\/events\/(.+)$/);
        if (method === "GET" && eventMatch) {
            const key = decodeURIComponent(eventMatch[1]!);
            const event = this.store.get(key);
            return event ? json(res, 200, event) : json(res, 404, { error: "Not found" });
        }

        // GET /api/stats
        if (method === "GET" && path === "/api/stats") {
            return json(res, 200, { bySource: this.store.stats(), total: this.store.size });
        }

        // POST /api/actions
        if (method === "POST" && path === "/api/actions") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }

            const b = body as Record<string, unknown>;
            const connectorName = b["connector"];
            const action = b["action"] as ConnectorAction | undefined;

            if (typeof connectorName !== "string" || !action || typeof action.kind !== "string") {
                return json(res, 400, {
                    error: "Body must be { connector: string, action: ConnectorAction }",
                });
            }

            const connector = this.connectors.find((c) => c.name === connectorName);
            if (!connector) {
                return json(res, 404, { error: `Connector '${connectorName}' not found` });
            }
            if (!connector.executeAction) {
                return json(res, 400, {
                    error: `Connector '${connectorName}' does not support actions`,
                });
            }

            try {
                await connector.executeAction(action);
                return json(res, 204, null);
            } catch (e) {
                console.error("[API] action error:", (e as Error).message);
                return json(res, 500, { error: "Action failed" });
            }
        }

        // POST /api/chat
        if (method === "POST" && path === "/api/chat") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const text = (body as Record<string, unknown>)["text"];
            if (typeof text !== "string" || text.trim().length === 0) {
                return json(res, 400, { error: "Body must be { text: string }" });
            }
            try {
                const response = await this.ai.chat(text.trim());
                return json(res, 200, { response });
            } catch (e) {
                console.error("[API] chat error:", (e as Error).message);
                return json(res, 502, { error: "AI provider error" });
            }
        }

        // GET /api/digest
        if (method === "GET" && path === "/api/digest") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            const limitParam = url.searchParams.get("limit");
            const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;
            const { events } = this.store.query({ limit, offset: 0 });
            try {
                const response = await this.ai.digest(events as AcediaEvent[]);
                return json(res, 200, { response, count: events.length });
            } catch (e) {
                console.error("[API] digest error:", (e as Error).message);
                return json(res, 502, { error: "AI provider error" });
            }
        }

        // POST /api/devices/push-token
        if (method === "POST" && path === "/api/devices/push-token") {
            if (!this.fcm) return json(res, 503, { error: "FCM not configured" });
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }

            const token = (body as Record<string, unknown>)["token"];
            if (typeof token !== "string" || token.length === 0) {
                return json(res, 400, { error: "Body must be { token: string }" });
            }
            this.fcm.setToken(token);
            return json(res, 204, null);
        }

        // DELETE /api/devices/push-token
        if (method === "DELETE" && path === "/api/devices/push-token") {
            this.fcm?.setToken(null);
            return json(res, 204, null);
        }

        json(res, 404, { error: "Not found" });
    }
}
