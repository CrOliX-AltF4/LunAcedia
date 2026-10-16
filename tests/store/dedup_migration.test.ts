import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EventStore } from "../../source/store/event_store.js";
import { adoptLegacyDedup } from "../../source/store/dedup_migration.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// Dedup used to live in a file of its own; at the first start with the one-file box, what it knew moves into the box.

function mail(id: string): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: id,
        priority: "normal",
        dedupeKey: `email-${id}`,
    };
}

describe("adoptLegacyDedup", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-migration-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("remembers as gone every seen key the box does not hold, then sets the old file aside with a copy of the box", async () => {
        const dedup = path.join(dir, "dedup_seen.json");
        const box = path.join(dir, "inbox_store.json");
        await fs.writeFile(dedup, JSON.stringify({ "email-held": 1, "rss-expired": 42 }), "utf-8");
        await fs.writeFile(box, JSON.stringify([mail("held")]), "utf-8");
        const store = new EventStore(1000, box);
        await store.load();

        expect(await adoptLegacyDedup(store, dedup, box)).toBe(1);
        expect(store.isGone("rss-expired")).toBe(true);
        expect(store.isGone("email-held")).toBe(false);
        expect(store.purgeGone(43)).toBe(1); // kept with the date dedup had for it
        await store.flush();
        expect((await fs.readdir(dir)).sort()).toEqual([
            "dedup_seen.json.migrated",
            "inbox_store.json",
            "inbox_store.json.before-migration",
        ]);
        // Once: nothing left to migrate at the next start.
        expect(await adoptLegacyDedup(store, dedup, box)).toBeNull();
    });
});
