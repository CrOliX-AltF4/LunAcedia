import "dotenv/config";
import { GitHubConnector } from "./connectors/github/github_connector.js";
import { RssConnector }    from "./connectors/rss/rss_connector.js";
import { GmailConnector }  from "./connectors/email/gmail_connector.js";
import type { IConnector } from "./connectors/connector_interface.js";
import { IngestionHub }    from "./hub/ingestion_hub.js";
import { AcediaWsServer }  from "./ws/acedia_ws_server.js";

const port = parseInt(process.env["PORT"] ?? "4000", 10);

const connectors: IConnector[] = [];
if (process.env["GITHUB_ENABLED"] === "true") connectors.push(new GitHubConnector());
if (process.env["RSS_ENABLED"]    === "true") connectors.push(new RssConnector());
if (process.env["GMAIL_ENABLED"]  === "true") connectors.push(new GmailConnector());

if (connectors.length === 0) {
    console.warn("[LunAcedia] No connectors enabled. Set GITHUB_ENABLED=true or GMAIL_ENABLED=true in .env");
}

const hub    = new IngestionHub(connectors);
const server = new AcediaWsServer();

server.start(port);
hub.onEvent((event) => server.broadcast(event));
hub.start();

console.warn(`[LunAcedia] Running — ${connectors.map((c) => c.name).join(", ") || "no connectors"}`);

process.on("SIGINT",  () => { hub.stop(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { hub.stop(); server.stop(); process.exit(0); });