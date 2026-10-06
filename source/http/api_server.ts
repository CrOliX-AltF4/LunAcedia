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
import type { InboxSync } from "../hub/inbox_sync.js";
import { InboxRoutes } from "./inbox_routes.js";
import { ConversationRoutes } from "./conversation_routes.js";
import {
    callerOf,
    withUsageContext,
    type UsageContext,
    type UsageLedger,
} from "../usage/llm_usage.js";
import type { UsageAlerts } from "../usage/usage_alerts.js";
import { UsageRoutes } from "./usage_routes.js";
import { DeviceRoutes } from "./device_routes.js";
import type { Device, DeviceRegistry } from "../auth/device_registry.js";
import { isDeviceRoute } from "../auth/device_scope.js";
import { timingSafeEqual } from "node:crypto";
import type { ConversationStore } from "../store/conversation_store.js";
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
import { summarizeAction } from "../push/pending_push.js";
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
import { BULK_LIMIT, selectMail, ruleFromAction, type MailMatch } from "../actions/mail_selection.js";

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
 *   GET  /api/identity             → { name, kind: "lunacedia", version } — who the mobile app is talking to
 *                                  (the app shows the server's name, never a hardcoded one).
 *                                  Authenticated: it doubles as the app's connection test.
 *   GET  /api/events               ?source= &priority= &since= &limit= &offset= &unread=true
 *   GET  /api/events/:dedupeKey
 *   POST /api/events/read-all      → 204
 *   POST /api/events/held          body: { keys: string[] } (≤ 2000) → { held: { [key]: { read } }, ready } — which of
 *                                  these keys the box still holds; a key absent from `held` is gone
 *                                  (a hub reconciles its copies against the box; ready=false
 *                                  while the initial sweep runs — nothing may be removed on that answer)
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
 *   POST /api/inbox/select         body: { match } → { matched, limit, sample } — what a bulk_email would touch
 *   GET  /api/config/tiers         → ActionTierConfig
 *   PATCH /api/config/tiers        body: Partial<Record<ActionKind, ActionTier>>
 *   GET  /api/config/risk          → Record<ActionKind, ActionRisk> — static, not configurable
 *   GET  /api/config/tier-overrides  → Record<"{kind}:{scope}", ActionTier> — per-sender
 *                                    (email kinds) / per-repo (GitHub kinds) tier overrides
 *   PATCH /api/config/tier-overrides body: { kind, scope, tier: ActionTier | null }
 *                                    tier: null removes the override
 *   GET  /api/config/email-rules   → EmailClassificationConfig
 *   PATCH /api/config/email-rules  body: Partial<EmailClassificationConfig>
 *   GET  /api/guard/rules          → { version, rules, stats }   (ingestion guards)
 *   PUT  /api/guard/rules          body: { rules }  full list, strictly validated → 400 { error, problem } if
 *                                  invalid (problem: { code, rule?, part?, index? } — for a client to translate)
 *   GET  /api/guard/journal        ?limit=  events a rule dropped, newest first (never silent, restorable)
 *   GET  /api/guard/actions        ?limit=  what rules did at the source, mail by mail, newest first
 *   PUT  /api/guard/source-actions body: { enabled }  the one switch over every rule's actions at the source
 *   POST /api/guard/journal/restore body: { dedupeKey }  re-dispatches a dropped event, bypassing dedup + guard
 *   POST /api/guard/preview        body: { rules? }  what-if against the store + journal, changes nothing
 *   GET  /api/events               also accepts ?tag=  (guard tag, case-insensitive)
 *   GET  /api/calendar/free-slots?hours=24&minGapMin=30  → TimeSlot[] (deterministic, no LLM)
 *   GET  /api/oauth/google/start?connector=gmail|gcal|gtasks  → 302 to Google consent
 *   GET  /api/oauth/google/callback  Google's own redirect target — not called directly
 *   GET  /api/oauth/google/status  → { gmail: boolean, gcal: boolean, gtasks: boolean }
 *   POST /api/agent                body: { text, context?: string[], callerId?, readOnly?, untrusted? }  → the agent
 *                                 : reads the events, acts only through the tier gate;
 *                                  versioned { version, status, summary, items, actions, steps }
 *   GET  /api/agent/journal        the last 50 agent runs (who asked, steps, actions)
 *   GET|PUT /api/agent/settings    { enabled, writes } — the agent's switch (off = no tool is ever
 *                                  called) and whether it may write (off = triage only, default)
 *   POST /api/chat                 body: { text, context? } → { response, agent? } — the agent's
 *                                  answer; plain dialogue with no tool when the agent is off
 *   GET|POST /api/conversations, GET|PATCH|DELETE /api/conversations/:id, POST /api/conversations/:id/messages
 *                                  the pocket app's topics, answered by the agent with their earlier turns
 *                                  — contract in conversation_routes.ts
 *   GET  /api/usage?days=30        LLM usage by day, caller, purpose and model + alert settings and fired alerts
 *   GET|PUT /api/config/usage-alerts  spend alert paliers — information only, never a cap
 *   POST /api/devices/pair           { code, name } → { device, token } — no auth: the one-time code is the proof
 *   POST /api/devices/pairing-code · GET /api/devices · DELETE /api/devices/:id   admin
 *   A paired device's token opens only the mobile routes (auth/device_scope.ts); everything else needs ACEDIA_SECRET.
 *   POST /api/intent               body: { text } → the agent limited to one action, answered as
 *                                  { matched, connector, action, status, id?/reason? }
 *   GET  /api/digest               synthesize recent events (requires AI_PROVIDER != none)
 *   GET  /api/proposals            suggest next actions for unread urgent/conflict items (requires AI_PROVIDER != none)
 *   POST /api/devices/push-token   body: { token: string }
 *   DELETE /api/devices/push-token
 */
