import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAIProvider } from "./ai_provider.js";
import { NullAIProvider } from "./null_provider.js";
import { OpenAIProvider } from "./openai_provider.js";
import { OllamaProvider } from "./ollama_provider.js";
import { NatsumeProvider } from "./natsume_provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SYSTEM_PROMPT =
    "You are a precise, formal digital butler assistant. Summarize information concisely and factually. Prioritize urgent items. Address the user directly. Do not editorialize.";

function loadSystemPrompt(): string {
    const characterPath = path.resolve(__dirname, "../../characters/butler.json");
    try {
        const raw = fs.readFileSync(characterPath, "utf-8");
        const parsed = JSON.parse(raw) as { systemPrompt?: string };
        return parsed.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    } catch {
        return DEFAULT_SYSTEM_PROMPT;
    }
}

export function createAIProvider(): IAIProvider {
    const mode = process.env["AI_PROVIDER"] ?? "none";

    switch (mode) {
        case "openai": {
            const key = process.env["OPENAI_API_KEY"];
            if (!key) throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY");
            const model = process.env["AI_MODEL"] ?? "gpt-4o-mini";
            return new OpenAIProvider(key, model, loadSystemPrompt());
        }
        case "ollama": {
            const url = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
            const model = process.env["AI_MODEL"] ?? "llama3.2";
            return new OllamaProvider(url, model, loadSystemPrompt());
        }
        case "natsume": {
            const url = process.env["NATSUME_CORE_URL"];
            const secret = process.env["NATSUME_CORE_SECRET"];
            if (!url || !secret)
                throw new Error(
                    "AI_PROVIDER=natsume requires NATSUME_CORE_URL and NATSUME_CORE_SECRET",
                );
            return new NatsumeProvider(url, secret);
        }
        default:
            return new NullAIProvider();
    }
}
