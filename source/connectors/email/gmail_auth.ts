import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";

export async function getAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
): Promise<string> {
    return getGoogleToken(clientId, clientSecret, refreshToken, "gmail");
}

export function clearTokenCache(): void {
    clearGoogleTokenCache("gmail");
}
