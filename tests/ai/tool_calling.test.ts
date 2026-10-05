import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "../../source/ai/openai_provider";
import { OllamaProvider } from "../../source/ai/ollama_provider";
import { NullAIProvider } from "../../source/ai/null_provider";
import type { AgentMessage } from "../../source/ai/agent_types";
import type { ToolDefinition } from "../../source/capabilities/capability_manifest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TOOLS: ToolDefinition[] = [
    {
        name: "search_events",
        description: "Search events.",
        parameters: { type: "object", properties: { unread: { type: "boolean" } } },
    },
];

const HISTORY: AgentMessage[] = [
    { role: "system", content: "You are the agent." },
    { role: "user", content: "Mes mails urgents ?" },
    {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "search_events", rawArguments: '{"unread":true}' }],
    },
    {
        role: "tool",
        toolCallId: "call_1",
        name: "search_events",
        content: '{"total":0,"events":[]}',
    },
];

function lastBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!;
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

describe("OpenAIProvider.chatWithTools", () => {
    const provider = new OpenAIProvider("sk-test", "gpt-4o-mini", "butler");
    beforeEach(() => mockFetch.mockReset());

    it("offers the tools in OpenAI's function format and lets the model choose", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        });
        await provider.chatWithTools(HISTORY, TOOLS);
        const body = lastBody();
        expect(body["model"]).toBe("gpt-4o-mini");
        expect(body["tool_choice"]).toBe("auto");
        expect(body["tools"]).toEqual([
            {
                type: "function",
                function: {
                    name: "search_events",
                    description: "Search events.",
                    parameters: TOOLS[0]!.parameters,
                },
            },
        ]);
    });

    it("sends the conversation as given, tool calls and tool results in OpenAI's shape", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        });
        await provider.chatWithTools(HISTORY, TOOLS);
        expect(lastBody()["messages"]).toEqual([
            { role: "system", content: "You are the agent." },
            { role: "user", content: "Mes mails urgents ?" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: { name: "search_events", arguments: '{"unread":true}' },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_1", content: '{"total":0,"events":[]}' },
        ]);
    });

    it("returns the model's tool calls", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: null,
                            tool_calls: [
                                {
                                    id: "call_9",
                                    type: "function",
                                    function: { name: "get_event", arguments: '{"key":"email-1"}' },
                                },
                            ],
                        },
                    },
                ],
            }),
        });
        const turn = await provider.chatWithTools(HISTORY, TOOLS);
        expect(turn).toEqual({
            content: null,
            toolCalls: [{ id: "call_9", name: "get_event", rawArguments: '{"key":"email-1"}' }],
        });
    });

    it("returns plain text when the model answers without tools", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "Rien d'urgent." } }] }),
        });
        expect(await provider.chatWithTools(HISTORY, TOOLS)).toEqual({
            content: "Rien d'urgent.",
            toolCalls: [],
        });
    });

    it("passes the abort signal so the loop's time budget can stop a slow call", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "x" } }] }),
        });
        const controller = new AbortController();
        await provider.chatWithTools(HISTORY, TOOLS, { signal: controller.signal });
        expect((mockFetch.mock.calls[0]![1] as { signal: AbortSignal }).signal).toBe(
            controller.signal,
        );
    });

    it("throws on an HTTP error instead of inventing an answer", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
        });
        await expect(provider.chatWithTools(HISTORY, TOOLS)).rejects.toThrow("429");
    });
});

describe("OllamaProvider.chatWithTools", () => {
    const provider = new OllamaProvider("http://ollama:11434", "llama3.2", "butler");
    beforeEach(() => mockFetch.mockReset());

    it("sends tools and history in Ollama's shape (arguments as objects, no ids)", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ message: { content: "ok" } }),
        });
        await provider.chatWithTools(HISTORY, TOOLS);
        const body = lastBody();
        expect(body["stream"]).toBe(false);
        expect(body["tools"]).toEqual([
            {
                type: "function",
                function: {
                    name: "search_events",
                    description: "Search events.",
                    parameters: TOOLS[0]!.parameters,
                },
            },
        ]);
        expect((body["messages"] as unknown[])[2]).toEqual({
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "search_events", arguments: { unread: true } } }],
        });
        expect((body["messages"] as unknown[])[3]).toEqual({
            role: "tool",
            content: '{"total":0,"events":[]}',
        });
    });

    it("gives Ollama's id-less tool calls stable ids and serializes their arguments", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                message: {
                    content: "",
                    tool_calls: [
                        { function: { name: "get_event", arguments: { key: "email-1" } } },
                    ],
                },
            }),
        });
        const turn = await provider.chatWithTools(HISTORY, TOOLS);
        expect(turn).toEqual({
            content: null,
            toolCalls: [{ id: "call_0", name: "get_event", rawArguments: '{"key":"email-1"}' }],
        });
    });
});

describe("NullAIProvider", () => {
    it("has no tool calling — the agent reports that honestly instead of faking it", () => {
        expect((new NullAIProvider() as { chatWithTools?: unknown }).chatWithTools).toBeUndefined();
    });
});
