import type { GoogleConnectorKey } from "./google_token_store.js";

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
        prompt: "consent",
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
