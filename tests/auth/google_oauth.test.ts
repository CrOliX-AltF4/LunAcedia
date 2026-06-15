import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGoogleToken, clearGoogleTokenCache } from "../../source/auth/google_oauth.js";

beforeEach(() => {
    clearGoogleTokenCache();
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ access_token: "test-token", expires_in: 3600 }),
        }),
    );
});

afterEach(() => vi.unstubAllGlobals());

describe("getGoogleToken", () => {
    it("should fetch and return an access token", async () => {
        const token = await getGoogleToken("cid", "csec", "rtoken", "test");
        expect(token).toBe("test-token");
    });

    it("should cache token and not re-fetch on second call", async () => {
        await getGoogleToken("cid", "csec", "rtoken", "test");
        await getGoogleToken("cid", "csec", "rtoken", "test");
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("should use separate cache per cacheKey", async () => {
        await getGoogleToken("cid", "csec", "rtoken", "key-a");
        await getGoogleToken("cid", "csec", "rtoken", "key-b");
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it("should throw when endpoint returns non-ok", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
        await expect(getGoogleToken("cid", "csec", "rtoken", "test")).rejects.toThrow("400");
    });
});

describe("clearGoogleTokenCache", () => {
    it("should force re-fetch after clearing a specific key", async () => {
        await getGoogleToken("cid", "csec", "rtoken", "test");
        clearGoogleTokenCache("test");
        await getGoogleToken("cid", "csec", "rtoken", "test");
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it("should clear all keys when called without argument", async () => {
        await getGoogleToken("cid", "csec", "rtoken", "a");
        await getGoogleToken("cid", "csec", "rtoken", "b");
        clearGoogleTokenCache();
        await getGoogleToken("cid", "csec", "rtoken", "a");
        await getGoogleToken("cid", "csec", "rtoken", "b");
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    });
});
