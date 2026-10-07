import os from "node:os";
import path from "node:path";
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
import { applyStoredAiProvider } from "./ai/ai_provider_writer.js";
import { ActionTierStore } from "./actions/action_tier_store.js";
import { PendingActionStore } from "./actions/pending_action_store.js";
import { pendingActionEvent } from "./push/pending_push.js";
import { ChangeFeed, changeEvent } from "./changes/change_feed.js";
import { EmailClassificationStore } from "./connectors/email/email_classification_store.js";
import { GoogleTokenStore } from "./auth/google_token_store.js";
import { GuardRulesStore } from "./guards/guard_rules_store.js";
import { GuardJournal } from "./guards/guard_journal.js";
import { GuardStats } from "./guards/guard_stats.js";
import { GuardPipeline } from "./guards/guard_pipeline.js";
import { RuleActionJournal, createRuleActor } from "./guards/rule_actor.js";
import { migrateLegacyPriority } from "./guards/priority_migration.js";
import { parseRules } from "./connectors/email/email_rules.js";
import { AgentService, defaultAgentSettingsPath } from "./agent/agent_service.js";
import { InboxSync } from "./hub/inbox_sync.js";
import { ConversationStore, defaultConversationDir } from "./store/conversation_store.js";
import { defaultUsagePath, usageLedger } from "./usage/llm_usage.js";
import { UsageAlerts, defaultAlertsPath } from "./usage/usage_alerts.js";
import { DeviceRegistry, defaultDevicesPath } from "./auth/device_registry.js";

const wsPort = parseInt(process.env["PORT"] ?? "4000", 10);
const httpPort = parseInt(process.env["HTTP_PORT"] ?? "4001", 10);

const emailClassificationStore = new EmailClassificationStore();
await emailClassificationStore.load();

const googleTokenStore = new GoogleTokenStore();
await googleTokenStore.load();

const connectors: IConnector[] = [];
if (process.env["GITHUB_ENABLED"] === "true") connectors.push(new GitHubConnector());
if (process.env["RSS_ENABLED"] === "true") connectors.push(new RssConnector());
if (process.env["GMAIL_ENABLED"] === "true") connectors.push(new GmailConnector(googleTokenStore));
if (process.env["GCAL_ENABLED"] === "true") connectors.push(new GcalConnector(googleTokenStore));
if (process.env["GTASKS_ENABLED"] === "true") connectors.push(new TasksConnector(googleTokenStore));
if (process.env["HA_ENABLED"] === "true") connectors.push(new HaConnector());

if (connectors.length === 0) {
    console.warn(
        "[LunAcedia] No connectors enabled — set GITHUB_ENABLED, GMAIL_ENABLED, GCAL_ENABLED, GTASKS_ENABLED, RSS_ENABLED, or HA_ENABLED in .env",
    );
}

// Ingestion guards: user rules + journal of dropped events + per-rule counters. With no
// rule configured nothing is ever dropped or tagged — installing this changes no existing behaviour.
const guardRules = new GuardRulesStore();
const guardJournal = new GuardJournal();
const guardStats = new GuardStats();
// What confirmed rules do at the source, mail by mail.
const ruleActions = new RuleActionJournal();
await Promise.all([guardRules.load(), guardJournal.load(), guardStats.load(), ruleActions.load()]);
// One way to set a mail's priority: the keyword lists and GMAIL_RULES become guard rules, once (parity list kept).
try {
    const report = await migrateLegacyPriority({
        classification: emailClassificationStore,
        rules: guardRules,
        gmailRules: process.env["GMAIL_RULES"],
        storageDir: process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia"),
    });
    if (report)
        console.warn(
            `[Priority] ${report.migrated.length} keyword(s)/GMAIL_RULES entr(ies) turned into guard rules, ${report.skipped.length} skipped — see priority_migration.json`,
        );
} catch (e) {
    console.error((e as Error).message);
}
if (parseRules(process.env["GMAIL_RULES"] ?? "[]").length > 0)
    console.warn(
        "[Priority] GMAIL_RULES is no longer read — its entries are guard rules now; remove it from .env",
    );
const guardPipeline = new GuardPipeline({
    rules: guardRules,
    journal: guardJournal,
    stats: guardStats,
    // The legacy VIP list stays the single source of truth for "never drop" (edited live from the dashboard).
    vipSenders: () => emailClassificationStore.getAll().vipSenders,
});

