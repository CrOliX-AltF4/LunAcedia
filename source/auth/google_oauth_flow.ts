import { randomBytes } from "node:crypto";
import type { GoogleConnectorKey } from "./google_token_store.js";

/** Each connector's own env prefix: `GMAIL_CLIENT_ID`… — what it refreshes its token with. */
export const GOOGLE_ENV_PREFIX: Record<GoogleConnectorKey, "GMAIL" | "GCAL" | "GTASKS"> = {
    gmail: "GMAIL",
    gcal: "GCAL",
    gtasks: "GTASKS",
};

export interface GoogleClient {
    id: string;
    secret: string;
    /** Where the pair came from: the connector's own, or the shared GOOGLE_* one. */
    from: "GMAIL" | "GCAL" | "GTASKS" | "GOOGLE";
}

/**
 * The OAuth client of a connector: its own pair first, the shared `GOOGLE_*` pair otherwise; null when neither is
 * complete. The consent, the code exchange and the connector's own refreshes all use this one — a refresh token is
 * only valid with the client that obtained it (2026-10-07: the consent used GOOGLE_*, the connector its own pair).
 */
export function googleClientFor(key: GoogleConnectorKey): GoogleClient | null {
    for (const from of [GOOGLE_ENV_PREFIX[key], "GOOGLE"] as const) {
        const id = process.env[`${from}_CLIENT_ID`] ?? "";
        const secret = process.env[`${from}_CLIENT_SECRET`] ?? "";
        if (id && secret) return { id, secret, from };
    }
    return null;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The returns from Google this server asked for. The callback is reached without authentication (Google redirects
 * the browser there), so its `state` must be one this server issued — random, for one connector, used once, within
 * 10 minutes. Otherwise a forged link could store someone else's Google account.
 */
export class OAuthStates {
    private readonly issued = new Map<string, { key: GoogleConnectorKey; until: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    issue(key: GoogleConnectorKey): string {
        this.purge();
        const state = randomBytes(16).toString("hex");
        this.issued.set(state, { key, until: this.now() + STATE_TTL_MS });
        return state;
    }

    /** The connector this state was issued for — once; null for an unknown, used or expired one. */
    take(state: string): GoogleConnectorKey | null {
        this.purge();
        const entry = this.issued.get(state);
        if (!entry) return null;
        this.issued.delete(state);
        return entry.key;
    }

    private purge(): void {
        const t = this.now();
        for (const [state, e] of this.issued) if (e.until < t) this.issued.delete(state);
    }
}

export interface GoogleConnectorOAuthMeta {
    key: GoogleConnectorKey;
    label: string;
    scopes: string[];
}

/** Same scope sets scripts/get_google_tokens.mjs used — kept in sync deliberately. */
export const GOOGLE_OAUTH_CONNECTORS: GoogleConnectorOAuthMeta[] = [
    {
        key: "gmail",
        label: "Gmail",
        scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.modify",
        ],
    },
    {
        key: "gcal",
        label: "Google Calendar",
        scopes: [
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.events",
        ],
    },
    {
        key: "gtasks",
        label: "Google Tasks",
        scopes: ["https://www.googleapis.com/auth/tasks"],
    },
];

export function findGoogleOAuthConnector(key: string): GoogleConnectorOAuthMeta | undefined {
    return GOOGLE_OAUTH_CONNECTORS.find((c) => c.key === key);
}

export function buildGoogleAuthUrl(
    clientId: string,
    redirectUri: string,
    scopes: string[],
    state: string,
): string {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        // consent: a refresh token every time; select_account: another Google account can be chosen.
        prompt: "consent select_account",
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
): Promise<{ refreshToken: string | null }> {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        throw new Error(`Google token exchange failed (${resp.status}): ${err}`);
    }
    const data = (await resp.json()) as { refresh_token?: string };
    return { refreshToken: data.refresh_token ?? null };
}
