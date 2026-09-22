import * as fs from "fs";
import * as path from "path";

/**
 * Configures LunAcedia's own AI provider from the dashboard onboarding screen (ADR-013 I1,
 * LunAnima repo). Unlike the Core's config_writer.ts (which blanket-rejects any key matching
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

export type ValidationResult =
    | { ok: true; patch: AiProviderPatch }
    | { ok: false; error: string };

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

function envPath(): string {
    return path.join(process.cwd(), ".env");
}

function patchLines(updates: Record<string, string>): void {
    const filePath = envPath();
    const lines = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8").split("\n")
        : [];

    const patched = new Set<string>();
    const result = lines.map((line) => {
        const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
        if (key !== undefined && updates[key] !== undefined) {
            patched.add(key);
            return `${key}=${updates[key]}`;
        }
        return line;
    });

    for (const [key, val] of Object.entries(updates)) {
        if (!patched.has(key)) result.push(`${key}=${val}`);
    }

    fs.writeFileSync(filePath, result.join("\n"), "utf8");
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows has no POSIX bits — best-effort */ }

    for (const [key, val] of Object.entries(updates)) {
        process.env[key] = val;
    }
}

/** Writes the patch to .env and process.env — never logs apiKey (audit trail must not carry secrets). */
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
    patchLines(updates);
    console.warn(`[Config] AI provider configured: ${patch.provider}`);
}
