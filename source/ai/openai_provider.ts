import type { IAIProvider } from "./ai_provider.js";
import { formatDigestPrompt } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { AgentMessage, AgentTurn, ToolCallOptions } from "./agent_types.js";
import type { ToolDefinition } from "../capabilities/capability_manifest.js";

interface OpenAIToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}
interface OpenAIChoice {
    message: { content: string | null; tool_calls?: OpenAIToolCall[] };
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

    async chatWithTools(
        messages: AgentMessage[],
        tools: ToolDefinition[],
        options: ToolCallOptions = {},
    ): Promise<AgentTurn> {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.model,
                messages: messages.map(toOpenAIMessage),
                tools: tools.map((t) => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                    },
                })),
                tool_choice: "auto",
                max_tokens: options.maxTokens ?? 800,
            }),
            ...(options.signal && { signal: options.signal }),
        });
        if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as OpenAIResponse;
        const message = data.choices[0]?.message;
        return {
            content: message?.content ?? null,
            toolCalls: (message?.tool_calls ?? []).map((c) => ({
                id: c.id,
                name: c.function.name,
                rawArguments: c.function.arguments,
            })),
        };
    }
}

function toOpenAIMessage(m: AgentMessage): Record<string, unknown> {
    switch (m.role) {
        case "system":
        case "user":
            return { role: m.role, content: m.content };
        case "assistant":
            return {
                role: "assistant",
                content: m.content,
                ...(m.toolCalls?.length && {
                    tool_calls: m.toolCalls.map((c) => ({
                        id: c.id,
                        type: "function",
                        function: { name: c.name, arguments: c.rawArguments },
                    })),
                }),
            };
        case "tool":
            return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
}
