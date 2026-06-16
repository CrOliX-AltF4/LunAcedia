import type { AcediaEvent } from "../types/acedia_event.js";

export interface IAIProvider {
    readonly mode: string;
    chat(query: string): Promise<string>;
    digest(events: AcediaEvent[]): Promise<string>;
}

export function formatDigestPrompt(events: AcediaEvent[]): string {
    if (events.length === 0) return "No pending events.";
    const lines = events.map((e, i) => {
        const prio = e.priority === "urgent" ? " [URGENT]" : "";
        const body = e.body ? ` — ${e.body}` : "";
        return `${i + 1}. [${e.source.toUpperCase()}]${prio} ${e.title}${body}`;
    });
    return `Summarize these ${events.length} events concisely, prioritizing urgent ones:\n\n${lines.join("\n")}`;
}
