import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ActionKind, ActionTier, ActionTierConfig } from "../types/action_tier.js";
import { DEFAULT_ACTION_TIERS, IMMUTABLE_TIERS } from "../types/action_tier.js";

const VALID_TIERS = new Set<ActionTier>(["auto", "confirm", "manual"]);
// Derived from DEFAULT_ACTION_TIERS rather than hand-listed — a kind added to the catalog
// (connector_action.ts) without a default here would already fail typechecking, but this
// keeps the *set of configurable kinds* from ever silently drifting from it too.
const VALID_KINDS = new Set<ActionKind>(Object.keys(DEFAULT_ACTION_TIERS) as ActionKind[]);

function resolveTierPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "action_tiers.json");
}

function resolveOverridesPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "action_tier_overrides.json");
}

/** "{kind}:{scope}" — scope is a sender email (email kinds) or "{owner}/{repo}" (GitHub kinds). */
export type TierOverrides = Record<string, ActionTier>;

function overrideKey(kind: ActionKind, scope: string): string {
    return `${kind}:${scope}`;
}

/**
 * Persists the autonomy tier for each action kind — same STORAGE_DIR convention as
 * FcmSender's device token. Defaults to DEFAULT_ACTION_TIERS (everything "confirm", merge_pr
 * "manual") when nothing is stored yet, so a fresh install never starts in "auto" for
 * anything. IMMUTABLE_TIERS entries (currently just merge_pr) are enforced both on read
 * (getTier/getAll always report the immutable value, regardless of what's on disk — even a
 * hand-edited file can't override it) and on write (patch() silently drops any attempt to
 * change one) — "merger reste toujours humain" is a guarantee, not a default.
 */
export class ActionTierStore {
    private tiers: ActionTierConfig = { ...DEFAULT_ACTION_TIERS };
    private overrides: TierOverrides = {};
    private readonly tierPath: string;
    private readonly overridesPath: string;

    constructor(tierPath?: string, overridesPath?: string) {
        this.tierPath = tierPath ?? resolveTierPath();
        this.overridesPath = overridesPath ?? resolveOverridesPath();
    }

    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.tierPath, "utf-8");
            const parsed = JSON.parse(raw) as Partial<ActionTierConfig>;
            for (const kind of Object.keys(this.tiers) as ActionKind[]) {
                if (kind in IMMUTABLE_TIERS) continue;
                const value = parsed[kind];
                if (value && VALID_TIERS.has(value)) this.tiers[kind] = value;
            }
        } catch {
            // File absent or unreadable — keep defaults, that's fine
        }

        try {
            const raw = await fs.readFile(this.overridesPath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, string>;
            const clean: TierOverrides = {};
            for (const [key, tier] of Object.entries(parsed)) {
                const kind = key.slice(0, key.indexOf(":")) as ActionKind;
                if (
                    VALID_KINDS.has(kind) &&
                    !(kind in IMMUTABLE_TIERS) &&
                    VALID_TIERS.has(tier as ActionTier)
                ) {
                    clean[key] = tier as ActionTier;
                }
            }
            this.overrides = clean;
        } catch {
            // File absent or unreadable — no overrides yet, that's fine
        }
    }

    getAll(): ActionTierConfig {
        return { ...this.tiers, ...IMMUTABLE_TIERS };
    }

    getOverrides(): TierOverrides {
        return { ...this.overrides };
    }

    /**
     * Backlog #329 P1 "paliers d'autonomie par type d'action ET par expéditeur/repo" — scope
     * is a sender email (email kinds) or "{owner}/{repo}" (GitHub kinds), resolved by the
     * caller (see resolve_tier_scope.ts) since ActionTierStore has no access to EventStore.
     * IMMUTABLE_TIERS always wins regardless of scope — merge_pr stays manual no matter what
     * override might exist for a specific repo.
     */
    getTier(kind: ActionKind, scope?: string): ActionTier {
        if (kind in IMMUTABLE_TIERS) return IMMUTABLE_TIERS[kind]!;
        if (scope) {
            const override = this.overrides[overrideKey(kind, scope)];
            if (override) return override;
        }
        return this.tiers[kind];
    }

    /** Applies only valid, mutable (kind, tier) pairs from the patch; returns the keys actually changed. */
    async patch(updates: Record<string, string>): Promise<ActionKind[]> {
        const changed: ActionKind[] = [];
        for (const [kind, tier] of Object.entries(updates)) {
            if (!VALID_KINDS.has(kind as ActionKind)) continue;
            if (kind in IMMUTABLE_TIERS) continue;
            if (!VALID_TIERS.has(tier as ActionTier)) continue;
            this.tiers[kind as ActionKind] = tier as ActionTier;
            changed.push(kind as ActionKind);
        }
        if (changed.length > 0) await this.save();
        return changed;
    }

    /**
     * Sets or clears a per-scope override. `tier: null` removes the override (falls back to
     * the kind-level tier). Silently no-ops for an unknown kind, an immutable kind, or an
     * invalid tier value — mirrors patch()'s own validation posture.
     */
    async patchOverride(kind: string, scope: string, tier: string | null): Promise<boolean> {
        if (!VALID_KINDS.has(kind as ActionKind) || kind in IMMUTABLE_TIERS || !scope) return false;
        const key = overrideKey(kind as ActionKind, scope);
        if (tier === null) {
            if (!(key in this.overrides)) return false;
            delete this.overrides[key];
        } else {
            if (!VALID_TIERS.has(tier as ActionTier)) return false;
            this.overrides[key] = tier as ActionTier;
        }
        await this.saveOverrides();
        return true;
    }

    private async save(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.tierPath), { recursive: true });
            await fs.writeFile(this.tierPath, JSON.stringify(this.tiers, null, 2), "utf-8");
        } catch (e) {
            console.error("[ActionTiers] Failed to persist:", (e as Error).message);
        }
    }

    private async saveOverrides(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.overridesPath), { recursive: true });
            await fs.writeFile(
                this.overridesPath,
                JSON.stringify(this.overrides, null, 2),
                "utf-8",
            );
        } catch (e) {
            console.error("[ActionTiers] Failed to persist overrides:", (e as Error).message);
        }
    }
}
