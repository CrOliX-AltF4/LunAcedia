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
    private readonly tierPath: string;

    constructor(tierPath?: string) {
        this.tierPath = tierPath ?? resolveTierPath();
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
    }

    getAll(): ActionTierConfig {
        return { ...this.tiers, ...IMMUTABLE_TIERS };
    }

    getTier(kind: ActionKind): ActionTier {
        return IMMUTABLE_TIERS[kind] ?? this.tiers[kind];
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

    private async save(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.tierPath), { recursive: true });
            await fs.writeFile(this.tierPath, JSON.stringify(this.tiers, null, 2), "utf-8");
        } catch (e) {
            console.error("[ActionTiers] Failed to persist:", (e as Error).message);
        }
    }
}
