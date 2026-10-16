import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { EventStore } from "./event_store.js";

/** Where dedup lived before it became part of the box. */
export function legacyDedupPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "dedup_seen.json");
}

/**
 * Once, at the first start with the one-file box: every key the old dedup file had seen and the box does not hold is
 * remembered as gone (it left — expired, taken out by a rule, evicted — and must not come back as news). The old file
 * is renamed `.migrated` and a copy of the box as it was is kept, so nothing is lost if this goes wrong. Call after
 * the box is loaded. Returns how many keys were adopted, or null when there was nothing to migrate.
 */
export async function adoptLegacyDedup(
    store: Pick<EventStore, "has" | "markGone">,
    dedupPath: string,
    boxPath?: string,
): Promise<number | null> {
    let seen: Record<string, number>;
    try {
        seen = JSON.parse(await fs.readFile(dedupPath, "utf-8")) as Record<string, number>;
    } catch {
        return null;
    }
    if (boxPath) await fs.copyFile(boxPath, `${boxPath}.before-migration`).catch(() => {});
    let adopted = 0;
    for (const [key, at] of Object.entries(seen)) {
        if (store.has(key) || typeof at !== "number") continue;
        store.markGone(key, at);
        adopted++;
    }
    await fs.rename(dedupPath, `${dedupPath}.migrated`);
    return adopted;
}