// The box is persisted next to dedup — both must survive a restart together.
const store = new EventStore(1000, defaultEventStorePath());
const fcm = FcmSender.fromEnv();
// The AI set from the dashboard, kept in STORAGE_DIR, over .env — it survives image updates.
applyStoredAiProvider();
const ai = createAIProvider();
const hub = new IngestionHub(
    connectors,
    undefined,
    guardPipeline,
    (key) => store.has(key),
    createRuleActor({ connectors, journal: ruleActions }),
);
const ws = new AcediaWsServer();
// What changed, for the views that follow (lot S): the dashboard and the phones by /api/changes, the Core by the
// WebSocket (system.change), which relays to its own views.
const changes = new ChangeFeed();
changes.subscribe((change) => ws.broadcast(changeEvent(change)));
const tierStore = new ActionTierStore();
// Durable since M5: the writes waiting for Master survive a restart.
const pendingStore = new PendingActionStore();
await pendingStore.load();
// A write waiting for Master rings the phone: directly when standalone, through the Core when wired (it reads the
// stream). Never put in the box.
pendingStore.onCreate((p) => {
    const event = pendingActionEvent(p);
    ws.broadcast(event);
    void fcm?.send(event);
    changes.emit("actions", p.id);
});
// Decided anywhere, failed or expired: the views follow.
pendingStore.onSettle((p) => {
    changes.emit("actions", p.id);
    fcm?.settle(`action-${p.id}`);
});
// The agent's switch — loaded before the API serves anything.
const agent = new AgentService(defaultAgentSettingsPath());
await agent.load();
// The pocket app's topics — kept server side, the same from every client.
const topics = new ConversationStore(defaultConversationDir());
await topics.load();
// LLM usage: measured and alerted on, never capped — the owner manages spend at the provider.
await usageLedger.load(defaultUsagePath());
const usageAlerts = new UsageAlerts(defaultAlertsPath());
await usageAlerts.load();
// Paired phones: each has its own token; the master secret never leaves the server.
const devices = new DeviceRegistry(defaultDevicesPath());
await devices.load();
const sweepDevices = async (): Promise<void> => {
    for (const d of await devices.sweepInactive())
        console.warn(`[Devices] "${d.name}" silent for 90 days — revoked`);
};
await sweepDevices();
setInterval(() => void sweepDevices(), 24 * 60 * 60 * 1000).unref();
// The sync rule: every item follows its source object; changes go to the Core on the wire.
const inboxSync = new InboxSync({
    connectors,
    store,
    emit: (change) => {
        ws.broadcast(InboxSync.toWire(change));
        changes.emit("box", change.key);
        // Read or gone: a notification about it has nothing left to say, even on a closed phone (lot S, S5).
        if (change.op === "removed" || change.op === "read") fcm?.settle(change.key);
    },
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
    {
        pipeline: guardPipeline,
        rules: guardRules,
        journal: guardJournal,
        stats: guardStats,
        ruleActions,
    },
    agent,
    inboxSync,
    topics,
    { ledger: usageLedger, alerts: usageAlerts },
    devices,
    changes,
);

if (fcm) await fcm.load();
// Spend alerts: logged, and pushed to the phone within its priority filter; the Core relays them when wired.
usageAlerts.watch(usageLedger, (alert) => {
    console.warn(`[Usage] ${alert.title} — ${alert.body}`);
    return fcm?.send({
        type: "system.llm_spend",
        ts: alert.at,
        source: "system",
        title: alert.title,
        body: alert.body,
        priority: alert.priority,
        dedupeKey: `llm-spend-${alert.key}`,
    });
});
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
    changes.emit("box", event.dedupeKey);
    // A recovered item is back in the box only: the Core already holds it and the phone must not ring.
    if (meta?.recovered) return;
    ws.broadcast(event);
    // The inbox now holds read mail too: only something new and unread is pushed.
    if (!event.read) void fcm?.send(event);
});

// A known item whose content changed at the source (moved event, new due date): the box is
// updated and the Core refreshes its copy by key through an "updated" sync message — never the event itself,
// which the Core would announce as news. A backlog item was never sent to the Core, so its refresh is not either.
hub.onRefresh((event) => {
    const updated = store.refresh(event);
    if (!updated || updated.meta?.["backlog"] === true) return;
    const { title, body, priority, ts } = updated;
    inboxSync.applyLocal({
        op: "updated",
        key: updated.dedupeKey,
        source: updated.source,
        item: { title, body, priority, ts },
    });
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
