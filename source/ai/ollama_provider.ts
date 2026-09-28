import type { IAIProvider } from "./ai_provider.js";
import { formatDigestPrompt } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { AgentMessage, AgentTurn, ToolCallOptions } from "./agent_types.js";
import type { ToolDefinition } from "../capabilities/capability_manifest.js";

interface OllamaToolCall {
    function: { name: string; arguments: Record<string, unknown> };
}
interface OllamaResponse {
    message: { content: string; tool_calls?: OllamaToolCall[] };
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

    /** Needs a model with tool support (llama3.1+, qwen2.5...); Ollama answers an error otherwise. */
    async chatWithTools(
        messages: AgentMessage[],
        tools: ToolDefinition[],
        options: ToolCallOptions = {},
    ): Promise<AgentTurn> {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: messages.map(toOllamaMessage),
                tools: tools.map((t) => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                    },
                })),
            }),
            ...(options.signal && { signal: options.signal }),
        });
        if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as OllamaResponse;
        const calls = data.message.tool_calls ?? [];
        return {
            content: data.message.content ? data.message.content : null,
            // Ollama gives tool calls no id: a positional one is enough to pair each result.
            toolCalls: calls.map((c, i) => ({
                id: `call_${i}`,
                name: c.function.name,
                rawArguments: JSON.stringify(c.function.arguments ?? {}),
            })),
        };
    }
}

function parseArguments(raw: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(raw);
        return typeof v === "object" && v !== null && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function toOllamaMessage(m: AgentMessage): Record<string, unknown> {
    switch (m.role) {
        case "system":
        case "user":
            return { role: m.role, content: m.content };
        case "assistant":
            return {
                role: "assistant",
                content: m.content ?? "",
                ...(m.toolCalls?.length && {
                    tool_calls: m.toolCalls.map((c) => ({
                        function: { name: c.name, arguments: parseArguments(c.rawArguments) },
                    })),
                }),
            };
        case "tool":
            return { role: "tool", content: m.content };
    }
}
