import type { IAIProvider } from "./ai_provider.js";
import { formatDigestPrompt } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";

interface OpenAIChoice {
    message: { content: string | null };
}
interface OpenAIResponse {
    choices: OpenAIChoice[];
}

export class OpenAIProvider implements IAIProvider {
    readonly mode = "openai";

    constructor(
        private readonly apiKey: string,
        private readonly model: string,
        private readonly systemPrompt: string,
    ) {}

    async chat(query: string): Promise<string> {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: "system", content: this.systemPrompt },
                    { role: "user", content: query },
                ],
                max_tokens: 500,
            }),
        });
        if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as OpenAIResponse;
        return data.choices[0]?.message.content ?? "";
    }

    async digest(events: AcediaEvent[]): Promise<string> {
        return this.chat(formatDigestPrompt(events));
    }
}
