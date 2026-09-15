import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";

const h = vi.hoisted(() => ({
    mockReadFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
    default: { readFile: h.mockReadFile, writeFile: h.mockWriteFile, mkdir: h.mockMkdir },
    readFile: h.mockReadFile,
    writeFile: h.mockWriteFile,
    mkdir: h.mockMkdir,
}));

import { GoogleTokenStore } from "../../source/auth/google_token_store.js";

describe("GoogleTokenStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("get() returns undefined for a connector with no stored token", () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        expect(store.get("gmail")).toBeUndefined();
    });

    it("set() persists and get() returns it", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gmail", "rt-123");
        expect(store.get("gmail")).toBe("rt-123");
        expect(h.mockWriteFile).toHaveBeenCalledOnce();
    });

    it("clear() removes a stored token", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gcal", "rt-456");
        await store.clear("gcal");
        expect(store.get("gcal")).toBeUndefined();
    });

    it("load() restores persisted tokens", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ gmail: "rt-abc" }));
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.load();
        expect(store.get("gmail")).toBe("rt-abc");
    });

    it("status() reports which connectors have a stored token", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gmail", "rt-1");
        expect(store.status()).toEqual({ gmail: true, gcal: false, gtasks: false });
    });
});

describe("GoogleTokenStore — encryption at rest (ACEDIA_TOKEN_ENCRYPTION_ENABLED)", () => {
    const ORIGINAL_ENABLED = process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"];
    const ORIGINAL_KEY = process.env["ACEDIA_MASTER_KEY"];
    const KEY_HEX = randomBytes(32).toString("hex");

    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
        delete process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"];
        delete process.env["ACEDIA_MASTER_KEY"];
    });

    afterEach(() => {
        if (ORIGINAL_ENABLED === undefined) delete process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"]; else process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = ORIGINAL_ENABLED;
        if (ORIGINAL_KEY === undefined) delete process.env["ACEDIA_MASTER_KEY"]; else process.env["ACEDIA_MASTER_KEY"] = ORIGINAL_KEY;
    });

    it("refuses to construct when enabled without a configured key — fails closed, never writes plaintext", () => {
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        expect(() => new GoogleTokenStore("/tmp/x.json")).toThrow(/ACEDIA_MASTER_KEY/);
    });

    it("writes an encrypted (not plaintext-JSON) blob when enabled with a key", async () => {
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        process.env["ACEDIA_MASTER_KEY"] = KEY_HEX;
        const store = new GoogleTokenStore("/tmp/x.json");

        await store.set("gmail", "rt-secret");

        const written = h.mockWriteFile.mock.calls[0]?.[1] as string;
        expect(written).not.toContain("rt-secret");
        expect(written.startsWith("enc:v1:")).toBe(true);
    });

    it("round-trips through load() with the same key", async () => {
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        process.env["ACEDIA_MASTER_KEY"] = KEY_HEX;
        const writer = new GoogleTokenStore("/tmp/x.json");
        await writer.set("gcal", "rt-789");
        const persisted = h.mockWriteFile.mock.calls[0]?.[1] as string;

        h.mockReadFile.mockResolvedValue(persisted);
        const reader = new GoogleTokenStore("/tmp/x.json");
        await reader.load();

        expect(reader.get("gcal")).toBe("rt-789");
    });

    it("loads a pre-existing plaintext file unchanged, then re-encrypts it on the next save (auto-migration)", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ gmail: "rt-legacy-plaintext" }));
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        process.env["ACEDIA_MASTER_KEY"] = KEY_HEX;
        const store = new GoogleTokenStore("/tmp/x.json");

        await store.load();
        expect(store.get("gmail")).toBe("rt-legacy-plaintext");

        await store.set("gcal", "rt-new");
        const written = h.mockWriteFile.mock.calls[0]?.[1] as string;
        expect(written.startsWith("enc:v1:")).toBe(true);
    });

    it("stays plaintext (unchanged behavior) when the flag is not set, even with a key present", async () => {
        process.env["ACEDIA_MASTER_KEY"] = KEY_HEX; // set but ACEDIA_TOKEN_ENCRYPTION_ENABLED is not
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gmail", "rt-plain");
        const written = h.mockWriteFile.mock.calls[0]?.[1] as string;
        expect(JSON.parse(written)).toEqual({ gmail: "rt-plain" });
    });
});
