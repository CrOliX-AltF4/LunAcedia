import http from "node:http";
import * as fs from "node:fs";
// Aliased — this file already uses `path` as a local variable name for the request URL's pathname.
import * as nodePath from "node:path";
import type { IConnector } from "../connectors/connector_interface.js";
import type { IngestionHub } from "../hub/ingestion_hub.js";
import type { EventStore } from "../store/event_store.js";
import type { FcmSender } from "../push/fcm_sender.js";
import type { IAIProvider } from "../ai/ai_provider.js";
import { formatProposalsPrompt } from "../ai/ai_provider.js";
import { createAIProvider, loadSystemPrompt } from "../ai/create_ai_provider.js";
import { AgentService } from "../agent/agent_service.js";
import { runAgent, type AgentRequest, type AgentResult } from "../agent/agent_loop.js";
import { validateAiProviderPatch, writeAiProviderConfig } from "../ai/ai_provider_writer.js";
import { computeFreeSlots } from "../connectors/calendar/free_slots.js";
import type { TimeSlot } from "../connectors/calendar/free_slots.js";
import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { ActionTierStore } from "../actions/action_tier_store.js";
import { ACTION_RISK } from "../types/action_tier.js";
import { ActionCooldownTracker } from "../actions/action_cooldown.js";
import { resolveTierScope } from "../actions/resolve_tier_scope.js";
import { resolveEventSync } from "../store/event_sync.js";
import type { PendingActionStore } from "../actions/pending_action_store.js";
import type { EmailClassificationStore } from "../connectors/email/email_classification_store.js";
import type { EmailClassificationConfig } from "../types/email_classification.js";
import type { GoogleTokenStore } from "../auth/google_token_store.js";
import type { GuardServices } from "../guards/guard_services.js";
import { validateRules } from "../guards/guard_rules_store.js";
import {
    findGoogleOAuthConnector,
    buildGoogleAuthUrl,
    exchangeGoogleCode,
} from "../auth/google_oauth_flow.js";
import { DASHBOARD_HTML } from "./dashboard.js";

const SOURCES = new Set<string>(["github", "calendar", "email", "rss", "ha", "tasks", "system"]);
const PRIORITIES = new Set<string>(["urgent", "normal", "info"]);

