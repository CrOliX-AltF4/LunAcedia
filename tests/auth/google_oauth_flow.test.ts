import { describe, it, expect, vi, afterEach } from "vitest";
import {
    findGoogleOAuthConnector,
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    GOOGLE_OAUTH_CONNECTORS,
} from "../../source/auth/google_oauth_flow.js";

describe("findGoogleOAuthConnector", () => {
    it("finds gmail/gcal/gtasks by key", () => {
        expect(findGoogleOAuthConnector("gmail")?.label).toBe("Gmail");
        expect(findGoogleOAuthConnector("gcal")?.label).toBe("Google Calendar");
        expect(findGoogleOAuthConnector("gtasks")?.label).toBe("Google Tasks");
    });

    it("returns undefined for an unknown key", () => {
        expect(findGoogleOAuthConnector("dropbox")).toBeUndefined();
        expect(findGoogleOAuthConnector("")).toBeUndefined();
    });

    it("every connector declares at least one scope", () => {
        for (const c of GOOGLE_OAUTH_CONNECTORS) {
            expect(c.scopes.length).toBeGreaterThan(0);
        }
    });
});

describe("buildGoogleAuthUrl", () => {
    it("includes client_id, redirect_uri, scopes, and state", () => {
        const url = new URL(
            buildGoogleAuthUrl(
                "cid",
                "http://localhost:4001/api/oauth/google/callback",
                ["scope-a", "scope-b"],
                "gmail",
            ),
        );
        expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
        expect(url.searchParams.get("client_id")).toBe("cid");
        expect(url.searchParams.get("redirect_uri")).toBe(
            "http://localhost:4001/api/oauth/google/callback",
        );
        expect(url.searchParams.get("scope")).toBe("scope-a scope-b");
        expect(url.searchParams.get("state")).toBe("gmail");
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("prompt")).toBe("consent");
    });
});

describe("exchangeGoogleCode", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns the refresh token from a successful exchange", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ refresh_token: "rt-xyz" }),
            }),
        );
        const result = await exchangeGoogleCode(
            "cid",
            "secret",
            "code123",
            "http://localhost/callback",
        );
        expect(result.refreshToken).toBe("rt-xyz");
    });

    it("returns null when Google's response has no refresh_token (already consented once)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
        );
        const result = await exchangeGoogleCode(
            "cid",
            "secret",
            "code123",
            "http://localhost/callback",
        );
        expect(result.refreshToken).toBeNull();
    });

    it("throws with Google's error body when the exchange fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                text: () => Promise.resolve('{"error":"invalid_grant"}'),
            }),
        );
        await expect(
            exchangeGoogleCode("cid", "secret", "bad-code", "http://localhost/callback"),
        ).rejects.toThrow("invalid_grant");
    });
});
