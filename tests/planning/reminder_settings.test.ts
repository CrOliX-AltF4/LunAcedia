import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    ReminderSettingsStore,
    mergeReminderSettings,
} from "../../source/planning/reminder_settings.js";
import { DEFAULT_REMINDER_SETTINGS } from "../../source/planning/reminder_rules.js";

describe("reminder settings", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-settings-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("starts from the default rules", () => {
        expect(new ReminderSettingsStore().get()).toEqual(DEFAULT_REMINDER_SETTINGS);
        expect(DEFAULT_REMINDER_SETTINGS.quietStart).toBe("22:00");
        expect(DEFAULT_REMINDER_SETTINGS.rules.event_soon.minutesBefore).toBe(60);
    });

    it("applies a partial change and keeps the rest", () => {
        const r = mergeReminderSettings(DEFAULT_REMINDER_SETTINGS, {
            quietEnd: "07:30",
            rules: { event_soon: { minutesBefore: 30 }, task_undated: { enabled: false } },
        });
        if (!r.ok) throw new Error(r.error);
        expect(r.value.quietEnd).toBe("07:30");
        expect(r.value.rules.event_soon).toEqual({ enabled: true, minutesBefore: 30 });
        expect(r.value.rules.task_undated.enabled).toBe(false);
        expect(r.value.rules.event_eve).toEqual(DEFAULT_REMINDER_SETTINGS.rules.event_eve);
    });

    it.each([
        [{ quietStart: "25:00" }, "quietStart"],
        [{ rules: { nope: {} } }, "unknown rule"],
        [{ rules: { event_soon: { minutesBefore: 2 } } }, "5 to 1440"],
        [{ rules: { task_undated: { afterDays: 0 } } }, "1 to 60 days"],
        [{ rules: { event_eve: { colour: "red" } } }, "unknown field"],
        [{ volume: 3 }, "unknown setting"],
        [{ enabled: "yes" }, "true or false"],
    ])("refuses %j, saying which field", (patch, message) => {
        const r = mergeReminderSettings(DEFAULT_REMINDER_SETTINGS, patch);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain(message);
    });

    it("keeps a change across a restart; an unreadable file means the defaults", async () => {
        const file = path.join(dir, "reminder_settings.json");
        const store = new ReminderSettingsStore(file);
        await store.set({ enabled: false });
        const again = new ReminderSettingsStore(file);
        await again.load();
        expect(again.get().enabled).toBe(false);

        await fs.writeFile(file, "{ torn");
        const broken = new ReminderSettingsStore(file);
        await broken.load();
        expect(broken.get()).toEqual(DEFAULT_REMINDER_SETTINGS);
    });
});
