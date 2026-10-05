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
    | "calendar.conflict"
    | "email.received"
    | "rss.item"
    | "ha.state_changed"
    | "tasks.due"
    | "system.heartbeat"
    /** A spend alert on LunAcedia's own LLM — pushed to the phone, never put in the box. */
    | "system.llm_spend"
    /** A write waiting for Master — pushed to the phone, opens « À valider », never put in the box. */
    | "system.action_pending"
    /**
     * Sync message: an item changed or died with its source object — meta { op, key }, op one of
     * removed | read | unread | updated — `updated` also carries meta.item { title, body, priority,
     * ts } — a refresh of what the client holds, never news.
     */
    | "inbox.changed";

export type AcediaEventSource = "github" | "calendar" | "email" | "rss" | "ha" | "tasks" | "system";

export type AcediaEventPriority = "urgent" | "normal" | "info";

/**
 * Wire format pushed by LunAcedia → connected clients (Natsume, mobile app, etc.).
 *
 * Design rule: AcediaEvent carries facts only — no interpretation, no LLM synthesis.
 * The consumer (Natsume) decides what an event means for the user.
 */
export interface AcediaEvent {
    type: AcediaEventType;
    ts: number;
    source: AcediaEventSource;
    title: string;
    body?: string;
    url?: string;
    priority: AcediaEventPriority;
    dedupeKey: string;
    meta?: Record<string, unknown>;
    read?: boolean;
    /** Labels set by the user's guard rules (decision C-014). Facts about the classification the
     *  user configured, not model output. Additive and optional: consumers that ignore it are unaffected. */
    tags?: string[];
    /** The guard rule that set `tags` / a priority on this event, so the user can trace it back. */
    ruleId?: string;
}