/**
 * The usage context of a request: who is asking and for what, from its route. An agent request declares
 * its caller too (runAgentRequest), which wins — the Core asking counts as the Core.
 */
export function usageContextOf(url: string | undefined): UsageContext {
    const path = new URL(url ?? "/", "http://localhost").pathname;
    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) {
        return { caller: "topics", purpose: "topic" };
    }
    const purpose = /^\/api\/(agent|chat|intent|digest|proposals)$/.exec(path)?.[1] ?? "other";
    return { caller: "api", purpose };
}

/** Keys one /api/events/held call may ask about — the box itself holds at most 1000 items. */
const HELD_KEYS_MAX = 2000;

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
        // (no restart).
        private ai: IAIProvider,
        private readonly secret: string | undefined,
        private readonly tierStore: ActionTierStore,
        private readonly pendingStore: PendingActionStore,
        private readonly emailClassificationStore?: EmailClassificationStore,
        private readonly googleTokenStore?: GoogleTokenStore,
        private readonly cooldown: ActionCooldownTracker = new ActionCooldownTracker(),
        private readonly guards?: GuardServices,
        // The agent's switch and journal. In memory unless index.ts gives it a file.
        private readonly agent: AgentService = new AgentService(),
        // The box and the sync rule — absent in tests that do not exercise them.
        inbox?: InboxSync,
        // The pocket app's topics — absent in tests that do not exercise them.
        topics?: ConversationStore,
        // LLM usage and its alerts — absent in tests that do not exercise them.
        usage?: { ledger: UsageLedger; alerts: UsageAlerts },
        // Paired devices — absent in tests that do not exercise them.
        devices?: DeviceRegistry,
    ) {
        this.usageRoutes = usage ? new UsageRoutes({ ...usage, readBody, json }) : null;
        this.devices = devices ?? null;
        this.deviceRoutes = devices ? new DeviceRoutes({ devices, fcm, readBody, json }) : null;
        this.inboxSync = inbox ?? null;
        this.inboxRoutes = inbox
            ? new InboxRoutes({ store, connectors, hub, sync: inbox, json })
            : null;
        this.conversationRoutes = topics
            ? new ConversationRoutes({
                  topics,
                  store,
                  ai: () => this.ai,
                  agentEnabled: () => this.agent.isEnabled(),
                  runAgent: (r) => this.runAgentRequest(r),
                  readBody,
                  json,
              })
            : null;
    }

    private readonly usageRoutes: UsageRoutes | null;
    private readonly devices: DeviceRegistry | null;
    private readonly deviceRoutes: DeviceRoutes | null;

    /** Null without a topic store. Public for tests: settled() waits for background titles and summaries. */
    readonly conversationRoutes: ConversationRoutes | null;

    private readonly inboxSync: InboxSync | null;

    private readonly inboxRoutes: InboxRoutes | null;

    private agentSettings(): { enabled: boolean; writes: boolean } {
        return { enabled: this.agent.isEnabled(), writes: this.agent.writesEnabled() };
    }

    /** One agent run over this server's store, calendar and tier gate, journaled. */
    private runAgentRequest(req: AgentRequest): Promise<AgentResult> {
        // The declared caller wins over the route's default: the Core asking counts as the Core.
        return withUsageContext({ caller: callerOf(req.callerId) }, () =>
            this.agent.run(req, () =>
                runAgent(req, {
                    provider: this.ai,
                    read: {
                        store: this.store,
                        busyIntervals: () => this.calendarBusyIntervals(),
                        now: () => Date.now(),
                        // Natsume read it in full: it is read at the source, and the item follows.
                        markRead: async (event) => {
                            const connector = this.connectors.find((c) => c.slug === event.source);
                            if (!connector?.inboxGesture) return;
                            const r = await connector.inboxGesture("read", event);
                            if (r.change && this.inboxSync) {
                                this.inboxSync.applyLocal({
                                    op: r.change,
                                    key: event.dedupeKey,
                                    source: event.source,
                                });
                            }
                        },
                    },
                    dispatch: (connector, action, capToConfirm) =>
                        this.dispatchAction(connector, action, capToConfirm, "agent"),
                    persona: loadSystemPrompt(),
                    allowWrites: this.agent.writesEnabled(),
                }),
            ),
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
            // The caller's context carries third-party text (e.g. the Core relayed a mail read in an earlier turn):
            // every action is held for confirmation from the first step. It can only restrict, never widen (D2).
            ...(b["untrusted"] === true && { untrusted: true }),
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
            sourceActions: g.rules.sourceActionsEnabled(),
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
            if (!result.ok) return json(res, 400, { error: result.error, problem: result.problem });
            g.stats.prune(new Set(g.rules.getRules().map((r) => r.id)));
            return json(res, 200, rulesPayload());
        }

        if (method === "PUT" && path === "/api/guard/source-actions") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const enabled = (body as { enabled?: unknown } | null)?.enabled;
            if (typeof enabled !== "boolean") return json(res, 400, { error: "Body must be { enabled: boolean }" });
            await g.rules.setSourceActionsEnabled(enabled);
            return json(res, 200, { enabled: g.rules.sourceActionsEnabled() });
        }

        if (method === "GET" && path === "/api/guard/actions") {
            const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
            return json(res, 200, {
                entries: g.ruleActions?.list(Number.isNaN(limit) ? 100 : Math.min(limit, 500)) ?? [],
            });
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
                if (!parsed.ok)
                    return json(res, 400, { error: parsed.error, problem: parsed.problem });
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
            // Every LLM call a request makes is counted under its caller and purpose.
            void withUsageContext(usageContextOf(req.url), () => this.handle(req, res));
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
        if (action.kind === "bulk_email") {
            // Each mail of the batch follows, as if acted on alone.
            for (const sourceId of action.sourceIds ?? []) {
                const one = (
                    action.action === "label_email"
                        ? { kind: "label_email", sourceId, label: action.label ?? "" }
                        : { kind: action.action, sourceId }
                ) as ConnectorAction;
                this.syncStoreAfterAction(one);
            }
            return;
        }
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
            if (action.kind === "create_rule") {
                const added = this.guards ? await this.guards.rules.add(ruleFromAction(action)) : null;
                if (!added?.ok) return json(res, 409, { error: `Rule not added: ${added ? added.error : "no rules here"}` });
                return json(res, 204, null);
            }
            await connector.executeAction!(action);
            this.syncStoreAfterAction(action);
            return json(res, 204, null);
        } catch (e) {
            // Said to Master, not hidden: the object may have changed or gone since the action was proposed.
            const message = (e as Error).message;
            console.error("[API] action error:", message);
            return json(res, 502, { error: `Action failed: ${message}` });
        }
    }

    /**
     * Connector lookup + tier check, shared by POST /api/actions and the agent — the
     * one place that decides auto/pending/refused, so an intent-parsed action is gated by
     * exactly the same rule a directly-submitted one is, not a parallel copy of it.
     */
    /**
     * The tier gate. `capToConfirm` holds an auto-tier action for the user instead of executing it —
     * the agent sets it once it has read third-party content.
     */
    private async dispatchAction(
        connectorName: string,
        action: ConnectorAction,
        capToConfirm = false,
        origin: "agent" | "api" = "api",
    ): Promise<
        | { status: "not_found" }
        | { status: "unsupported" }
        | { status: "refused"; reason: string }
        | { status: "pending"; id: string; expiresAt: number; action: ConnectorAction }
        | { status: "executed"; action: ConnectorAction }
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
        // A batch: the selection is LunAcedia's own, frozen now (a caller's ids are dropped), and it always waits.
        // A rule for the mails to come always waits too, and must already be a valid rule.
        let batch = false;
        if (action.kind === "create_rule") {
            if (!this.guards) return { status: "refused", reason: "rules are not available on this deployment" };
            const check = validateRules([...this.guards.rules.getRules(), ruleFromAction(action)]);
            if (!check.ok) return { status: "refused", reason: `not a valid rule — ${check.error}` };
            batch = true;
        }
        if (action.kind === "bulk_email") {
            const selection = selectMail(this.store, (action.match ?? {}) as MailMatch);
            if (selection.sourceIds.length === 0)
                return { status: "refused", reason: "no mail of the box matches these criteria" };
            action = { ...action, sourceIds: selection.sourceIds, matched: selection.matched };
            batch = true;
        }
        if (tier === "confirm" || batch || (capToConfirm && tier === "auto")) {
            // Durable, with its own delay; capToConfirm = a third party's text came first.
            const pending = this.pendingStore.create(connectorName, action, {
                origin,
                untrusted: capToConfirm,
            });
            return { status: "pending", id: pending.id, expiresAt: pending.expiresAt, action };
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
            return { status: "executed", action };
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

    /**
     * Who is calling: the admin (the master secret — dashboard, Core), a paired device (its own token,
     * limited to the mobile routes), or nobody. Without ACEDIA_SECRET the API is open, as before (LAN-only setups).
     */
    private authorize(
        req: http.IncomingMessage,
    ): { kind: "admin" } | { kind: "device"; device: Device } | null {
        if (!this.secret) return { kind: "admin" };
        const auth = req.headers["authorization"] ?? "";
        const expected = Buffer.from(`Bearer ${this.secret}`);
        const given = Buffer.from(auth);
        // Constant time: the master secret must not leak through response timings.
        if (given.length === expected.length && timingSafeEqual(given, expected))
            return { kind: "admin" };
        const device = this.devices?.authenticate(
            auth.startsWith("Bearer ") ? auth.slice(7) : undefined,
        );
        return device ? { kind: "device", device } : null;
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

        // Pairing a device: the code is the proof.
        if (this.deviceRoutes && (await this.deviceRoutes.handlePairing(method, path, req, res)))
            return;

        const caller = this.authorize(req);
        if (!caller) {
            return json(res, 401, { error: "Unauthorized" });
        }
        if (caller.kind === "device" && !isDeviceRoute(method, path)) {
            return json(res, 403, { error: "This device cannot reach this route" });
        }
        // Device management: the admin only.
        if (
            caller.kind === "admin" &&
            this.deviceRoutes &&
            (await this.deviceRoutes.handleAdmin(method, path, res))
        )
            return;

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

        // GET /api/identity — the assistant's name the mobile app shows: ASSISTANT_NAME, else
        // "LunAcedia". Standalone is a product of its own — never "Natsume" here.
        if (method === "GET" && path === "/api/identity") {
            const name = process.env["ASSISTANT_NAME"]?.trim() || "LunAcedia";
            return json(res, 200, { name, kind: "lunacedia", version: PACKAGE_VERSION });
        }

        // POST /api/events/held — which of these keys the box still holds
        if (method === "POST" && path === "/api/events/held") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const keys = (body as { keys?: unknown } | null)?.keys;
            if (
                !Array.isArray(keys) ||
                keys.length > HELD_KEYS_MAX ||
                !keys.every((k) => typeof k === "string")
            ) {
                return json(res, 400, {
                    error: `Body must be { keys: string[] } with at most ${HELD_KEYS_MAX} keys`,
                });
            }
            const held: Record<string, { read: boolean }> = {};
            for (const key of keys as string[]) {
                const e = this.store.get(key);
                if (e) held[key] = { read: e.read === true };
            }
            // `ready`: false until the hub's initial sweep finished — the box may still be filling.
            return json(res, 200, { held, ready: this.hub.isReady() });
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
                return json(res, 202, {
                    status: "pending",
                    id: result.id,
                    expiresAt: result.expiresAt,
                });
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
            // Hours may have passed: the tier is read again — a kind set to manual since is refused.
            const tier = this.tierStore.getTier(
                pending.action.kind,
                resolveTierScope(pending.action, this.store) ?? undefined,
            );
            if (tier === "manual")
                return json(res, 403, {
                    error: `'${pending.action.kind}' is set to manual since — nothing was done`,
                });
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

        // POST /api/inbox/select — what a batch would touch, without acting (ADR-023 T2)
        if (method === "POST" && path === "/api/inbox/select") {
            let body: unknown;
            try {
                body = await readBody(req);
            } catch {
                return json(res, 400, { error: "Invalid JSON" });
            }
            const match = (body as Record<string, unknown> | null)?.["match"];
            if (typeof match !== "object" || match === null)
                return json(res, 400, { error: "Body must be { match: { from?, fromContains?, fromDomain?, subjectContains? } }" });
            const selection = selectMail(this.store, match as MailMatch);
            return json(res, 200, { matched: selection.matched, limit: BULK_LIMIT, sample: selection.sample });
        }

        // GET /api/actions/pending
        if (method === "GET" && path === "/api/actions/pending") {
            // With what each would do, in words: the phone and the panel only show it.
            return json(
                res,
                200,
                this.pendingStore.list().map((p) => ({ ...p, summary: summarizeAction(p.action) })),
            );
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

        // The box: Master's gestures at the source, trash, journal
        if (this.inboxRoutes && (await this.inboxRoutes.handle(method, path, res))) return;

        // LLM usage and its alert settings
        if (this.usageRoutes && (await this.usageRoutes.handle(method, path, url, req, res)))
            return;

        // The pocket app's topics
        if (
            this.conversationRoutes &&
            (await this.conversationRoutes.handle(method, path, url, req, res))
        )
            return;

        // Ingestion guards: /api/guard/{rules,journal,journal/restore,preview}
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

        // POST /api/config/ai-provider — first-run onboarding: LunAcedia ships
        // with AI_PROVIDER=none and no default key to guess at (LunAcedia always
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

        // POST /api/agent — the agent: reads what LunAcedia holds, acts through the tier
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
            // From a phone, the agent can only be turned OFF (law 3) — turning it back on is the dashboard's or the panel's.
            if (caller.kind === "device" && (writes !== undefined || enabled !== false)) {
                return json(res, 403, { error: "From a device, the agent can only be turned off" });
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
            if (caller.kind === "device") await this.devices?.setPushToken(caller.device.id, token);
            return json(res, 204, null);
        }

        // DELETE /api/devices/push-token
        if (method === "DELETE" && path === "/api/devices/push-token") {
            if (caller.kind === "device") {
                // A device stops its own notifications, never another one's.
                if (this.fcm && this.fcm.getToken() === caller.device.pushToken)
                    await this.fcm.setToken(null);
                await this.devices?.setPushToken(caller.device.id, null);
            } else if (this.fcm) await this.fcm.setToken(null);
            return json(res, 204, null);
        }

        json(res, 404, { error: "Not found" });
    }
}
