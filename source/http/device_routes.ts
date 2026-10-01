/**
 * Paired devices (ADR-020 M3).
 *
 *   POST   /api/devices/pair            { code, name } → 201 { device, token }   — NO auth (the code is the proof);
 *                                        rate-limited per address; the token is shown once
 *   POST   /api/devices/pairing-code    admin → { code, expiresAt }
 *   GET    /api/devices                 admin → { devices, journal }
 *   DELETE /api/devices/:id             admin → 204; its notifications stop at once
 */
import type http from "node:http";
import type { DeviceRegistry } from "../auth/device_registry.js";
import type { FcmSender } from "../push/fcm_sender.js";

/** Pairing attempts per address and per window — on top of the five-wrong-codes rule of the registry. */
const PAIR_LIMIT = 10;
const PAIR_WINDOW_MS = 10 * 60 * 1000;

export interface DeviceRouteDeps {
    devices: DeviceRegistry;
    fcm: FcmSender | null;
    readBody: (req: http.IncomingMessage) => Promise<unknown>;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
    now?: () => number;
}

export class DeviceRoutes {
    private readonly attempts = new Map<string, number[]>();

    constructor(private readonly deps: DeviceRouteDeps) {}

    /** The only unauthenticated one. Returns false when it is not the pairing route. */
    async handlePairing(
        method: string,
        path: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<boolean> {
        if (method !== "POST" || path !== "/api/devices/pair") return false;
        const { json } = this.deps;
        const now = (this.deps.now ?? Date.now)();
        const who = req.socket.remoteAddress ?? "unknown";
        const recent = (this.attempts.get(who) ?? []).filter((t) => t > now - PAIR_WINDOW_MS);
        if (recent.length >= PAIR_LIMIT) {
            json(res, 429, { error: "Too many pairing attempts — wait a few minutes" });
            return true;
        }
        recent.push(now);
        this.attempts.set(who, recent);
        let body: unknown;
        try {
            body = await this.deps.readBody(req);
        } catch {
            json(res, 400, { error: "Invalid JSON" });
            return true;
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const code = typeof b["code"] === "string" ? b["code"] : "";
        const name = typeof b["name"] === "string" ? b["name"] : "";
        const result = await this.deps.devices.pair(code, name);
        if (!result.ok) {
            json(res, result.reason === "name_required" ? 400 : 401, {
                error:
                    result.reason === "name_required"
                        ? "Give this device a name"
                        : "Invalid or expired code",
            });
            return true;
        }
        console.warn(`[Devices] paired "${result.device.name}" (${result.device.id})`);
        json(res, 201, { device: result.device, token: result.token });
        return true;
    }

    /** The admin routes. Returns false when it is not one of them. */
    async handleAdmin(method: string, path: string, res: http.ServerResponse): Promise<boolean> {
        const { json, devices, fcm } = this.deps;
        if (method === "POST" && path === "/api/devices/pairing-code") {
            json(res, 200, devices.createPairingCode());
            return true;
        }
        if (method === "GET" && path === "/api/devices") {
            json(res, 200, { devices: devices.list(), journal: devices.journal().slice(0, 50) });
            return true;
        }
        const m = path.match(/^\/api\/devices\/([^/]+)$/);
        if (method === "DELETE" && m && m[1] !== "push-token") {
            const removed = await devices.revoke(decodeURIComponent(m[1]!));
            if (!removed) {
                json(res, 404, { error: "No such device" });
                return true;
            }
            // Its notifications stop with it.
            if (fcm && removed.pushToken && fcm.getToken() === removed.pushToken)
                await fcm.setToken(null);
            console.warn(`[Devices] revoked "${removed.name}" (${removed.id})`);
            res.writeHead(204);
            res.end();
            return true;
        }
        return false;
    }
}
