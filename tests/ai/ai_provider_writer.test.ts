import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    validateAiProviderPatch,
    writeAiProviderConfig,
    applyStoredAiProvider,
} from "../../source/ai/ai_provider_writer.js";

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "lunacedia-ai-cfg-"));
}

describe("validateAiProviderPatch", () => {
    it("rejects an unknown provider", () => {
        const result = validateAiProviderPatch({ provider: "natsume" });
        expect(result.ok).toBe(false);
    });

    it("rejects openai without an apiKey", () => {
        const result = validateAiProviderPatch({ provider: "openai" });
        expect(result.ok).toBe(false);
    });

    it("accepts openai with a non-empty apiKey", () => {
        const result = validateAiProviderPatch({ provider: "openai", apiKey: "sk-test-key" });
        expect(result.ok).toBe(true);
    });

    it("accepts ollama without an apiKey (local, no key needed)", () => {
        const result = validateAiProviderPatch({ provider: "ollama" });
        expect(result.ok).toBe(true);
    });
});

// 2026-09-25 → 2026-10-07: the setting was written to the container's own /app/.env, not mounted — lost at every
// image update. It now lives in STORAGE_DIR (mounted), and is applied at start.
describe("writeAiProviderConfig", () => {
    let tmpDir: string;
    let cwdDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    const ENV = [
        "AI_PROVIDER",
        "OPENAI_API_KEY",
        "OLLAMA_URL",
        "AI_MODEL",
        "STORAGE_DIR",
        "ACEDIA_TOKEN_ENCRYPTION_ENABLED",
        "ACEDIA_MASTER_KEY",
    ];

    beforeEach(() => {
        tmpDir = makeTempDir();
        cwdDir = makeTempDir();
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        ENV.forEach((k) => delete process.env[k]);
        process.env["STORAGE_DIR"] = tmpDir;
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(cwdDir, { recursive: true, force: true });
        ENV.forEach((k) => delete process.env[k]);
    });

    it("keeps the setting in STORAGE_DIR, never in the container's own .env", () => {
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-test-key" });
        const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, "ai_provider.json"), "utf8"));
        expect(stored).toMatchObject({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-key" });
        expect(fs.existsSync(path.join(cwdDir, ".env"))).toBe(false);
    });

    it("comes back after a restart, over what .env says — the choice made in the dashboard", () => {
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-test-key", model: "gpt-x" });
        ENV.filter((k) => k !== "STORAGE_DIR").forEach((k) => delete process.env[k]);
        process.env["AI_PROVIDER"] = "none";
        expect(applyStoredAiProvider()).toBe(true);
        expect(process.env["AI_PROVIDER"]).toBe("openai");
        expect(process.env["OPENAI_API_KEY"]).toBe("sk-test-key");
        expect(process.env["AI_MODEL"]).toBe("gpt-x");
    });

    it("changes nothing when nothing was set from the dashboard", () => {
        process.env["AI_PROVIDER"] = "ollama";
        expect(applyStoredAiProvider()).toBe(false);
        expect(process.env["AI_PROVIDER"]).toBe("ollama");
    });

    it("encrypts the key at rest when token encryption is on", () => {
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        process.env["ACEDIA_MASTER_KEY"] = "a".repeat(64);
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-secret" });
        const raw = fs.readFileSync(path.join(tmpDir, "ai_provider.json"), "utf8");
        expect(raw).not.toContain("sk-secret");
        delete process.env["OPENAI_API_KEY"];
        expect(applyStoredAiProvider()).toBe(true);
        expect(process.env["OPENAI_API_KEY"]).toBe("sk-secret");
    });

    it("refuses to write the key in clear when encryption is on without a key", () => {
        process.env["ACEDIA_TOKEN_ENCRYPTION_ENABLED"] = "true";
        expect(() => writeAiProviderConfig({ provider: "openai", apiKey: "sk-secret" })).toThrow(
            /master key/,
        );
        expect(fs.existsSync(path.join(tmpDir, "ai_provider.json"))).toBe(false);
    });

    it("sets process.env immediately so the change applies without a restart", () => {
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-test-key" });
        expect(process.env["AI_PROVIDER"]).toBe("openai");
        expect(process.env["OPENAI_API_KEY"]).toBe("sk-test-key");
    });

    it("never logs the apiKey value", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-super-secret-value" });
        const allCalls = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat().map(String);
        warnSpy.mockRestore();
        logSpy.mockRestore();
        expect(allCalls.some((s) => s.includes("sk-super-secret-value"))).toBe(false);
    });

    it("keeps OLLAMA_URL for the ollama provider, defaulting when not given", () => {
        writeAiProviderConfig({ provider: "ollama" });
        const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, "ai_provider.json"), "utf8"));
        expect(stored).toMatchObject({
            AI_PROVIDER: "ollama",
            OLLAMA_URL: "http://localhost:11434",
        });
    });
});
