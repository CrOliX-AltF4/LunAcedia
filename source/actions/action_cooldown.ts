import type { ActionKind } from "../types/action_tier.js";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_PER_WINDOW = 5;

/**
 * Backlog #327 P1 "cooldown/rate-limit par type d'action" — until now the only thing standing
 * between an action kind and unlimited executions was the confirmation timeout (a UX delay,
 * not a real throttle) and, for "auto" tier, nothing at all. This is a safety net against a
 * runaway loop (a misbehaving LLM/automation repeatedly triggering the same action kind), not
 * a per-user or per-target business rate limit — it only tracks *how often this kind fired*,
 * not who asked or what it targeted.
 *
 * In-memory only, deliberately — same reasoning as PendingActionStore: a cooldown that
 * doesn't survive a restart is a rare edge case (a runaway loop right across a restart), a
 * cooldown silently stuck forever on stale state would be a worse failure mode.
 */
export class ActionCooldownTracker {
    private readonly hits = new Map<ActionKind, number[]>();
    private readonly windowMs: number;
    private readonly maxPerWindow: number;

    constructor(
        windowMs = Math.max(
            1,
            parseInt(process.env["ACTION_COOLDOWN_WINDOW_MIN"] ?? "5", 10) || 5,
        ) * 60_000,
        maxPerWindow = Math.max(
            1,
            parseInt(process.env["ACTION_COOLDOWN_MAX"] ?? String(DEFAULT_MAX_PER_WINDOW), 10) ||
                DEFAULT_MAX_PER_WINDOW,
        ),
    ) {
        this.windowMs = windowMs || DEFAULT_WINDOW_MS;
        this.maxPerWindow = maxPerWindow;
    }

    /**
     * Records an execution attempt and reports whether it's allowed. Only successful calls
     * (returning true) count toward the window — a refused attempt doesn't consume a slot
     * twice. Call this once per real execution attempt, right before connector.executeAction().
     */
    tryConsume(kind: ActionKind): boolean {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        const recent = (this.hits.get(kind) ?? []).filter((ts) => ts > cutoff);

        if (recent.length >= this.maxPerWindow) {
            this.hits.set(kind, recent);
            return false;
        }

        recent.push(now);
        this.hits.set(kind, recent);
        return true;
    }
}
