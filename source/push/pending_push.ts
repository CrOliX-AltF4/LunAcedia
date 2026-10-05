import type { PendingAction } from "../actions/pending_action_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";

/** What each write would do, in Master's words — the same wording as the dashboard's tier labels. */
const LABELS: Record<string, string> = {
    reply: "Répondre à un mail",
    archive_email: "Archiver un mail",
    delete_email: "Mettre un mail à la corbeille",
    mark_email_read: "Marquer un mail lu",
    mark_email_unread: "Marquer un mail non lu",
    create_event: "Créer un événement",
    update_event: "Modifier un événement",
    delete_event: "Supprimer un événement",
    create_task: "Créer une tâche",
    complete_task: "Terminer une tâche",
    delete_task: "Supprimer une tâche",
    comment_issue: "Commenter sur GitHub",
    add_label: "Ajouter un label GitHub",
    create_issue: "Créer un ticket GitHub",
    close_issue: "Fermer un ticket GitHub",
    open_pr: "Ouvrir une PR GitHub",
    mark_notification_read: "Marquer une notification GitHub lue",
};

const MAX = 130;

/** « Répondre à un mail — C'est noté pour jeudi. » — the label, then what it would write or touch. */
export function summarizeAction(action: ConnectorAction): string {
    const a = action as Record<string, unknown>;
    const fields = (a["fields"] ?? {}) as Record<string, unknown>;
    const detail = [a["body"], a["label"], fields["summary"], fields["title"], a["sourceId"]].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    const text = `${LABELS[action.kind] ?? action.kind}${detail ? ` — ${detail.trim()}` : ""}`;
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * The phone's notification for a write waiting for Master (ADR-020 §5.11 M5b): it opens "À valider". Urgent so the
 * priority filter lets it through — Master asked for it, or the agent proposed it on his behalf. Pushed only, never
 * put in the box.
 */
export function pendingActionEvent(p: PendingAction): AcediaEvent {
    return {
        type: "system.action_pending",
        ts: p.createdAt,
        source: "system",
        title: "Action à valider",
        body: summarizeAction(p.action),
        priority: "urgent",
        dedupeKey: `action-${p.id}`,
    };
}
