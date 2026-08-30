import type { ConnectorAction } from "./connector_action.js";

export type ActionKind = ConnectorAction["kind"];

/**
 * auto    — autonomous: the AI executes with no human signal at all, at the moment it decides to.
 * confirm — needs a human signal before executing — either the user explicitly asked for it
 *           (a voice/chat command translates directly into a queued action) or the AI proposed
 *           it and is waiting on a "yes". Both paths land here: POST /api/actions queues a
 *           PendingAction either way, executed only via POST /api/actions/:id/confirm.
 * manual  — strictly the user's own hands — never executable through this API regardless of
 *           how explicitly it's requested. The AI may only suggest it as text (/api/proposals).
 */
export type ActionTier = "auto" | "confirm" | "manual";

export type ActionTierConfig = Record<ActionKind, ActionTier>;

/**
 * merge_pr can never be set to anything but "manual" — "ouvrir une PR peut être auto ou
 * confirmation, mais merger reste toujours humain" (CrOliX, chantier LunAcedia 2026-08-15).
 * ActionTierStore.patch() silently drops any attempt to change it.
 */
export const IMMUTABLE_TIERS: Partial<ActionTierConfig> = {
    merge_pr: "manual",
};

/**
 * Fail-safe defaults. Trivial/reversible/no-external-effect actions default to "confirm" too
 * (not "auto") on first install — "auto" is something CrOliX opts into per action kind via
 * PATCH /api/config/tiers or the dashboard, never assumed. merge_pr is fixed at "manual"
 * regardless (see IMMUTABLE_TIERS).
 */
export const DEFAULT_ACTION_TIERS: ActionTierConfig = {
    reply: "confirm",
    archive_email: "confirm",
    delete_email: "manual",
    mark_email_read: "confirm",
    mark_email_unread: "confirm",
    create_event: "confirm",
    update_event: "confirm",
    delete_event: "confirm",
    create_task: "confirm",
    complete_task: "confirm",
    delete_task: "confirm",
    comment_issue: "confirm",
    add_label: "confirm",
    create_issue: "confirm",
    close_issue: "confirm",
    open_pr: "confirm",
    merge_pr: "manual",
    mark_notification_read: "confirm",
};

/**
 * How bad it is if this action fires wrongly — orthogonal to ActionTier (who must approve).
 * A "confirm"-tier action can still be low-risk (archive_email — fully reversible), and a
 * "manual"-tier one is always high (merge_pr). Purely descriptive today: surfaced on the
 * Confiance panel screen so CrOliX can see risk at a glance, not read yet by dispatchAction()
 * or any gating logic — see backlog #327 P2 "ré-consentement sur franchissement de seuil de
 * risque" for where this would plug in if that's ever built.
 *
 *   low    — reversible, no data loss, nothing sent to anyone else (mark read/unread, archive,
 *            complete a task, mark a GitHub thread read).
 *   medium — creates or sends something new, but doesn't destroy anything (reply, comment,
 *            label, create_*, update_event, open_pr).
 *   high   — destructive or hard to reverse, or reaches other people irreversibly (delete_*,
 *            close_issue, merge_pr).
 */
export type ActionRisk = "low" | "medium" | "high";

export const ACTION_RISK: Record<ActionKind, ActionRisk> = {
    mark_email_read: "low",
    mark_email_unread: "low",
    archive_email: "low",
    complete_task: "low",
    mark_notification_read: "low",

    reply: "medium",
    comment_issue: "medium",
    add_label: "medium",
    create_event: "medium",
    create_task: "medium",
    create_issue: "medium",
    open_pr: "medium",
    update_event: "medium",

    delete_email: "high",
    delete_event: "high",
    delete_task: "high",
    close_issue: "high",
    merge_pr: "high",
};
