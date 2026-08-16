import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type GoogleConnectorKey = "gmail" | "gcal" | "gtasks";

type TokenMap = Partial<Record<GoogleConnectorKey, string>>;

function resolveTokenPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "google_tokens.json");
}

/**
 * Persists Google OAuth refresh tokens obtained through the server-side consent flow
 * (google_oauth_flow.ts + the /api/oauth/google/* routes) — same STORAGE_DIR convention
 * as ActionTierStore/EmailClassificationStore.
 *
 * Connectors read tokens fresh from get() on every poll()/executeAction() call rather than
 * freezing them at construction, so connecting a source through the flow takes effect on
 * the very next poll — no restart needed, the same reasoning as EmailClassificationStore
 * being read fresh instead of cached.
 *
 * *_REFRESH_TOKEN env vars remain a valid fallback (get() only returns a stored value when
 * one was actually persisted here) — existing deployments that already pasted a token by
 * hand keep working unchanged.
 */
export class GoogleTokenStore {
    private tokens: TokenMap = {};
    private readonly tokenPath: string;

    constructor(tokenPath?: string) {
        this.tokenPath = tokenPath ?? resolveTokenPath();
    }

    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.tokenPath, "utf-8");
            const parsed = JSON.parse(raw) as TokenMap;
            if (parsed && typeof parsed === "object") this.tokens = parsed;
        } catch {
            // File absent or unreadable — no stored tokens, that's fine
        }
    }

    get(connector: GoogleConnectorKey): string | undefined {
        return this.tokens[connector];
    }

    async set(connector: GoogleConnectorKey, refreshToken: string): Promise<void> {
        this.tokens[connector] = refreshToken;
        await this.save();
    }

    async clear(connector: GoogleConnectorKey): Promise<void> {
        delete this.tokens[connector];
        await this.save();
    }

    status(): Record<GoogleConnectorKey, boolean> {
        return {
            gmail: this.tokens.gmail !== undefined,
            gcal: this.tokens.gcal !== undefined,
            gtasks: this.tokens.gtasks !== undefined,
        };
    }

    private async save(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
            await fs.writeFile(this.tokenPath, JSON.stringify(this.tokens, null, 2), "utf-8");
        } catch (e) {
            console.error("[GoogleTokenStore] Failed to persist:", (e as Error).message);
        }
    }
}
