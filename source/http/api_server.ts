import http from "node:http";
import type { IConnector } from "../connectors/connector_interface.js";
import type { IngestionHub } from "../hub/ingestion_hub.js";
import type { EventStore } from "../store/event_store.js";
import type { FcmSender } from "../push/fcm_sender.js";
import type { IAIProvider } from "../ai/ai_provider.js";
import { formatProposalsPrompt } from "../ai/ai_provider.js";
import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { ActionTierStore } from "../actions/action_tier_store.js";
import type { PendingActionStore } from "../actions/pending_action_store.js";
import type { EmailClassificationStore } from "../connectors/email/email_classification_store.js";
import type { EmailClassificationConfig } from "../types/email_classification.js";
import type { GoogleTokenStore } from "../auth/google_token_store.js";
import { findGoogleOAuthConnector, buildGoogleAuthUrl, exchangeGoogleCode } from "../auth/google_oauth_flow.js";
import { DASHBOARD_HTML } from "./dashboard.js";

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
 *   GET  /api/events               ?source= &priority= &since= &limit= &offset= &unread=true
 *   GET  /api/events/:dedupeKey
 *   POST /api/events/read-all      → 204
 *   POST /api/events/:dedupeKey/read → 204
 *   GET  /api/stats
 *   POST /api/connectors/:slug/reconnect  → { ok: boolean, error?: string }
 *   POST /api/actions              body: ConnectorAction & { connector: string }
 *                                  → 204 (auto tier, executed) | 202 { id } (confirm tier, pending)
 *                                  | 403 (manual tier — not executable via this endpoint)
 *   POST /api/actions/:id/confirm  → 204, executes a pending action
 *   POST /api/actions/:id/cancel   → 204, discards a pending action
 *   GET  /api/actions/pending      → PendingAction[]
 *   GET  /api/config/tiers         → ActionTierConfig
 *   PATCH /api/config/tiers        body: Partial<Record<ActionKind, ActionTier>>
 *   GET  /api/config/email-rules   → EmailClassificationConfig
 *   PATCH /api/config/email-rules  body: Partial<EmailClassificationConfig>
 *   GET  /api/oauth/google/start?connector=gmail|gcal|gtasks  → 302 to Google consent
 *   GET  /api/oauth/google/callback  Google's own redirect target — not called directly
 *   GET  /api/oauth/google/status  → { gmail: boolean, gcal: boolean, gtasks: boolean }
 *   POST /api/chat                 body: { text: string }  (requires AI_PROVIDER != none)
 *   GET  /api/digest               synthesize recent events (requires AI_PROVIDER != none)
 *   GET  /api/proposals            suggest next actions for unread urgent/conflict items (requires AI_PROVIDER != none)
 *   POST /api/devices/push-token   body: { token: string }
 *   DELETE /api/devices/push-token
 */
export class AcediaApiServer {
    private server: http.Server | null = null;
    private readonly startedAt = Date.now();

