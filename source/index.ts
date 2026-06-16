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
import { EventStore } from "./store/event_store.js";
import { FcmSender } from "./push/fcm_sender.js";

const wsPort = parseInt(process.env["PORT"] ?? "4000", 10);
const httpPort = parseInt(process.env["HTTP_PORT"] ?? "4001", 10);

const connectors: IConnector[] = [];
if (process.env["GITHUB_ENABLED"] === "true") connectors.push(new GitHubConnector());
if (process.env["RSS_ENABLED"] === "true") connectors.push(new RssConnector());
if (process.env["GMAIL_ENABLED"] === "true") connectors.push(new GmailConnector());
if (process.env["GCAL_ENABLED"] === "true") connectors.push(new GcalConnector());
if (process.env["GTASKS_ENABLED"] === "true") connectors.push(new TasksConnector());
if (process.env["HA_ENABLED"] === "true") connectors.push(new HaConnector());

if (connectors.length === 0) {
    console.warn(
        "[LunAcedia] No connectors enabled — set GITHUB_ENABLED, GMAIL_ENABLED, GCAL_ENABLED, GTASKS_ENABLED, RSS_ENABLED, or HA_ENABLED in .env",
    );
}

const store = new EventStore();
const fcm = FcmSender.fromEnv();
const hub = new IngestionHub(connectors);
const ws = new AcediaWsServer();
const api = new AcediaApiServer(store, connectors, fcm, process.env["ACEDIA_SECRET"]);

ws.start(wsPort);
api.start(httpPort);

hub.onEvent((event) => {
    store.push(event);
    ws.broadcast(event);
    void fcm?.send(event);
});

hub.start();

console.warn(
    `[LunAcedia] Running — ${connectors.map((c) => c.name).join(", ") || "no connectors"}`,
);
if (fcm) console.warn("[LunAcedia] FCM push enabled");

process.on("SIGINT", () => {
    hub.stop();
    ws.stop();
    api.stop();
    process.exit(0);
});
process.on("SIGTERM", () => {
    hub.stop();
    ws.stop();
    api.stop();
    process.exit(0);
});
