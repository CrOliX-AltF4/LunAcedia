import type { IAIProvider } from "./ai_provider.js";
import { formatDigestPrompt } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";

interface OllamaResponse {
    message: { content: string };
}

export class OllamaProvider implements IAIProvider {
    readonly mode = "ollama";

    constructor(
        private readonly baseUrl: string,
        private readonly model: string,
        private readonly systemPrompt: string,
    ) {}

    async chat(query: string): Promise<string> {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: [
                    { role: "system", content: this.systemPrompt },
                    { role: "user", content: query },
                ],
            }),
        });
        if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as OllamaResponse;
        return data.message.content ?? "";
    }

    async digest(events: AcediaEvent[]): Promise<string> {
        return this.chat(formatDigestPrompt(events));
    }
}
