import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { encryptValue, decryptValue, isEncryptedValue, loadMasterKey } from "./secret_crypto.js";

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
 *
 * Encryption at rest (docs/standards/04-securite-auth.md rule 2, LunAnima side) — opt-in via
 * ACEDIA_TOKEN_ENCRYPTION_ENABLED, same fail-closed contract as LunAnima's own
 * STORAGE_ENCRYPTION_ENABLED (enabled without a configured key throws at construction, never
 * a silent plaintext fallback). Migrates transparently: a plaintext file from before
 * encryption was turned on still loads fine, and gets encrypted on the very next save() — no
 * separate migration script or manual step.
 */
export class GoogleTokenStore {
    private tokens: TokenMap = {};
    private readonly tokenPath: string;
    private readonly encryptionEnabled: boolean;
    private readonly masterKey: Buffer | null;

    constructor(tokenPath?: string) {
        this.tokenPath = tokenPath ?? resolveTokenPath();
        this.encryptionEnabled = process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] === "true";
        this.masterKey = this.encryptionEnabled ? loadMasterKey() : null;
        if (this.encryptionEnabled && !this.masterKey) {
            throw new Error(
                "[GoogleTokenStore] ACEDIA_TOKEN_ENCRYPTION_ENABLED=true but no master key is " +
                "configured (ACEDIA_MASTER_KEY or ACEDIA_MASTER_KEY_FILE). Refusing to start " +
                "rather than fall back to writing refresh tokens in clear text.",
            );
        }
    }

    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.tokenPath, "utf-8");
            // Plaintext from before encryption was turned on stays readable — re-encrypted on
            // the next save() rather than requiring a manual migration.
            const json = this.masterKey && isEncryptedValue(raw) ? decryptValue(raw, this.masterKey) : raw;
            const parsed = JSON.parse(json) as TokenMap;
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
            const json = JSON.stringify(this.tokens, null, 2);
            const out  = this.masterKey ? encryptValue(json, this.masterKey) : json;
            await fs.writeFile(this.tokenPath, out, "utf-8");
        } catch (e) {
            console.error("[GoogleTokenStore] Failed to persist:", (e as Error).message);
        }
    }
}