    constructor(
        private readonly store: EventStore,
        private readonly connectors: IConnector[],
        private readonly hub: IngestionHub,
        private readonly fcm: FcmSender | null,
        private readonly ai: IAIProvider,
        private readonly secret: string | undefined,
        private readonly tierStore: ActionTierStore,
        private readonly pendingStore: PendingActionStore,
        private readonly emailClassificationStore?: EmailClassificationStore,
        private readonly googleTokenStore?: GoogleTokenStore,
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

    private async executeConnectorAction(
        res: http.ServerResponse,
        connector: IConnector,
        action: ConnectorAction,
    ): Promise<void> {
        try {
            await connector.executeAction!(action);
            return json(res, 204, null);
        } catch (e) {
            console.error("[API] action error:", (e as Error).message);
            return json(res, 500, { error: "Action failed" });
        }
    }

    /** Reachable only by the user's own browser, so we build it from whatever host they used
     *  to reach the dashboard — matches the redirect Google will send them back to, as long as
     *  that exact host is registered as an authorized redirect URI in Google Cloud Console.
     *  OAUTH_REDIRECT_BASE_URL overrides this (reverse proxy / non-default port setups). */
    private resolveOAuthRedirectUri(req: http.IncomingMessage): string {
        const override = process.env["OAUTH_REDIRECT_BASE_URL"];
        if (override) return `${override.replace(/\/$/, "")}/api/oauth/google/callback`;
        const host = req.headers["host"] ?? "localhost";
        return `http://${host}/api/oauth/google/callback`;
    }

    private handleGoogleOAuthStart(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: URL,
    ): void {
        const key = url.searchParams.get("connector") ?? "";
        const meta = findGoogleOAuthConnector(key);
        const clientId = process.env["GOOGLE_CLIENT_ID"];
        if (!meta) { json(res, 400, { error: "Unknown or missing connector" }); return; }
        if (!clientId) { json(res, 503, { error: "GOOGLE_CLIENT_ID not configured" }); return; }

        const redirectUri = this.resolveOAuthRedirectUri(req);
        const authUrl = buildGoogleAuthUrl(clientId, redirectUri, meta.scopes, meta.key);
        res.writeHead(302, { Location: authUrl });
        res.end();
    }

    private async handleGoogleOAuthCallback(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: URL,
    ): Promise<void> {
        const html = (title: string, body: string): void => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<html><body><h2>${title}</h2><p>${body}</p></body></html>`);
        };

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        const oauthError = url.searchParams.get("error");
        const meta = findGoogleOAuthConnector(state);

        if (oauthError) { html("❌ Connexion refusée", oauthError); return; }
        if (!code || !meta) { html("❌ Requête invalide", "Code ou connecteur manquant."); return; }

        const clientId = process.env["GOOGLE_CLIENT_ID"] ?? "";
        const clientSecret = process.env["GOOGLE_CLIENT_SECRET"] ?? "";
        try {
            const { refreshToken } = await exchangeGoogleCode(
                clientId,
                clientSecret,
                code,
                this.resolveOAuthRedirectUri(req),
            );
            if (!refreshToken) {
                html(
                    "⚠️ Aucun refresh token reçu",
                    "Révoque l'accès dans myaccount.google.com/permissions puis réessaie — Google n'en renvoie qu'au premier consentement.",
                );
                return;
            }
            if (this.googleTokenStore) await this.googleTokenStore.set(meta.key, refreshToken);
            html(`✅ ${meta.label} connecté`, "Tu peux fermer cet onglet.");
        } catch (e) {
            html("❌ Erreur", (e as Error).message);
        }
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

        // GET / — web dashboard (no auth required)
        if (method === "GET" && (path === "/" || path === "/dashboard")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(DASHBOARD_HTML);
            return;
        }

        // Health check — no auth required
        if (method === "GET" && path === "/api/health") {
            return json(res, 200, {
                status: "ok",
                uptime: Math.floor((Date.now() - this.startedAt) / 1000),
                connectors: this.hub.getConnectorHealth(),
                events: this.store.size,
                ai: this.ai.mode,
            });
        }

        // GET /api/oauth/google/start — no auth required (a plain browser redirect can't
        // carry an Authorization header; anyone reaching it without an account still needs
        // to complete Google's own consent screen as the real account owner to get anywhere).
        if (method === "GET" && path === "/api/oauth/google/start") {
            return this.handleGoogleOAuthStart(req, res, url);
        }

        // GET /api/oauth/google/callback — same reasoning, and Google's own `code` param is
        // single-use/short-lived, which is what actually secures this endpoint, not a Bearer
        // header a browser redirect can never send.
        if (method === "GET" && path === "/api/oauth/google/callback") {
            return this.handleGoogleOAuthCallback(req, res, url);
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
            const unreadParam = url.searchParams.get("unread");

            const result = this.store.query({
                source: source && SOURCES.has(source) ? (source as AcediaEventSource) : undefined,
                priority:
                    priority && PRIORITIES.has(priority)
                        ? (priority as AcediaEventPriority)
                        : undefined,
                since: since ? parseInt(since, 10) : undefined,
                limit: limit ? parseInt(limit, 10) : 50,
                offset: offset ? parseInt(offset, 10) : 0,
                unread: unreadParam === "true" ? true : undefined,
            });
            return json(res, 200, result);
        }

        // POST /api/events/read-all
        if (method === "POST" && path === "/api/events/read-all") {
            this.store.markAllRead();
            return json(res, 204, null);
        }

        // POST /api/events/:dedupeKey/read
        const readMatch = path.match(/^\/api\/events\/(.+)\/read$/);
        if (method === "POST" && readMatch) {
            const key = decodeURIComponent(readMatch[1]!);
            this.store.markRead(key);
            return json(res, 204, null);
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
            return json(res, 200, {
                bySource: this.store.stats(),
                total: this.store.size,
                unread: this.store.unreadCount,
            });
        }

        // POST /api/connectors/:slug/reconnect
        const reconnectMatch = path.match(/^\/api\/connectors\/([^/]+)\/reconnect$/);
        if (method === "POST" && reconnectMatch) {
            const slug = decodeURIComponent(reconnectMatch[1]!);
            const result = await this.hub.pollOne(slug);
            if (!result.ok && result.error === "Unknown connector") return json(res, 404, result);
            return json(res, result.ok ? 200 : 502, result);
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

            const tier = this.tierStore.getTier(action.kind);
            if (tier === "manual") {
                return json(res, 403, {
                    error: `'${action.kind}' is set to manual — not executable via this endpoint`,
                });
            }
            if (tier === "confirm") {
                const pending = this.pendingStore.create(connectorName, action);
                return json(res, 202, { status: "pending", id: pending.id });
            }
            return this.executeConnectorAction(res, connector, action);
        }

        // POST /api/actions/:id/confirm
        const confirmMatch = path.match(/^\/api\/actions\/([^/]+)\/confirm$/);
        if (method === "POST" && confirmMatch) {
            const id = decodeURIComponent(confirmMatch[1]!);
            const pending = this.pendingStore.consume(id);
            if (!pending) return json(res, 404, { error: "No such pending action (expired or already resolved)" });
            const connector = this.connectors.find((c) => c.name === pending.connector);
            if (!connector?.executeAction) return json(res, 404, { error: "Connector no longer available" });
            return this.executeConnectorAction(res, connector, pending.action);
        }

        // POST /api/actions/:id/cancel
        const cancelMatch = path.match(/^\/api\/actions\/([^/]+)\/cancel$/);
        if (method === "POST" && cancelMatch) {
            const id = decodeURIComponent(cancelMatch[1]!);
            const pending = this.pendingStore.consume(id);
            if (!pending) return json(res, 404, { error: "No such pending action (expired or already resolved)" });
            return json(res, 204, null);
        }

        // GET /api/actions/pending
        if (method === "GET" && path === "/api/actions/pending") {
            return json(res, 200, this.pendingStore.list());
        }

        // GET /api/config/tiers
        if (method === "GET" && path === "/api/config/tiers") {
            return json(res, 200, this.tierStore.getAll());
        }

        // PATCH /api/config/tiers
        if (method === "PATCH" && path === "/api/config/tiers") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const changed = await this.tierStore.patch(body as Record<string, string>);
            return json(res, 200, { changed, tiers: this.tierStore.getAll() });
        }

        // GET /api/config/email-rules
        if (method === "GET" && path === "/api/config/email-rules") {
            if (!this.emailClassificationStore) return json(res, 503, { error: "Not configured" });
            return json(res, 200, this.emailClassificationStore.getAll());
        }

        // PATCH /api/config/email-rules
        if (method === "PATCH" && path === "/api/config/email-rules") {
            if (!this.emailClassificationStore) return json(res, 503, { error: "Not configured" });
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            await this.emailClassificationStore.patch(body as Partial<EmailClassificationConfig>);
            return json(res, 200, this.emailClassificationStore.getAll());
        }

        // GET /api/oauth/google/status
        if (method === "GET" && path === "/api/oauth/google/status") {
            return json(
                res,
                200,
                this.googleTokenStore?.status() ?? { gmail: false, gcal: false, gtasks: false },
            );
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

        // GET /api/proposals — butler-layer suggestions for current urgent/conflict items.
        // Read-only: proposes in plain text, never executes — acting on a proposal still
        // goes through POST /api/actions and its autonomy tiers like any other action.
        if (method === "GET" && path === "/api/proposals") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            const { events } = this.store.query({ unread: true, limit: 100 });
            const relevant = (events as AcediaEvent[]).filter(
                (e) => e.priority === "urgent" || e.type === "calendar.conflict",
            );
            try {
                const proposals = await this.ai.chat(formatProposalsPrompt(relevant));
                return json(res, 200, { proposals, count: relevant.length });
            } catch (e) {
                console.error("[API] proposals error:", (e as Error).message);
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
            await this.fcm.setToken(token);
            return json(res, 204, null);
        }

        // DELETE /api/devices/push-token
        if (method === "DELETE" && path === "/api/devices/push-token") {
            if (this.fcm) await this.fcm.setToken(null);
            return json(res, 204, null);
        }

        json(res, 404, { error: "Not found" });
    }
}