// Read once at module load — package.json doesn't change at runtime. Lets Natsume's panel
// show which LunAcedia version it's actually talking to, instead of no version at all
// (the gap that let a shipped feature go out with a stale package.json — see PR history).
function readPackageVersion(): string {
    try {
        const raw = fs.readFileSync(nodePath.join(process.cwd(), "package.json"), "utf-8");
        return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
    } catch {
        return "unknown";
    }
}
const PACKAGE_VERSION = readPackageVersion();

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
 *   POST /api/events/clear-read    → 200 { removed: number } — drops every already-read event
 *   POST /api/events/:dedupeKey/read → 204
 *   GET  /api/stats
 *   POST /api/connectors/:slug/reconnect  → { ok: boolean, error?: string }
 *   POST /api/actions              body: ConnectorAction & { connector: string }
 *                                  → 204 (auto tier, executed) | 202 { id } (confirm tier, pending)
 *                                  | 403 (manual tier, or the kind is on cooldown — too many
 *                                    recent executions, see ActionCooldownTracker)
 *   POST /api/actions/:id/confirm  → 204, executes a pending action
 *                                  | 429 if the kind is on cooldown (see ActionCooldownTracker)
 *   POST /api/actions/:id/cancel   → 204, discards a pending action
 *   GET  /api/actions/pending      → PendingAction[]
 *   GET  /api/config/tiers         → ActionTierConfig
 *   PATCH /api/config/tiers        body: Partial<Record<ActionKind, ActionTier>>
 *   GET  /api/config/risk          → Record<ActionKind, ActionRisk> — static, not configurable
 *   GET  /api/config/tier-overrides  → Record<"{kind}:{scope}", ActionTier> — per-sender
 *                                    (email kinds) / per-repo (GitHub kinds) tier overrides
 *   PATCH /api/config/tier-overrides body: { kind, scope, tier: ActionTier | null }
 *                                    tier: null removes the override
 *   GET  /api/config/email-rules   → EmailClassificationConfig
 *   PATCH /api/config/email-rules  body: Partial<EmailClassificationConfig>
 *   GET  /api/guard/rules          → { version, rules, stats }   (ingestion guards, chantier A)
 *   PUT  /api/guard/rules          body: { rules }  full list, strictly validated → 400 { error } if invalid
 *   GET  /api/guard/journal        ?limit=  events a rule dropped, newest first (never silent, restorable)
 *   POST /api/guard/journal/restore body: { dedupeKey }  re-dispatches a dropped event, bypassing dedup + guard
 *   POST /api/guard/preview        body: { rules? }  what-if against the store + journal, changes nothing
 *   GET  /api/events               also accepts ?tag=  (guard tag, case-insensitive)
 *   GET  /api/calendar/free-slots?hours=24&minGapMin=30  → TimeSlot[] (deterministic, no LLM)
 *   GET  /api/oauth/google/start?connector=gmail|gcal|gtasks  → 302 to Google consent
 *   GET  /api/oauth/google/callback  Google's own redirect target — not called directly
 *   GET  /api/oauth/google/status  → { gmail: boolean, gcal: boolean, gtasks: boolean }
 *   POST /api/agent                body: { text, context?: string[], callerId?, readOnly? }  → the agent
 *                                  (ADR-017): reads the events, acts only through the tier gate;
 *                                  versioned { version, status, summary, items, actions, steps }
 *   GET  /api/agent/journal        the last 50 agent runs (who asked, steps, actions)
 *   GET|PUT /api/agent/settings    { enabled, writes } — the agent's switch (off = no tool is ever
 *                                  called) and whether it may write (off = triage only, default)
 *   POST /api/chat                 body: { text, context? } → { response, agent? } — the agent's
 *                                  answer; plain dialogue with no tool when the agent is off
 *   POST /api/intent               body: { text } → the agent limited to one action, answered as
 *                                  { matched, connector, action, status, id?/reason? }
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
        // Not readonly — POST /api/config/ai-provider swaps this in place after a successful
        // write, so a first-time key configured from the dashboard takes effect immediately
        // (no restart, ADR-013 I1).
        private ai: IAIProvider,
        private readonly secret: string | undefined,
        private readonly tierStore: ActionTierStore,
        private readonly pendingStore: PendingActionStore,
        private readonly emailClassificationStore?: EmailClassificationStore,
        private readonly googleTokenStore?: GoogleTokenStore,
        private readonly cooldown: ActionCooldownTracker = new ActionCooldownTracker(),
        private readonly guards?: GuardServices,
        // The agent's switch and journal (ADR-017 M5). In memory unless index.ts gives it a file.
        private readonly agent: AgentService = new AgentService(),
    ) {}

    private agentSettings(): { enabled: boolean; writes: boolean } {
        return { enabled: this.agent.isEnabled(), writes: this.agent.writesEnabled() };
    }

    /** One agent run over this server's store, calendar and tier gate, journaled (ADR-017). */
    private runAgentRequest(req: AgentRequest): Promise<AgentResult> {
        return this.agent.run(req, () =>
            runAgent(req, {
                provider: this.ai,
                read: {
                    store: this.store,
                    busyIntervals: () => this.calendarBusyIntervals(),
                    now: () => Date.now(),
                },
                dispatch: (connector, action, capToConfirm) =>
                    this.dispatchAction(connector, action, capToConfirm),
                persona: loadSystemPrompt(),
                allowWrites: this.agent.writesEnabled(),
            }),
        );
    }

    /** Reads { text, context?, callerId? } — null when the body is not usable. */
    private async readAgentRequest(
        req: http.IncomingMessage,
    ): Promise<AgentRequest | "invalid_json" | null> {
        let body: unknown;
        try {
            body = await readBody(req);
        } catch {
            return "invalid_json";
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const text = b["text"];
        if (typeof text !== "string" || text.trim().length === 0) return null;
        const context = Array.isArray(b["context"])
            ? b["context"].filter((c): c is string => typeof c === "string")
            : undefined;
        const callerId =
            typeof b["callerId"] === "string" && b["callerId"].trim() ? b["callerId"] : undefined;
        if (callerId) console.warn(`[API] agent request from ${callerId}`);
        return {
            text: text.trim(),
            ...(context && { context }),
            ...(callerId && { callerId }),
            ...(b["readOnly"] === true && { readOnly: true }),
        };
    }

    /** GET/PUT /api/guard/rules · GET /api/guard/journal · POST /api/guard/journal/restore · POST /api/guard/preview */
    private async handleGuard(
        method: string,
        path: string,
        url: URL,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        g: GuardServices,
    ): Promise<void> {
        const rulesPayload = () => ({
            version: g.rules.getVersion(),
            rules: g.rules.getRules(),
            stats: g.stats.getAll(),
        });

        if (method === "GET" && path === "/api/guard/rules") return json(res, 200, rulesPayload());

        if (method === "PUT" && path === "/api/guard/rules") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const rules = (body as { rules?: unknown } | null)?.rules;
            const result = await g.rules.replaceAll(rules);
            if (!result.ok) return json(res, 400, { error: result.error });
            g.stats.prune(new Set(g.rules.getRules().map((r) => r.id)));
            return json(res, 200, rulesPayload());
        }

        if (method === "GET" && path === "/api/guard/journal") {
            const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
            return json(res, 200, {
                total: g.journal.size,
                entries: g.journal.list(Number.isNaN(limit) ? 100 : Math.min(limit, 500)),
            });
        }

        if (method === "POST" && path === "/api/guard/journal/restore") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const key = (body as { dedupeKey?: unknown } | null)?.dedupeKey;
            if (typeof key !== "string" || !key)
                return json(res, 400, { error: "dedupeKey is required" });
            const event = g.pipeline.restore(key);
            if (!event) return json(res, 404, { error: "Not in the journal" });
            this.hub.dispatchRestored(event);
            return json(res, 200, { restored: key });
        }

        if (method === "POST" && path === "/api/guard/preview") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const candidateInput = (body as { rules?: unknown } | null)?.rules;
            let candidate = g.rules.getRules();
            if (candidateInput !== undefined) {
                const parsed = validateRules(candidateInput);
                if (!parsed.ok) return json(res, 400, { error: parsed.error });
                candidate = parsed.rules;
            }
            // What a rule could be tested against: what already passed (the store) and what was dropped (the journal).
            const byKey = new Map<string, AcediaEvent>();
            for (const e of this.store.query({ limit: 1000 }).events) byKey.set(e.dedupeKey, e);
            for (const entry of g.journal.list(500)) byKey.set(entry.event.dedupeKey, entry.event);
            return json(res, 200, g.pipeline.preview(candidate, [...byKey.values()]));
        }

        return json(res, 404, { error: "Not found" });
    }

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

    /** Busy intervals from every currently-known timed calendar.upcoming event — all-day
     *  events excluded, same reasoning as GcalConnector's conflict detection. */
    private calendarBusyIntervals(): TimeSlot[] {
        const { events } = this.store.query({ source: "calendar", limit: 200 });
        return (events as AcediaEvent[])
            .filter((e) => e.type === "calendar.upcoming")
            .map((e) => {
                const start = e.meta?.["start"];
                const end = e.meta?.["end"];
                if (typeof start !== "string" || typeof end !== "string") return null;
                if (!start.includes("T") || !end.includes("T")) return null;
                const s = new Date(start).getTime();
                const en = new Date(end).getTime();
                if (isNaN(s) || isNaN(en)) return null;
                return { start: s, end: en };
            })
            .filter((x): x is TimeSlot => x !== null);
    }

    /** Keeps the notification in sync with the real-world effect an action just had — a
     *  deleted email's notification used to keep showing up as unread/present forever, since
     *  connector.executeAction() touches Gmail/GCal/Tasks for real but EventStore (what
     *  /api/events actually serves) never heard about it. Best-effort: a no-op for actions
     *  with no derivable mapping (create_*, GitHub, reply) or no matching buffered event. */
    private syncStoreAfterAction(action: ConnectorAction): void {
        const sync = resolveEventSync(action);
        if (!sync) return;
        if (sync.effect === "remove") this.store.remove(sync.dedupeKey);
        else if (sync.effect === "read") this.store.markRead(sync.dedupeKey);
        else this.store.markUnread(sync.dedupeKey);
    }

    private async executeConnectorAction(
        res: http.ServerResponse,
        connector: IConnector,
        action: ConnectorAction,
    ): Promise<void> {
        if (!this.cooldown.tryConsume(action.kind)) {
            return json(res, 429, {
                error: `'${action.kind}' hit its cooldown — too many executions in a short window`,
            });
        }
        try {
            await connector.executeAction!(action);
            this.syncStoreAfterAction(action);
            return json(res, 204, null);
        } catch (e) {
            console.error("[API] action error:", (e as Error).message);
            return json(res, 500, { error: "Action failed" });
        }
    }

    /**
     * Connector lookup + tier check, shared by POST /api/actions and the agent — the
     * one place that decides auto/pending/refused, so an intent-parsed action is gated by
     * exactly the same rule a directly-submitted one is, not a parallel copy of it.
     */
    /**
     * The tier gate. `capToConfirm` holds an auto-tier action for the user instead of executing it —
     * the agent sets it once it has read third-party content (ADR-017 D2).
     */
    private async dispatchAction(
        connectorName: string,
        action: ConnectorAction,
        capToConfirm = false,
    ): Promise<
        | { status: "not_found" }
        | { status: "unsupported" }
        | { status: "refused"; reason: string }
        | { status: "pending"; id: string }
        | { status: "executed" }
        | { status: "error" }
    > {
        const connector = this.connectors.find((c) => c.name === connectorName);
        if (!connector) return { status: "not_found" };
        if (!connector.executeAction) return { status: "unsupported" };

        const tier = this.tierStore.getTier(
            action.kind,
            resolveTierScope(action, this.store) ?? undefined,
        );
        if (tier === "manual") {
            return {
                status: "refused",
                reason: `'${action.kind}' is set to manual — not executable via this endpoint`,
            };
        }
        if (tier === "confirm" || (capToConfirm && tier === "auto")) {
            const pending = this.pendingStore.create(connectorName, action);
            return { status: "pending", id: pending.id };
        }
        if (!this.cooldown.tryConsume(action.kind)) {
            return {
                status: "refused",
                reason: `'${action.kind}' hit its cooldown — too many executions in a short window`,
            };
        }
        try {
            await connector.executeAction(action);
            this.syncStoreAfterAction(action);
            return { status: "executed" };
        } catch (e) {
            console.error("[API] action error:", (e as Error).message);
            return { status: "error" };
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
        if (!meta) {
            json(res, 400, { error: "Unknown or missing connector" });
            return;
        }
        if (!clientId) {
            json(res, 503, { error: "GOOGLE_CLIENT_ID not configured" });
            return;
        }

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

        if (oauthError) {
            html("❌ Connexion refusée", oauthError);
            return;
        }
        if (!code || !meta) {
            html("❌ Requête invalide", "Code ou connecteur manquant.");
            return;
        }

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
                version: PACKAGE_VERSION,
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
            const tag = url.searchParams.get("tag");

            const result = this.store.query({
                tag: tag ? tag : undefined,
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

        // POST /api/events/clear-read
        if (method === "POST" && path === "/api/events/clear-read") {
            const removed = this.store.removeAllRead();
            return json(res, 200, { removed });
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

            const result = await this.dispatchAction(connectorName, action);
            if (result.status === "not_found")
                return json(res, 404, { error: `Connector '${connectorName}' not found` });
            if (result.status === "unsupported")
                return json(res, 400, {
                    error: `Connector '${connectorName}' does not support actions`,
                });
            if (result.status === "refused") return json(res, 403, { error: result.reason });
            if (result.status === "pending")
                return json(res, 202, { status: "pending", id: result.id });
            if (result.status === "error") return json(res, 500, { error: "Action failed" });
            return json(res, 204, null);
        }

        // POST /api/actions/:id/confirm
        const confirmMatch = path.match(/^\/api\/actions\/([^/]+)\/confirm$/);
        if (method === "POST" && confirmMatch) {
            const id = decodeURIComponent(confirmMatch[1]!);
            const pending = this.pendingStore.consume(id);
            if (!pending)
                return json(res, 404, {
                    error: "No such pending action (expired or already resolved)",
                });
            const connector = this.connectors.find((c) => c.name === pending.connector);
            if (!connector?.executeAction)
                return json(res, 404, { error: "Connector no longer available" });
            return this.executeConnectorAction(res, connector, pending.action);
        }

        // POST /api/actions/:id/cancel
        const cancelMatch = path.match(/^\/api\/actions\/([^/]+)\/cancel$/);
        if (method === "POST" && cancelMatch) {
            const id = decodeURIComponent(cancelMatch[1]!);
            const pending = this.pendingStore.consume(id);
            if (!pending)
                return json(res, 404, {
                    error: "No such pending action (expired or already resolved)",
                });
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

        // GET /api/config/risk — static, not user-configurable (see ACTION_RISK's own doc)
        if (method === "GET" && path === "/api/config/risk") {
            return json(res, 200, ACTION_RISK);
        }

        // GET /api/config/tier-overrides — per-{sender,repo} tier overrides (backlog #329 P1)
        if (method === "GET" && path === "/api/config/tier-overrides") {
            return json(res, 200, this.tierStore.getOverrides());
        }

        // PATCH /api/config/tier-overrides
        // body: { kind: string, scope: string, tier: "auto" | "confirm" | "manual" | null }
        // tier: null removes the override, falling back to the kind-level tier.
        if (method === "PATCH" && path === "/api/config/tier-overrides") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const b = body as { kind?: unknown; scope?: unknown; tier?: unknown };
            if (
                typeof b.kind !== "string" ||
                typeof b.scope !== "string" ||
                (b.tier !== null && typeof b.tier !== "string")
            ) {
                return json(res, 400, {
                    error: "Body must be { kind: string, scope: string, tier: string | null }",
                });
            }
            const ok = await this.tierStore.patchOverride(b.kind, b.scope, b.tier);
            if (!ok)
                return json(res, 400, {
                    error: "Unknown kind, immutable kind, invalid tier, or no matching override to remove",
                });
            return json(res, 200, { overrides: this.tierStore.getOverrides() });
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

        // Ingestion guards (chantier A): /api/guard/{rules,journal,journal/restore,preview}
        if (path.startsWith("/api/guard/")) {
            if (!this.guards) return json(res, 503, { error: "Guards not configured" });
            return this.handleGuard(method, path, url, req, res, this.guards);
        }

        // GET /api/calendar/free-slots?hours=24&minGapMin=30
        if (method === "GET" && path === "/api/calendar/free-slots") {
            const hoursAhead = parseInt(url.searchParams.get("hours") ?? "24", 10);
            const minGapMin = parseInt(url.searchParams.get("minGapMin") ?? "30", 10);
            const now = Date.now();
            const windowEnd = now + Math.max(1, isNaN(hoursAhead) ? 24 : hoursAhead) * 3_600_000;
            const minGapMs = Math.max(1, isNaN(minGapMin) ? 30 : minGapMin) * 60_000;
            const slots = computeFreeSlots(this.calendarBusyIntervals(), now, windowEnd, minGapMs);
            return json(
                res,
                200,
                slots.map((s) => ({
                    start: new Date(s.start).toISOString(),
                    end: new Date(s.end).toISOString(),
                })),
            );
        }

        // GET /api/oauth/google/status
        if (method === "GET" && path === "/api/oauth/google/status") {
            return json(
                res,
                200,
                this.googleTokenStore?.status() ?? { gmail: false, gcal: false, gtasks: false },
            );
        }

        // POST /api/config/ai-provider — first-run onboarding (ADR-013 I1): LunAcedia ships
        // with AI_PROVIDER=none and no default key to guess at (D2, ADR-008 — LunAcedia always
        // keeps its own LLM, the Core never picks one for it). Writes .env and swaps this.ai
        // live so the dashboard's setup screen takes effect without a restart.
        if (method === "POST" && path === "/api/config/ai-provider") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const validated = validateAiProviderPatch(body);
            if (!validated.ok) {
                return json(res, 400, { error: validated.error });
            }
            writeAiProviderConfig(validated.patch);
            this.ai = createAIProvider();
            return json(res, 200, { ok: true, provider: this.ai.mode });
        }

        // POST /api/agent — the agent (ADR-017): reads what LunAcedia holds, acts through the tier
        // gate, bounded in steps/time/actions. Versioned result: summary, items, actions, steps.
        if (method === "POST" && path === "/api/agent") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            if (!this.agent.isEnabled()) return json(res, 503, { error: "Agent disabled" });
            const agentReq = await this.readAgentRequest(req);
            if (agentReq === "invalid_json") return json(res, 400, { error: "Invalid JSON" });
            if (!agentReq) return json(res, 400, { error: "Body must be { text: string }" });
            const result = await this.runAgentRequest(agentReq);
            const status =
                result.status === "error" ? 502 : result.status === "unavailable" ? 503 : 200;
            return json(res, status, result);
        }

        // GET /api/agent/journal — the last 50 runs (law 3: what the agent did, and why)
        if (method === "GET" && path === "/api/agent/journal") {
            return json(res, 200, this.agent.journal());
        }

        // GET/PUT /api/agent/settings — the agent's switch (law 3: off = no tool is ever called)
        if (method === "GET" && path === "/api/agent/settings") {
            return json(res, 200, this.agentSettings());
        }
        if (method === "PUT" && path === "/api/agent/settings") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const b = (body ?? {}) as Record<string, unknown>;
            const enabled = b["enabled"];
            const writes = b["writes"];
            const bad = (v: unknown) => v !== undefined && typeof v !== "boolean";
            if (bad(enabled) || bad(writes) || (enabled === undefined && writes === undefined)) {
                return json(res, 400, {
                    error: "Body must be { enabled?: boolean, writes?: boolean }",
                });
            }
            if (typeof enabled === "boolean") await this.agent.setEnabled(enabled);
            if (typeof writes === "boolean") await this.agent.setWrites(writes);
            return json(res, 200, this.agentSettings());
        }

        // POST /api/chat — kept for LunAvaritia (reads `response`): answered by the agent; with the
        // agent off (or a provider without tool calling), plain dialogue with no tool at all.
        if (method === "POST" && path === "/api/chat") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            const agentReq = await this.readAgentRequest(req);
            if (agentReq === "invalid_json") return json(res, 400, { error: "Invalid JSON" });
            if (!agentReq) return json(res, 400, { error: "Body must be { text: string }" });

            if (this.agent.isEnabled() && this.ai.chatWithTools) {
                const result = await this.runAgentRequest(agentReq);
                if (result.status === "error") {
                    console.error("[API] chat (agent) error:", result.error);
                    return json(res, 502, { error: "AI provider error" });
                }
                return json(res, 200, { response: result.summary, agent: result });
            }

            const query = agentReq.context?.length
                ? `Context:\n${agentReq.context.join("\n")}\n\n${agentReq.text}`
                : agentReq.text;
            try {
                const response = await this.ai.chat(query);
                return json(res, 200, { response });
            } catch (e) {
                console.error("[API] chat error:", (e as Error).message);
                return json(res, 502, { error: "AI provider error" });
            }
        }

        // POST /api/intent — the agent limited to one action, answered in the historical shape
        // ({ matched, connector, action, status, id?/reason? }). Every action still goes through
        // the tier gate; merge_pr is never built from model output (capability manifest).
        if (method === "POST" && path === "/api/intent") {
            if (this.ai.mode === "none") {
                return json(res, 503, { error: "AI_PROVIDER not configured" });
            }
            if (!this.agent.isEnabled()) return json(res, 503, { error: "Agent disabled" });
            const agentReq = await this.readAgentRequest(req);
            if (agentReq === "invalid_json") return json(res, 400, { error: "Invalid JSON" });
            if (!agentReq) return json(res, 400, { error: "Body must be { text: string }" });

            const result = await this.runAgentRequest({ ...agentReq, maxActions: 1 });
            if (result.status === "unavailable") {
                return json(res, 503, { error: result.error ?? "Agent unavailable" });
            }
            if (result.status === "error") {
                console.error("[API] intent error:", result.error);
                return json(res, 502, { error: "AI provider error" });
            }
            const taken = result.actions.find((a) => a.status !== "invalid");
            if (!taken || !taken.action) return json(res, 200, { matched: false });
            return json(res, 200, {
                matched: true,
                connector: taken.connector,
                action: taken.action,
                status: taken.status,
                ...(taken.id && { id: taken.id }),
                ...(taken.reason && { reason: taken.reason }),
            });
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
            const hasConflict = relevant.some((e) => e.type === "calendar.conflict");
            const freeSlots = hasConflict
                ? computeFreeSlots(
                      this.calendarBusyIntervals(),
                      Date.now(),
                      Date.now() + 7 * 86_400_000,
                      30 * 60_000,
                  )
                : [];
            try {
                const proposals = await this.ai.chat(formatProposalsPrompt(relevant, freeSlots));
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
