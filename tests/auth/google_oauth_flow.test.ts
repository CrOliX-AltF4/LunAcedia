import { describe, it, expect, vi, afterEach } from "vitest";
import {
    findGoogleOAuthConnector,
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    GOOGLE_OAUTH_CONNECTORS,
    googleClientFor,
    OAuthStates,
} from "../../source/auth/google_oauth_flow.js";

// 2026-10-07: the consent ran with GOOGLE_CLIENT_ID while each connector refreshes with its own pair — a token is
// only valid with the client that obtained it.
describe("googleClientFor", () => {
    const KEYS = ["GMAIL", "GCAL", "GTASKS", "GOOGLE"].flatMap((p) => [
        `${p}_CLIENT_ID`,
        `${p}_CLIENT_SECRET`,
    ]);
    afterEach(() => KEYS.forEach((k) => delete process.env[k]));

    it("takes the connector's own pair first", () => {
        process.env["GMAIL_CLIENT_ID"] = "gm-id";
        process.env["GMAIL_CLIENT_SECRET"] = "gm-secret";
        process.env["GOOGLE_CLIENT_ID"] = "g-id";
        process.env["GOOGLE_CLIENT_SECRET"] = "g-secret";
        expect(googleClientFor("gmail")).toEqual({
            id: "gm-id",
            secret: "gm-secret",
            from: "GMAIL",
        });
    });

    it("falls back on the shared pair, and has none when neither is complete", () => {
        process.env["GOOGLE_CLIENT_ID"] = "g-id";
        process.env["GOOGLE_CLIENT_SECRET"] = "g-secret";
        process.env["GCAL_CLIENT_ID"] = "half-a-pair";
        expect(googleClientFor("gcal")).toEqual({ id: "g-id", secret: "g-secret", from: "GOOGLE" });
        delete process.env["GOOGLE_CLIENT_SECRET"];
        expect(googleClientFor("gtasks")).toBeNull();
    });
});

describe("OAuthStates — a return from Google that was asked for", () => {
    it("gives an unguessable state, taken once, for its connector", () => {
        const states = new OAuthStates();
        const s = states.issue("gmail");
        expect(s).toMatch(/^[0-9a-f]{32}$/);
        expect(states.take(s)).toBe("gmail");
        expect(states.take(s)).toBeNull();
        expect(states.take("gmail")).toBeNull();
    });

    it("forgets a state after 10 minutes", () => {
        let now = 0;
        const states = new OAuthStates(() => now);
        const s = states.issue("gcal");
        now = 10 * 60 * 1000 + 1;
        expect(states.take(s)).toBeNull();
    });
});

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
        // The account can be chosen: reconnecting with another Google account is possible.
        expect(url.searchParams.get("prompt")).toBe("consent select_account");
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
