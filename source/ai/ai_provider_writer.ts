import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    decryptValue,
    encryptValue,
    isEncryptedValue,
    loadMasterKey,
} from "../auth/secret_crypto.js";

/**
 * Configures LunAcedia's own AI provider from the dashboard onboarding screen. Unlike a hub's config writer (which blanket-rejects any key matching
 * SECRET_PATTERN), this one deliberately writes an API key — CrOliX asked for a LunIra-style
 * onboarding ("configure at least one key on first use") rather than a pre-picked default
 * (there is none to pick: AI_PROVIDER=none ships with no key in the repo).
 */
export interface AiProviderPatch {
    provider: "openai" | "ollama";
    apiKey?: string;
    model?: string;
    ollamaUrl?: string;
}

export type ValidationResult = { ok: true; patch: AiProviderPatch } | { ok: false; error: string };

export function validateAiProviderPatch(input: unknown): ValidationResult {
    if (typeof input !== "object" || input === null) {
        return { ok: false, error: "Body must be an object" };
    }
    const body = input as Record<string, unknown>;
    const provider = body["provider"];
    if (provider !== "openai" && provider !== "ollama") {
        return { ok: false, error: "provider must be 'openai' or 'ollama'" };
    }
    const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : undefined;
    const model = typeof body["model"] === "string" ? body["model"].trim() : undefined;
    const ollamaUrl = typeof body["ollamaUrl"] === "string" ? body["ollamaUrl"].trim() : undefined;

    if (provider === "openai" && !apiKey) {
        return { ok: false, error: "openai requires a non-empty apiKey" };
    }

    return {
        ok: true,
        patch: {
            provider,
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            ...(ollamaUrl ? { ollamaUrl } : {}),
        },
    };
}

/** Where the dashboard's choice lives: STORAGE_DIR, the directory a deployment keeps across image updates. */
function settingsPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "ai_provider.json");
}

/** The master key when encryption at rest is on; fail-closed — never a key written in clear by mistake. */
function encryptionKey(): Buffer | null {
    if (process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] !== "true") return null;
    const key = loadMasterKey();
    if (!key)
        throw new Error(
            "[Config] ACEDIA_TOKEN_ENCRYPTION_ENABLED=true but no master key is configured (ACEDIA_MASTER_KEY or " +
                "ACEDIA_MASTER_KEY_FILE) — the AI key is not written in clear text.",
        );
    return key;
}

/**
 * Keeps the dashboard's choice in STORAGE_DIR (2026-10-07: it was written to the container's own .env, not mounted,
 * and lost at every image update) and applies it to process.env at once — no restart. Never logs the key.
 */
export function writeAiProviderConfig(patch: AiProviderPatch): void {
    const updates: Record<string, string> = { AI_PROVIDER: patch.provider };
    if (patch.provider === "openai" && patch.apiKey) {
        updates["OPENAI_API_KEY"] = patch.apiKey;
    }
    if (patch.provider === "ollama") {
        updates["OLLAMA_URL"] = patch.ollamaUrl ?? "http://localhost:11434";
    }
    if (patch.model) {
        updates["AI_MODEL"] = patch.model;
    }
    const key = encryptionKey();
    const json = JSON.stringify(updates);
    const filePath = settingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, key ? encryptValue(json, key) : json, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);

    for (const [k, v] of Object.entries(updates)) process.env[k] = v;
    console.warn(`[Config] AI provider configured: ${patch.provider}`);
}

/**
 * At start, before the provider is built: the dashboard's choice, if one was made, over what .env says — otherwise a
 * value left in .env would undo it at every restart. False when nothing was stored.
 */
export function applyStoredAiProvider(): boolean {
    let raw: string;
    try {
        raw = fs.readFileSync(settingsPath(), "utf8");
    } catch {
        return false;
    }
    const key = isEncryptedValue(raw) ? (encryptionKey() ?? loadMasterKey()) : null;
    if (isEncryptedValue(raw) && !key) {
        console.error(
            "[Config] the stored AI setting is encrypted and no master key is configured — not applied",
        );
        return false;
    }
    let stored: Record<string, unknown>;
    try {
        stored = JSON.parse(key ? decryptValue(raw, key) : raw) as Record<string, unknown>;
    } catch {
        console.error("[Config] the stored AI setting is unreadable — not applied");
        return false;
    }
    const KEYS = ["AI_PROVIDER", "OPENAI_API_KEY", "OLLAMA_URL", "AI_MODEL"];
    for (const k of KEYS) {
        const v = stored[k];
        if (typeof v === "string" && v) process.env[k] = v;
    }
    return typeof stored["AI_PROVIDER"] === "string";
}
