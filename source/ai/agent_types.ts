/**
 * Provider-neutral shapes of a tool-calling conversation. Each provider maps them to
 * its own wire format; the agent loop only ever sees these.
 */

/** Arguments stay a raw string: the loop parses and re-validates them, the provider never trusts them. */
export interface ToolCall {
    id: string;
    name: string;
    rawArguments: string;
}

export type AgentMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentTurn {
    content: string | null;
    toolCalls: ToolCall[];
}

export interface ToolCallOptions {
    signal?: AbortSignal;
    maxTokens?: number;
}
