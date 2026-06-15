/** Canonical event types produced by LunAcedia connectors. */
export type AcediaEventType =
    | "github.push"
    | "github.pr.opened"
    | "github.pr.merged"
    | "github.issue.opened"
    | "github.ci.failed"
    | "github.review.requested"
    | "github.mention"
    | "calendar.upcoming"
    | "email.received"
    | "rss.item"
    | "ha.state_changed"
    | "system.heartbeat";

export type AcediaEventSource = "github" | "calendar" | "email" | "rss" | "ha" | "system";

export type AcediaEventPriority = "urgent" | "normal" | "info";

/**
 * Wire format pushed by LunAcedia → connected clients (Natsume, mobile app, etc.).
 *
 * Design rule: AcediaEvent carries facts only — no interpretation, no LLM synthesis.
 * The consumer (Natsume) decides what an event means for the user.
 */
export interface AcediaEvent {
    type:      AcediaEventType;
    ts:        number;
    source:    AcediaEventSource;
    title:     string;
    body?:     string;
    url?:      string;
    priority:  AcediaEventPriority;
    dedupeKey: string;
    meta?:     Record<string, unknown>;
}
