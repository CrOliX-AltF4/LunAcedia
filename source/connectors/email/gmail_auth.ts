interface TokenCache {
    accessToken: string;
    expiresAt:   number;
}

let cache: TokenCache | null = null;

export async function getAccessToken(
    clientId:     string,
    clientSecret: string,
    refreshToken: string,
): Promise<string> {
    if (cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;

    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type:    "refresh_token",
        }),
    });

    if (!resp.ok) throw new Error(`Gmail token refresh failed: ${resp.status}`);

    const data = await resp.json() as { access_token: string; expires_in: number };
    cache = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1_000 };
    return cache.accessToken;
}

/** Reset cached token — used in tests and on 401 responses. */
export function clearTokenCache(): void {
    cache = null;
}