import "dotenv/config";
import { GitHubConnector } from "./connectors/github/github_connector.js";
import { RssConnector } from "./connectors/rss/rss_connector.js";
import { GmailConnector } from "./connectors/email/gmail_connector.js";
import { GcalConnector } from "./connectors/calendar/gcal_connector.js";
import { TasksConnector } from "./connectors/tasks/tasks_connector.js";
import { HaConnector } from "./connectors/ha/ha_connector.js";
import type { IConnector } from "./connectors/connector_interface.js";
import { IngestionHub } from "./hub/ingestion_hub.js";
import { AcediaWsServer } from "./ws/acedia_ws_server.js";
import { AcediaApiServer } from "./http/api_server.js";
import { EventStore, defaultEventStorePath } from "./store/event_store.js";
import { FcmSender } from "./push/fcm_sender.js";
import { createAIProvider } from "./ai/create_ai_provider.js";
import { ActionTierStore } from "./actions/action_tier_store.js";
import { PendingActionStore } from "./actions/pending_action_store.js";
import { EmailClassificationStore } from "./connectors/email/email_classification_store.js";
import { GoogleTokenStore } from "./auth/google_token_store.js";
import { GuardRulesStore } from "./guards/guard_rules_store.js";
import { GuardJournal } from "./guards/guard_journal.js";
import { GuardStats } from "./guards/guard_stats.js";
import { GuardPipeline } from "./guards/guard_pipeline.js";
import { AgentService, defaultAgentSettingsPath } from "./agent/agent_service.js";
import { InboxSync } from "./hub/inbox_sync.js";

const wsPort = parseInt(process.env["PORT"] ?? "4000", 10);
const httpPort = parseInt(process.env["HTTP_PORT"] ?? "4001", 10);

const emailClassificationStore = new EmailClassificationStore();
await emailClassificationStore.load();

const googleTokenStore = new GoogleTokenStore();
await googleTokenStore.load();

const connectors: IConnector[] = [];
if (process.env["GITHUB_ENABLED"] === "true") connectors.push(new GitHubConnector());
if (process.env["RSS_ENABLED"] === "true") connectors.push(new RssConnector());
if (process.env["GMAIL_ENABLED"] === "true")
    connectors.push(new GmailConnector(emailClassificationStore, googleTokenStore));
if (process.env["GCAL_ENABLED"] === "true") connectors.push(new GcalConnector(googleTokenStore));
if (process.env["GTASKS_ENABLED"] === "true") connectors.push(new TasksConnector(googleTokenStore));
if (process.env["HA_ENABLED"] === "true") connectors.push(new HaConnector());

if (connectors.length === 0) {
    console.warn(
        "[LunAcedia] No connectors enabled — set GITHUB_ENABLED, GMAIL_ENABLED, GCAL_ENABLED, GTASKS_ENABLED, RSS_ENABLED, or HA_ENABLED in .env",
    );
}

// Ingestion guards (chantier A, ADR-010): user rules + journal of dropped events + per-rule counters. With no
// rule configured nothing is ever dropped or tagged — installing this changes no existing behaviour.
const guardRules = new GuardRulesStore();
const guardJournal = new GuardJournal();
const guardStats = new GuardStats();
await Promise.all([guardRules.load(), guardJournal.load(), guardStats.load()]);
const guardPipeline = new GuardPipeline({
    rules: guardRules,
    journal: guardJournal,
    stats: guardStats,
    // The legacy VIP list stays the single source of truth for "never drop" (edited live from the dashboard).
    vipSenders: () => emailClassificationStore.getAll().vipSenders,
});

// The box (ADR-018) is persisted next to dedup — both must survive a restart together.
const store = new EventStore(1000, defaultEventStorePath());
const fcm = FcmSender.fromEnv();
const ai = createAIProvider();
const hub = new IngestionHub(connectors, undefined, guardPipeline);
const ws = new AcediaWsServer();
const tierStore = new ActionTierStore();
const pendingStore = new PendingActionStore();
// The agent's switch (ADR-017 M5) — loaded before the API serves anything.
const agent = new AgentService(defaultAgentSettingsPath());
await agent.load();
// The sync rule (ADR-018 R8): every item follows its source object; changes go to the Core on the wire.
const inboxSync = new InboxSync({
    connectors,
    store,
    emit: (change) => ws.broadcast(InboxSync.toWire(change)),
    forget: (key) => hub.forget(key),
});
const INBOX_SYNC_MS = 60_000;
const api = new AcediaApiServer(
    store,
    connectors,
    hub,
    fcm,
    ai,
    process.env["ACEDIA_SECRET"],
    tierStore,
    pendingStore,
    emailClassificationStore,
    googleTokenStore,
    undefined,
    { pipeline: guardPipeline, rules: guardRules, journal: guardJournal, stats: guardStats },
    agent,
    inboxSync,
);

if (fcm) await fcm.load();
await tierStore.load();
await hub.load();
await store.load();
// Whatever dedup still calls "seen" but the box lost (first run with a persisted box, an unreadable
// file) is collected again, quietly — see the onEvent handler below.
const recovered = hub.recoverMissing((key) => store.has(key));
if (recovered > 0)
    console.warn(`[LunAcedia] Box: ${recovered} seen item(s) missing, re-collecting`);

ws.start(wsPort);
api.start(httpPort);

hub.onEvent((event, meta) => {
    store.push(event);
    // A recovered item is back in the box only: the Core already holds it and the phone must not ring.
    if (meta?.recovered) return;
    ws.broadcast(event);
    // The inbox now holds read mail too (ADR-018 D2): only something new and unread is pushed.
    if (!event.read) void fcm?.send(event);
});

hub.start();

const inboxSyncTimer = setInterval(() => void inboxSync.reconcile(), INBOX_SYNC_MS);

console.warn(
    `[LunAcedia] Running — ${connectors.map((c) => c.name).join(", ") || "no connectors"} — AI: ${ai.mode}`,
);
if (fcm) console.warn("[LunAcedia] FCM push enabled");

async function flushGuards(): Promise<void> {
    await Promise.all([guardJournal.flush(), guardStats.flush(), store.flush()]);
}

process.on("SIGINT", () => {
    hub.stop();
    clearInterval(inboxSyncTimer);
    ws.stop();
    api.stop();
    // Pending journal / counter writes must land before the process goes away.
    void flushGuards().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
    hub.stop();
    clearInterval(inboxSyncTimer);
    ws.stop();
    api.stop();
    // Pending journal / counter writes must land before the process goes away.
    void flushGuards().finally(() => process.exit(0));
});
