interface TokenCache {
    accessToken: string;
    expiresAt: number;
}

// Per-key cache — one entry per connector ("gmail", "gcal", etc.)
const caches = new Map<string, TokenCache>();

export async function getGoogleToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    cacheKey: string,
): Promise<string> {
    const cached = caches.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;

    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
    });

    if (!resp.ok) {
        // Google's OAuth error body carries the actual reason (invalid_grant, invalid_client,
        // unauthorized_client, ...) — the HTTP status alone ("400") gives no way to tell a
        // revoked/expired refresh token apart from a bad client_id or a scope mismatch.
        const bodyText = await resp.text().catch(() => "");
        let detail = bodyText;
        try {
            const parsed = JSON.parse(bodyText) as { error?: string; error_description?: string };
            if (parsed.error)
                detail = `${parsed.error}${parsed.error_description ? `: ${parsed.error_description}` : ""}`;
        } catch {
            /* not JSON — fall back to raw body text */
        }
        throw new Error(
            `Google token refresh failed (${resp.status}) for cacheKey="${cacheKey}": ${detail || "(empty response body)"}`,
        );
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number };
    caches.set(cacheKey, {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
    });
    return data.access_token;
}

export function clearGoogleTokenCache(cacheKey?: string): void {
    if (cacheKey) caches.delete(cacheKey);
    else caches.clear();
}
