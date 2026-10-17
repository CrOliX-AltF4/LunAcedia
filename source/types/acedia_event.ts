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
    /**
     * A reminder about an event or a task of the planning (lot AT4) — in the box, with the gestures of its object.
     * meta { reminder: true, rule, objectKind, objectId, at, and the object's ids (calendarId/eventId or listId/taskId) }.
     */
    | "planning.reminder"
    /**
     * Two events of the planning that overlap — in the box until the overlap is gone. meta { conflict: true,
     * eventIds, moving (the event a solution moves), solutions: [{ eventId, start, end }] } — chosen by Master, never alone.
     */
    | "planning.conflict"
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
    | "inbox.changed"
    /** What changed — meta { scope: box | actions | topics, key? } — for the Core to relay to its views; never news. */
    | "system.change";

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
    /** Why it has its priority, in words (« Gmail : important », « VIP », « règle « … » », « CI rouge sur main ») — what a
     *  client shows. Absent: the source's plain default. */
    priorityReason?: string;
    /** On the wire only, never stored: whether this new item rings the phone (LunAcedia's rule, notify_policy.ts) —
     *  a hub relays it as it is, it never decides. */
    notify?: boolean;
    /** On the wire only, never stored: false when no model may read this item (its class of mail) — a hub keeps it out
     *  of its own model's reach (briefing, voice) as LunAcedia does. Absent: readable. */
    ai?: boolean;
}
