import { WebSocketServer, WebSocket } from "ws";
import type { AcediaEvent } from "../types/acedia_event.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket server — broadcasts AcediaEvents to all connected clients.
 *
 * Clients: Natsume Core (via JarvisClient), future mobile app.
 * Auth: optional bearer token via ACEDIA_SECRET env var.
 *       On LAN / Tailscale, leave empty — network trust is sufficient.
 *
 * Heartbeat: sends system.heartbeat every 30s to keep connections alive.
 */
export class AcediaWsServer {
    private wss: WebSocketServer | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private readonly secret: string | null;

    constructor() {
        const s = process.env["ACEDIA_SECRET"] ?? "";
        this.secret = s.length > 0 ? s : null;
    }

    start(port: number): void {
        this.wss = new WebSocketServer({ port });

        this.wss.on("connection", (ws, req) => {
            if (!this.authenticate(req.headers["authorization"])) {
                ws.close(4001, "Unauthorized");
                return;
            }
            console.warn(`[WS] Client connected — ${this.wss!.clients.size} total`);
            ws.on("close", () => console.warn(`[WS] Client disconnected`));
            ws.on("error", (err) => console.error("[WS] Client error:", err.message));
        });

        this.heartbeatTimer = setInterval(() => {
            this.broadcast({
                type: "system.heartbeat",
                ts: Date.now(),
                source: "system",
                title: "heartbeat",
                priority: "info",
                dedupeKey: `hb-${Date.now()}`,
            });
        }, HEARTBEAT_INTERVAL_MS);

        console.warn(`[WS] AcediaWsServer listening on ws://0.0.0.0:${port}`);
    }

    broadcast(event: AcediaEvent): void {
        if (!this.wss) return;
        const msg = JSON.stringify(event);
        for (const client of this.wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        }
    }

    stop(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.wss?.close();
        this.wss = null;
    }

    private authenticate(header: string | undefined): boolean {
        if (!this.secret) return true;
        return header === `Bearer ${this.secret}`;
    }
}
