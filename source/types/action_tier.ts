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
};
