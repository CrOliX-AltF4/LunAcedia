import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    DeviceRegistry,
    INACTIVE_REVOKE_MS,
    MAX_FAILED_PAIRINGS,
    PAIRING_CODE_LENGTH,
    PAIRING_CODE_TTL_MS,
    normalizeCode,
} from "../../source/auth/device_registry.js";
import { isDeviceRoute } from "../../source/auth/device_scope.js";

// Each phone its own token, limited, revocable; the master secret never leaves the server.

describe("DeviceRegistry", () => {
    let t: number;
    let reg: DeviceRegistry;
    beforeEach(() => {
        t = Date.parse("2026-09-30T12:00:00Z");
        reg = new DeviceRegistry(undefined, () => t);
    });

    it("pairs with a one-time code and gives a token that authenticates the device", async () => {
        const { code } = reg.createPairingCode();
        expect(code).toHaveLength(PAIRING_CODE_LENGTH);
        expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]+$/);
        const r = await reg.pair(code.toLowerCase().replace(/(.{4})/, "$1-"), "Pixel de CrOliX");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.token.startsWith("acd_dev_")).toBe(true);
        expect(reg.authenticate(r.token)).toMatchObject({
            id: r.device.id,
            name: "Pixel de CrOliX",
        });
        // One use only.
        expect(await reg.pair(code, "again")).toEqual({ ok: false, reason: "invalid_or_expired" });
    });

    it("refuses an expired code and a nameless device", async () => {
        const { code } = reg.createPairingCode();
        expect(await reg.pair(code, "   ")).toEqual({ ok: false, reason: "name_required" });
        t += PAIRING_CODE_TTL_MS + 1;
        expect(await reg.pair(code, "Pixel")).toEqual({ ok: false, reason: "invalid_or_expired" });
    });

    it("revokes every open code after five wrong ones", async () => {
        const { code } = reg.createPairingCode();
        for (let i = 0; i < MAX_FAILED_PAIRINGS; i++) await reg.pair("WRONGONE", "x");
        expect(await reg.pair(code, "Pixel")).toEqual({ ok: false, reason: "invalid_or_expired" });
        expect(reg.journal()[0]).toMatchObject({ op: "pair_refused" });
    });

    it("refuses anything that is not one of its tokens", () => {
        expect(reg.authenticate(undefined)).toBeNull();
        expect(reg.authenticate("acd_dev_forged")).toBeNull();
        expect(reg.authenticate("some-admin-secret")).toBeNull();
    });

    it("refuses a revoked token at once, and journals it", async () => {
        const r = await reg.pair(reg.createPairingCode().code, "Pixel");
        if (!r.ok) throw new Error("pair failed");
        expect(await reg.revoke(r.device.id)).toMatchObject({ name: "Pixel" });
        expect(reg.authenticate(r.token)).toBeNull();
        expect(reg.list()).toEqual([]);
        expect(reg.journal()[0]).toMatchObject({ op: "revoke", name: "Pixel" });
    });

    it("revokes a device silent for 90 days, and keeps an active one", async () => {
        const old = await reg.pair(reg.createPairingCode().code, "Vieux");
        t += 30 * 24 * 60 * 60 * 1000;
        const recent = await reg.pair(reg.createPairingCode().code, "Récent");
        if (!old.ok || !recent.ok) throw new Error("pair failed");
        t += INACTIVE_REVOKE_MS - 30 * 24 * 60 * 60 * 1000 + 1;
        reg.authenticate(recent.token);
        const revoked = await reg.sweepInactive();
        expect(revoked.map((d) => d.name)).toEqual(["Vieux"]);
        expect(reg.list().map((d) => d.name)).toEqual(["Récent"]);
        expect(reg.journal()[0]).toMatchObject({ op: "expire", name: "Vieux" });
    });

    it("normalizes a typed code", () => {
        expect(normalizeCode(" ab cd-ef 12 ")).toBe("ABCDEF12");
    });

    describe("on disk", () => {
        let dir: string;
        beforeEach(async () => {
            dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-devices-"));
        });
        afterEach(async () => {
            await fs.rm(dir, { recursive: true, force: true });
        });

        it("keeps only the token's hash — never the token — and survives a restart", async () => {
            const file = path.join(dir, "devices.json");
            const first = new DeviceRegistry(file, () => t);
            const r = await first.pair(first.createPairingCode().code, "Pixel");
            if (!r.ok) throw new Error("pair failed");
            await first.setPushToken(r.device.id, "fcm-token");
            await first.flush();

            const raw = await fs.readFile(file, "utf-8");
            expect(raw).not.toContain(r.token);
            expect(raw).not.toContain(r.token.slice(8));

            const again = new DeviceRegistry(file, () => t);
            await again.load();
            expect(again.authenticate(r.token)).toMatchObject({
                name: "Pixel",
                pushToken: "fcm-token",
            });
            expect(again.list()[0]).not.toHaveProperty("tokenHash");
        });
    });
});

describe("isDeviceRoute", () => {
    it("opens the mobile routes", () => {
        for (const [m, p] of [
            ["GET", "/api/identity"],
            ["GET", "/api/inbox"],
            ["POST", "/api/inbox/email-1/archive"],
            ["POST", "/api/inbox/trash/abc/restore"],
            ["GET", "/api/conversations"],
            ["POST", "/api/conversations/x/messages"],
            ["DELETE", "/api/conversations/x"],
            ["GET", "/api/actions/pending"],
            ["POST", "/api/actions/a1/confirm"],
            ["GET", "/api/digest"],
            ["POST", "/api/devices/push-token"],
            ["PUT", "/api/agent/settings"],
        ])
            expect(isDeviceRoute(m!, p!), `${m} ${p}`).toBe(true);
    });

    it("closes everything that administers", () => {
        for (const [m, p] of [
            ["GET", "/api/config/tiers"],
            ["PATCH", "/api/config/tiers"],
            ["PUT", "/api/guard/rules"],
            ["POST", "/api/actions"],
            ["POST", "/api/agent"],
            ["POST", "/api/intent"],
            ["GET", "/api/usage"],
            ["PUT", "/api/config/usage-alerts"],
            ["GET", "/api/devices"],
            ["POST", "/api/devices/pairing-code"],
            ["DELETE", "/api/devices/abc"],
            ["POST", "/api/config/ai-provider"],
            ["POST", "/api/events/held"],
            ["POST", "/api/events/clear-read"],
            // The legacy event list: the app has read the box since M4 (closed 2026-10-07).
            ["GET", "/api/events"],
            ["POST", "/api/events/read-all"],
            ["POST", "/api/events/email-1/read"],
            ["GET", "/api/agent/journal"],
        ])
            expect(isDeviceRoute(m!, p!), `${m} ${p}`).toBe(false);
    });
});
