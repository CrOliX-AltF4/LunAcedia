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
 *
 * freeSlots (optional) — deterministically computed by free_slots.ts, not the AI — lets a
 * calendar.conflict proposal name an actual open slot to move to ("Reschedule to 15:00–
 * 15:30") instead of a vague "find another time". Only meaningful when a conflict is present.
 */
export function formatProposalsPrompt(
    events: AcediaEvent[],
    freeSlots: { start: number; end: number }[] = [],
): string {
    if (events.length === 0) return "No urgent or conflicting items — nothing to propose.";
    const lines = events.map((e, i) => {
        const prio = e.priority === "urgent" ? " [URGENT]" : "";
        const kind = e.type === "calendar.conflict" ? " [CONFLICT]" : "";
        const body = e.body ? ` — ${e.body}` : "";
        return `${i + 1}. [${e.source.toUpperCase()}]${prio}${kind} ${e.title}${body}`;
    });

    const hasConflict = events.some((e) => e.type === "calendar.conflict");
    const slotsBlock =
        hasConflict && freeSlots.length > 0
            ? "\n\nOpen calendar slots available for rescheduling (use these exact times, do not invent others):\n" +
              freeSlots
                  .slice(0, 5)
                  .map(
                      (s) =>
                          `- ${new Date(s.start).toLocaleString()} → ${new Date(s.end).toLocaleString()}`,
                  )
                  .join("\n")
            : "";

    return (
        "For each item below, propose one concrete next action in a single short imperative " +
        'sentence (e.g. "Decline the client call", "Reply confirming attendance", "No ' +
        'action needed"). Prioritize CONFLICT and URGENT items. For a CONFLICT item, if an ' +
        "open slot is listed below, name it explicitly as the reschedule target. Do not " +
        "invent facts not present below.\n\n" +
        lines.join("\n") +
        slotsBlock
    );
}
