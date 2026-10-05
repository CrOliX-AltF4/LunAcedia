import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { AgentService } from "../../source/agent/agent_service.js";
import { DeviceRegistry } from "../../source/auth/device_registry.js";

// End to end: pairing, a device token limited to the mobile routes, revocation; the admin secret unchanged.

let PORT = 49_900 + Math.floor(Math.random() * 300);
const nextPort = () => PORT++;
const SECRET = "admin-secret-of-this-test";

async function call(
    method: string,
    url: string,
    token?: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("AcediaApiServer — paired devices", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;
    let agent: AgentService;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start() {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-devices-"));
        agent = new AgentService();
        server = new AcediaApiServer(
            new EventStore(),
            [],
            new IngestionHub([]),
            null,
            new NullAIProvider(),
            SECRET,
            new ActionTierStore(path.join(dir, "tiers.json"), path.join(dir, "overrides.json")),
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            undefined,
            agent,
            undefined,
            undefined,
            undefined,
            new DeviceRegistry(path.join(dir, "devices.json")),
        );
        const port = nextPort();
        server.start(port);
        return `http://localhost:${port}`;
    }

    async function pairedDevice(base: string): Promise<{ id: string; token: string }> {
        const code = (await call("POST", `${base}/api/devices/pairing-code`, SECRET)).body
            .code as string;
        const r = await call("POST", `${base}/api/devices/pair`, undefined, {
            code,
            name: "Pixel",
        });
        expect(r.status).toBe(201);
        return { id: r.body.device.id, token: r.body.token };
    }

    it("pairs a phone with a code the admin asked for — no secret needed on the phone", async () => {
        const base = await start();
        expect((await call("POST", `${base}/api/devices/pairing-code`)).status).toBe(401);
        const { token } = await pairedDevice(base);
        expect(token.startsWith("acd_dev_")).toBe(true);
        const list = await call("GET", `${base}/api/devices`, SECRET);
        expect(list.body.devices).toEqual([expect.objectContaining({ name: "Pixel" })]);
        expect(JSON.stringify(list.body)).not.toContain(token);
    });

    it("refuses a wrong code, and a nameless device", async () => {
        const base = await start();
        const code = (await call("POST", `${base}/api/devices/pairing-code`, SECRET)).body
            .code as string;
        expect(
            (
                await call("POST", `${base}/api/devices/pair`, undefined, {
                    code: "WRONG123",
                    name: "x",
                })
            ).status,
        ).toBe(401);
        expect(
            (await call("POST", `${base}/api/devices/pair`, undefined, { code, name: "" })).status,
        ).toBe(400);
    });

    it("opens the mobile routes to a device token, and nothing that administers", async () => {
        const base = await start();
        const { token } = await pairedDevice(base);
        expect((await call("GET", `${base}/api/identity`, token)).status).toBe(200);
        expect((await call("GET", `${base}/api/actions/pending`, token)).status).toBe(200);
        for (const [m, p] of [
            ["GET", "/api/config/tiers"],
            ["GET", "/api/devices"],
            ["POST", "/api/devices/pairing-code"],
            ["GET", "/api/agent/journal"],
            ["POST", "/api/agent"],
        ] as const) {
            const r = await call(m, `${base}${p}`, token, m === "POST" ? {} : undefined);
            expect(r.status, `${m} ${p}`).toBe(403);
        }
    });

    it("lets a phone turn the agent off, never back on (law 3)", async () => {
        const base = await start();
        const { token } = await pairedDevice(base);
        expect(
            (await call("PUT", `${base}/api/agent/settings`, token, { enabled: true })).status,
        ).toBe(403);
        expect(
            (await call("PUT", `${base}/api/agent/settings`, token, { writes: true })).status,
        ).toBe(403);
        const off = await call("PUT", `${base}/api/agent/settings`, token, { enabled: false });
        expect(off.status).toBe(200);
        expect(agent.isEnabled()).toBe(false);
        expect(
            (await call("PUT", `${base}/api/agent/settings`, SECRET, { enabled: true })).status,
        ).toBe(200);
        expect(agent.isEnabled()).toBe(true);
    });

    it("refuses a revoked device at once", async () => {
        const base = await start();
        const { id, token } = await pairedDevice(base);
        expect((await call("DELETE", `${base}/api/devices/${id}`, SECRET)).status).toBe(204);
        expect((await call("GET", `${base}/api/identity`, token)).status).toBe(401);
        expect((await call("DELETE", `${base}/api/devices/${id}`, SECRET)).status).toBe(404);
    });

    it("keeps the admin secret working, and refuses a wrong one", async () => {
        const base = await start();
        expect((await call("GET", `${base}/api/config/tiers`, SECRET)).status).toBe(200);
        expect(
            (await call("GET", `${base}/api/config/tiers`, "admin-secret-of-this-tesT")).status,
        ).toBe(401);
        expect((await call("GET", `${base}/api/config/tiers`, "short")).status).toBe(401);
    });

    it("limits pairing attempts per address", async () => {
        const base = await start();
        let last = 0;
        for (let i = 0; i < 11; i++)
            last = (
                await call("POST", `${base}/api/devices/pair`, undefined, {
                    code: "WRONG123",
                    name: "x",
                })
            ).status;
        expect(last).toBe(429);
    });
});
