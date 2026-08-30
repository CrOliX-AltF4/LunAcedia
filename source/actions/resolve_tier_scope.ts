import type { ConnectorAction } from "../types/connector_action.js";
import type { EventStore } from "../store/event_store.js";

/**
 * Backlog #329 P1 "paliers d'autonomie par type d'action ET par expéditeur/repo" — the scope
 * value an override is keyed on: a sender email for Gmail kinds, "{owner}/{repo}" for the
 * GitHub kinds whose sourceId already carries it. Returns null when no scope is derivable —
 * the caller then falls back to the plain kind-level tier, same as before this existed.
 *
 * GitHub kinds encode "{owner}/{repo}#{number}" directly in sourceId, no lookup needed. Email
 * kinds only ever carry a bare messageId — the sender lives in the buffered AcediaEvent's
 * meta.from (gmail_connector.ts sets it at poll time), so this looks it up via EventStore. A
 * cold EventStore (buffer evicted, or the action came in before this connector's most recent
 * poll) means no sender is known — same "fall back to the kind default" behavior, not an error.
 */
export function resolveTierScope(action: ConnectorAction, store: EventStore): string | null {
    switch (action.kind) {
        case "comment_issue":
        case "add_label":
        case "close_issue":
        case "merge_pr": {
            const hash = action.sourceId.lastIndexOf("#");
            return hash === -1 ? null : action.sourceId.slice(0, hash);
        }

        case "reply":
        case "archive_email":
        case "delete_email":
        case "mark_email_read":
        case "mark_email_unread": {
            const event = store.get(`email-${action.sourceId}`);
            const from = event?.meta?.["from"];
            return typeof from === "string" ? from : null;
        }

        default:
            return null;
    }
}
