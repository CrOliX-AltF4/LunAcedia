import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    validateAiProviderPatch,
    writeAiProviderConfig,
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

describe("writeAiProviderConfig", () => {
    let tmpDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = makeTempDir();
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
        delete process.env["AI_PROVIDER"];
        delete process.env["OPENAI_API_KEY"];
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env["AI_PROVIDER"];
        delete process.env["OPENAI_API_KEY"];
    });

    it("creates .env with AI_PROVIDER and OPENAI_API_KEY when the file does not exist", () => {
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-test-key" });
        const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf8");
        expect(content).toContain("AI_PROVIDER=openai");
        expect(content).toContain("OPENAI_API_KEY=sk-test-key");
    });

    it("updates an existing AI_PROVIDER line in place instead of duplicating it", () => {
        fs.writeFileSync(path.join(tmpDir, ".env"), "AI_PROVIDER=none\nACEDIA_SECRET=x\n", "utf8");
        writeAiProviderConfig({ provider: "openai", apiKey: "sk-test-key" });
        const lines = fs.readFileSync(path.join(tmpDir, ".env"), "utf8").split("\n");
        expect(lines.filter((l) => l.startsWith("AI_PROVIDER="))).toHaveLength(1);
        expect(lines).toContain("AI_PROVIDER=openai");
        expect(lines).toContain("ACEDIA_SECRET=x");
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

    it("writes OLLAMA_URL for the ollama provider, defaulting when not given", () => {
        writeAiProviderConfig({ provider: "ollama" });
        const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf8");
        expect(content).toContain("AI_PROVIDER=ollama");
        expect(content).toContain("OLLAMA_URL=http://localhost:11434");
    });
});
