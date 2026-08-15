/**
 * Discriminated union of write operations connectors can execute.
 *
 * Kind names are globally unique across connectors (not just per-connector) because
 * ActionTierStore keys autonomy tiers by kind alone — "delete_email" and "delete_event"
 * must never collide the way a bare "delete" would.
 */
export type ConnectorAction =
    // Gmail
    | { kind: "reply"; sourceId: string; body: string }
    | { kind: "archive_email"; sourceId: string }
    | { kind: "delete_email"; sourceId: string }
    | { kind: "mark_email_read"; sourceId: string }
    | { kind: "mark_email_unread"; sourceId: string }
    // Google Calendar
    | { kind: "create_event"; fields: { summary: string; start: string; end: string; description?: string; location?: string; calendarId?: string } }
    | { kind: "update_event"; sourceId: string; fields: Record<string, string> }
    | { kind: "delete_event"; sourceId: string }
    // Google Tasks
    | { kind: "create_task"; fields: { title: string; due?: string; notes?: string; listId?: string } }
    | { kind: "complete_task"; sourceId: string }
    | { kind: "delete_task"; sourceId: string }
    // GitHub — sourceId is always "{owner}/{repo}#{number}" for existing issues/PRs
    | { kind: "comment_issue"; sourceId: string; body: string }
    | { kind: "add_label"; sourceId: string; label: string }
    | { kind: "create_issue"; fields: { repo: string; title: string; body?: string } }
    | { kind: "close_issue"; sourceId: string }
    | { kind: "open_pr"; fields: { repo: string; title: string; head: string; base: string; body?: string } }
    // merge_pr's tier is hardcoded to "manual" in ActionTierStore and cannot be relaxed —
    // "ouvrir une PR peut être auto ou confirmation, mais merger reste toujours humain."
    | { kind: "merge_pr"; sourceId: string };
