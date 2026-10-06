import type { PendingAction } from "../actions/pending_action_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import { actionCapabilities } from "../capabilities/capability_manifest.js";
import { describeMatch } from "../actions/mail_selection.js";

/** What each action would do, in Master's words — declared once, in the capability manifest. */
const LABELS: Record<string, string> = Object.fromEntries(actionCapabilities().map((a) => [a.kind, a.label]));

const MAX = 130;

/** « Répondre à un mail — C'est noté pour jeudi. » — the label, then what it would write or touch. */
export function summarizeAction(action: ConnectorAction): string {
    if (action.kind === "create_rule") {
        const label = action.action === "label_email" && action.label ? ` « ${action.label} »` : "";
        return `Créer une règle « ${action.name} » : ${LABELS[action.action] ?? action.action}${label} à chaque collecte — ${describeMatch(action.match ?? {})}`;
    }
    if (action.kind === "bulk_email") {
        const n = action.sourceIds?.length ?? 0;
        const of = action.matched !== undefined && action.matched > n ? ` (sur ${action.matched})` : "";
        const label = action.action === "label_email" && action.label ? ` « ${action.label} »` : "";
        return `${LABELS[action.action] ?? action.action}${label} × ${n}${of} — ${describeMatch(action.match ?? {})}`;
    }
    const a = action as Record<string, unknown>;
    const fields = (a["fields"] ?? {}) as Record<string, unknown>;
    const detail = [a["body"], a["label"], fields["summary"], fields["title"], a["sourceId"]].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    const text = `${LABELS[action.kind] ?? action.kind}${detail ? ` — ${detail.trim()}` : ""}`;
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * The phone's notification for a write waiting for Master: it opens "À valider". Urgent so the
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
