import type { ConnectorAction } from "../types/connector_action.js";

export type EventSyncEffect = "read" | "unread" | "remove";

/**
 * Maps a successfully-executed ConnectorAction back to the AcediaEvent it should keep in
 * sync — the notification and the real object it describes (email/task/calendar event) used
 * to drift apart the moment an action executed: connector.executeAction() touched Gmail/GCal/
 * Tasks for real, but EventStore (what /api/events actually serves) never heard about it, so
 * a "deleted" email's notification kept showing up as if nothing had happened.
 *
 * GitHub is deliberately absent: its notification dedupeKey is built from a GitHub
 * notification thread id or CI run id (github_formatter.ts), not the "{owner}/{repo}#{number}"
 * sourceId its actions use — there is no derivable mapping between the two id spaces today.
 * "reply"/"create_*" actions don't address an existing event, so they have nothing to sync.
 */
export function resolveEventSync(
    action: ConnectorAction,
): { dedupeKey: string; effect: EventSyncEffect } | null {
    switch (action.kind) {
        case "mark_email_read":
            return { dedupeKey: `email-${action.sourceId}`, effect: "read" };
        case "mark_email_unread":
            return { dedupeKey: `email-${action.sourceId}`, effect: "unread" };
        case "archive_email":
            return { dedupeKey: `email-${action.sourceId}`, effect: "read" };
        case "delete_email":
            return { dedupeKey: `email-${action.sourceId}`, effect: "remove" };

        case "complete_task":
            return { dedupeKey: `task-${taskIdFrom(action.sourceId)}`, effect: "read" };
        case "delete_task":
            return { dedupeKey: `task-${taskIdFrom(action.sourceId)}`, effect: "remove" };

        case "update_event":
            return { dedupeKey: `cal-${eventIdFrom(action.sourceId)}`, effect: "read" };
        case "delete_event":
            return { dedupeKey: `cal-${eventIdFrom(action.sourceId)}`, effect: "remove" };

        default:
            return null;
    }
}

/** tasks_connector.ts accepts sourceId as "{listId}/{taskId}" or a bare "{taskId}" (falls back
 *  to the configured list) — mirrors its own parsing so the derived dedupeKey always matches
 *  what poll() actually stored (`task-${task.id}`, task.id never includes the listId). */
function taskIdFrom(sourceId: string): string {
    const slash = sourceId.indexOf("/");
    return slash === -1 ? sourceId : sourceId.slice(slash + 1);
}

/** gcal_connector.ts requires sourceId as "{calendarId}/{eventId}" for update/delete — the
 *  dedupeKey only ever encodes the bare event id (`cal-${ev.id}`), never the calendar id. */
function eventIdFrom(sourceId: string): string {
    const slash = sourceId.indexOf("/");
    return slash === -1 ? sourceId : sourceId.slice(slash + 1);
}
