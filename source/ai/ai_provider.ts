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

/**
 * Prompt for GET /api/proposals — asks the butler for concrete next actions on the current
 * urgent/conflict items, not just a summary. Butler-layer only (optional, requires
 * AI_PROVIDER) — the events themselves were already classified deterministically by the
 * connector layer (calendar.conflict, priority) before ever reaching this prompt.
 */
export function formatProposalsPrompt(events: AcediaEvent[]): string {
    if (events.length === 0) return "No urgent or conflicting items — nothing to propose.";
    const lines = events.map((e, i) => {
        const prio = e.priority === "urgent" ? " [URGENT]" : "";
        const kind = e.type === "calendar.conflict" ? " [CONFLICT]" : "";
        const body = e.body ? ` — ${e.body}` : "";
        return `${i + 1}. [${e.source.toUpperCase()}]${prio}${kind} ${e.title}${body}`;
    });
    return (
        "For each item below, propose one concrete next action in a single short imperative " +
        "sentence (e.g. \"Decline the client call\", \"Reply confirming attendance\", \"No " +
        "action needed\"). Prioritize CONFLICT and URGENT items. Do not invent facts not " +
        "present below.\n\n" +
        lines.join("\n")
    );
}
