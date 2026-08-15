import type { ConnectorAction } from "./connector_action.js";

export type ActionKind = ConnectorAction["kind"];

/**
 * auto    — executes immediately, no confirmation.
 * confirm — queued as pending; a second call (POST /api/actions/:id/confirm) executes it.
 * manual  — never executable through this endpoint; the AI may only surface it as a suggestion.
 */
export type ActionTier = "auto" | "confirm" | "manual";

export type ActionTierConfig = Record<ActionKind, ActionTier>;

/** Fail-safe: every action kind starts at "confirm" until explicitly relaxed. */
export const DEFAULT_ACTION_TIERS: ActionTierConfig = {
    reply: "confirm",
    complete: "confirm",
    update: "confirm",
};
